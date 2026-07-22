import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import {
  DeleteObjectOperation,
  type DeleteObjectOperationParams,
} from '@/features/scene/DeleteObjectOperation';

export class DeleteObjectCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.delete-object',
    title: 'Delete Object',
    description: 'Delete one or more nodes from the scene',
    keywords: ['delete', 'remove', 'erase', 'destroy'],
    menuPath: 'edit',
    keybinding: 'Delete | Backspace',
    when: '!isInputFocused && (viewportFocused || sceneTreeFocused)',
    addToMenu: true,
    menuOrder: 5,
  };

  private readonly params?: DeleteObjectOperationParams;

  constructor(params?: DeleteObjectOperationParams) {
    super();
    this.params = params;
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    const { state } = context;
    const activeSceneId = state.scenes.activeSceneId;

    if (!activeSceneId) {
      return {
        canExecute: false,
        reason: 'An active scene is required to delete objects',
        scope: 'scene',
      };
    }

    const nodeIds = this.params?.nodeIds ?? state.selection.nodeIds;
    if (nodeIds.length === 0) {
      return {
        canExecute: false,
        reason: 'At least one node must be selected to delete',
        scope: 'selection',
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );

    const nodeIds = this.params?.nodeIds ?? context.state.selection.nodeIds;
    const op = new DeleteObjectOperation({ nodeIds });
    const pushed = await operationService.invokeAndPush(op);

    return { didMutate: pushed, payload: undefined };
  }
}
