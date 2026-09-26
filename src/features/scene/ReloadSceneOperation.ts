import { ResourceManager } from '@/services/assets/ResourceManager';
import { SceneManager } from '@pix3/runtime';
import { SceneValidationError } from '@pix3/runtime';
import { ref } from 'valtio/vanilla';
import { optionalService } from '@/services/project/coauthoring/optional-service';
import { SceneDiskStateService } from '@/services/project/coauthoring/SceneDiskStateService';
import { RecoveryJournalService } from '@/services/project/coauthoring/RecoveryJournalService';
import { readDiskVersion } from '@/services/project/coauthoring/disk-version';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import {
  NON_HUMAN_OPERATION_TAG,
  type Operation,
  type OperationContext,
  type OperationInvokeResult,
  type OperationMetadata,
} from '@/core/Operation';

export interface ReloadSceneOperationParams {
  /** Scene ID to reload. */
  sceneId: string;
  /** File path to reload from. */
  filePath: string;
  /**
   * The scene text to build the graph from — the external version `A` (already read by the merge)
   * or the merge result `M`. Omitted: the file is read now.
   */
  sceneText?: string;
  /**
   * Byte hash of the version ON DISK this reload corresponds to (`A`'s hash, also when the graph
   * is built from `M`). Omitted: the hash of the bytes read now (or of `sceneText`).
   */
  diskHash?: string;
  /**
   * Whether the loaded text becomes `E`, the version the editor accepted (default true). False
   * for a merge result `M` that still has to be written back: `E` becomes `M` once it is on disk.
   */
  acceptAsEditorVersion?: boolean;
  /** Mark the scene dirty after the reload (a merge result not on disk yet). */
  markDirty?: boolean;
}

/**
 * ReloadSceneOperation reloads a scene from its file source.
 * Used when external file changes are detected.
 */
