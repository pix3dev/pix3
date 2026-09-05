/**
 * UI Kit Forge page — the session: everything the page holds that the core deliberately does
 * not.
 *
 * The core (`src/services/uikit/`) is a pure function of `(theme, lang, stripText)` handed to
 * `runBuild`; it owns no mutable "current theme", because two hosts share it (plan §4). So the
 * *page* owns the live theme, the caption language, the preset name and the export options,
 * and every module here reads them from this one object rather than from module globals of
 * its own.
 */
import {
  DEFAULT_PRESET,
  normalizeTheme,
  presetTheme,
  runBuild,
  type BuildOptions,
  type ForgeLang,
  type ForgeTheme,
} from '@/services/uikit';

/** The preview backdrops, in the order the picker lists them. */
export const BACKDROPS = ['Game gradient', 'Checker', 'Dark', 'Light'] as const;
export type Backdrop = (typeof BACKDROPS)[number];

export interface ForgeSession {
  theme: ForgeTheme;
  /** The language the KIT's captions are drawn in. The page chrome itself is English. */
  lang: ForgeLang;
  /** The preset the theme came from — `★ name` for a user preset. */
  preset: string;
  /** Raster scale for every PNG export. */
  scale: number;
  /** Trim the theme's transparent `pad` out of every atlas frame. */
  trimPad: boolean;
  backdrop: Backdrop;
}

export const session: ForgeSession = {
  theme: presetTheme(DEFAULT_PRESET),
  lang: 'en',
  preset: DEFAULT_PRESET,
  scale: 2,
  trimPad: true,
  backdrop: 'Game gradient',
};

/**
 * Merge a patch into the live theme.
 *
 * Everything goes through `normalizeTheme`, including a slider write: it is the core's single
 * validated entry point, and a bad hex reaching `hexToHsl` silently paints `#NaNNaN` over the
 * whole kit (plan §7).
 */
export function patchTheme(patch: Partial<ForgeTheme>): void {
  session.theme = normalizeTheme({ ...session.theme, ...patch });
}

/** Replace the theme wholesale (a preset, a pasted JSON, a randomize). */
export function setTheme(theme: unknown): void {
  session.theme = normalizeTheme(theme);
}

/** The build options for the current session. `stripText` is the engine/atlas lane. */
export function buildOptions(stripText = false): BuildOptions {
  return { theme: session.theme, lang: session.lang, stripText };
}

/**
 * Run `fn` inside a build context for the current session.
 *
 * The core's theme-dependent helpers (`faceSpecs`, `C`, `fontFamilies`…) read the ambient
 * context and throw outside one, so the page's font and palette code has to wrap its reads.
 */
export function withSessionTheme<T>(fn: () => T): T {
  return runBuild({ theme: session.theme, lang: session.lang }, fn);
}
