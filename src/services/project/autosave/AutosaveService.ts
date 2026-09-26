import { subscribe } from 'valtio/vanilla';
import { inject, injectable } from '@/fw/di';
import { appState, type AutosaveStatus } from '@/state';
import { OperationService, type OperationEvent } from '@/services/core/OperationService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { SceneDiskStateService } from '@/services/project/coauthoring/SceneDiskStateService';
import { ProjectOwnershipService } from '@/services/project/coauthoring/ProjectOwnershipService';
import { GestureStateService } from '@/services/viewport/GestureStateService';
import { SceneManager } from '@pix3/runtime';
import { RecoveryJournalService } from '@/services/project/coauthoring/RecoveryJournalService';
import { PIX3_INTERNAL_DIRECTORY } from '@/services/project/coauthoring/coauthoring-paths';
import { toProjectPath } from '@/services/project/coauthoring/coauthoring-paths';
import {
  SaveSceneOperation,
  type SaveSceneOperationResult,
} from '@/features/scene/SaveSceneOperation';

/** Quiet time after the last committed operation before a dirty scene is written (plan §5 C4). */
export const AUTOSAVE_DEBOUNCE_MS = 1000;
/** Re-check cadence while a gesture holds the save back. */
const GESTURE_RETRY_MS = 250;

/** Files whose presence at the project root marks an agent kit (plan §5 B). */
const AGENT_KIT_MARKERS = ['AGENTS.md'] as const;

/**
 * Autosave of the co-authoring mode — plan §5 C4 "Автосохранение привязанного проекта": without it
 * an agent working on the same folder never sees a manual edit.
 *
 * **When.** ~{@link AUTOSAVE_DEBOUNCE_MS} after the last committed operation (history push, undo,
 * redo — anything that leaves a scene dirty), every dirty open scene with a `res://` path is saved.
 *
 * **Enabled for:** a `workspace` project (always); a local folder / browser project with an agent
 * kit (`AGENTS.md` at the root or a `.pix3/` directory — detected once when the project opens) or
 * with the "Autosave scenes in local project folders" editor setting. Never for cloud projects
 * (they sync through collaboration).
 *
 * **Who.** Only the owner window (`ProjectOwnershipService`: workspace lease holder / Web Lock
 * holder).
 *
 * **Held back** while that scene has a pending external version (`SceneDiskStateService`) — an
 * autosave then would overwrite an agent's unfinished write — and while a pointer gesture is in
 * progress (`GestureStateService`). The save itself is the ordinary `SaveSceneOperation`
 * (`quiet`), invoked WITHOUT a history entry: it runs the pre-write check, the recovery journal and
 * the hash bookkeeping, never steals focus, and only clears the dirty flag once the write
 * succeeded and no edit landed during it. An `external-change` outcome leaves the scene dirty;
 * autosave comes back when the pending version has been applied.
 */
@injectable()
export class AutosaveService {
  @inject(OperationService)
  private readonly operations!: OperationService;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(SceneDiskStateService)
  private readonly diskState!: SceneDiskStateService;

  @inject(ProjectOwnershipService)
  private readonly ownership!: ProjectOwnershipService;

  @inject(GestureStateService)
  private readonly gestures!: GestureStateService;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(RecoveryJournalService)
  private readonly journal!: RecoveryJournalService;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  private kitProjectId: string | null = null;
  private disposers: Array<() => void> = [];
  private debounceMs = AUTOSAVE_DEBOUNCE_MS;

  initialize(): void {
    if (this.disposers.length > 0) {
      return;
    }
    this.disposers.push(this.operations.addListener(event => this.handleOperationEvent(event)));
    this.disposers.push(subscribe(appState.project, () => this.refresh()));
    this.disposers.push(
      subscribe(appState.ui, () => {
        if (appState.project.coauthoring.autosaveEnabled !== this.computeEnabled()) {
          this.refresh();
        }
      })
    );
    this.disposers.push(this.ownership.subscribe(() => this.refresh()));
    this.disposers.push(
      this.diskState.subscribe(() => {
        // A pending external version was applied: a held save may go now.
        if (appState.project.coauthoring.autosaveStatus === 'held') {
          this.schedule();
        }
      })
    );
    this.refresh();
  }

  /** Tests: shorter debounce. */
  setDebounceMs(ms: number): void {
    this.debounceMs = ms;
  }

  isEnabled(): boolean {
    return appState.project.coauthoring.autosaveEnabled;
  }

