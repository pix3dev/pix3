import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { LocalizationEditorService } from '@/services/LocalizationEditorService';
import { ViewportRendererService } from '@/services/ViewportRenderService';

export interface UpdateLocaleEntryParams {
  locale: string;
  key: string;
  value: string;
}

/**
 * Set (or clear, when `value` is empty) a single translation in a locale table.
 * Write-through: the locale JSON is persisted immediately and the preview
 * instance re-fed, so a viewport preview of that locale updates live. Undoable,
 * but not a scene mutation — it edits a project-level `locales/*.json` file, so
 * it never marks a scene descriptor dirty.
 */
export class UpdateLocaleEntryOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'localization.update-entry',
    title: 'Update Translation',
    description: 'Set or clear a translation for a locale key',
    tags: ['localization', 'editor'],
  };

  constructor(private readonly params: UpdateLocaleEntryParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const service = tryGetService(context, LocalizationEditorService);
    if (!service) return { didMutate: false };

    const { locale, key } = this.params;
    if (!locale || !key) return { didMutate: false };

    const next = this.params.value;
    const prev = service.getEntry(locale, key);
    if (next === prev) return { didMutate: false };

    const viewport = tryGetService(context, ViewportRendererService);
    const apply = async (value: string): Promise<void> => {
      await service.setEntry(locale, key, value);
      // Only the previewed locale affects the viewport, but refreshing is cheap
      // and correct regardless of which locale was edited.
      viewport?.refreshLocalizedLabels();
    };

    await apply(next);

    return {
      didMutate: true,
      commit: {
        label: 'Update Translation',
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
