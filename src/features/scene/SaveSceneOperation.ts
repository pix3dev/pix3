import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { SceneManager } from '@pix3/runtime';
import { getAppStateSnapshot } from '@/state';
import { LoggingService } from '@/services/LoggingService';
import { FileWatchService } from '@/services/FileWatchService';
import { ProjectStorageService } from '@/services/ProjectStorageService';

export interface SaveSceneOperationParams {
  /** Optional scene id to save (defaults to active scene). */
  sceneId?: string;
}

export class SaveSceneOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.save',
    title: 'Save Scene',
    description: 'Save the active scene to its current file',
  };

  private readonly params: SaveSceneOperationParams;

  constructor(params: SaveSceneOperationParams = {}) {
    this.params = params;
  }

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
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

    logger.info('Saving scene...');

    const sceneYaml = sceneManager.serializeScene(sceneGraph);
    if (!sceneYaml || sceneYaml.trim().length === 0) {
      throw new Error('Failed to serialize scene - result is empty');
    }

    await storage.writeTextFile(filePath, sceneYaml);

    logger.info(`✓ Scene saved: ${descriptor.name || filePath}`);

    const beforeSnapshot = context.snapshot;

    // Update descriptor saved state
    descriptor.isDirty = false;
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

    // Trigger asset explorer refresh for the containing directory
    const lastSlashIndex = filePath.lastIndexOf('/');
    const directoryPath = lastSlashIndex > 0 ? filePath.substring(0, lastSlashIndex) : '.';
    state.project.lastModifiedDirectoryPath = directoryPath;
    state.project.fileRefreshSignal = (state.project.fileRefreshSignal || 0) + 1;

    const afterSnapshot = getAppStateSnapshot();

    return {
      didMutate: true,
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
