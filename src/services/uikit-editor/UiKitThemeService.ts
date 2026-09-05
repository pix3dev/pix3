import { injectable, inject } from '@/fw/di';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { appState } from '@/state';
import {
  DEFAULT_PRESET,
  DEFAULT_THEME,
  normalizeTheme,
  presetNames,
  presetTheme,
  type ForgeLang,
  type ForgeTheme,
} from '@/services/uikit';
import { FLOW_STYLE_PATH } from '@/services/flow/PrototypeBootstrapService';

/**
 * Where the project's UI theme lives.
 *
 * Derived from {@link FLOW_STYLE_PATH} rather than spelling `design/` again: the theme is the
 * machine-readable half of the same style contract `design/style.md` carries for humans, and the
 * two must never drift into different folders (plan §4).
 */
export const UI_THEME_PATH = `${FLOW_STYLE_PATH.slice(0, FLOW_STYLE_PATH.lastIndexOf('/'))}/ui-theme.json`;

/** The kit manifest a {@link import('./UiKitProjectWriter').UiKitProjectWriter} writes beside it. */
export const UI_KIT_MANIFEST_PATH = `${UI_THEME_PATH.slice(0, UI_THEME_PATH.lastIndexOf('/'))}/ui-kit.json`;

/** The shape stored in `design/ui-theme.json`. */
export interface UiThemeDocument {
  version: string;
  generator: string;
  /** The preset the theme was last derived from — a label, not a constraint. */
  preset: string;
  lang: ForgeLang;
  theme: ForgeTheme;
}

export const UI_THEME_DOC_VERSION = '1.0';
export const UI_THEME_GENERATOR = 'UI Kit Forge';

/**
 * The editor host's live {@link ForgeTheme}: what the UI Kit panel edits, what the writer bakes,
 * what the prefab builder skins from.
 *
 * Deliberately NOT in `appState`. `appState` is UI state and scene bookkeeping; the theme is a
 * PROJECT DOCUMENT (`design/ui-theme.json`) that outlives the session, travels in the repository
 * and is readable by the agent through `fs_read` (plan §4). Putting it in Valtio would make it
 * look like editor chrome and would silently persist it into session snapshots.
 *
 * The listener API is a plain `Set<() => void>` for the same reason — a panel that wants to
 * repaint on theme changes needs nothing more, and a proxy here would tempt callers to mutate the
 * theme in place, which the core's `normalizeTheme` contract forbids.
 */
@injectable()
export class UiKitThemeService {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  private currentTheme: ForgeTheme = normalizeTheme(DEFAULT_THEME);
  private currentPreset = DEFAULT_PRESET;
  private currentLang: ForgeLang = 'en';
  private loadedFor: string | null = null;
  private readonly listeners = new Set<() => void>();

  getTheme(): ForgeTheme {
    return this.currentTheme;
  }

  getPresetName(): string {
    return this.currentPreset;
  }

  getLang(): ForgeLang {
    return this.currentLang;
  }

  /** Every preset the core ships, in declaration order. */
  listPresets(): string[] {
    return presetNames();
  }

  /**
   * Patch the theme. The patch goes through `normalizeTheme` with the current theme underneath, so
   * a slider handing over a string, or an agent handing over a bad hex, cannot poison the state.
   */
  setTheme(patch: Partial<ForgeTheme>): ForgeTheme {
    this.currentTheme = normalizeTheme({ ...this.currentTheme, ...patch });
    this.emit();
    return this.currentTheme;
  }

  /** Replace the whole theme (a loaded file, a randomization, a preset). */
  replaceTheme(theme: unknown, presetName?: string): ForgeTheme {
    this.currentTheme = normalizeTheme(theme);
    if (presetName !== undefined) this.currentPreset = presetName;
    this.emit();
    return this.currentTheme;
  }

  applyPreset(name: string): ForgeTheme {
    this.currentPreset = name;
    this.currentTheme = presetTheme(name);
    this.emit();
    return this.currentTheme;
  }

  reset(): ForgeTheme {
    return this.applyPreset(DEFAULT_PRESET);
  }

