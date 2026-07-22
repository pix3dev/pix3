import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { FileSystemAPIService } from '@/services/project/FileSystemAPIService';
import { SaveAsPrefabOperation } from '@/features/scene/SaveAsPrefabOperation';
import { SceneManager } from '@pix3/runtime';

export interface SaveAsPrefabCommandParams {
  nodeId?: string;
  prefabPath?: string;
}

export class SaveAsPrefabCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.save-as-prefab',
    title: 'Save Branch as Prefab',
    description: 'Save selected node branch as prefab and replace it with instance',
    keywords: ['prefab', 'save', 'branch', 'instance'],
    menuPath: 'file',
    addToMenu: true,
  };

  private readonly params?: SaveAsPrefabCommandParams;

  constructor(params?: SaveAsPrefabCommandParams) {
    super();
    this.params = params;
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (context.state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'Project must be opened before saving prefabs',
        scope: 'project',
        recoverable: true,
      };
    }

    const sceneManager = context.container.getService<SceneManager>(
      context.container.getOrCreateToken(SceneManager)
    );
    if (!sceneManager.getActiveSceneGraph()) {
      return {
        canExecute: false,
        reason: 'An active scene is required to save a prefab',
        scope: 'scene',
      };
    }

    const nodeId = this.params?.nodeId ?? context.state.selection.primaryNodeId;
    if (!nodeId) {
      return {
        canExecute: false,
        reason: 'Select a node to save as prefab',
        scope: 'selection',
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const nodeId = this.params?.nodeId ?? context.state.selection.primaryNodeId;
    if (!nodeId) {
      return { didMutate: false, payload: undefined };
    }

    const sceneManager = context.container.getService<SceneManager>(
      context.container.getOrCreateToken(SceneManager)
    );
    const fileSystem = context.container.getService<FileSystemAPIService>(
      context.container.getOrCreateToken(FileSystemAPIService)
    );
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );

    const sceneGraph = sceneManager.getActiveSceneGraph();
    const nodeNameFromScene = sceneGraph?.nodeMap.get(nodeId)?.name ?? null;
    const prefabPath =
      this.params?.prefabPath ?? (await this.pickPrefabPath(fileSystem, nodeId, nodeNameFromScene));
    if (!prefabPath) {
      return { didMutate: false, payload: undefined };
    }

    const pushed = await operationService.invokeAndPush(
      new SaveAsPrefabOperation({
        nodeId,
        prefabPath,
      })
    );

    return { didMutate: pushed, payload: undefined };
  }

  private async pickPrefabPath(
    fileSystem: FileSystemAPIService,
    nodeId: string,
    nodeName: string | null
  ): Promise<string | null> {
    type ShowSaveFilePickerFn = (opts?: unknown) => Promise<FileSystemFileHandle>;
    type WindowWithSave = { showSaveFilePicker?: ShowSaveFilePickerFn };
    const w = window as unknown as WindowWithSave;

    if (!w.showSaveFilePicker) {
      const fallbackBaseName = this.toSceneFileBaseName(nodeName, nodeId);
      return `res://prefabs/${fallbackBaseName}.pix3scene`;
    }

    try {
      const suggestedBaseName = this.toSceneFileBaseName(nodeName, nodeId);
      const handle = await w.showSaveFilePicker({
        suggestedName: `${suggestedBaseName}.pix3scene`,
        types: [
          {
            description: 'Pix3 Scene Files',
            accept: { 'application/yaml': ['.pix3scene'] },
          },
        ],
      });

      const inProject = await fileSystem.isHandleInProject(handle);
      if (!inProject) {
        console.warn('[SaveAsPrefabCommand] Prefab path must be inside the project directory.');
        return null;
      }

      return await fileSystem.resolveHandleToResourcePath(handle);
    } catch (error) {
      if (error instanceof Error && error.name !== 'AbortError') {
        console.error('[SaveAsPrefabCommand] Failed to select prefab path', error);
      }
      return null;
    }
  }

  private toSceneFileBaseName(nodeName: string | null, fallbackId: string): string {
    const source = (nodeName && nodeName.trim().length > 0 ? nodeName : fallbackId).trim();
    const withoutExtension = source.replace(/\.pix3scene$/i, '');
    const sanitized = withoutExtension
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
      .replace(/\s+/g, '_')
      .replace(/-+/g, '-')
      .replace(/_+/g, '_')
      .replace(/^[-_.]+|[-_.]+$/g, '');

    return sanitized || 'prefab';
  }
}
