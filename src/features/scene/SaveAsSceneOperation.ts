import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { SceneManager } from '@pix3/runtime';
import { getAppStateSnapshot } from '@/state';
import { FileSystemAPIService } from '@/services/project/FileSystemAPIService';
import { FileWatchService } from '@/services/project/FileWatchService';
import { LoggingService } from '@/services/core/LoggingService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { ref } from 'valtio/vanilla';

export interface SaveAsSceneOperationParams {
  filePath: string; // res:// path (only used if fileHandle not provided)
  fileHandle?: FileSystemFileHandle; // Direct file handle from showSaveFilePicker
  isHandleInProject?: boolean; // Whether the fileHandle is within the project directory
  sceneId?: string; // optional scene id to save (defaults to active scene)
}

export class SaveAsSceneOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.save-as',
    title: 'Save Scene As',
    description: 'Save the active scene to a new file',
  };

  private readonly params: SaveAsSceneOperationParams;

  constructor(params: SaveAsSceneOperationParams) {
    this.params = params;
  }

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state } = context;
    console.debug('[SaveAsSceneOperation] Starting perform', {
      filePath: this.params.filePath,
      hasFileHandle: !!this.params.fileHandle,
      activeSceneId: state.scenes.activeSceneId,
    });

    const sceneManager = context.container.getService<SceneManager>(
      context.container.getOrCreateToken(SceneManager)
    );
    const fileSystem = context.container.getService<FileSystemAPIService>(
      context.container.getOrCreateToken(FileSystemAPIService)
    );
    const storage = context.container.getService<ProjectStorageService>(
      context.container.getOrCreateToken(ProjectStorageService)
    );
    const fileWatchService = context.container.getService<FileWatchService>(
      context.container.getOrCreateToken(FileWatchService)
    );
    const logger = context.container.getService<LoggingService>(
      context.container.getOrCreateToken(LoggingService)
    );

    // Get the scene to save (either specified or active)
    const sceneId = this.params.sceneId ?? state.scenes.activeSceneId;
    if (!sceneId) {
      throw new Error('No active scene to save');
    }

    const sceneGraph = sceneManager.getSceneGraph(sceneId);
    if (!sceneGraph) {
      throw new Error(`Scene not found: ${sceneId}`);
    }

    logger.info('Saving scene as...');

    // Serialize the scene
    const sceneYaml = sceneManager.serializeScene(sceneGraph);

    // Validate that we have content to save
    if (!sceneYaml || sceneYaml.trim().length === 0) {
      console.error('[SaveAsSceneOperation] Serialized scene is empty');
      throw new Error('Failed to serialize scene - result is empty');
    }

    let savedFilePath: string | undefined;
    let isInProject = false;

    // Write to file - either directly via fileHandle or to project
    if (this.params.fileHandle) {
      try {
        console.debug(
          '[SaveAsSceneOperation] Writing to external file via handle:',
          this.params.fileHandle.name
        );
        const writable = await this.params.fileHandle.createWritable();
        await writable.write(sceneYaml);
        await writable.close();
        console.info('[SaveAsSceneOperation] File written successfully to external location', {
          fileName: this.params.fileHandle.name,
          byteSize: sceneYaml.length,
        });
        // Prefer keeping a stable res:// path if the chosen handle is within the project.
        isInProject = this.params.isHandleInProject ?? false;
        if (isInProject) {
          const resolved = await fileSystem.resolveHandleToResourcePath(this.params.fileHandle);
          savedFilePath = resolved ?? this.params.filePath;
        } else {
          // External save: keep descriptor.filePath unchanged.
          savedFilePath = this.params.fileHandle.name;
        }

        // Best-effort: read updated mtime after write to suppress watcher reload.
        let lastModifiedTime: number | null = null;
        try {
          const file = await this.params.fileHandle.getFile();
          lastModifiedTime = file.lastModified;
        } catch {
          // ignore
        }

        // Only update scene descriptor if we saved to project
        const descriptorForSave = state.scenes.descriptors[sceneId];
        if (
          isInProject &&
          descriptorForSave &&
          savedFilePath &&
          savedFilePath.startsWith('res://')
        ) {
          descriptorForSave.fileHandle = ref(this.params.fileHandle);
          descriptorForSave.lastModifiedTime = lastModifiedTime;
          fileWatchService.setLastKnownModifiedTime(savedFilePath, lastModifiedTime);
        }
        console.debug('[SaveAsSceneOperation] File handle project containment check', {
          fileName: this.params.fileHandle.name,
          isInProject,
        });
      } catch (error) {
        console.error('[SaveAsSceneOperation] Failed to write to external file', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw new Error(
          `Failed to save scene: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else if (this.params.filePath) {
      // Validate that the path is within the project (res:// prefix)
      if (!this.params.filePath.startsWith('res://')) {
        console.error('[SaveAsSceneOperation] Invalid file path - must be within project', {
          filePath: this.params.filePath,
        });
        throw new Error(
          `File must be saved within the project. Path must start with 'res://', got: ${this.params.filePath}`
        );
      }

      try {
        await storage.writeTextFile(this.params.filePath, sceneYaml);
        console.info('[SaveAsSceneOperation] File written successfully to project', {
          filePath: this.params.filePath,
          byteSize: sceneYaml.length,
        });
        savedFilePath = this.params.filePath;
        isInProject = true;
      } catch (error) {
        console.error('[SaveAsSceneOperation] Failed to write file to project', {
          filePath: this.params.filePath,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new Error(
          `Failed to save scene to ${this.params.filePath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else {
      throw new Error('No file path or handle provided');
    }

    // Only update scene descriptor if we saved to project
    let descriptor = state.scenes.descriptors[sceneId];
    if (isInProject && descriptor) {
      descriptor.filePath = savedFilePath || this.params.filePath;
      descriptor.isDirty = false;
      descriptor.lastSavedAt = Date.now();

      // If we saved using a handle inside the project, ensure the descriptor has the up-to-date handle.
      if (this.params.fileHandle) {
        descriptor.fileHandle = ref(this.params.fileHandle);
      }

      // Best-effort: record modification time so the watcher does not immediately reload.
      try {
        if (descriptor.fileHandle) {
          const file = await descriptor.fileHandle.getFile();
          descriptor.lastModifiedTime = file.lastModified;
          fileWatchService.setLastKnownModifiedTime(
            descriptor.filePath,
            descriptor.lastModifiedTime
          );
        } else {
          descriptor.lastModifiedTime = await storage.getLastModified(descriptor.filePath);
        }
      } catch {
        // ignore
      }
      console.debug('[SaveAsSceneOperation] Updated scene descriptor (saved in project)', {
        sceneId,
        newFilePath: savedFilePath || this.params.filePath,
      });

      // Extract directory path for targeted refresh (e.g., 'res://Scenes' from 'res://Scenes/level1.pix3scene')
      const filePath = savedFilePath || this.params.filePath;
      const lastSlashIndex = filePath.lastIndexOf('/');
      const directoryPath = lastSlashIndex > 0 ? filePath.substring(0, lastSlashIndex) : '.';
      state.project.lastModifiedDirectoryPath = directoryPath;

      // Trigger asset explorer refresh by incrementing signal
      state.project.fileRefreshSignal = (state.project.fileRefreshSignal || 0) + 1;
      console.debug('[SaveAsSceneOperation] Triggered project file refresh', {
        refreshSignal: state.project.fileRefreshSignal,
        modifiedDirectory: directoryPath,
      });
    } else if (!isInProject) {
      console.debug('[SaveAsSceneOperation] Scene saved externally - not updating project state', {
        sceneId,
        externalFile: savedFilePath,
      });
    }

    // Mark scene state as saved
    state.scenes.lastLoadedAt = Date.now();

    // Create undo/redo closures
    const beforeSnapshot = context.snapshot;
    const afterSnapshot = getAppStateSnapshot();

    logger.info(`✓ Scene saved as: ${savedFilePath}`);

    return {
      didMutate: true,
      commit: {
        label: `Save scene as: ${savedFilePath}`,
        beforeSnapshot,
        afterSnapshot,
        undo: () => {
          // For now, undo just restores the previous state (only applies if saved in project)
          if (isInProject && descriptor && beforeSnapshot.scenes.descriptors[sceneId]) {
            descriptor.filePath = beforeSnapshot.scenes.descriptors[sceneId].filePath;
            descriptor.isDirty = beforeSnapshot.scenes.descriptors[sceneId].isDirty;
            descriptor.lastSavedAt = beforeSnapshot.scenes.descriptors[sceneId].lastSavedAt;
          }
        },
        redo: () => {
          // Redo just restores the saved state (only applies if saved in project)
          if (isInProject && descriptor) {
            descriptor.filePath = savedFilePath || this.params.filePath;
            descriptor.isDirty = false;
            descriptor.lastSavedAt = Date.now();
          }
        },
      },
    };
  }
}
