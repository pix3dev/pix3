import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import type { LocaleTableSection } from '@/services/localization/LocalizationEditorService';
import { RemoveLocalizationKeyOperation } from './RemoveLocalizationKeyOperation';

export interface RemoveLocalizationKeyCommandParams {
  key: string;
  /** Table section the key lives in (default `'strings'`; `'sprites'` = localized texture paths). */
  section?: LocaleTableSection;
}

/** Remove a translation key from every locale table. Undoable. */
export class RemoveLocalizationKeyCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'localization.remove-key',
    title: 'Remove Translation Key',
    description: 'Remove a key from all locale tables',
    keywords: ['localization', 'locale', 'translation', 'i18n', 'remove', 'delete', 'key'],
    addToMenu: false,
  };

  constructor(private readonly params: RemoveLocalizationKeyCommandParams) {
    super();
  }

  preconditions(_context: CommandContext): CommandPreconditionResult {
    if (!this.params.key) {
      return { canExecute: false, reason: 'A key is required' };
    }
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const pushed = await operationService.invokeAndPush(
      new RemoveLocalizationKeyOperation({ key: this.params.key, section: this.params.section })
    );
    return { didMutate: pushed, payload: undefined };
  }
}
