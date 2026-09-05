/**
 * UI Kit Forge — the theme: the global parameters every component is drawn from, the
 * semantic palette, the font selection and the theme-aware colour accessors.
 *
 * The jam-august forge kept ONE mutable object `T` that every module held a live reference
 * to. Here the theme travels in the build context instead (see `build-context.ts`), so the
 * accessors below — `C()`, `DARK()`, `NAVY()`, `LABEL_EDGE()`, `ink()` — read
 * `theme()` rather than a global. Their maths is unchanged.
 *
 * Ported from `src/dev/uikit/theme.js`.
 */
import { adj, brightness, isHex, lum } from './color';
import { theme } from './build-context';

// ---------------------------------------------------------------------------
// The theme
// ---------------------------------------------------------------------------

/** The ids a component asks a colour by. */
export type PaletteId =
  | 'sky'
  | 'blue'
  | 'green'
  | 'yellow'
  | 'bluegray'
  | 'gray'
  | 'white'
  | 'red'
  | 'orange'
  | 'purple';

export type GlossType = 'strip' | 'dome' | 'corner';
/** 0 — off, 1 — a hard offset slab, 2 — blurred. */
export type ShadowMode = 0 | 1 | 2;
export type TxtColorMode = 'white' | 'dark' | 'auto';

export interface ForgeTheme {
  /** Global HSL shift applied to every palette colour. */
  hue: number;
  sat: number;
  light: number;

  /** Geometry, design px. */
  radius: number;
  bevel: number;
  outline: number;
  /** Degrees of lean on the vertical edges (Brawl-Stars parallelogram). */
  skew: number;
  /** Transparent margin `withShadow` adds around a frame. The engine lane forces 0 (§3.5). */
  pad: number;

  /** The highlight. `glossOn` is 0/1 rather than a boolean, as the sliders write it. */
  glossOn: number;
  glossType: GlossType;
  /** Band height as a PERCENT of the face height. */
  glossH: number;
  /** Band alpha, percent. */
  glossA: number;
  /** How far the edges bulge outwards (a "pillow"). > 0 cannot be nine-sliced. */
  puffy: number;

  gradOn: number;
  gradK: number;

  shadowMode: ShadowMode;
  shadowDx: number;
  shadowDy: number;
  shadowBlur: number;
  /** Shadow alpha, percent. */
  shadowA: number;

  /**
   * TWO font choices, because a kit is bilingual and most display faces are Latin-only.
   * `font` is the primary family; `fontCyr` supplies CYRILLIC glyphs. The face is picked
   * per caption (see {@link faceFor}) rather than left to per-character CSS fallback,
   * because a CSS stack carries ONE weight and the Latin display faces are weight 400 —
   * with a stack every Russian caption came out thin.
   */
  font: string;
  fontCyr: string;

  /** The caption's outline half-width, ABSOLUTE px at any caption size. */
  txtOut: number;
  txtDrop: number;
  txtColor: TxtColorMode;
  /** Letter spacing, px. */
  track: number;

  /** The tone of shape outlines and dark panels. */
  darkTone: string;
  /**
   * The caption's outline tone, kept APART from `darkTone`: a panel's edge and a sticker's
   * edge are different colours in every real kit, and one tone cannot express both.
   * `null` falls back to `darkTone`.
   */
  labelEdge: string | null;
  /**
   * Per-role ABSOLUTE colour override: `{ paletteId: hex }`. This is the plan's "absolute
   * colours, not deltas" (§4) — a project palette pins the roles here and the hue/sat/light
   * sliders remain a convenience on top of it. `null` keeps the generic PALETTE below.
   */
  palette: Partial<Record<PaletteId, string>> | null;
}

export const DEFAULT_THEME: ForgeTheme = {
  hue: 0,
  sat: 0,
  light: 0,
  radius: 7,
  bevel: 5,
  outline: 1.5,
  skew: 0,
  pad: 24,
  glossOn: 1,
  glossType: 'strip',
  glossH: 51,
  glossA: 15,
  puffy: 0,
  gradOn: 0,
  gradK: 11,
  shadowMode: 0,
  shadowDx: 3,
  shadowDy: 6,
  shadowBlur: 5,
  shadowA: 40,
  font: 'Nunito',
  fontCyr: 'Nunito',
  txtOut: 1,
  txtDrop: 3,
  txtColor: 'white',
  track: 0,
  darkTone: '#15243c',
  labelEdge: null,
  palette: null,
};