  setLang(lang: ForgeLang): void {
    if (this.currentLang === lang) return;
    this.currentLang = lang;
    this.emit();
  }

  /**
   * Roll the shape knobs (never the palette): the point of the die is to find a silhouette, and a
   * random palette would throw away the project colours the theme carries.
   */
  randomize(random: () => number = Math.random): ForgeTheme {
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
    const between = (min: number, max: number, step = 1): number =>
      Math.round((min + random() * (max - min)) / step) * step;

    return this.setTheme({
      radius: between(0, 22),
      bevel: between(0, 12),
      outline: between(0, 4, 0.5),
      skew: random() < 0.75 ? 0 : between(3, 10),
      puffy: random() < 0.8 ? 0 : between(2, 10),
      glossOn: random() < 0.6 ? 1 : 0,
      glossType: pick(['strip', 'dome', 'corner'] as const),
      glossH: between(30, 70),
      glossA: between(8, 28),
      gradOn: random() < 0.5 ? 1 : 0,
      gradK: between(6, 18),
      shadowMode: pick([0, 1, 1, 2] as const),
      shadowDx: between(0, 5),
      shadowDy: between(2, 9),
      shadowA: between(25, 65),
      txtOut: between(0, 4, 0.5),
      txtDrop: between(0, 4, 0.5),
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[UiKitThemeService] listener threw', error);
      }
    }
  }

  // -- project I/O -----------------------------------------------------------

  /**
   * Read `design/ui-theme.json` from the open project, once per project. A missing file is the
   * normal case (the project has never been themed) and leaves the defaults in place — it is not
   * an error and must not surface as one.
   *
   * @returns whether a stored theme was actually adopted.
   */
  async load(force = false): Promise<boolean> {
    const projectKey = appState.project.id ?? appState.project.projectName ?? null;
    if (!force && this.loadedFor !== null && this.loadedFor === projectKey) return false;
    this.loadedFor = projectKey;

    let text: string;
    try {
      text = await this.storage.readTextFile(UI_THEME_PATH);
    } catch {
      return false;
    }

    try {
      const parsed = JSON.parse(text) as Partial<UiThemeDocument> & Record<string, unknown>;
      // Both shapes are accepted: the document written by `save()`, and a bare theme object —
      // the standalone host exchanges themes through the clipboard as a bare theme.
      const themeSource =
        parsed && typeof parsed === 'object' && 'theme' in parsed ? parsed.theme : parsed;
      this.currentTheme = normalizeTheme(themeSource);
      if (typeof parsed?.preset === 'string') this.currentPreset = parsed.preset;
      if (parsed?.lang === 'ru' || parsed?.lang === 'en') this.currentLang = parsed.lang;
      this.emit();
      return true;
    } catch (error) {
      console.warn(
        '[UiKitThemeService] design/ui-theme.json is not valid JSON — keeping defaults',
        error
      );
      return false;
    }
  }

  /** Write the current theme back to `design/ui-theme.json`. */
  async save(): Promise<string> {
    if (appState.project.status !== 'ready') {
      throw new Error('No project is open — cannot save the UI theme.');
    }
    await this.writeDocument(UI_THEME_PATH, this.toDocument());
    this.loadedFor = appState.project.id ?? appState.project.projectName ?? null;
    return UI_THEME_PATH;
  }

  toDocument(): UiThemeDocument {
    return {
      version: UI_THEME_DOC_VERSION,
      generator: UI_THEME_GENERATOR,
      preset: this.currentPreset,
      lang: this.currentLang,
      theme: this.currentTheme,
    };
  }

  private async writeDocument(path: string, document: UiThemeDocument): Promise<void> {
    const directory = path.slice(0, path.lastIndexOf('/'));
    if (directory) {
      try {
        await this.storage.createDirectory(directory);
      } catch {
        // Already there — `createDirectory` has no portable "exists" answer across the two
        // backends, so the honest place to fail is the write below.
      }
    }
    await this.storage.writeTextFile(path, `${JSON.stringify(document, null, 2)}\n`);
  }
}
