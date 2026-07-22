import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { SceneManager } from '@pix3/runtime';
import {
  SaveSceneOperation,
  type SaveSceneOperationParams,
} from '@/features/scene/SaveSceneOperation';

export class SaveSceneCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.save',
    title: 'Save',
    description: 'Save the active scene to its current file',
    keywords: ['save', 'scene'],
    menuPath: 'file',
    keybinding: 'Mod+S',
    when: '!isInputFocused',
    addToMenu: true,
    menuOrder: 10,
  };

  private readonly params?: SaveSceneOperationParams;

  constructor(params?: SaveSceneOperationParams) {
    super();
    this.params = params;
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    const { state } = context;

    if (state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'Project must be opened before saving scenes',
        scope: 'project',
        recoverable: true,
      };
    }

    if (state.project.backend === 'cloud') {
      return {
        canExecute: false,
        reason: 'Cloud collaboration scenes are synchronized automatically.',
        scope: 'scene',
        recoverable: true,
      };
    }

    const sceneId = this.params?.sceneId ?? state.scenes.activeSceneId;
    if (!sceneId) {
      return {
        canExecute: false,
        reason: 'An active scene is required to save',
        scope: 'scene',
      };
    }

    const descriptor = state.scenes.descriptors[sceneId];
    if (!descriptor) {
      return {
        canExecute: false,
        reason: 'Active scene descriptor not found',
        scope: 'scene',
      };
    }

    if (!descriptor.filePath?.startsWith('res://')) {
      return {
        canExecute: false,
        reason: 'Scene must be saved within the project. Use Save As.',
        scope: 'scene',
        recoverable: true,
      };
    }

    const sceneManager = context.container.getService<SceneManager>(
      context.container.getOrCreateToken(SceneManager)
    );
    const graph = sceneManager.getSceneGraph(sceneId);
    if (!graph) {
      return {
        canExecute: false,
        reason: 'An active scene graph is required to save',
        scope: 'scene',
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );

    const op = new SaveSceneOperation({
      sceneId: this.params?.sceneId,
    });

    const pushed = await operationService.invokeAndPush(op);
    return { didMutate: pushed, payload: undefined };
  }
}
