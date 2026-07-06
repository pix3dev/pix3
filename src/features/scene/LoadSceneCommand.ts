import { inject } from '@/fw/di';
import { ResourceManager } from '@/services/ResourceManager';
import { OperationService } from '@/services/OperationService';
import { SceneManager } from '@pix3/runtime';
import { SceneValidationError } from '@pix3/runtime';
import { ProjectStorageService } from '@/services/ProjectStorageService';
import type { SceneGraph } from '@pix3/runtime';
import { ref } from 'valtio/vanilla';
import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';

export interface LoadSceneCommandPayload {
  filePath: string; // res:// path
  sceneId?: string; // optional override id
}

export class LoadSceneCommand extends CommandBase<LoadSceneCommandPayload, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.load',
    title: 'Load Scene',
    description: 'Load a scene file into the editor',
    keywords: ['load', 'scene', 'open'],
  };

  @inject(ResourceManager) private readonly resources!: ResourceManager;
  @inject(SceneManager) private readonly sceneManager!: SceneManager;
  @inject(ProjectStorageService) private readonly storage!: ProjectStorageService;

  private payload?: LoadSceneCommandPayload;

  constructor(payload?: LoadSceneCommandPayload) {
    super();
    this.payload = payload;
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (context.state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'Project must be opened before loading scenes',
        scope: 'project',
        recoverable: true,
      };
    }

    if (!this.payload?.filePath) {
      return {
        canExecute: false,
        reason: 'File path is required to load a scene',
        scope: 'service',
        recoverable: false,
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<LoadSceneCommandPayload>> {
    if (!this.payload) {
      throw new Error('LoadSceneCommand requires payload with filePath');
    }

    const { filePath } = this.payload;
    const { state } = context;

    state.scenes.loadState = 'loading';
    state.scenes.loadError = null;

    try {
      const sceneText = await this.resources.readText(filePath);
      const graph = await this.sceneManager.parseScene(sceneText, { filePath });

      const activeId = this.payload.sceneId ?? state.scenes.activeSceneId ?? 'startup-scene';
      const existing = state.scenes.descriptors[activeId] ?? null;
      const sceneName = this.deriveSceneName(filePath, graph.metadata ?? {}, existing?.name);

      // Try to get file handle and modification time for file watching
      let fileHandle: FileSystemFileHandle | null = null;
      let lastModifiedTime: number | null = null;

      try {
        // Only get handle for res:// paths (project files)
        if (filePath.startsWith('res://')) {
          fileHandle = await this.storage.getFileHandle(filePath);
          lastModifiedTime = await this.storage.getLastModified(filePath);

          // Do not mutate project root from the active scene path.
          // FileSystemAPIService project directory must always remain the opened project root.
        }
      } catch (error) {
        // File handle retrieval failed, but we can still load the scene
        console.debug('[LoadSceneCommand] Could not get file handle for watching:', error);
      }

      const storedFileHandle = fileHandle ? ref(fileHandle) : null;

      if (!existing) {
        state.scenes.descriptors[activeId] = {
          id: activeId,
          filePath,
          name: sceneName,
          version: graph.version ?? '1.0.0',
          isDirty: false,
          lastSavedAt: null,
          fileHandle: storedFileHandle,
          lastModifiedTime,
        };
        state.scenes.activeSceneId = activeId;
      } else {
        state.scenes.descriptors[activeId] = {
          ...existing,
          filePath,
          name: sceneName,
          version: graph.version ?? existing.version,
          isDirty: false,
          fileHandle: storedFileHandle,
          lastModifiedTime,
        } as typeof existing;
        state.scenes.activeSceneId = activeId;
      }

      this.sceneManager.setActiveSceneGraph(activeId, graph);

      // Reloading into an already-open scene replaces its graph in place (the old
      // nodes are disposed by setActiveSceneGraph). The active-scene id is
      // unchanged, so OperationService's per-scene switch won't fire — clear this
      // scene's undo history explicitly so entries don't reference detached nodes.
      if (existing) {
        const operationService = context.container.getService<OperationService>(
          context.container.getOrCreateToken(OperationService)
        );
        operationService.clearHistory();
      }

      state.scenes.hierarchies[activeId] = {
        version: graph.version ?? null,
        description: graph.description ?? null,
        // Store Three.js nodes as non-proxied references to avoid DOM Illegal invocation errors
        rootNodes: ref(graph.rootNodes),
        metadata: graph.metadata ?? {},
      };
      state.scenes.loadState = 'ready';
      state.scenes.lastLoadedAt = Date.now();
      state.scenes.pendingScenePaths = state.scenes.pendingScenePaths.filter(
        (p: string) => p !== filePath
      );
      state.project.lastOpenedScenePath = filePath;

      return {
        didMutate: true,
        payload: this.payload,
      };
    } catch (error) {
      let message = 'Failed to load scene.';
      if (error instanceof SceneValidationError) {
        message = `${message} Validation issues: ${error.details.join('; ')}`;
      } else if (error instanceof Error) {
        message = `${message} ${error.message}`;
      }
      state.scenes.loadState = 'error';
      state.scenes.loadError = message;
      console.error('[LoadSceneCommand] Scene load failed:', error);
      throw error;
    }
  }

  private deriveSceneName(
    filePath: string,
    metadata: SceneGraph['metadata'] | Record<string, unknown>,
    existingName?: string | null
  ): string {
    const preserved = typeof existingName === 'string' ? existingName.trim() : '';
    if (preserved) return preserved;

    const metaName = this.extractMetadataName(metadata);
    if (metaName) return metaName;

    const normalizedPath = this.resources.normalize(filePath).replace(/\\+/g, '/');
    const segments = normalizedPath.split('/').filter(Boolean);
    const basename = segments.length ? segments[segments.length - 1] : normalizedPath;
    const withoutExtension = basename.replace(/\.[^./]+$/i, '');
    const words = withoutExtension
      .split(/[^a-z0-9]+/i)
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1));
    return words.length ? words.join(' ') : 'Scene';
  }

  private extractMetadataName(metadata: SceneGraph['metadata'] | Record<string, unknown>): string {
    const candidates = [
      (metadata as Record<string, unknown>)?.name,
      (metadata as Record<string, unknown>)?.title,
      (metadata as Record<string, unknown>)?.displayName,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string') {
        const trimmed = candidate.trim();
        if (trimmed) return trimmed;
      }
    }
    return '';
  }
}
