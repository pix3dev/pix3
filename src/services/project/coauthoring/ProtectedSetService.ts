import { subscribe } from 'valtio/vanilla';
import { inject, injectable } from '@/fw/di';
import { appState } from '@/state';
import { SceneManager, type SceneGraph } from '@pix3/runtime';
import { OperationService, type OperationEvent } from '@/services/core/OperationService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { ProjectOwnershipService } from '@/services/project/coauthoring/ProjectOwnershipService';
import {
  PROTECTED_SET_FILE,
  toProjectPath,
} from '@/services/project/coauthoring/coauthoring-paths';
import {
  emptyProtectedSet,
  parseProtectedSet,
  recordEditorWrite,
  recordHumanOperation,
  serializeProtectedSet,
  type HumanOperation,
  type ProtectedSetData,
} from '@/services/project/external-merge/protected-set';
import {
  diffSceneDocuments,
  toMergeDoc,
} from '@/services/project/external-merge/human-operation-diff';
import type { MergeDoc } from '@/services/project/external-merge/scene-doc';
import { isRecord } from '@/services/project/external-merge/scene-doc';

export const PROTECTED_FILE_FORMAT = 1;

/** Debounce of `.pix3/protected.json` writes. */
const PERSIST_DEBOUNCE_MS = 1000;

interface Baseline {
  readonly graph: SceneGraph;
  readonly doc: MergeDoc;
}

/** Scene graph access the recorder needs (the real `SceneManager` in the editor). */
export interface ProtectedSetSceneSource {
  getSceneGraph(sceneId: string): SceneGraph | null;
  serializeSceneDocument(graph: SceneGraph): unknown;
}

/**
 * The protected set `P` of plan §4.3, per open scene, and the recorder that fills it.
 *
 * **Recording.** Hooks the `OperationService` commit point: every `operation:completed` that was
 * pushed to history with origin `user`, and every `operation:undone` / `operation:redone`, is a
 * completed human operation (an undo of a human edit is itself a human edit — the resulting value
 * is recorded). The operation's effect is taken as the difference between the scene document
 * right before and right after it (`diffSceneDocuments`, see its header for why a diff and the
 * exact path granularity). Everything else — a reload from disk (`ReloadSceneOperation` is tagged
 * non-human and never reaches history), an operation invoked with `origin: 'external' | 'system'`,
 * any operation that is not pushed to history — only moves the baseline and records nothing.
 *
 * Gestures: a live drag mutates nodes without an operation and commits one at pointer-up. The
 * baseline is the document after the PREVIOUS operation, so the committed operation's diff contains
 * the whole drag; nothing is recorded while it is in progress.
 *
 * **Persistence.** `.pix3/protected.json` = `{ format: 1, scenes: { <path>: ProtectedSetData } }`,
 * loaded when a project opens (recording waits for it), written debounced by the OWNER window only
 * (`ProjectOwnershipService`). A malformed file is never silently dropped: it is kept aside as
 * `.pix3/protected.corrupt-<time>.json` before the editor starts a fresh set.
 *
 * Consumed by `ExternalMergeService` (the merge of external versions) and by the accept / restore
 * operations, which replace a scene's set through {@link set}.
 */
@injectable()
export class ProtectedSetService {
  @inject(OperationService)
  private readonly operations!: OperationService;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(ProjectOwnershipService)
  private readonly ownership!: ProjectOwnershipService;

  private sets = new Map<string, ProtectedSetData>();
  private readonly baselines = new Map<string, Baseline>();
  private loadedProjectId: string | null = null;
  private ready: Promise<void> = Promise.resolve();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private sceneSource: ProtectedSetSceneSource | null = null;
  private disposers: Array<() => void> = [];
  private readonly listeners = new Set<(path: string) => void>();

  initialize(): void {
    if (this.disposers.length > 0) {
      return;
    }
    this.disposers.push(this.operations.addListener(event => this.handleOperationEvent(event)));
    this.disposers.push(
      subscribe(appState.project, () => {
        this.syncProject();
      })
    );
    this.disposers.push(
      subscribe(appState.scenes, () => {
        // A scene was loaded/replaced or the active tab changed: baseline it before any gesture.
        const sceneId = appState.scenes.activeSceneId;
        if (sceneId) this.ensureBaseline(sceneId);
      })
    );
    this.syncProject();
  }

