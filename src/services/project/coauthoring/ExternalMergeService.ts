import { stringify } from 'yaml';
import { inject, injectable } from '@/fw/di';
import { appState, type MergeBannerState } from '@/state';
import { SceneManager } from '@pix3/runtime';
import { LoggingService } from '@/services/core/LoggingService';
import { OperationService } from '@/services/core/OperationService';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { ProjectOwnershipService } from '@/services/project/coauthoring/ProjectOwnershipService';
import { ProtectedSetService } from '@/services/project/coauthoring/ProtectedSetService';
import { SceneDiskStateService } from '@/services/project/coauthoring/SceneDiskStateService';
import {
  RecoveryJournalService,
  type RecoveryRecord,
} from '@/services/project/coauthoring/RecoveryJournalService';
import { AckService } from '@/services/project/coauthoring/AckService';
import {
  MergeLogService,
  type EditorMergeLogEvent,
} from '@/services/project/coauthoring/MergeLogService';
import type { ExternalBatchResult } from '@/services/project/coauthoring/ExternalChangeService';
import { toProjectPath } from '@/services/project/coauthoring/coauthoring-paths';
import { readDiskVersion, type DiskVersion } from '@/services/project/coauthoring/disk-version';
import {
  mergeExternalVersion,
  stampMergedHash,
  type MergeConflict,
  type MergeLogEntry,
  type MergeResult,
} from '@/services/project/external-merge/merge-external-version';
import {
  emptyProtectedSet,
  type ProtectedSetData,
} from '@/services/project/external-merge/protected-set';
import {
  indexTree,
  ownFields,
  parseSceneText,
  type MergeDoc,
} from '@/services/project/external-merge/scene-doc';
import { toMergeDoc } from '@/services/project/external-merge/human-operation-diff';
import { getEditorTypeResolver } from '@/services/project/external-merge/editor-type-resolver';
import type { PropertyTypeResolver } from '@/services/project/external-merge/value-equality';
import { ReloadSceneOperation } from '@/features/scene/ReloadSceneOperation';
import {
  SaveSceneOperation,
  type SaveSceneOperationResult,
} from '@/features/scene/SaveSceneOperation';
import { AcceptAgentVersionCommand } from '@/features/scene/AcceptAgentVersionCommand';
import { RestoreRecoveryVersionCommand } from '@/features/scene/RestoreRecoveryVersionCommand';
import { RefreshPrefabInstancesCommand } from '@/features/scene/RefreshPrefabInstancesCommand';

/** How long the scene tree highlights the nodes an external version changed. */
export const CHANGED_NODES_HIGHLIGHT_MS = 3000;

/** What happened to one external version (visible for tests and diagnostics). */
export type ExternalApplyOutcome =
  /** Plain reload from the file: no protected edits, a non-owner window, or `M == A`. */
  | 'reloaded'
  /** Merged silently: human values kept, `M` loaded and written back. */
  | 'merged'
  /** Merged with conflicts: as `merged`, plus the banner. */
  | 'conflicts'
  /** Could not be merged: the last good graph stays, a whole-scene banner waits for a decision. */
  | 'rejected'
  /** The file vanished before it could be read. */
  | 'missing';

/**
 * Applies settled external versions to the open scenes — plan §4.3 "Таблица разбора внешней
 * версии" wired to the graph, §5 C3. The editor shell hands every batch from
 * `ExternalChangeService` to {@link handleBatch}.
 *
 * Per open scene named in the batch (in the OWNER window; a non-owner just reloads the disk):
 *
 * | `P` / merge                    | graph           | disk                      | UI        |
 * |--------------------------------|-----------------|---------------------------|-----------|
 * | `P` empty, no acks (fast path) | reload from `A` | —                         | —         |
 * | `clean`, `M == A`              | reload from `A` | —                         | —         |
 * | `clean`, `M != A`              | reload from `M` | `M` written back          | —         |
 * | `conflicts`                    | reload from `M` | `M` written back          | banner    |
 * | `rejected`                     | last good graph | `A` stays, autosave held  | banner: accept / keep mine |
 *
 * `A` is read ONCE as raw bytes: its hash is the byte hash (what `pix3 read` acks and what the
 * pre-write check compares), its text is what is merged. `E` is the last version the editor wrote
 * or accepted (`SceneDiskStateService`). Before `M` replaces the graph the human version is
 * journaled (`before-external`), so "Restore my version" has it; every merge appends its
 * `MergeLogEntry`s (hash of `M` stamped after the write) to `.pix3/merge-log.jsonl`; consumed acks
 * leave `.pix3/ack.json`. Every reload keeps camera, selection and expanded tree branches by id,
 * clears undo history (there is no coherent undo across an external write) and says so.
 */
