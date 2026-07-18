/** Configuration for the {@link LocalizationService} (injected by the editor/exported bootstrap). */
export interface LocalizationConfig {
  /** Locale used at boot and as the template/complete locale. */
  defaultLocale: string;
  /** Final string fallback when a key is missing in the current locale. Defaults to defaultLocale. */
  fallbackLocale?: string;
  /** Declared locale ids (informational — drives editor panel + export). */
  locales?: readonly string[];
  /** Where locale tables load from. `{locale}` is substituted. Default `res://locales/{locale}.json`. */
  tablePathTemplate?: string;
}

/** A single locale's translation table. */
export interface LocaleTable {
  locale: string;
  /** Translation key → localized string. */
  strings: Record<string, string>;
  /** Sprite key → localized `res://` texture path. */
  sprites: Record<string, string>;
  meta?: { name?: string; direction?: 'ltr' | 'rtl' };
}

/** Interpolation parameters for `tr(key, params)` — `{name}` tokens are replaced. */
export type TrParams = Record<string, string | number>;
