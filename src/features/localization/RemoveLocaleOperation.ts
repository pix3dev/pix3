import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { LocalizationEditorService } from '@/services/localization/LocalizationEditorService';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';

export interface RemoveLocaleParams {
  locale: string;
}

/**
 * Remove a declared locale: drop its table, its declaration, and delete the
 * `locales/<locale>.json` file. The default locale (the template) cannot be
 * removed. Undo restores the full table content + declaration. Not a scene
 * mutation — never marks a scene descriptor dirty.
 */
export class RemoveLocaleOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'localization.remove-locale',
    title: 'Remove Locale',
    description: 'Remove a project locale and its table file',
    tags: ['localization', 'editor'],
  };

  constructor(private readonly params: RemoveLocaleParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const service = tryGetService(context, LocalizationEditorService);
    if (!service) return { didMutate: false };

    const viewport = tryGetService(context, ViewportRendererService);
    const removed = await service.removeLocale(this.params.locale);
    if (!removed) return { didMutate: false };
    viewport?.refreshLocalizedLabels();

    return {
      didMutate: true,
      commit: {
        label: 'Remove Locale',
        undo: async () => {
          await service.restoreLocale(removed);
          viewport?.refreshLocalizedLabels();
        },
        redo: async () => {
          await service.removeLocale(this.params.locale);
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
