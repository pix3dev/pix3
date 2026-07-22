import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import {
  RemoveNodeFromGroupOperation,
  type RemoveNodeFromGroupParams,
} from './RemoveNodeFromGroupOperation';
import { requireActiveScene } from './scene-command-utils';

export class RemoveNodeFromGroupCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.remove-node-from-group',
    title: 'Remove Node From Group',
    description: 'Remove the selected node from a group',
    keywords: ['scene', 'group'],
  };

  constructor(private readonly params: RemoveNodeFromGroupParams) {
    super();
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    const activeSceneCheck = requireActiveScene(
      context,
      'An active scene is required to edit groups'
    );
    if (!activeSceneCheck.canExecute) {
      return activeSceneCheck;
    }
    if (!this.params.group.trim()) {
      return {
        canExecute: false,
        reason: 'Group name is required.',
        scope: 'scene',
      };
    }
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const operation = new RemoveNodeFromGroupOperation({
      nodeId: this.params.nodeId,
      group: this.params.group.trim(),
    });
    const pushed = await operationService.invokeAndPush(operation);
    return { didMutate: pushed, payload: undefined };
  }
}
