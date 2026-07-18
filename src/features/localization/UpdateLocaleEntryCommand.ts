import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/OperationService';
import { UpdateLocaleEntryOperation } from './UpdateLocaleEntryOperation';

export interface UpdateLocaleEntryCommandParams {
  locale: string;
  key: string;
  value: string;
}

/** Set or clear a single translation (locale × key). Persists + refreshes preview. */
export class UpdateLocaleEntryCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'localization.update-entry',
    title: 'Update Translation',
    description: 'Set or clear a translation for a locale key',
    keywords: ['localization', 'locale', 'translation', 'i18n', 'string'],
    addToMenu: false,
  };

  constructor(private readonly params: UpdateLocaleEntryCommandParams) {
    super();
  }

  preconditions(_context: CommandContext): CommandPreconditionResult {
    if (!this.params.locale || !this.params.key) {
      return { canExecute: false, reason: 'A locale and key are required' };
    }
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const pushed = await operationService.invokeAndPush(
      new UpdateLocaleEntryOperation({
        locale: this.params.locale,
        key: this.params.key,
        value: this.params.value,
      })
    );
    return { didMutate: pushed, payload: undefined };
  }
}
