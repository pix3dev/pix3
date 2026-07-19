import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import {
  LocalizationEditorService,
  type LocaleTableSection,
} from '@/services/LocalizationEditorService';
import { ViewportRendererService } from '@/services/ViewportRenderService';

export interface RemoveLocalizationKeyParams {
  key: string;
  /** Table section the key lives in (default `'strings'`; `'sprites'` = localized texture paths). */
  section?: LocaleTableSection;
}

/**
 * Remove a translation key from every locale table. Undo re-inserts the removed
 * values in all locales that had them. Not a scene mutation — never marks a scene
 * descriptor dirty. (Nodes referencing the removed key via `labelKey` keep the
 * key; `tr()` then falls back to the literal / echoes the key, per the never-throw
 * fallback chain.)
 */
export class RemoveLocalizationKeyOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'localization.remove-key',
    title: 'Remove Translation Key',
    description: 'Remove a key from all locale tables',
    tags: ['localization', 'editor'],
  };

  constructor(private readonly params: RemoveLocalizationKeyParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const service = tryGetService(context, LocalizationEditorService);
    if (!service) return { didMutate: false };

    const key = this.params.key;
    if (!key) return { didMutate: false };

    const section = this.params.section ?? 'strings';
    const viewport = tryGetService(context, ViewportRendererService);
    const removed = await service.removeKey(key, section);
    if (Object.keys(removed).length === 0) return { didMutate: false };
    viewport?.refreshLocalizedLabels();

    return {
      didMutate: true,
      commit: {
        label: 'Remove Translation Key',
        undo: async () => {
          await service.restoreKey(key, removed, section);
          viewport?.refreshLocalizedLabels();
        },
        redo: async () => {
          await service.removeKey(key, section);
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