// ---------------------------------------------------------------------------
// normalizeTheme — the single entry point for a theme from JSON
// ---------------------------------------------------------------------------

const GLOSS_TYPES: readonly GlossType[] = ['strip', 'dome', 'corner'];
const TXT_COLORS: readonly TxtColorMode[] = ['white', 'dark', 'auto'];
const PALETTE_IDS: readonly PaletteId[] = [
  'sky',
  'blue',
  'green',
  'yellow',
  'bluegray',
  'gray',
  'white',
  'red',
  'orange',
  'purple',
];

/** A finite number or the fallback — sliders and JSON both hand over strings. */
function num(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function nonNegative(value: unknown, fallback: number): number {
  return Math.max(0, num(value, fallback));
}

function hexOr(value: unknown, fallback: string): string {
  return isHex(value) ? value.trim() : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const v = typeof value === 'string' ? (value.toLowerCase() as T) : null;
  return v !== null && allowed.includes(v) ? v : fallback;
}

/**
 * Coerce an arbitrary value — parsed JSON, a host's form state, an agent's payload — into a
 * valid {@link ForgeTheme}.
 *
 * The rules (plan §7 "input validation", §9.2):
 * - numbers are coerced from strings; a non-finite one falls back to the default;
 * - hex colours are validated by regex, because `hexToHsl` on a bad string silently yields
 *   `#NaNNaN` and the whole kit paints garbage;
 * - the legacy single `shadowOff` slider migrates to the pair: `shadowDx = round(off*0.45)`,
 *   `shadowDy = off`;
 * - enums are clamped to their allowed values;
 * - unknown keys are DROPPED, so a stale file cannot smuggle fields into the context.
 */
export function normalizeTheme(input: unknown): ForgeTheme {
  const raw: Record<string, unknown> =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const d = DEFAULT_THEME;

  // Legacy: one "shadow offset" slider became a dx/dy pair. The 0.45 ratio is the one the
  // old UI drew with, so an old file keeps the shadow direction it was authored with.
  const legacyOff = 'shadowOff' in raw ? num(raw.shadowOff, NaN) : NaN;
  const hasLegacyOff = Number.isFinite(legacyOff);
  const shadowDx = hasLegacyOff ? Math.round(legacyOff * 0.45) : num(raw.shadowDx, d.shadowDx);
  const shadowDy = hasLegacyOff ? legacyOff : num(raw.shadowDy, d.shadowDy);

  let palette: Partial<Record<PaletteId, string>> | null = null;
  if (raw.palette && typeof raw.palette === 'object') {
    const src = raw.palette as Record<string, unknown>;
    const out: Partial<Record<PaletteId, string>> = {};
    let any = false;
    for (const id of PALETTE_IDS) {
      const v = src[id];
      if (isHex(v)) {
        out[id] = v.trim();
        any = true;
      }
    }
    palette = any ? out : null;
  }

  const shadowMode = ([0, 1, 2] as const).includes(num(raw.shadowMode, d.shadowMode) as ShadowMode)
    ? (num(raw.shadowMode, d.shadowMode) as ShadowMode)
    : d.shadowMode;

  return {
    hue: num(raw.hue, d.hue),
    sat: num(raw.sat, d.sat),
    light: num(raw.light, d.light),
    radius: nonNegative(raw.radius, d.radius),
    bevel: nonNegative(raw.bevel, d.bevel),
    outline: nonNegative(raw.outline, d.outline),
    skew: nonNegative(raw.skew, d.skew),
    pad: nonNegative(raw.pad, d.pad),
    glossOn: nonNegative(raw.glossOn, d.glossOn),
    glossType: oneOf(raw.glossType, GLOSS_TYPES, d.glossType),
    glossH: nonNegative(raw.glossH, d.glossH),
    glossA: nonNegative(raw.glossA, d.glossA),
    puffy: nonNegative(raw.puffy, d.puffy),
    gradOn: nonNegative(raw.gradOn, d.gradOn),
    gradK: num(raw.gradK, d.gradK),
    shadowMode,
    shadowDx,
    shadowDy,
    shadowBlur: nonNegative(raw.shadowBlur, d.shadowBlur),
    shadowA: nonNegative(raw.shadowA, d.shadowA),
    font: stringOr(raw.font, d.font),
    fontCyr: stringOr(raw.fontCyr, d.fontCyr),
    txtOut: nonNegative(raw.txtOut, d.txtOut),
    txtDrop: nonNegative(raw.txtDrop, d.txtDrop),
    txtColor: oneOf(raw.txtColor, TXT_COLORS, d.txtColor),
    track: nonNegative(raw.track, d.track),
    darkTone: hexOr(raw.darkTone, d.darkTone),
    labelEdge: isHex(raw.labelEdge) ? raw.labelEdge.trim() : null,
    palette,
  };
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

export interface FontSpec {
  /** Family name. */
  f: string;
  /** The weight the face is used at. */
  w: number;
  /** Does the family carry Cyrillic? */
  cyr: boolean;
}

/**
 * The available families.
 *
 * The coverage was checked against each family's Google Fonts stylesheet, by the subsets it
 * declares: Nunito and Rubik have `cyrillic`/`cyrillic-ext`; Baloo 2
 * (devanagari/vietnamese/latin), Fredoka (hebrew/latin), Lilita One and Luckiest Guy (latin
 * only) do not. That is exactly why there are two pickers: choose a Latin-only display face
 * as the primary and every Cyrillic caption in the kit silently falls to a system font.
 */
export const FONTS: readonly FontSpec[] = [
  { f: 'Baloo 2', w: 800, cyr: false },
  { f: 'Fredoka', w: 700, cyr: false },
  { f: 'Lilita One', w: 400, cyr: false },
  { f: 'Luckiest Guy', w: 400, cyr: false },
  { f: 'Nunito', w: 900, cyr: true },
  { f: 'Rubik', w: 800, cyr: true },
];

/** The families that can render Cyrillic — the options of the second picker. */
export const CYR_FONTS: readonly FontSpec[] = FONTS.filter(f => f.cyr);

/** The declared weight of a family (800 if unknown). */
export function weightOf(family: string): number {
  return FONTS.find(o => o.f === family)?.w ?? 800;
}

/** Does the family carry Cyrillic? */
export function hasCyr(family: string): boolean {
  return !!FONTS.find(o => o.f === family)?.cyr;
}

/** The families a caption set actually needs, primary first — what a host must inline. */
export function fontFamilies(): string[] {
  const t = theme();
  const out = [t.font];
  if (t.fontCyr && t.fontCyr !== t.font && !hasCyr(t.font)) out.push(t.fontCyr);
  return out;
}

/** Cyrillic, plus the numero sign that ships in the same subset. */
const CYR_RE = /[Ѐ-ӿԀ-ԯ№]/;

/** Is this caption Cyrillic — i.e. does it need the Cyrillic supplier? */
export function isCyrText(text: unknown): boolean {
  return CYR_RE.test(String(text));
}

export interface FaceSpec {
  family: string;
  weight: number;
  /** The CSS `font-family` value for this caption. */
  stack: string;
}

/**
 * The face ONE caption is drawn with: family, its own weight, and the CSS stack.
 *
 * Chosen by the caption's own characters rather than left to per-character fallback, and
 * that is the point. A CSS stack carries ONE `font-weight`, so with a stack the Cyrillic
 * supplier was drawn at the PRIMARY's weight — and the Latin display faces are weight 400
 * (Lilita One and Luckiest Guy have no bold at all), so every Cyrillic caption came out
 * thin. Worse, if the primary's weight does not exist for the supplier there is no face to
 * inline at all and the caption dropped to the system fallback.
 *
 * The tail differs on purpose: for a Cyrillic caption the last resort is the generic sans,
 * because 'Baloo 2' — the kit's fallback display face — carries no Cyrillic either.
 */
export function faceFor(text: unknown): FaceSpec {
  const t = theme();
  const cyr = isCyrText(text) && !hasCyr(t.font) && !!t.fontCyr && t.fontCyr !== t.font;
  const family = cyr ? t.fontCyr : t.font;
  const tail = cyr || family === 'Baloo 2' ? ['sans-serif'] : ["'Baloo 2'", 'sans-serif'];
  return { family, weight: weightOf(family), stack: [`'${family}'`, ...tail].join(', ') };
}

export interface FaceInlineSpec {
  family: string;
  weight: number;
  /** True for the family that supplies Cyrillic rather than the primary. */
  cyr: boolean;
}

/** The families to inline, each with the weight it is actually drawn at. */
export function faceSpecs(): FaceInlineSpec[] {
  const primary = theme().font;
  return fontFamilies().map(f => ({ family: f, weight: weightOf(f), cyr: f !== primary }));
}

/** The stack of a LATIN caption — the primary face. */
export function fontStack(): string {
  return faceFor('A').stack;
}

/** The weight of the primary face. */
export function fontW(): number {
  return weightOf(theme().font);
}

// ---------------------------------------------------------------------------
// The semantic palette
//
// `id` is the name a component asks for, `role` is what the colour MEANS, `use` is written
// into the exported style contract. The mapping is the contract an exported kit documents.
// ---------------------------------------------------------------------------

export interface PaletteEntry {
  id: PaletteId;
  hex: string;
  label: string;
  role: string;
  use?: string;
}

export const PALETTE: readonly PaletteEntry[] = [
  { id: 'sky', hex: '#35aef2', label: 'Sky', role: 'info-alt' },
  { id: 'blue', hex: '#1f7fd6', label: 'Blue', role: 'info', use: 'settings toggles, restart' },
  {
    id: 'green',
    hex: '#43c11d',
    label: 'Green',
    role: 'primary',
    use: 'the single main action on a screen (rewarded "free", "Next")',
  },
  { id: 'yellow', hex: '#ffc42e', label: 'Select', role: 'reward', use: 'reward and "current"' },
  { id: 'bluegray', hex: '#5c6577', label: 'Blue Gray', role: 'chrome' },
  {
    id: 'gray',
    hex: '#8b8b95',
    label: 'Gray',
    role: 'neutral',
    use: 'secondary buttons, "CLOSE", "Stay"',
  },
  { id: 'white', hex: '#ffffff', label: 'White', role: 'ink' },
  {
    id: 'red',
    hex: '#e5494b',
    label: 'Red',
    role: 'danger',
    use: 'danger ("HOME", reset progress)',
  },
  { id: 'orange', hex: '#f07d1f', label: 'Orange', role: 'warn' },
  {
    id: 'purple',
    hex: '#a43ddb',
    label: 'Purple',
    role: 'confirm',
    use: 'confirmation that costs something ("Retry -1", dead end)',
  },
];

/**
 * A palette id (or a raw hex) with the theme's global hue/sat/light shift applied.
 *
 * `theme.palette[id]` — the absolute per-role override — wins over the generic entry, and
 * it is the mechanism a project palette plugs into (plan §4).
 */
export function C(hexOrId: string): string {
  const t = theme();
  const over = t.palette ? t.palette[hexOrId as PaletteId] : undefined;
  const entry = over ? null : PALETTE.find(p => p.id === hexOrId);
  const hex = over || (entry ? entry.hex : hexOrId);
  if (!isHex(hex)) return DEFAULT_THEME.darkTone;
  if (lum(hex) > 92) return adj(hex, { dl: t.light * 0.3 }); // white stays white
  return adj(hex, { dh: t.hue, ds: t.sat, dl: t.light });
}

/** The outline / dark panel tone. */
export function DARK(): string {
  const t = theme();
  return adj(t.darkTone, { dh: t.hue * 0.5 });
}

/** The darkest tone: recesses, troughs, the inside of a slot. */
export function NAVY(): string {
  const t = theme();
  return adj(t.darkTone, { dh: t.hue * 0.5, dl: -4 });
}

/** The caption's outline tone (see {@link ForgeTheme.labelEdge}). */
export function LABEL_EDGE(): string {
  const t = theme();
  return t.labelEdge ? adj(t.labelEdge, { dh: t.hue * 0.5 }) : DARK();
}

/** The content colour (text, icons) on a given background, honouring `theme.txtColor`. */
export function ink(bg?: string | null): string {
  const t = theme();
  const darkInk = (): string => adj(t.darkTone, { dh: (t.hue || 0) * 0.5, dl: -3 });
  if (bg && brightness(bg) > 0.9) return darkInk(); // near-white ground: always dark
  if (t.txtColor === 'dark') return darkInk();
  if (t.txtColor === 'auto' && bg && brightness(bg) > 0.56) return darkInk();
  return '#ffffff';
}