  /** Save now (skipping the debounce) — the same rules apply. Resolves when done. */
  async flushNow(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /**
   * Hand-over to another window (plan §4.3 "Несколько окон"): write every dirty scene now, and
   * journal whatever still could not be written (autosave off, a held external version, a failed
   * write) so the new owner can restore it from `.pix3/recovery/`. Runs while still the owner.
   */
  async handOver(): Promise<void> {
    await this.flushNow();
    for (const [sceneId, descriptor] of Object.entries(appState.scenes.descriptors)) {
      if (!descriptor?.isDirty || !descriptor.filePath?.startsWith('res://')) continue;
      const graph = this.sceneManager.getSceneGraph(sceneId);
      if (!graph) continue;
      try {
        await this.journal.recordVersion(
          descriptor.filePath,
          this.sceneManager.serializeScene(graph),
          'editor-write'
        );
      } catch (error) {
        console.warn(`[AutosaveService] Could not journal ${descriptor.filePath}`, error);
      }
    }
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
  }

  // --- internals ------------------------------------------------------------------------------

  /** Visible for tests. */
  handleOperationEvent(event: OperationEvent): void {
    if (!this.isEnabled()) {
      return;
    }
    if (event.type === 'operation:completed') {
      if (!event.didMutate || event.metadata.id === 'scene.save') {
        return;
      }
      if (event.pushedToHistory || this.hasDirtyScene()) {
        this.schedule();
      }
      return;
    }
    if (event.type === 'operation:undone' || event.type === 'operation:redone') {
      this.schedule();
    }
  }

  private schedule(delay = this.debounceMs): void {
    if (!this.isEnabled()) {
      return;
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    if (this.ownership.isOwner() && appState.project.coauthoring.autosaveStatus !== 'saving') {
      this.setStatus('dirty');
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    this.flushing = this.flushOnce().finally(() => {
      this.flushing = null;
    });
    await this.flushing;
    if (this.flushAgain) {
      this.flushAgain = false;
      this.schedule();
    }
  }

  private async flushOnce(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }
    if (!this.ownership.isOwner()) {
      this.setStatus('not-owner', 'Another window owns this project; it saves the edits.');
      return;
    }
    if (this.gestures.isGestureActive()) {
      this.schedule(GESTURE_RETRY_MS);
      return;
    }

    let held: string[] = [];
    let failure: string | null = null;
    let savedAny = false;
    for (const [sceneId, descriptor] of Object.entries(appState.scenes.descriptors)) {
      if (!descriptor?.isDirty || !descriptor.filePath?.startsWith('res://')) {
        continue;
      }
      if (this.diskState.isPendingExternal(descriptor.filePath)) {
        held.push(toProjectPath(descriptor.filePath));
        continue;
      }
      this.setStatus('saving');
      try {
        const result = await this.operations.invoke<SaveSceneOperationResult>(
          new SaveSceneOperation({ sceneId, quiet: true }),
          { origin: 'system' }
        );
        if (result.outcome === 'external-change') {
          held.push(toProjectPath(descriptor.filePath));
        } else {
          savedAny = true;
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        console.warn(`[AutosaveService] Autosave of ${descriptor.filePath} failed`, error);
      }
    }
    held = Array.from(new Set(held));

    if (failure !== null) {
      this.setStatus('error', failure);
    } else if (held.length > 0) {
      this.setStatus(
        'held',
        `Waiting for the external version of ${held.join(', ')} to load before saving.`
      );
    } else if (this.hasDirtyScene()) {
      // An edit landed during the write: go again.
      this.schedule();
    } else {
      if (savedAny) {
        appState.project.coauthoring.lastAutosavedAt = Date.now();
      }
      this.setStatus('saved');
    }
  }

  private hasDirtyScene(): boolean {
    return Object.values(appState.scenes.descriptors).some(
      descriptor => descriptor?.isDirty && descriptor.filePath?.startsWith('res://')
    );
  }

  private computeEnabled(): boolean {
    const project = appState.project;
    if (project.status !== 'ready') {
      return false;
    }
    if (project.backend === 'workspace') {
      return true;
    }
    if (project.backend === 'cloud') {
      return false;
    }
    return project.coauthoring.hasAgentKit || appState.ui.autosaveLocalProjects;
  }

  private refresh(): void {
    const project = appState.project;
    const projectId = project.status === 'ready' ? project.id : null;
    if (projectId !== this.kitProjectId) {
      this.kitProjectId = projectId;
      if (project.coauthoring.hasAgentKit) {
        project.coauthoring.hasAgentKit = false;
      }
      if (projectId && project.backend !== 'cloud') {
        void this.detectAgentKit(projectId);
      }
    }

    const enabled = this.computeEnabled();
    if (project.coauthoring.autosaveEnabled !== enabled) {
      project.coauthoring.autosaveEnabled = enabled;
    }
    if (!enabled) {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.setStatus('off', this.offReason());
      return;
    }
    if (!this.ownership.isOwner()) {
      this.setStatus('not-owner', 'Another window owns this project; it saves the edits.');
      return;
    }
    const status = project.coauthoring.autosaveStatus;
    if (status === 'off' || status === 'not-owner') {
      if (this.hasDirtyScene()) {
        this.schedule();
      } else {
        this.setStatus('saved');
      }
    }
  }

  private offReason(): string | null {
    const project = appState.project;
    if (project.status !== 'ready') return null;
    if (project.backend === 'cloud') {
      return 'Cloud projects are synchronized automatically.';
    }
    return (
      'Autosave is off for this folder (no AGENTS.md or .pix3/). Turn it on in ' +
      'Settings → General, or save with Ctrl+S.'
    );
  }

  /** Visible for tests. */
  async detectAgentKit(projectId: string): Promise<void> {
    let found = false;
    try {
      for (const marker of AGENT_KIT_MARKERS) {
        if (await this.storage.fileExists(marker)) {
          found = true;
          break;
        }
      }
      if (!found) {
        const root = await this.storage.listDirectory('.');
        found = root.some(
          entry => entry.kind === 'directory' && entry.name === PIX3_INTERNAL_DIRECTORY
        );
      }
    } catch (error) {
      console.debug('[AutosaveService] Agent-kit detection failed', error);
    }
    if (appState.project.id !== projectId || this.kitProjectId !== projectId) {
      return;
    }
    if (appState.project.coauthoring.hasAgentKit !== found) {
      appState.project.coauthoring.hasAgentKit = found;
    }
  }

  private setStatus(status: AutosaveStatus, reason: string | null = null): void {
    const coauthoring = appState.project.coauthoring;
    if (coauthoring.autosaveStatus !== status) coauthoring.autosaveStatus = status;
    if (coauthoring.autosaveReason !== reason) coauthoring.autosaveReason = reason;
  }
}
