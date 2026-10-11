import type { ResourceManager } from '../ResourceManager';
import type { LocaleTable, LocalizationConfig, TrParams } from './localization-types';
/**
 * Runtime i18n/l10n service. Adapts Godot's TranslationServer/`tr()` model to Pix3: per-locale JSON
 * tables loaded through {@link ResourceManager} (so exported/embedded builds work unchanged), a
 * current locale with a fallback chain that never throws, and change listeners so live UI re-renders
 * on a locale switch. Plain class (no editor DI) so it stays part of the editor-agnostic runtime.
 */
export declare class LocalizationService {
    private config;
    private resources;
    private readonly tables;
    private currentLocale;
    private readonly listeners;
    configure(config: LocalizationConfig): void;
    /** Provide the loader source for lazy locale-file reads (null = tables must be injected). */
    attachResources(resources: ResourceManager | null): void;
    get locale(): string;
    get locales(): readonly string[];
    get fallbackLocale(): string;
    /** Switch locale, loading its table on first use. Always notifies listeners. */
    setLocale(locale: string): Promise<void>;
    /** Inject a table directly (editor live-edit / tests). Notifies listeners. */
    setTable(table: LocaleTable): void;
    private loadTable;
    /** Translate `key`. Falls through current → fallback → the key itself; never throws. */
    tr(key: string, params?: TrParams): string;
    /** Empty entries count as untranslated (Godot semantics) — they are template
     *  placeholders seeded by extraction, so the chain falls through them. */
    private lookupString;
    /**
     * Translate a count-dependent string via convention-based suffix keys:
     * `key.one` / `key.few` / `key.many` / `key.other` (whichever the table
     * provides), selected with `Intl.PluralRules(locale)`. Falls back to
     * `key.other`, then the bare `key`, then the key text itself — never throws.
     * `{count}` is always available as an interpolation token.
     */
    trPlural(key: string, count: number, params?: TrParams): string;
    private pluralRulesCache;
    private pluralCategory;
    /** Resolve a localized sprite path, or null (caller keeps the node's authored texture). */
    trSprite(key: string): string | null;
    /** Whether `key` resolves in the current-or-fallback chain (vs. echoing the key). */
    has(key: string): boolean;
    /** Subscribe to locale switches / table edits. Returns an unsubscribe function. */
    onChange(listener: () => void): () => void;
    private notify;
    dispose(): void;
}
