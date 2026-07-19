import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/OperationService';
import { LocalizationEditorService } from '@/services/LocalizationEditorService';
import { LocalizationExtractionService } from '@/services/LocalizationExtractionService';
import { ExtractLocalizationKeysOperation } from './ExtractLocalizationKeysOperation';

/**
 * Project-wide localization extraction (the POT analog, design §4.5). Scans every
 * `.pix3scene` for label literals without a `labelKey` and project scripts for
 * `tr()`-family string-literal keys missing from the default table (the report
 * lands in the Localization panel), then seeds keys present in the default locale
 * but missing from other locales as `""` placeholders (undoable). The scan itself
 * is read-only; only the seeding goes through history.
 */
export class ExtractLocalizationKeysCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'localization.extract-keys',
    title: 'Extract Localization Keys',
    description: 'Scan scenes and scripts for unlocalized text and fill locale templates',
    keywords: ['localization', 'locale', 'translation', 'i18n', 'extract', 'scan', 'keys'],
    addToMenu: false,
  };

  preconditions(context: CommandContext): CommandPreconditionResult {
    const localization = context.container.getService<LocalizationEditorService>(
      context.container.getOrCreateToken(LocalizationEditorService)
    );
    if (!localization.isActive()) {
      return { canExecute: false, reason: 'The project has no locales yet' };
    }
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const container = context.container;
    const extraction = container.getService<LocalizationExtractionService>(
      container.getOrCreateToken(LocalizationExtractionService)
    );
    const localization = container.getService<LocalizationEditorService>(
      container.getOrCreateToken(LocalizationEditorService)
    );
    const operationService = container.getService<OperationService>(
      container.getOrCreateToken(OperationService)
    );

    await extraction.scan();

    // Seed plan: every default-locale key absent from each non-default locale.
    // Computed here (not in the operation) so redo re-applies the exact set.
    const defaultLocale = localization.getDefaultLocale();
    const defaultKeys = localization
      .getAllKeys('strings')
      .filter(key => localization.hasEntry(defaultLocale, key, 'strings'));
    const plan: Record<string, string[]> = {};
    for (const locale of localization.getLocales()) {
      if (locale === defaultLocale) continue;
      const missing = defaultKeys.filter(key => !localization.hasEntry(locale, key, 'strings'));
      if (missing.length > 0) plan[locale] = missing;
    }

    let didMutate = false;
    if (Object.keys(plan).length > 0) {
      didMutate = await operationService.invokeAndPush(
        new ExtractLocalizationKeysOperation({ plan })
      );
      if (didMutate) extraction.setSeededKeys(plan);
    }

    return { didMutate, payload: undefined };
  }
}