@injectable()
export class ExternalMergeService {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(OperationService)
  private readonly operations!: OperationService;

  @inject(CommandDispatcher)
  private readonly dispatcher!: CommandDispatcher;

  @inject(LoggingService)
  private readonly logger!: LoggingService;

  @inject(ProjectOwnershipService)
  private readonly ownership!: ProjectOwnershipService;

  @inject(ProtectedSetService)
  private readonly protectedSets!: ProtectedSetService;

  @inject(SceneDiskStateService)
  private readonly diskState!: SceneDiskStateService;

  @inject(RecoveryJournalService)
  private readonly journal!: RecoveryJournalService;

  @inject(AckService)
  private readonly acks!: AckService;

  @inject(MergeLogService)
  private readonly mergeLog!: MergeLogService;

  /** The agent's text behind each banner (kept out of `appState`: it can be large). */
  private readonly externalTexts = new Map<string, string>();
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;
  private typeResolver: PropertyTypeResolver | null = null;
  private highlightMs = CHANGED_NODES_HIGHLIGHT_MS;

  /** Tests: a resolver without importing the whole runtime namespace; a shorter highlight. */
  configureForTests(options: { typeResolver?: PropertyTypeResolver; highlightMs?: number }): void {
    if (options.typeResolver) this.typeResolver = options.typeResolver;
    if (options.highlightMs !== undefined) this.highlightMs = options.highlightMs;
  }

  /**
   * A settled batch: apply every open scene it names, then refresh the active scene's prefab
   * instances for the other files. Paths whose load failed are handed back (retried).
   */
  async handleBatch(paths: readonly string[]): Promise<ExternalBatchResult> {
    const failed: string[] = [];
    const changed = new Set(paths.map(path => toProjectPath(path)));
    const activeSceneId = appState.scenes.activeSceneId;

    for (const [sceneId, descriptor] of Object.entries(appState.scenes.descriptors)) {
      const filePath = descriptor?.filePath ?? '';
      if (!filePath.startsWith('res://') || !changed.has(toProjectPath(filePath))) {
        continue;
      }
      try {
        await this.applyExternalVersion(sceneId, filePath);
      } catch (error) {
        console.error('[ExternalMergeService] Failed to apply an external version:', error);
        failed.push(toProjectPath(filePath));
      }
    }

    const activePath = activeSceneId
      ? toProjectPath(appState.scenes.descriptors[activeSceneId]?.filePath ?? '')
      : null;
    if (activeSceneId) {
      for (const path of changed) {
        if (path === activePath) continue;
        try {
          await this.dispatcher.execute(
            new RefreshPrefabInstancesCommand({
              sceneId: activeSceneId,
              changedPrefabPath: `res://${path}`,
            })
          );
        } catch (error) {
          console.error('[ExternalMergeService] Failed to refresh prefab instances:', error);
        }
      }
    }
    return { failed };
  }

