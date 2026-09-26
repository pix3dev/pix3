import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { SceneManager } from '@pix3/runtime';
import { getAppStateSnapshot } from '@/state';
import { LoggingService } from '@/services/core/LoggingService';
import { FileWatchService } from '@/services/project/FileWatchService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { WorkspaceConflictError } from '@/services/project/workspace/workspace-protocol';
import { sha256 } from '@/services/project/external-merge/hash';
import { toProjectPath } from '@/services/project/coauthoring/coauthoring-paths';
import { readDiskVersion } from '@/services/project/coauthoring/disk-version';
import { optionalService } from '@/services/project/coauthoring/optional-service';
import { SceneDiskStateService } from '@/services/project/coauthoring/SceneDiskStateService';
import { RecoveryJournalService } from '@/services/project/coauthoring/RecoveryJournalService';
import { ProtectedSetService } from '@/services/project/coauthoring/ProtectedSetService';
import { ExternalChangeService } from '@/services/project/coauthoring/ExternalChangeService';

export interface SaveSceneOperationParams {
  /** Optional scene id to save (defaults to active scene). */
  sceneId?: string;
  /** Autosave: log at debug level and skip the extra listing refresh (no status-bar chatter). */
  quiet?: boolean;
  /**
   * The human decided to write over the external version with this byte hash ("Keep mine" after a
   * rejected merge): the pre-write check accepts exactly that version on disk, nothing newer.
   */
  overwriteExternalHash?: string;
}

/**
 * - `saved`: written;
 * - `unchanged`: the serialized scene is byte-identical to the version on disk — nothing written,
 *   the scene is clean;
 * - `external-change`: the file on disk is not the version the editor last read or wrote (an
 *   agent wrote it meanwhile). NOTHING was written; the path was handed to the external-change
 *   path (stabilise → reload) and the scene stays dirty, so autosave retries after the reload.
 */
export type SaveSceneOutcome = 'saved' | 'unchanged' | 'external-change';

export interface SaveSceneOperationResult extends OperationInvokeResult {
  readonly outcome: SaveSceneOutcome;
}

