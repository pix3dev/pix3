import type { LocalizationService } from './LocalizationService';
import type { TrParams } from './localization-types';
export declare function setActiveLocalization(service: LocalizationService | null): void;
export declare function getActiveLocalization(): LocalizationService | null;
/**
 * Resolve a translation key through the active service, returning `fallbackLiteral` when no service
 * is active or the key is empty. This is the single call text-bearing nodes make.
 */
export declare function resolveLocalizedText(key: string, fallbackLiteral: string, params?: TrParams): string;
