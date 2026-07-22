import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { ReorderAutoloadOperation, type ReorderAutoloadParams } from './ReorderAutoloadOperation';

export class ReorderAutoloadCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'project.reorder-autoload',
    title: 'Reorder Autoload',
    description: 'Change autoload initialization order',
    keywords: ['project', 'autoload', 'order'],
  };

  constructor(private readonly params: ReorderAutoloadParams) {
    super();
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (context.state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'Project must be opened to manage autoloads.',
        scope: 'project',
      };
    }
    if (this.params.fromIndex < 0 || this.params.toIndex < 0) {
      return {
        canExecute: false,
        reason: 'Indexes must be positive.',
        scope: 'project',
      };
    }
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const pushed = await operationService.invokeAndPush(
      new ReorderAutoloadOperation({
        fromIndex: this.params.fromIndex,
        toIndex: this.params.toIndex,
      })
    );
    return { didMutate: pushed, payload: undefined };
  }
}
