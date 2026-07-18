import type { LocalizationService } from './LocalizationService';
import type { TrParams } from './localization-types';

/**
 * Module-global "active localization" pointer, stored on a globalThis sink so both the runtime nodes
 * and the editor viewport resolve localized text without threading a service instance through every
 * node — the same pattern as `project-texture-filtering.ts`. The editor sets a preview instance; the
 * SceneRunner swaps in the play-mode instance on start and restores it on stop.
 */
const ACTIVE_LOCALIZATION_KEY = '__PIX3_ACTIVE_LOCALIZATION__';

export function setActiveLocalization(service: LocalizationService | null): void {
  (globalThis as Record<string, unknown>)[ACTIVE_LOCALIZATION_KEY] = service ?? undefined;
}

export function getActiveLocalization(): LocalizationService | null {
  return (
    ((globalThis as Record<string, unknown>)[ACTIVE_LOCALIZATION_KEY] as
      | LocalizationService
      | undefined) ?? null
  );
}

/**
 * Resolve a translation key through the active service, returning `fallbackLiteral` when no service
 * is active or the key is empty. This is the single call text-bearing nodes make.
 */
export function resolveLocalizedText(
  key: string,
  fallbackLiteral: string,
  params?: TrParams
): string {
  if (!key) return fallbackLiteral;
  const service = getActiveLocalization();
  return service ? service.tr(key, params) : fallbackLiteral;
}
