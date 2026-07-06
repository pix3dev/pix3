import { ResourceManager } from '@/services/ResourceManager';
import { SceneManager } from '@pix3/runtime';
import { SceneValidationError } from '@pix3/runtime';
import { ref } from 'valtio/vanilla';
import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';

export interface ReloadSceneOperationParams {
  /** Scene ID to reload. */
  sceneId: string;
  /** File path to reload from. */
  filePath: string;
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
      // Read and parse the scene from file
      let sceneText = await resourceManager.readText(filePath);

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

      // Update scene manager with new graph
      sceneManager.setActiveSceneGraph(sceneId, graph);

      // Update state hierarchy
      state.scenes.hierarchies[sceneId] = {
        version: graph.version ?? null,
        description: graph.description ?? null,
        rootNodes: ref(graph.rootNodes),
        metadata: graph.metadata ?? {},
      };

      // Mark as not dirty since we just reloaded from source
      descriptor.isDirty = false;

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
