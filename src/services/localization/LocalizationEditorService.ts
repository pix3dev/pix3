import { subscribe } from 'valtio/vanilla';
import { injectable, inject } from '@/fw/di';
import { appState } from '@/state';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { LocalizationService, setActiveLocalization, type LocaleTable } from '@pix3/runtime';
import type { LocalizationSettings } from '@/core/ProjectManifest';

const LOCALES_DIR = 'locales';

/** Which half of a locale table an entry lives in: UI strings or localized sprite paths. */
export type LocaleTableSection = 'strings' | 'sprites';

/** Human-readable default names for common locale ids (used when a table has no `$meta.name`). */
const LOCALE_DISPLAY_NAMES: Record<string, string> = {
  en: 'English',
  ru: 'Русский',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  pt: 'Português',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
  zh: '中文',
};

/**
 * Editor-side authoring layer for localization. Owns the **editor-preview**
 * {@link LocalizationService} (the active-localization pointer while editing, so
 * viewport label proxies resolve translations), loads `locales/*.json` at project
 * open, and exposes an authoring API (read/edit/save tables, switch preview
 * locale, missing-key diff). It mirrors UI-facing counters into
 * `appState.localization`; the actual tables stay here (state-vs-scene-graph
 * separation). All *undoable* mutations run through Commands/Operations that call
 * into this service — the service persists + feeds the preview + bumps `revision`.
 */
