import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { RemoveAutoloadOperation, type RemoveAutoloadParams } from './RemoveAutoloadOperation';

export class RemoveAutoloadCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'project.remove-autoload',
    title: 'Remove Autoload',
    description: 'Remove an autoload singleton script',
    keywords: ['project', 'autoload', 'singleton'],
  };

  constructor(private readonly params: RemoveAutoloadParams) {
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
    if (!this.params.singleton.trim()) {
      return {
        canExecute: false,
        reason: 'Singleton name is required.',
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
      new RemoveAutoloadOperation({
        singleton: this.params.singleton.trim(),
      })
    );
    return { didMutate: pushed, payload: undefined };
  }
}
