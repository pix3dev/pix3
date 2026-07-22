import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { LocalizationEditorService } from '@/services/localization/LocalizationEditorService';

export interface ExtractLocalizationKeysParams {
  /** Precomputed seed plan: keys to add as `""` placeholders per non-default locale. */
  plan: Record<string, string[]>;
}

/**
 * Template-fill half of key extraction (design §4.5): seed keys that exist in the
 * default locale but are missing from a target locale as `""` placeholders, so
 * translators opening the JSON see the complete key set. The plan is computed by
 * `ExtractLocalizationKeysCommand` (from the scan) so redo re-applies exactly the
 * same set. Undo removes the added placeholders, keeping any the author has since
 * filled in. Not a scene mutation — never marks a scene descriptor dirty.
 */
export class ExtractLocalizationKeysOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'localization.extract-keys',
    title: 'Extract Localization Keys',
    description: 'Seed missing translation keys into non-default locales',
    tags: ['localization', 'editor'],
  };

  constructor(private readonly params: ExtractLocalizationKeysParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const service = tryGetService(context, LocalizationEditorService);
    if (!service) return { didMutate: false };

    const seeded = await this.seed(service);
    if (Object.keys(seeded).length === 0) return { didMutate: false };

    return {
      didMutate: true,
      commit: {
        label: 'Extract Localization Keys',
        undo: async () => {
          for (const [locale, keys] of Object.entries(seeded)) {
            await service.unseedKeys(locale, keys);
          }
        },
        redo: async () => {
          await this.seed(service);
        },
      },
    };
  }

  /** Returns what was actually seeded (already-present keys skipped) per locale. */
  private async seed(service: LocalizationEditorService): Promise<Record<string, string[]>> {
    const seeded: Record<string, string[]> = {};
    for (const [locale, keys] of Object.entries(this.params.plan)) {
      const added = await service.seedMissingKeys(locale, keys);
      if (added.length > 0) seeded[locale] = added;
    }
    return seeded;
  }
}

function tryGetService<T>(context: OperationContext, token: new (...args: never[]) => T): T | null {
  try {
    return context.container.getService<T>(context.container.getOrCreateToken(token));
  } catch {
    return null;
  }
}