  /** Apply the version of `filePath` now on disk to scene `sceneId` (see the class table). */
  async applyExternalVersion(sceneId: string, filePath: string): Promise<ExternalApplyOutcome> {
    const path = toProjectPath(filePath);
    const disk = await readDiskVersion(this.storage, filePath);
    if (!disk) {
      return 'missing';
    }

    if (!this.canMerge()) {
      await this.reload(sceneId, filePath, disk.text, disk.hash, true);
      this.clearBanner(path);
      return 'reloaded';
    }

    await this.protectedSets.whenLoaded();
    const acks = await this.acks.acksFor(path);
    const protectedSet = this.protectedSets.get(path);
    if (protectedSet.entries.length === 0 && acks.length === 0) {
      // Fast path: nothing of the human's is at stake. A still counts as a version the editor
      // accepted (an ack of it releases nothing newer).
      await this.reload(sceneId, filePath, disk.text, disk.hash, true);
      this.protectedSets.recordEditorWrite(path, disk.hash);
      this.diskState.releaseDecision(path);
      this.clearBanner(path);
      return 'reloaded';
    }

    const result = this.merge(path, disk, protectedSet, acks);
    if (result.consumedAcks.length > 0) {
      await this.acks.consume(path, result.consumedAcks);
    }

    if (result.status === 'rejected') {
      // The last good graph stays; nothing is written; autosave holds this path until the human
      // decides (or a newer version merges).
      this.diskState.holdForDecision(path);
      this.externalTexts.set(path, disk.text);
      const reason = rejectionReason(result);
      this.setBanner({
        path,
        sceneId,
        status: 'rejected',
        conflicts: result.conflicts,
        reason,
        externalHash: disk.hash,
        restoreRef: null,
        at: Date.now(),
      });
      await this.mergeLog.append(path, result.mergeLog);
      this.logger.warn(
        `The agent's version of ${path} could not be merged (${reason}); your version is kept.`
      );
      return 'rejected';
    }

    this.diskState.releaseDecision(path);
    this.protectedSets.set(path, result.protectedSet);

    if (result.status === 'clean' && result.mergedEqualsExternal) {
      await this.reload(sceneId, filePath, disk.text, disk.hash, true);
      await this.mergeLog.append(path, stampMergedHash(result.mergeLog, disk.hash));
      this.clearBanner(path);
      return 'reloaded';
    }

    // M != A: journal the human version first, load M, write it back through the save path.
    const restore = await this.journalCurrent(sceneId, path);
    await this.reload(sceneId, filePath, stringify(result.merged), disk.hash, false);
    const mergedHash = await this.writeBack(sceneId);
    await this.mergeLog.append(
      path,
      mergedHash ? stampMergedHash(result.mergeLog, mergedHash) : result.mergeLog
    );

    if (result.status === 'conflicts') {
      this.externalTexts.set(path, disk.text);
      this.setBanner({
        path,
        sceneId,
        status: 'conflicts',
        conflicts: result.conflicts,
        reason: null,
        externalHash: disk.hash,
        restoreRef: restore?.ref ?? null,
        at: Date.now(),
      });
      return 'conflicts';
    }
    this.clearBanner(path);
    return 'merged';
  }

  // --- Banner decisions -----------------------------------------------------------------------

  /** Accept the agent's side of `conflictIds` (all of the banner's when omitted). Undoable. */
  async acceptConflicts(path: string, conflictIds?: readonly string[]): Promise<boolean> {
    const key = toProjectPath(path);
    const banner = appState.project.coauthoring.merges[key];
    const externalText = this.externalTexts.get(key);
    if (!banner || banner.status !== 'conflicts' || externalText === undefined) {
      return false;
    }
    const all = conflictIds === undefined;
    const chosen = plainConflicts(banner.conflicts).filter(
      c => conflictIds === undefined || conflictIds.includes(c.id)
    );
    if (chosen.length === 0) return false;
    const filePath = appState.scenes.descriptors[banner.sceneId]?.filePath ?? `res://${key}`;
    const done = await this.dispatcher.execute(
      new AcceptAgentVersionCommand({
        sceneId: banner.sceneId,
        filePath,
        externalText,
        conflicts: chosen,
      })
    );
    if (!done) return false;
    const chosenIds = new Set(chosen.map(c => c.id));
    const remaining = plainConflicts(banner.conflicts).filter(c => !chosenIds.has(c.id));
    if (remaining.length === 0) {
      this.clearBanner(key);
    } else {
      this.setBanner({ ...plainBanner(banner), conflicts: remaining });
    }
    await this.log(key, { event: 'accept-agent', conflicts: [...chosenIds], all });
    return true;
  }

  /** Rejected merge → "Accept agent's version": load `A` as it is and release all of `P`. */
  async acceptRejected(path: string): Promise<boolean> {
    const key = toProjectPath(path);
    const banner = appState.project.coauthoring.merges[key];
    if (!banner || banner.status !== 'rejected' || !this.ownership.isOwner()) return false;
    const filePath = appState.scenes.descriptors[banner.sceneId]?.filePath ?? `res://${key}`;
    const disk = await readDiskVersion(this.storage, filePath);
    if (!disk) return false;
    await this.journalCurrent(banner.sceneId, key);
    await this.reload(banner.sceneId, filePath, disk.text, disk.hash, true);
    const current = this.protectedSets.get(key);
    const released: ProtectedSetData = {
      ...emptyProtectedSet(),
      gen: current.gen,
      versions: current.versions,
    };
    this.protectedSets.set(key, released);
    this.protectedSets.recordEditorWrite(key, disk.hash);
    this.diskState.releaseDecision(key);
    this.clearBanner(key);
    await this.log(key, { event: 'accept-agent', conflicts: ['invalid-graph:scene'], all: true });
    return true;
  }

