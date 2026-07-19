import type { ResourceManager } from '../ResourceManager';
import type { LocaleTable, LocalizationConfig, TrParams } from './localization-types';

const DEFAULT_TABLE_TEMPLATE = 'res://locales/{locale}.json';

/** Replace `{token}` placeholders from `params`; unknown tokens are left as-is. */
function interpolate(text: string, params: TrParams): string {
  return text.replace(/\{(\w+)\}/g, (match, token: string) =>
    token in params ? String(params[token]) : match
  );
}

function toRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function normalizeTable(input: {
  locale: string;
  strings?: unknown;
  sprites?: unknown;
  meta?: LocaleTable['meta'];
}): LocaleTable {
  return {
    locale: input.locale,
    strings: toRecord(input.strings),
    sprites: toRecord(input.sprites),
    meta: input.meta,
  };
}

/**
 * Runtime i18n/l10n service. Adapts Godot's TranslationServer/`tr()` model to Pix3: per-locale JSON
 * tables loaded through {@link ResourceManager} (so exported/embedded builds work unchanged), a
 * current locale with a fallback chain that never throws, and change listeners so live UI re-renders
 * on a locale switch. Plain class (no editor DI) so it stays part of the editor-agnostic runtime.
 */
export class LocalizationService {
  private config: LocalizationConfig = { defaultLocale: 'en' };
  private resources: ResourceManager | null = null;
  private readonly tables = new Map<string, LocaleTable>();
  private currentLocale = 'en';
  private readonly listeners = new Set<() => void>();

  configure(config: LocalizationConfig): void {
    this.config = { ...config };
    this.currentLocale = config.defaultLocale;
  }

  /** Provide the loader source for lazy locale-file reads (null = tables must be injected). */
  attachResources(resources: ResourceManager | null): void {
    this.resources = resources;
  }

  get locale(): string {
    return this.currentLocale;
  }

  get locales(): readonly string[] {
    return this.config.locales ?? [...this.tables.keys()];
  }

  get fallbackLocale(): string {
    return this.config.fallbackLocale ?? this.config.defaultLocale;
  }

  /** Switch locale, loading its table on first use. Always notifies listeners. */
  async setLocale(locale: string): Promise<void> {
    if (!this.tables.has(locale) && this.resources) {
      await this.loadTable(locale);
    }
    this.currentLocale = locale;
    this.notify();
  }

  /** Inject a table directly (editor live-edit / tests). Notifies listeners. */
  setTable(table: LocaleTable): void {
    this.tables.set(table.locale, normalizeTable(table));
    this.notify();
  }

  private async loadTable(locale: string): Promise<void> {
    if (!this.resources) return;
    const path = (this.config.tablePathTemplate ?? DEFAULT_TABLE_TEMPLATE).replace(
      '{locale}',
      locale
    );
    try {
      const text = await this.resources.readText(path);
      const parsed = JSON.parse(text) as {
        strings?: unknown;
        sprites?: unknown;
        $meta?: LocaleTable['meta'];
        meta?: LocaleTable['meta'];
      };
      this.tables.set(
        locale,
        normalizeTable({
          locale,
          strings: parsed.strings,
          sprites: parsed.sprites,
          meta: parsed.$meta ?? parsed.meta,
        })
      );
    } catch (error) {
      console.warn(`[Localization] Failed to load locale "${locale}" from ${path}`, error);
      // Keep an empty table so the fallback chain still renders (key or fallback locale).
      this.tables.set(locale, { locale, strings: {}, sprites: {} });
    }
  }

  /** Translate `key`. Falls through current → fallback → the key itself; never throws. */
  tr(key: string, params?: TrParams): string {
    if (!key) return '';
    const raw = this.lookupString(key) ?? key;
    return params ? interpolate(raw, params) : raw;
  }

  private lookupString(key: string): string | undefined {
    const current = this.tables.get(this.currentLocale)?.strings[key];
    if (current !== undefined) return current;
    return this.tables.get(this.fallbackLocale)?.strings[key];
  }

  /**
   * Translate a count-dependent string via convention-based suffix keys:
   * `key.one` / `key.few` / `key.many` / `key.other` (whichever the table
   * provides), selected with `Intl.PluralRules(locale)`. Falls back to
   * `key.other`, then the bare `key`, then the key text itself — never throws.
   * `{count}` is always available as an interpolation token.
   */
  trPlural(key: string, count: number, params?: TrParams): string {
    const merged: TrParams = { count, ...params };
    const category = this.pluralCategory(count);
    if (this.has(`${key}.${category}`)) return this.tr(`${key}.${category}`, merged);
    if (this.has(`${key}.other`)) return this.tr(`${key}.other`, merged);
    return this.tr(key, merged);
  }

  private pluralRulesCache = new Map<string, Intl.PluralRules | null>();

  private pluralCategory(count: number): Intl.LDMLPluralRule {
    let rules = this.pluralRulesCache.get(this.currentLocale);
    if (rules === undefined) {
      try {
        rules = new Intl.PluralRules(this.currentLocale);
      } catch {
        rules = null; // unknown/invalid locale id — fall back to 'other'
      }
      this.pluralRulesCache.set(this.currentLocale, rules);
    }
    return rules ? rules.select(count) : 'other';
  }

  /** Resolve a localized sprite path, or null (caller keeps the node's authored texture). */
  trSprite(key: string): string | null {
    if (!key) return null;
    const current = this.tables.get(this.currentLocale)?.sprites[key];
    if (current !== undefined) return current;
    return this.tables.get(this.fallbackLocale)?.sprites[key] ?? null;
  }

  /** Whether `key` resolves in the current-or-fallback chain (vs. echoing the key). */
  has(key: string): boolean {
    return this.lookupString(key) !== undefined;
  }

  /** Subscribe to locale switches / table edits. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[Localization] onChange listener threw', error);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
    this.tables.clear();
    this.resources = null;
  }
}
