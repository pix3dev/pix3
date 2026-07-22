import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { LocalizationEditorService } from '@/services/localization/LocalizationEditorService';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';

export interface AddLocaleParams {
  locale: string;
}

/**
 * Declare a new locale and write its (empty) `locales/<locale>.json` file. Not a
 * scene mutation — it edits project-level localization files, so it never marks a
 * scene descriptor dirty. Undo removes the created locale (file + declaration).
 */
export class AddLocaleOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'localization.add-locale',
    title: 'Add Locale',
    description: 'Declare a new project locale',
    tags: ['localization', 'editor'],
  };

  constructor(private readonly params: AddLocaleParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const service = tryGetService(context, LocalizationEditorService);
    if (!service) return { didMutate: false };

    const locale = this.params.locale.trim();
    if (!locale || service.getLocales().includes(locale)) return { didMutate: false };

    const viewport = tryGetService(context, ViewportRendererService);
    await service.addLocale(locale);
    viewport?.refreshLocalizedLabels();

    return {
      didMutate: true,
      commit: {
        label: 'Add Locale',
        undo: async () => {
          await service.removeLocale(locale);
          viewport?.refreshLocalizedLabels();
        },
        redo: async () => {
          await service.addLocale(locale);
          viewport?.refreshLocalizedLabels();
        },
      },
    };
  }
}

function tryGetService<T>(context: OperationContext, token: new (...args: never[]) => T): T | null {
  try {
    return context.container.getService<T>(context.container.getOrCreateToken(token));
  } catch {
    return null;
  }
}