export class ReloadSceneOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.reload',
    title: 'Reload Scene',
    description: 'Reload scene from file (triggered by external change)',
    // Applying a version from disk is not a human edit: it must never be recorded into the
    // protected set `P` (`src/services/project/coauthoring/ProtectedSetService.ts`).
    tags: [NON_HUMAN_OPERATION_TAG],
  };

  private readonly params: ReloadSceneOperationParams;

  constructor(params: ReloadSceneOperationParams) {
    this.params = params;
  }

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state, container } = context;
    const { sceneId, filePath } = this.params;

    const resourceManager = container.getService<ResourceManager>(
      container.getOrCreateToken(ResourceManager)
    );
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );

    try {
      const diskState = optionalService(container, SceneDiskStateService);
      let diskBytes: Uint8Array | null = null;
      let sceneText = this.params.sceneText;
      if (sceneText === undefined) {
        // Raw bytes when the project storage is there (the recorded hash must be the disk's).
        const storage = optionalService(container, ProjectStorageService);
        const version = storage ? await readDiskVersion(storage, filePath).catch(() => null) : null;
        diskBytes = version?.bytes ?? null;
        sceneText = version?.text ?? (await resourceManager.readText(filePath));
      }

      // When a file is being written, some browsers briefly expose a 0-byte file.
      // Retry a few times before treating this as a real invalid scene.
      for (
        let attempt = 0;
        attempt < 3 && (!sceneText || sceneText.trim().length === 0);
        attempt += 1
      ) {
        console.warn('[ReloadSceneOperation] Scene file empty; retrying read', {
          filePath,
          attempt: attempt + 1,
          contentLength: sceneText?.length ?? 0,
        });
        await new Promise(resolve => window.setTimeout(resolve, 50));
        sceneText = await resourceManager.readText(filePath);
        diskBytes = null;
      }

      if (!sceneText || sceneText.trim().length === 0) {
        console.warn('[ReloadSceneOperation] Scene file still empty; skipping reload', {
          filePath,
          contentLength: sceneText?.length ?? 0,
        });
        return { didMutate: false };
      }

      const graph = await sceneManager.parseScene(sceneText, { filePath });

      // Get current scene descriptor
      const descriptor = state.scenes.descriptors[sceneId];
      if (!descriptor) {
        throw new Error(`Scene descriptor not found: ${sceneId}`);
      }

      // An external version is about to replace the in-memory one. If that one carries manual
      // edits not on disk yet, journal it first (plan §4.3: "каждая ручная версия, которую
      // редактор собирается заменить внешней, кладётся туда до замены").
      const previousGraph = sceneManager.getSceneGraph(sceneId);
      if (descriptor.isDirty && previousGraph) {
        const journal = optionalService(container, RecoveryJournalService);
        try {
          await journal?.recordVersion(
            filePath,
            sceneManager.serializeScene(previousGraph),
            'before-external'
          );
        } catch (error) {
          console.warn('[ReloadSceneOperation] Could not journal the manual version', error);
        }
      }

      // Update scene manager with new graph
      sceneManager.setActiveSceneGraph(sceneId, graph);
      if (diskState) {
        const accept = this.params.acceptAsEditorVersion !== false;
        if (this.params.diskHash) {
          diskState.recordReadHash(filePath, this.params.diskHash);
          if (accept) diskState.setEditorVersion(filePath, sceneText, this.params.diskHash);
        } else {
          await diskState.recordRead(
            filePath,
            diskBytes ?? sceneText,
            accept ? sceneText : undefined
          );
        }
      }

      // Non-destructive: keep the selection of every node that still exists (by id). The camera
      // lives in `appState.scenes.*CameraStates` and the viewport reconciles proxies by id, and the
      // scene tree prunes only the collapsed ids that are gone — neither is reset by a reload.
      const keep = (id: string) => graph.nodeMap.has(id);
      if (state.scenes.activeSceneId === sceneId) {
        const kept = state.selection.nodeIds.filter(keep);
        if (kept.length !== state.selection.nodeIds.length) {
          state.selection.nodeIds = kept;
        }
        if (state.selection.primaryNodeId && !keep(state.selection.primaryNodeId)) {
          state.selection.primaryNodeId = kept[0] ?? null;
        }
        if (state.selection.focusNodeId && !keep(state.selection.focusNodeId)) {
          state.selection.focusNodeId = null;
        }
      }

      // Update state hierarchy
      state.scenes.hierarchies[sceneId] = {
        version: graph.version ?? null,
        description: graph.description ?? null,
        rootNodes: ref(graph.rootNodes),
        metadata: graph.metadata ?? {},
      };

      // Not dirty: it is what is on disk — unless it is a merge result still to be written back.
      descriptor.isDirty = this.params.markDirty === true;

      // Update modification time
      try {
        if (descriptor.fileHandle) {
          const file = await descriptor.fileHandle.getFile();
          descriptor.lastModifiedTime = file.lastModified;
        }
      } catch (error) {
        console.debug('[ReloadSceneOperation] Could not update modification time:', error);
      }

      state.scenes.loadState = 'ready';
      state.scenes.loadError = null;
      state.scenes.lastLoadedAt = Date.now();

      // Reloading from disk replaces the in-memory graph wholesale (the previous
      // graph and its nodes are disposed by SceneManager.setActiveSceneGraph).
      // There is no coherent in-editor undo for an external file change, and the
      // old snapshot-swap undo left state and scene graph out of sync. Return a
      // non-committing mutation so this is never pushed to history;
      // ReloadSceneCommand clears history after a successful reload.
      return { didMutate: true };
    } catch (error) {
      let message = 'Failed to reload scene from file.';
      if (error instanceof SceneValidationError) {
        message = `${message} Validation issues: ${error.details.join('; ')}`;
      } else if (error instanceof Error) {
        message = `${message} ${error.message}`;
      }
      state.scenes.loadState = 'error';
      state.scenes.loadError = message;
      console.error('[ReloadSceneOperation] Reload failed:', error);
      throw error;
    }
  }
}