  /** Rejected merge → "Keep mine": write the editor's version over the agent's (journaled). */
  async keepMine(path: string): Promise<boolean> {
    const key = toProjectPath(path);
    const banner = appState.project.coauthoring.merges[key];
    if (!banner || banner.status !== 'rejected' || !this.ownership.isOwner()) return false;
    const agentText = this.externalTexts.get(key);
    if (agentText !== undefined) {
      // The agent's file is about to be overwritten: keep it recoverable as well.
      await this.journal.recordVersion(key, agentText, 'before-external');
    }
    this.diskState.releaseDecision(key);
    const result = await this.operations.invoke<SaveSceneOperationResult>(
      new SaveSceneOperation({
        sceneId: banner.sceneId,
        quiet: true,
        overwriteExternalHash: banner.externalHash,
      }),
      { origin: 'system' }
    );
    if (result.outcome === 'external-change') {
      // Something newer arrived meanwhile: it goes through the merge again.
      this.diskState.holdForDecision(key);
      return false;
    }
    this.clearBanner(key);
    await this.log(key, { event: 'keep-mine', hash: this.diskState.getKnown(key)?.hash ?? null });
    return true;
  }

  /** "Restore my version before the agent's changes" of the banner (journal, undoable). */
  async restoreBeforeMerge(path: string): Promise<boolean> {
    const key = toProjectPath(path);
    const banner = appState.project.coauthoring.merges[key];
    if (!banner) return false;
    const records = await this.journal.listVersions(key);
    const record =
      records.find(r => r.ref === banner.restoreRef) ??
      records.find(r => r.createdAt <= banner.at) ??
      null;
    if (!record) {
      this.logger.warn(`No journal version of ${key} from before the agent's change.`);
      return false;
    }
    const restored = await this.restoreVersion(banner.sceneId, record);
    if (restored) this.clearBanner(key);
    return restored;
  }

  /** Restore one journal version into scene `sceneId` (undoable; recorded into `P`). */
  async restoreVersion(sceneId: string, record: RecoveryRecord): Promise<boolean> {
    const filePath = appState.scenes.descriptors[sceneId]?.filePath;
    if (!filePath) return false;
    const content = await this.journal.readVersion(record);
    if (content === null) {
      this.logger.warn(`Journal version ${record.ref} is gone.`);
      return false;
    }
    const done = await this.dispatcher.execute(
      new RestoreRecoveryVersionCommand({
        sceneId,
        filePath,
        content,
        label: new Date(record.createdAt).toLocaleString(),
      })
    );
    if (done) {
      await this.log(toProjectPath(filePath), {
        event: 'restore-version',
        ref: record.ref,
        createdAt: record.createdAt,
      });
    }
    return done;
  }

  /** The last `limit` journal versions of a scene (newest first) — the tab context menu. */
  async listVersions(path: string, limit = 10): Promise<RecoveryRecord[]> {
    return (await this.journal.listVersions(toProjectPath(path))).slice(0, limit);
  }

  dismiss(path: string): void {
    this.clearBanner(toProjectPath(path));
  }

  dispose(): void {
    if (this.highlightTimer !== null) {
      clearTimeout(this.highlightTimer);
      this.highlightTimer = null;
    }
    this.externalTexts.clear();
  }

  // --- internals ------------------------------------------------------------------------------

  private canMerge(): boolean {
    return appState.project.backend !== 'cloud' && this.ownership.isOwner();
  }

  private merge(
    path: string,
    disk: DiskVersion,
    protectedSet: ProtectedSetData,
    acks: readonly string[]
  ): MergeResult {
    let external: unknown;
    try {
      external = parseSceneText(disk.text);
    } catch (error) {
      // Not a document: `mergeExternalVersion` rejects it with its own shape message.
      external = { yamlError: error instanceof Error ? error.message : String(error) };
    }
    return mergeExternalVersion({
      editorVersion: this.diskState.getEditorVersion(path)?.doc ?? null,
      externalVersion: external,
      protectedSet,
      acks,
      externalHash: disk.hash,
      file: path,
      typeResolver: this.typeResolver ?? getEditorTypeResolver(),
    });
  }

