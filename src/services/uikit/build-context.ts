/**
 * UI Kit Forge — the build context.
 *
 * The jam-august forge kept four module-level globals: the live theme `T`, the
 * `STRIP_TEXT` flag, the `anchors` collector and the `_uid` counter. That works for one
 * page with one theme; it does not work for a core two hosts share (plan §4: "no globals;
 * `uid()` is injected, otherwise gradient ids depend on generation order").
 *
 * Generators are synchronous, so the replacement is ONE module-scoped context installed for
 * the duration of a build by {@link runBuild} and restored in `finally`. The counter is
 * reset per top-level build — per registry descriptor, NOT per `comp*` call, because the
 * showcase nests parts into one document and their gradient ids must not collide (plan
 * §9.2). One `(theme, name, lang)` therefore yields a byte-identical SVG.
 *
 * Calling a generator outside `runBuild` throws. Falling back to a default theme instead
 * would hide the mistake and silently paint the wrong kit.
 */
import type { ForgeTheme } from './ForgeTheme';

/** The bench's languages. Captions are bilingual; the host UI is not this core's business. */
export const LANGS = ['ru', 'en'] as const;
export type ForgeLang = (typeof LANGS)[number];

/**
 * A caption the generator skipped while stripping text: where it belonged, so a host can
 * put a real, engine-drawn label there (plan §3.4, §9.1).
 */
export interface RawAnchor {
  /** What the caption names ('label', 'value', 'title', 'amount'…). */
  role: string | null;
  /** SVG text origin, component design units. */
  x: number;
  y: number;
  /** Font size in design units. */
  size: number;
  /** The SVG `text-anchor` the caption was drawn with. */
  align: string;
  /** The text that was dropped — useful for a preview, never for the art. */
  sample: string;
}

/** What one build needs to know. */
export interface BuildOptions {
  theme: ForgeTheme;
  lang?: ForgeLang;
  /** Drop every caption and collect its anchor instead (the engine/atlas lane). */
  stripText?: boolean;
}

interface BuildContext {
  theme: ForgeTheme;
  lang: ForgeLang;
  stripText: boolean;
  uid: number;
  anchors: RawAnchor[] | null;
}

let current: BuildContext | null = null;

function require_(): BuildContext {
  if (!current) {
    throw new Error(
      'UI Kit Forge: generators must run inside runBuild({ theme }, …). ' +
        'There is no ambient theme — a default one would silently paint the wrong kit.'
    );
  }
  return current;
}

/**
 * Run `fn` with `opts` installed as the build context.
 *
 * Nests safely (a host may build a part while building a template): the previous context is
 * restored in `finally`, and the uid counter starts at 0 for every call, which is what makes
 * the output deterministic.
 */
export function runBuild<T>(opts: BuildOptions, fn: () => T): T {
  const previous = current;
  current = {
    theme: opts.theme,
    lang: opts.lang ?? 'en',
    stripText: !!opts.stripText,
    uid: 0,
    anchors: null,
  };
  try {
    return fn();
  } finally {
    current = previous;
  }
}

/** The theme of the build in progress. Throws outside {@link runBuild}. */
export function theme(): ForgeTheme {
  return require_().theme;
}

/** The language of the build in progress. */
export function lang(): ForgeLang {
  return require_().lang;
}

/** A unique id for one SVG document: `prefix` plus a per-build counter. */
export function uid(prefix: string): string {
  const ctx = require_();
  return prefix + ctx.uid++;
}

/** Are captions being dropped (and their anchors collected) in this build? */
export function isStrippingText(): boolean {
  return require_().stripText;
}

/** Start collecting caption anchors for one component. */
export function beginAnchors(): void {
  require_().anchors = [];
}

/** Take (and clear) the anchors collected since {@link beginAnchors}. */
export function takeAnchors(): RawAnchor[] {
  const ctx = require_();
  const out = ctx.anchors ?? [];
  ctx.anchors = null;
  return out;
}

/** Record one skipped caption. No-op when nobody is collecting. */
export function pushAnchor(anchor: RawAnchor): void {
  const ctx = require_();
  if (ctx.anchors) ctx.anchors.push(anchor);
}

/** Is a build context installed? For hosts that want to check rather than catch. */
export function hasBuildContext(): boolean {
  return current !== null;
}
