import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { AddNodeToGroupOperation, type AddNodeToGroupParams } from './AddNodeToGroupOperation';
import { requireActiveScene } from './scene-command-utils';

const GROUP_NAME_REGEX = /^[A-Za-z0-9_]+$/;

export class AddNodeToGroupCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.add-node-to-group',
    title: 'Add Node To Group',
    description: 'Add the selected node to a group',
    keywords: ['scene', 'group'],
  };

  constructor(private readonly params: AddNodeToGroupParams) {
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

    const trimmed = this.params.group.trim();
    if (!trimmed || !GROUP_NAME_REGEX.test(trimmed)) {
      return {
        canExecute: false,
        reason: 'Group names must contain only letters, numbers, and underscores.',
        scope: 'scene',
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const operation = new AddNodeToGroupOperation({
      nodeId: this.params.nodeId,
      group: this.params.group.trim(),
    });
    const pushed = await operationService.invokeAndPush(operation);
    return { didMutate: pushed, payload: undefined };
  }
}