  /** Tests: bypass `SceneManager`. */
  setSceneSource(source: ProtectedSetSceneSource | null): void {
    this.sceneSource = source;
  }

  /** Resolves once `.pix3/protected.json` of the open project has been loaded. */
  whenLoaded(): Promise<void> {
    return this.ready;
  }

  /** The set of `path` (empty when none). Never mutate the result. */
  get(path: string): ProtectedSetData {
    return this.sets.get(toProjectPath(path)) ?? emptyProtectedSet();
  }

  getGen(path: string): number {
    return this.get(path).gen;
  }

  /** Replace the set of `path` (merge results, accept-agent decisions) and persist. */
  set(path: string, data: ProtectedSetData): void {
    this.sets.set(toProjectPath(path), data);
    this.changed(toProjectPath(path));
  }

  /** Record one completed human operation (several ops = one operation, one gen bump). */
  recordHuman(path: string, ops: readonly HumanOperation[]): void {
    if (ops.length === 0) {
      return;
    }
    const key = toProjectPath(path);
    this.sets.set(key, recordHumanOperation(this.get(key), ops));
    this.changed(key);
  }

  /** The editor wrote (or accepted) the version with byte hash `hash` containing gens ≤ `gen`. */
  recordEditorWrite(path: string, hash: string, genAtWrite?: number): void {
    const key = toProjectPath(path);
    const current = this.get(key);
    this.sets.set(key, recordEditorWrite(current, hash, genAtWrite ?? current.gen));
    this.changed(key);
  }