@injectable()
export class LocalizationEditorService {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  private preview: LocalizationService | null = null;
  /** In-memory authoring tables keyed by locale id (source of truth while editing). */
  private readonly tables = new Map<string, LocaleTable>();
  private settings: LocalizationSettings | null = null;
  /** Identity of the project whose tables are currently loaded (guards re-loads). */
  private loadedProjectKey: string | null = null;
  private previewLocale = '';
  private disposeProjectSub?: () => void;
  private initialized = false;

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.disposeProjectSub = subscribe(appState.project, () => {
      void this.syncFromProject();
    });
    void this.syncFromProject();
  }

  dispose(): void {
    this.disposeProjectSub?.();
    this.disposeProjectSub = undefined;
    setActiveLocalization(null);
    this.preview?.dispose();
    this.preview = null;
    this.tables.clear();
    this.settings = null;
    this.loadedProjectKey = null;
    this.previewLocale = '';
    this.initialized = false;
  }

  // ---- project lifecycle ---------------------------------------------------

  private projectKey(): string | null {
    const p = appState.project;
    return p.id ? `${p.backend}:${p.id}` : null;
  }

  /** (Re)load tables when a different project opens, or clear on close. */
  private async syncFromProject(): Promise<void> {
    const key = this.projectKey();
    if (key === this.loadedProjectKey) return;
    this.loadedProjectKey = key;

    // Reset state for the new (or absent) project.
    setActiveLocalization(null);
    this.preview?.dispose();
    this.preview = null;
    this.tables.clear();
    this.settings = null;
    this.previewLocale = '';

    if (!key) {
      this.mirrorSlice();
      return;
    }

    try {
      await this.loadTables();
    } catch (error) {
      console.warn('[Localization] Failed to load project locales', error);
    }
    this.mirrorSlice();
  }

  /** Resolve the effective settings (manifest block, else auto-discovered from `locales/`). */
  private async resolveSettings(): Promise<LocalizationSettings | null> {
    const fromManifest = appState.project.manifest?.localization;
    if (fromManifest && fromManifest.locales.length > 0) {
      return fromManifest;
    }
    // Zero-config: discover `locales/*.json`. Empty ⇒ localization inert.
    const discovered = await this.discoverLocaleIds();
    if (discovered.length === 0) return null;
    const defaultLocale = discovered.includes('en') ? 'en' : discovered[0];
    return { defaultLocale, locales: discovered };
  }

  private async discoverLocaleIds(): Promise<string[]> {
    try {
      const entries = await this.storage.listDirectory(LOCALES_DIR);
      return entries
        .filter(e => e.kind === 'file' && e.name.toLowerCase().endsWith('.json'))
        .map(e => e.name.slice(0, -'.json'.length))
        .sort();
    } catch {
      return []; // no locales/ directory
    }
  }

  private async loadTables(): Promise<void> {
    const settings = await this.resolveSettings();
    this.settings = settings;
    if (!settings) return;

    for (const locale of settings.locales) {
      const table = await this.readTableFile(locale);
      this.tables.set(locale, table);
    }

    // Build the preview instance from the loaded tables and activate it.
    const preview = this.ensurePreview();
    for (const table of this.tables.values()) {
      preview.setTable(table);
    }
    this.previewLocale = settings.defaultLocale;
    void preview.setLocale(settings.defaultLocale);
  }

  /**
   * Ensure the editor-preview {@link LocalizationService} exists and is the active
   * localization pointer (so viewport label proxies resolve translations). Built
   * lazily so authoring a first locale into a previously-inert project activates
   * the preview without a project reload.
   */
  private ensurePreview(): LocalizationService {
    if (!this.preview) {
      const preview = new LocalizationService();
      preview.configure({
        defaultLocale: this.settings?.defaultLocale ?? 'en',
        fallbackLocale: this.settings?.fallbackLocale,
        locales: this.settings?.locales,
      });
      this.preview = preview;
      if (!this.previewLocale) {
        this.previewLocale = this.settings?.defaultLocale ?? 'en';
      }
      setActiveLocalization(preview);
    }
    return this.preview;
  }

  private async readTableFile(locale: string): Promise<LocaleTable> {
    try {
      const text = await this.storage.readTextFile(`${LOCALES_DIR}/${locale}.json`);
      return parseTableFile(locale, text);
    } catch {
      // Missing/broken file ⇒ empty table (still declared; panel can populate it).
      return { locale, strings: {}, sprites: {} };
    }
  }

  // ---- read API (panel / inspector widget) --------------------------------

  isActive(): boolean {
    return this.settings !== null;
  }

  getLocales(): string[] {
    return this.settings ? [...this.settings.locales] : [];
  }

  getDefaultLocale(): string {
    return this.settings?.defaultLocale ?? '';
  }

  getPreviewLocale(): string {
    return this.previewLocale;
  }

  /**
   * Effective runtime localization config (manifest block, else auto-discovered),
   * for injection into the play-mode SceneRunner. Null ⇒ localization inert.
   */
  getRuntimeConfig(): { defaultLocale: string; fallbackLocale?: string; locales: string[] } | null {
    if (!this.settings) return null;
    return {
      defaultLocale: this.settings.defaultLocale,
      ...(this.settings.fallbackLocale ? { fallbackLocale: this.settings.fallbackLocale } : {}),
      locales: [...this.settings.locales],
    };
  }

  getLocaleDisplayName(locale: string): string {
    return (
      this.tables.get(locale)?.meta?.name ?? LOCALE_DISPLAY_NAMES[locale] ?? locale.toUpperCase()
    );
  }

  /** Union of keys in `section` across all locales (default locale first), for autocomplete. */
  getAllKeys(section: LocaleTableSection = 'strings'): string[] {
    const keys = new Set<string>();
    const def = this.getDefaultLocale();
    for (const k of Object.keys(this.tables.get(def)?.[section] ?? {})) keys.add(k);
    for (const table of this.tables.values()) {
      for (const k of Object.keys(table[section])) keys.add(k);
    }
    return [...keys].sort();
  }

  getEntry(locale: string, key: string, section: LocaleTableSection = 'strings'): string {
    return this.tables.get(locale)?.[section][key] ?? '';
  }

  /** Whether `locale` records an entry for `key` — even an empty `""` placeholder
   *  (getEntry can't distinguish an absent key from a seeded placeholder). */
  hasEntry(locale: string, key: string, section: LocaleTableSection = 'strings'): boolean {
    return key in (this.tables.get(locale)?.[section] ?? {});
  }

  /** Whether a key resolves (current-or-fallback) in the preview locale — as a
   *  string or as a sprite path (the inspector widget serves both labelKey and
   *  textureKey properties, which share the `localization-key` editor hint). */
  keyResolvesInPreview(key: string): boolean {
    if (!this.preview) return false;
    return this.preview.has(key) || this.preview.trSprite(key) !== null;
  }

  /** The preview-locale translation of `key` (falls back to the key itself). */
  resolveInPreview(key: string): string {
    return this.preview?.tr(key) ?? key;
  }

  /** Keys present (non-empty) in the default locale but missing/empty in `locale`. */
  getMissing(locale: string, section: LocaleTableSection = 'strings'): string[] {
    const def = this.getDefaultLocale();
    if (!def || locale === def) return [];
    const defEntries = this.tables.get(def)?.[section] ?? {};
    const locEntries = this.tables.get(locale)?.[section] ?? {};
    return Object.keys(defEntries).filter(k => !(locEntries[k] ?? '').trim());
  }

  // ---- mutation API (called by Operations; persists + refreshes preview) ---

  /** Switch the editor preview locale. Returns a Promise (may load a table). */
  async setPreviewLocale(locale: string): Promise<void> {
    if (!this.preview || !this.settings) return;
    if (!this.settings.locales.includes(locale)) return;
    this.previewLocale = locale;
    await this.preview.setLocale(locale);
    this.mirrorSlice();
  }

  /** Set/clear a single entry (translation or sprite path). Persists the file and re-feeds the preview. */
  async setEntry(
    locale: string,
    key: string,
    value: string,
    section: LocaleTableSection = 'strings'
  ): Promise<void> {
    if (!key) return;
    const table = this.ensureTable(locale);
    if (value) {
      table[section][key] = value;
    } else {
      delete table[section][key];
    }
    this.preview?.setTable(table);
    await this.saveLocale(locale);
    this.mirrorSlice();
  }

  /** Remove a key from every locale. Returns the removed values for undo. */
  async removeKey(
    key: string,
    section: LocaleTableSection = 'strings'
  ): Promise<Record<string, string>> {
    const removed: Record<string, string> = {};
    for (const [locale, table] of this.tables) {
      if (key in table[section]) {
        removed[locale] = table[section][key];
        delete table[section][key];
        this.preview?.setTable(table);
        await this.saveLocale(locale);
      }
    }
    this.mirrorSlice();
    return removed;
  }

  /** Declare a new locale and write an (empty) table file. */
  async addLocale(locale: string): Promise<void> {
    if (!locale || this.tables.has(locale)) return;
    const table: LocaleTable = { locale, strings: {}, sprites: {} };
    this.tables.set(locale, table);
    if (this.settings) {
      if (!this.settings.locales.includes(locale)) this.settings.locales.push(locale);
    } else {
      this.settings = { defaultLocale: locale, locales: [locale] };
    }
    this.ensurePreview().setTable(table);
    await this.saveLocale(locale);
    this.mirrorSlice();
  }

  /**
   * Remove a declared locale: drop its table, its manifest/settings entry, and
   * delete the `locales/<locale>.json` file. Returns the removed table so the
   * operation can restore it on undo. Refuses to remove the default locale (it
   * is the template) — returns null in that case.
   */
  async removeLocale(locale: string): Promise<LocaleTable | null> {
    if (!this.settings || !this.tables.has(locale)) return null;
    if (locale === this.settings.defaultLocale) return null;

    const removed = this.tables.get(locale) ?? null;
    this.tables.delete(locale);
    this.settings.locales = this.settings.locales.filter(l => l !== locale);
    if (this.previewLocale === locale) {
      this.previewLocale = this.settings.defaultLocale;
      void this.preview?.setLocale(this.settings.defaultLocale);
    }
    try {
      await this.storage.deleteEntry(`${LOCALES_DIR}/${locale}.json`);
    } catch (error) {
      console.error(`[Localization] Failed to delete locale file "${locale}"`, error);
    }
    this.mirrorSlice();
    return removed;
  }

  /** Re-insert a previously removed locale table (undo of {@link removeLocale}). */
  async restoreLocale(table: LocaleTable): Promise<void> {
    this.tables.set(table.locale, table);
    if (this.settings) {
      if (!this.settings.locales.includes(table.locale)) this.settings.locales.push(table.locale);
    } else {
      this.settings = { defaultLocale: table.locale, locales: [table.locale] };
    }
    this.ensurePreview().setTable(table);
    await this.saveLocale(table.locale);
    this.mirrorSlice();
  }

  /**
   * Move a key to a new name in every locale table that has it. Returns the moved
   * values per locale (for undo — renaming back restores them exactly), or null
   * when `oldKey` resolves nowhere or `newKey` is already taken in the section.
   * Symmetric: undo = `renameKey(newKey, oldKey, section)`.
   */
  async renameKey(
    oldKey: string,
    newKey: string,
    section: LocaleTableSection = 'strings'
  ): Promise<Record<string, string> | null> {
    if (!oldKey || !newKey || oldKey === newKey) return null;
    let found = false;
    for (const table of this.tables.values()) {
      if (oldKey in table[section]) found = true;
      if (newKey in table[section]) return null;
    }
    if (!found) return null;

    const moved: Record<string, string> = {};
    for (const [locale, table] of this.tables) {
      if (!(oldKey in table[section])) continue;
      moved[locale] = table[section][oldKey];
      delete table[section][oldKey];
      table[section][newKey] = moved[locale];
      this.preview?.setTable(table);
      await this.saveLocale(locale);
    }
    this.mirrorSlice();
    return moved;
  }

  /**
   * Seed keys missing from `locale` as `""` placeholders (extraction template
   * fill, design §4.5) so translators see the full key set. Returns the keys
   * actually seeded (already-present keys are left untouched) for undo.
   */
  async seedMissingKeys(
    locale: string,
    keys: string[],
    section: LocaleTableSection = 'strings'
  ): Promise<string[]> {
    const table = this.ensureTable(locale);
    const seeded = keys.filter(key => !(key in table[section]));
    if (seeded.length === 0) return [];
    for (const key of seeded) table[section][key] = '';
    this.preview?.setTable(table);
    await this.saveLocale(locale);
    this.mirrorSlice();
    return seeded;
  }

  /**
   * Remove previously seeded placeholder keys (undo of {@link seedMissingKeys}).
   * Entries the author has since filled in are kept.
   */
  async unseedKeys(
    locale: string,
    keys: string[],
    section: LocaleTableSection = 'strings'
  ): Promise<void> {
    const table = this.tables.get(locale);
    if (!table) return;
    let changed = false;
    for (const key of keys) {
      if (key in table[section] && table[section][key] === '') {
        delete table[section][key];
        changed = true;
      }
    }
    if (!changed) return;
    this.preview?.setTable(table);
    await this.saveLocale(locale);
    this.mirrorSlice();
  }

  /** Re-insert removed key values across locales (undo of {@link removeKey}). */
  async restoreKey(
    key: string,
    values: Record<string, string>,
    section: LocaleTableSection = 'strings'
  ): Promise<void> {
    for (const [locale, value] of Object.entries(values)) {
      const table = this.ensureTable(locale);
      table[section][key] = value;
      this.preview?.setTable(table);
      await this.saveLocale(locale);
    }
    this.mirrorSlice();
  }

  private ensureTable(locale: string): LocaleTable {
    let table = this.tables.get(locale);
    if (!table) {
      table = { locale, strings: {}, sprites: {} };
      this.tables.set(locale, table);
    }
    return table;
  }

  private async saveLocale(locale: string): Promise<void> {
    const table = this.tables.get(locale);
    if (!table) return;
    try {
      // writeTextFile does not create parent dirs; ensure `locales/` exists first
      // (idempotent — no-op when already present) so the first save in a project
      // without a locales/ directory succeeds.
      await this.storage.createDirectory(LOCALES_DIR);
      await this.storage.writeTextFile(`${LOCALES_DIR}/${locale}.json`, serializeTableFile(table));
    } catch (error) {
      console.error(`[Localization] Failed to save locale "${locale}"`, error);
    }
  }

  private mirrorSlice(): void {
    const slice = appState.localization;
    const locales = this.getLocales();
    const missingCounts: Record<string, number> = {};
    for (const locale of locales) {
      missingCounts[locale] = this.getMissing(locale).length;
    }
    slice.locales = locales;
    slice.defaultLocale = this.getDefaultLocale();
    slice.previewLocale = this.previewLocale;
    slice.missingCounts = missingCounts;
    slice.revision += 1;
  }
}

// ---- file (de)serialization -------------------------------------------------

/** Parse a `locales/<locale>.json` file into a runtime {@link LocaleTable}. */
function parseTableFile(locale: string, text: string): LocaleTable {
  const parsed = JSON.parse(text) as {
    $meta?: LocaleTable['meta'];
    meta?: LocaleTable['meta'];
    strings?: Record<string, unknown>;
    sprites?: Record<string, unknown>;
  };
  return {
    locale,
    strings: toStringRecord(parsed.strings),
    sprites: toStringRecord(parsed.sprites),
    meta: parsed.$meta ?? parsed.meta,
  };
}

/** Serialize a table to the on-disk format: `$meta` + sorted `strings`/`sprites`. */
function serializeTableFile(table: LocaleTable): string {
  const payload: Record<string, unknown> = {
    $meta: {
      locale: table.locale,
      name: table.meta?.name ?? LOCALE_DISPLAY_NAMES[table.locale] ?? table.locale.toUpperCase(),
      ...(table.meta?.direction ? { direction: table.meta.direction } : {}),
    },
    strings: sortRecord(table.strings),
    sprites: sortRecord(table.sprites),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key];
  return out;
}
