import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { RemoveLocaleOperation } from './RemoveLocaleOperation';

export interface RemoveLocaleCommandParams {
  locale: string;
}

/** Remove a project locale (and delete its table file). Undoable. */
export class RemoveLocaleCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'localization.remove-locale',
    title: 'Remove Locale',
    description: 'Remove a project locale and its table file',
    keywords: ['localization', 'locale', 'language', 'i18n', 'remove', 'delete'],
    addToMenu: false,
  };

  constructor(private readonly params: RemoveLocaleCommandParams) {
    super();
  }

  preconditions(_context: CommandContext): CommandPreconditionResult {
    if (!this.params.locale) {
      return { canExecute: false, reason: 'A locale id is required' };
    }
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const pushed = await operationService.invokeAndPush(
      new RemoveLocaleOperation({ locale: this.params.locale })
    );
    return { didMutate: pushed, payload: undefined };
  }
}