  /** Listener runs with the path whose set changed. */
  subscribe(listener: (path: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Write `.pix3/protected.json` now (if this window owns the project and anything changed). */
  async flush(): Promise<void> {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.dirty || !this.canPersist()) {
      return;
    }
    this.dirty = false;
    try {
      await this.storage.writeTextFile(PROTECTED_SET_FILE, this.serialize(), {
        unconditional: true,
      });
    } catch (error) {
      this.dirty = true;
      console.warn(`[ProtectedSetService] Could not write ${PROTECTED_SET_FILE}`, error);
    }
  }

  /** The persisted form (visible for tests). */
  serialize(): string {
    const scenes: Record<string, ProtectedSetData> = {};
    for (const [path, data] of [...this.sets.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      scenes[path] = JSON.parse(serializeProtectedSet(data)) as ProtectedSetData;
    }
    return `${JSON.stringify({ format: PROTECTED_FILE_FORMAT, scenes }, null, 2)}\n`;
  }

  /** Parse the persisted form; throws on anything malformed (visible for tests). */
  static parse(text: string): Map<string, ProtectedSetData> {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || raw.format !== PROTECTED_FILE_FORMAT || !isRecord(raw.scenes)) {
      throw new Error('protected.json: unsupported format');
    }
    const out = new Map<string, ProtectedSetData>();
    for (const [path, data] of Object.entries(raw.scenes)) {
      out.set(toProjectPath(path), parseProtectedSet(JSON.stringify(data)));
    }
    return out;
  }

  /** Load `.pix3/protected.json` of the open project (called on open; visible for tests). */
  async load(): Promise<void> {
    let text: string | null = null;
    try {
      if (await this.storage.fileExists(PROTECTED_SET_FILE)) {
        text = await this.storage.readTextFile(PROTECTED_SET_FILE);
      }
    } catch {
      text = null;
    }
    if (text === null) {
      this.sets = new Map();
      return;
    }
    try {
      this.sets = ProtectedSetService.parse(text);
    } catch (error) {
      console.warn(
        `[ProtectedSetService] ${PROTECTED_SET_FILE} is malformed; kept aside, starting fresh`,
        error
      );
      this.sets = new Map();
      if (this.canPersist()) {
        const aside = `.pix3/protected.corrupt-${Date.now()}.json`;
        await this.storage.writeTextFile(aside, text, { unconditional: true }).catch(() => {
          // best-effort: the original stays on disk until the next persist
        });
      }
    }
  }

  dispose(): void {
    void this.flush();
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.baselines.clear();
    this.listeners.clear();
  }

  // --- Recording ------------------------------------------------------------------------------

  /** Visible for tests. */
  handleOperationEvent(event: OperationEvent): void {
    const sceneId = appState.scenes.activeSceneId;
    if (!sceneId || !this.isRecordingBackend()) {
      return;
    }
    switch (event.type) {
      case 'operation:invoked':
        this.ensureBaseline(sceneId);
        return;
      case 'operation:completed':
        // A save writes the graph out; it never changes it (autosave runs one every second).
        if (!event.didMutate || event.metadata.id === 'scene.save') return;
        if (event.pushedToHistory && event.origin === 'user') {
          this.recordDiff(sceneId);
        } else {
          this.rebaseline(sceneId);
        }
        return;
      case 'operation:undone':
      case 'operation:redone':
        this.recordDiff(sceneId);
        return;
      default:
        return;
    }
  }

  private recordDiff(sceneId: string): void {
    const graph = this.source().getSceneGraph(sceneId);
    const path = this.scenePath(sceneId);
    if (!graph || !path) {
      return;
    }
    const baseline = this.baselines.get(sceneId);
    const after = this.snapshot(graph);
    this.baselines.set(sceneId, { graph, doc: after });
    if (!baseline || baseline.graph !== graph) {
      // No baseline for this graph (replaced wholesale): nothing to attribute.
      return;
    }
    const ops = diffSceneDocuments(baseline.doc, after);
    if (ops.length === 0) {
      return;
    }
    void this.ready.then(() => this.recordHuman(path, ops));
  }

  private rebaseline(sceneId: string): void {
    const graph = this.source().getSceneGraph(sceneId);
    if (graph) {
      this.baselines.set(sceneId, { graph, doc: this.snapshot(graph) });
    } else {
      this.baselines.delete(sceneId);
    }
  }

  private ensureBaseline(sceneId: string): void {
    const graph = this.source().getSceneGraph(sceneId);
    if (!graph) return;
    if (this.baselines.get(sceneId)?.graph !== graph) {
      this.baselines.set(sceneId, { graph, doc: this.snapshot(graph) });
    }
  }

  private snapshot(graph: SceneGraph): MergeDoc {
    return toMergeDoc(this.source().serializeSceneDocument(graph));
  }

  private source(): ProtectedSetSceneSource {
    return this.sceneSource ?? this.sceneManager;
  }

  private scenePath(sceneId: string): string | null {
    const filePath = appState.scenes.descriptors[sceneId]?.filePath;
    return filePath && filePath.startsWith('res://') ? toProjectPath(filePath) : null;
  }

  // --- Project lifecycle / persistence --------------------------------------------------------

  private syncProject(): void {
    const project = appState.project;
    const id = project.status === 'ready' ? project.id : null;
    if (id === this.loadedProjectId) {
      return;
    }
    this.loadedProjectId = id;
    this.sets = new Map();
    this.baselines.clear();
    this.dirty = false;
    if (id && this.isRecordingBackend()) {
      this.ready = this.load().catch(error => {
        console.warn('[ProtectedSetService] Loading the protected set failed', error);
      });
    } else {
      this.ready = Promise.resolve();
    }
  }

  /** `P` exists for projects on disk only: cloud scenes merge through collaboration instead. */
  private isRecordingBackend(): boolean {
    return appState.project.backend !== 'cloud';
  }

  private canPersist(): boolean {
    return (
      appState.project.status === 'ready' && this.isRecordingBackend() && this.ownership.isOwner()
    );
  }

  private changed(path: string): void {
    this.dirty = true;
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(path);
      } catch (error) {
        console.error('[ProtectedSetService] Listener error', error);
      }
    }
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, PERSIST_DEBOUNCE_MS);
  }
}