export class SaveSceneOperation implements Operation<SaveSceneOperationResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.save',
    title: 'Save Scene',
    description: 'Save the active scene to its current file',
  };

  private readonly params: SaveSceneOperationParams;

  constructor(params: SaveSceneOperationParams = {}) {
    this.params = params;
  }

  async perform(context: OperationContext): Promise<SaveSceneOperationResult> {
    const { state } = context;

    const sceneId = this.params.sceneId ?? state.scenes.activeSceneId;
    if (!sceneId) {
      throw new Error('No active scene to save');
    }

    const descriptor = state.scenes.descriptors[sceneId];
    if (!descriptor) {
      throw new Error(`Scene descriptor not found: ${sceneId}`);
    }

    const filePath = descriptor.filePath;
    if (!filePath?.startsWith('res://')) {
      throw new Error(
        `Scene must be saved within the project. Use Save As. (filePath: ${filePath})`
      );
    }

    const sceneManager = context.container.getService<SceneManager>(
      context.container.getOrCreateToken(SceneManager)
    );
    const storage = context.container.getService<ProjectStorageService>(
      context.container.getOrCreateToken(ProjectStorageService)
    );
    const logger = context.container.getService<LoggingService>(
      context.container.getOrCreateToken(LoggingService)
    );
    const fileWatchService = context.container.getService<FileWatchService>(
      context.container.getOrCreateToken(FileWatchService)
    );

    const sceneGraph = sceneManager.getSceneGraph(sceneId);
    if (!sceneGraph) {
      throw new Error(`Scene graph not found: ${sceneId}`);
    }

    const quiet = this.params.quiet === true;
    const log = (message: string) => (quiet ? logger.debug(message) : logger.info(message));
    log('Saving scene...');

    // Any operation completing while this save is in flight bumps the signal: its edit may not
    // be in the bytes serialized here, so the scene must stay dirty (autosave comes back for it).
    const changeSignalAtSerialize = state.scenes.nodeDataChangeSignal;
    const sceneYaml = sceneManager.serializeScene(sceneGraph);
    if (!sceneYaml || sceneYaml.trim().length === 0) {
      throw new Error('Failed to serialize scene - result is empty');
    }

    // Co-authoring bookkeeping (absent in minimal test containers).
    const diskState = optionalService(context.container, SceneDiskStateService);
    const journal = optionalService(context.container, RecoveryJournalService);
    const protectedSets = optionalService(context.container, ProtectedSetService);
    const externalChanges = optionalService(context.container, ExternalChangeService);
    const projectPath = toProjectPath(filePath);
    const newHash = await sha256(sceneYaml);
    const genAtSerialize = protectedSets?.getGen(projectPath);

    const refuse = (currentHash: string | null): SaveSceneOperationResult => {
      logger.warn(
        `${descriptor.name || filePath} changed on disk (an external edit) since Pix3 last read ` +
          'it — not saved. The new version loads first; your edits are protected.',
        { filePath, currentHash }
      );
      externalChanges?.report(projectPath);
      diskState?.markPendingExternal(projectPath);
      return { didMutate: false, outcome: 'external-change' };
    };

    // Pre-write check (plan §5 C4): never write over a version the editor has not seen. The
    // workspace backend does the same server-side (`If-Match`) — see the catch below.
    const known = diskState?.getKnown(projectPath) ?? null;
    let alreadyOnDisk = false;
    const overwrite = this.params.overwriteExternalHash;
    if (known && storage.getBackend() === 'local') {
      // Raw bytes: the same hash the external-change path and `pix3 serve` compute.
      const current = await readDiskVersion(storage, filePath);
      if (current !== null) {
        const currentHash = current.hash;
        if (currentHash === newHash) {
          alreadyOnDisk = true;
        } else if (currentHash !== known.hash && currentHash !== overwrite) {
          return refuse(currentHash);
        }
      }
    } else if (known && known.hash === newHash) {
      alreadyOnDisk = true;
    }

    if (!alreadyOnDisk) {
      // Journal first: the version being written is recoverable even if the write clobbers it.
      await journal?.recordVersion(projectPath, sceneYaml, 'editor-write');
      try {
        await storage.writeTextFile(filePath, sceneYaml);
      } catch (error) {
        if (error instanceof WorkspaceConflictError) {
          return refuse(error.currentHash);
        }
        throw error;
      }
      log(`✓ Scene saved: ${descriptor.name || filePath}`);
    }

    diskState?.recordWrite(projectPath, newHash, genAtSerialize, sceneYaml);
    fileWatchService.setLastKnownHash(filePath, newHash);
    protectedSets?.recordEditorWrite(projectPath, newHash, genAtSerialize);

    const beforeSnapshot = context.snapshot;

    // Update descriptor saved state — only when no edit landed during the write.
    if (state.scenes.nodeDataChangeSignal === changeSignalAtSerialize) {
      descriptor.isDirty = false;
    }
    descriptor.lastSavedAt = Date.now();

    // Update modification time best-effort and tell the file watcher about our own
    // write, so it does not mistake this Save for an external change and trigger a
    // self-reload (which would replace the graph and clear this scene's undo history).
    try {
      if (descriptor.fileHandle) {
        const file = await descriptor.fileHandle.getFile();
        descriptor.lastModifiedTime = file.lastModified;
      } else {
        descriptor.lastModifiedTime = await storage.getLastModified(filePath);
      }
      fileWatchService.setLastKnownModifiedTime(filePath, descriptor.lastModifiedTime);
    } catch {
      // ignore
    }

    // Trigger asset explorer refresh for the containing directory (the storage write already
    // bumped the signal; autosave skips the duplicate).
    if (!quiet) {
      const lastSlashIndex = filePath.lastIndexOf('/');
      const directoryPath = lastSlashIndex > 0 ? filePath.substring(0, lastSlashIndex) : '.';
      state.project.lastModifiedDirectoryPath = directoryPath;
      state.project.fileRefreshSignal = (state.project.fileRefreshSignal || 0) + 1;
    }

    const afterSnapshot = getAppStateSnapshot();

    return {
      didMutate: true,
      outcome: alreadyOnDisk ? 'unchanged' : 'saved',
      commit: {
        label: `Save scene: ${filePath}`,
        beforeSnapshot,
        afterSnapshot,
        undo: () => {
          const beforeDescriptor = beforeSnapshot.scenes.descriptors[sceneId];
          const liveDescriptor = state.scenes.descriptors[sceneId];
          if (beforeDescriptor && liveDescriptor) {
            liveDescriptor.isDirty = beforeDescriptor.isDirty;
            liveDescriptor.lastSavedAt = beforeDescriptor.lastSavedAt;
            liveDescriptor.lastModifiedTime = beforeDescriptor.lastModifiedTime;
          }
        },
        redo: () => {
          const afterDescriptor = afterSnapshot.scenes.descriptors[sceneId];
          const liveDescriptor = state.scenes.descriptors[sceneId];
          if (afterDescriptor && liveDescriptor) {
            liveDescriptor.isDirty = afterDescriptor.isDirty;
            liveDescriptor.lastSavedAt = afterDescriptor.lastSavedAt;
            liveDescriptor.lastModifiedTime = afterDescriptor.lastModifiedTime;
          }
        },
      },
    };
  }
}