  /**
   * Replace the graph of `sceneId` from `sceneText` (non-destructive: selection, camera and
   * expanded branches are kept by id), clear history, highlight what changed.
   */
  private async reload(
    sceneId: string,
    filePath: string,
    sceneText: string,
    diskHash: string,
    accept: boolean
  ): Promise<void> {
    const before = this.currentDoc(sceneId);
    await this.operations.invoke(
      new ReloadSceneOperation({
        sceneId,
        filePath,
        sceneText,
        diskHash,
        acceptAsEditorVersion: accept,
        markDirty: !accept,
      }),
      { origin: 'external' }
    );
    const history = this.operations.history;
    const hadHistory = history.canUndo || history.canRedo;
    this.operations.clearHistory();
    const name = appState.scenes.descriptors[sceneId]?.name || toProjectPath(filePath);
    this.logger.info(
      `${name} was changed outside Pix3 and reloaded` +
        (hadHistory ? ' — undo history was cleared.' : '.')
    );
    const after = this.currentDoc(sceneId);
    if (before && after && appState.scenes.activeSceneId === sceneId) {
      this.highlight(changedNodeIds(before, after));
    }
  }

  /** Write the loaded merge result back (pre-write check applies). Returns the hash written. */
  private async writeBack(sceneId: string): Promise<string | null> {
    const filePath = appState.scenes.descriptors[sceneId]?.filePath ?? '';
    try {
      const result = await this.operations.invoke<SaveSceneOperationResult>(
        new SaveSceneOperation({ sceneId, quiet: true }),
        { origin: 'system' }
      );
      if (result.outcome === 'external-change') {
        return null; // a newer version arrived; it goes through the merge next
      }
      return this.diskState.getKnown(filePath)?.hash ?? null;
    } catch (error) {
      console.warn('[ExternalMergeService] Writing the merged version failed', error);
      return null;
    }
  }

  private async journalCurrent(sceneId: string, path: string): Promise<RecoveryRecord | null> {
    const graph = this.sceneManager.getSceneGraph(sceneId);
    if (!graph) return null;
    try {
      const record = await this.journal.recordVersion(
        path,
        this.sceneManager.serializeScene(graph),
        'before-external'
      );
      return record ?? (await this.journal.listVersions(path))[0] ?? null;
    } catch (error) {
      console.warn('[ExternalMergeService] Could not journal the human version', error);
      return null;
    }
  }

  private currentDoc(sceneId: string): MergeDoc | null {
    const graph = this.sceneManager.getSceneGraph(sceneId);
    return graph ? toMergeDoc(this.sceneManager.serializeSceneDocument(graph)) : null;
  }

  private highlight(ids: readonly string[]): void {
    if (ids.length === 0) return;
    appState.project.coauthoring.recentlyChangedNodeIds = [...ids];
    if (this.highlightTimer !== null) clearTimeout(this.highlightTimer);
    this.highlightTimer = setTimeout(() => {
      this.highlightTimer = null;
      appState.project.coauthoring.recentlyChangedNodeIds = [];
    }, this.highlightMs);
  }

  private setBanner(banner: MergeBannerState): void {
    appState.project.coauthoring.merges[banner.path] = {
      ...banner,
      conflicts: plainConflicts(banner.conflicts),
    };
  }

  private clearBanner(path: string): void {
    if (appState.project.coauthoring.merges[path]) {
      delete appState.project.coauthoring.merges[path];
    }
    this.externalTexts.delete(path);
  }

  private log(path: string, event: EditorMergeLogEvent): Promise<void> {
    return this.mergeLog.append(path, [event]);
  }
}

/** Plain copies (valtio proxies must not leak into operations / structuredClone). */
function plainConflicts(conflicts: readonly MergeConflict[]): MergeConflict[] {
  return JSON.parse(JSON.stringify(conflicts)) as MergeConflict[];
}

function plainBanner(banner: MergeBannerState): MergeBannerState {
  return JSON.parse(JSON.stringify(banner)) as MergeBannerState;
}

function rejectionReason(result: MergeResult): string {
  const entry = result.mergeLog.find(
    (e): e is Extract<MergeLogEntry, { event: 'merge' }> => e.event === 'merge'
  );
  return entry?.problems?.join('; ') || result.conflicts[0]?.message || 'unknown reason';
}

/** Ids of nodes that are new in `after`, moved, or whose own fields differ from `before`. */
export function changedNodeIds(before: MergeDoc, after: MergeDoc): string[] {
  const b = indexTree(before);
  const a = indexTree(after);
  const out: string[] = [];
  for (const id of a.order) {
    const next = a.byId.get(id)!;
    const prev = b.byId.get(id);
    if (
      !prev ||
      prev.parentId !== next.parentId ||
      canonical(ownFields(prev.node)) !== canonical(ownFields(next.node))
    ) {
      out.push(id);
    }
  }
  return out;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1))
        )
      : v
  );
}
