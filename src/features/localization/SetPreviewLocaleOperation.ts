import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { LocalizationEditorService } from '@/services/localization/LocalizationEditorService';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';

export interface SetPreviewLocaleParams {
  locale: string;
}

/**
 * Switch the editor's preview locale. This is an editor-view setting, NOT a
 * scene mutation — it never marks any scene descriptor dirty (it only re-feeds
 * the preview localization instance and repaints label proxies). It IS pushed to
 * history so the switch is undoable, following the `UpdateEditorSettingsOperation`
 * precedent (undoable UI state).
 */
export class SetPreviewLocaleOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'localization.set-preview-locale',
    title: 'Set Preview Locale',
    description: 'Change the editor preview locale',
    tags: ['localization', 'editor'],
    coalesceKey: 'localization.set-preview-locale',
  };

  constructor(private readonly params: SetPreviewLocaleParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const service = tryGetService(context, LocalizationEditorService);
    if (!service || !service.isActive()) {
      return { didMutate: false };
    }

    const next = this.params.locale;
    const prev = service.getPreviewLocale();
    if (next === prev || !service.getLocales().includes(next)) {
      return { didMutate: false };
    }

    const viewport = tryGetService(context, ViewportRendererService);
    const apply = async (locale: string): Promise<void> => {
      await service.setPreviewLocale(locale);
      viewport?.refreshLocalizedLabels();
    };

    await apply(next);

    return {
      didMutate: true,
      commit: {
        label: 'Set Preview Locale',
        undo: () => apply(prev),
        redo: () => apply(next),
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
