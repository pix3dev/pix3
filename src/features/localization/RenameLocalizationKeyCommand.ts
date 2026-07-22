import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import {
  LocalizationEditorService,
  type LocaleTableSection,
} from '@/services/localization/LocalizationEditorService';
import { RenameLocalizationKeyOperation } from './RenameLocalizationKeyOperation';

export interface RenameLocalizationKeyCommandParams {
  oldKey: string;
  newKey: string;
  /** Table section the key lives in (default `'strings'`; `'sprites'` = localized texture paths). */
  section?: LocaleTableSection;
}

/**
 * Rename a translation key across all locale tables and rewrite `labelKey` /
 * `textureKey`-family references in open scenes. Undoable as one step.
 */
export class RenameLocalizationKeyCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'localization.rename-key',
    title: 'Rename Translation Key',
    description: 'Rename a key across all locale tables and open scenes',
    keywords: ['localization', 'locale', 'translation', 'i18n', 'rename', 'key'],
    addToMenu: false,
  };

  constructor(private readonly params: RenameLocalizationKeyCommandParams) {
    super();
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    const { oldKey, newKey } = this.params;
    if (!oldKey || !newKey) {
      return { canExecute: false, reason: 'Both the old and the new key are required' };
    }
    if (oldKey === newKey) {
      return { canExecute: false, reason: 'The new key equals the old key' };
    }
    const localization = context.container.getService<LocalizationEditorService>(
      context.container.getOrCreateToken(LocalizationEditorService)
    );
    const section = this.params.section ?? 'strings';
    const conflict = localization
      .getLocales()
      .some(locale => localization.hasEntry(locale, newKey, section));
    if (conflict) {
      return { canExecute: false, reason: `Key "${newKey}" already exists` };
    }
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const pushed = await operationService.invokeAndPush(
      new RenameLocalizationKeyOperation({
        oldKey: this.params.oldKey,
        newKey: this.params.newKey,
        section: this.params.section,
      })
    );
    return { didMutate: pushed, payload: undefined };
  }
}
