import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import {
  ToggleAutoloadEnabledOperation,
  type ToggleAutoloadEnabledParams,
} from './ToggleAutoloadEnabledOperation';

export class ToggleAutoloadEnabledCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'project.toggle-autoload-enabled',
    title: 'Toggle Autoload Enabled',
    description: 'Enable or disable an autoload singleton script',
    keywords: ['project', 'autoload', 'singleton'],
  };

  constructor(private readonly params: ToggleAutoloadEnabledParams) {
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
      new ToggleAutoloadEnabledOperation({
        singleton: this.params.singleton.trim(),
        enabled: this.params.enabled,
      })
    );
    return { didMutate: pushed, payload: undefined };
  }
}
