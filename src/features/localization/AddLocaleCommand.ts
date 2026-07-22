import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { AddLocaleOperation } from './AddLocaleOperation';

export interface AddLocaleCommandParams {
  locale: string;
}

/** Declare a new project locale and create its (empty) table file. Undoable. */
export class AddLocaleCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'localization.add-locale',
    title: 'Add Locale',
    description: 'Declare a new project locale',
    keywords: ['localization', 'locale', 'language', 'i18n', 'add'],
    addToMenu: false,
  };

  constructor(private readonly params: AddLocaleCommandParams) {
    super();
  }

  preconditions(_context: CommandContext): CommandPreconditionResult {
    if (!this.params.locale.trim()) {
      return { canExecute: false, reason: 'A locale id is required' };
    }
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const pushed = await operationService.invokeAndPush(
      new AddLocaleOperation({ locale: this.params.locale.trim() })
    );
    return { didMutate: pushed, payload: undefined };
  }
}
