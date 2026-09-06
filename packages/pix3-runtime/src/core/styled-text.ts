/**
 * Shared canvas text styling for every node that paints text into a canvas
 * texture — `Label2D` (through {@link paintLabelCanvas}) and `UIControl2D` (the
 * caption of `Button2D`, `Checkbox2D`, `Slider2D`, …).
 *
 * It exists because the two used to draw text with two independent snippets:
 * `Label2D` grew outline + glow while a button caption stayed a bare `fillText`
 * with `ctx.font = '<size>px <family>'`. A UI kit baked with an outlined display
 * face therefore came out of the forge right and out of the engine as flat Arial.
 * One helper is what keeps the two from drifting again.
 *
 * Everything is expressed in **logical** pixels — the caller is expected to have
 * applied the DPR scale to the context already.
 */

/** Generic CSS font families that must never be quoted. */
const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
  'inherit',
  'initial',
  'unset',
]);

/** A bare CSS identifier needs no quotes; anything else (spaces, digits first) does. */
const BARE_FAMILY = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Quote a font-family list so names with spaces survive into `ctx.font`.
 *
 * `ctx.font = '16px Lilita One'` is an **invalid** CSS font shorthand: the
 * assignment is silently ignored and the canvas keeps its previous (default)
 * font — which is exactly how a project font ended up rendering as the browser
 * default. Quoting turns it into `16px "Lilita One"`, which parses.
 *
 * Already-quoted entries and generic keywords are passed through untouched, so a
 * stack like `"Lilita One", Impact, sans-serif` stays valid.
 */
export function cssFontFamily(family: string): string {
  const trimmed = (family ?? '').trim();
  if (trimmed.length === 0) {
    return 'sans-serif';
  }

  return trimmed
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
    .map(entry => {
      if (entry.startsWith('"') || entry.startsWith("'")) {
        return entry;
      }
      if (GENERIC_FAMILIES.has(entry.toLowerCase()) || BARE_FAMILY.test(entry)) {
        return entry;
      }
      return `"${entry.replace(/["\\]/g, '\\$&')}"`;
    })
    .join(', ');
}

/** Normalize a weight to the CSS token used in the font shorthand (`''` = normal). */
export function cssFontWeight(weight: number | string | undefined): string {
  if (weight === undefined || weight === null) {
    return '';
  }
  if (typeof weight === 'number') {
    return Number.isFinite(weight) && weight > 0 ? String(Math.round(weight)) : '';
  }
  const token = weight.trim().toLowerCase();
  if (token.length === 0 || token === 'normal' || token === '400') {
    return '';
  }
  return token;
}

/** Build a valid CSS `font` shorthand: `[weight ]<size>px <quoted family list>`. */
export function cssFont(
  fontSize: number,
  fontFamily: string,
  fontWeight?: number | string
): string {
  const size = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 16;
  const weight = cssFontWeight(fontWeight);
  return `${weight ? `${weight} ` : ''}${size}px ${cssFontFamily(fontFamily)}`;
}

/** Decoration applied to a run of canvas text. Every field is optional and off by default. */
export interface StyledTextDecoration {
  /** Fill colour of the glyphs. */
  color: string;
  /** Outline half-width in logical px; the stroke is drawn at `2 ×` this. 0 = none. */
  outlineWidth?: number;
  /** Outline colour (default `#000000`), used when {@link outlineWidth} > 0. */
  outlineColor?: string;
  /** Drop-shadow colour; empty/null = no shadow (the default). */
  shadowColor?: string | null;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  /** Drop-shadow blur in logical px (default 0 = a hard offset silhouette). */
  shadowBlur?: number;
  /** Glow colour; empty/omitted glows in {@link color}. */
  glowColor?: string;
  /** Glow amount; 0 (default) = no glow. Blur/pass count come from the caller. */
  glowBlur?: number;
  glowPasses?: number;
}

/**
 * Paint one run of text at `(x, y)` with the current `textAlign` / `textBaseline`,
 * layering (bottom to top): drop shadow, outline, glow passes, fill.
 *
 * The context's font must already be set (see {@link cssFont} /
 * {@link applyTextStyle}); this helper only owns colour and decoration state so a
 * caller can lay out many lines with one font assignment.
 *
 * `ctx.save()` / `ctx.restore()` are only touched when a shadow or a glow is
 * actually on — an undecorated run issues exactly the one `fillText` it always did.
 */
export function drawStyledText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  style: StyledTextDecoration
): void {
  if (text.length === 0) {
    return;
  }

  const outlineWidth = Math.max(0, style.outlineWidth ?? 0);
  const shadowColor = style.shadowColor?.trim() ? style.shadowColor : '';
  const shadowOffsetX = style.shadowOffsetX ?? 0;
  const shadowOffsetY = style.shadowOffsetY ?? 0;
  const shadowBlur = Math.max(0, style.shadowBlur ?? 0);
  const glowBlur = Math.max(0, style.glowBlur ?? 0);
  const glowPasses = Math.max(0, Math.round(style.glowPasses ?? 0));

  ctx.fillStyle = style.color;
  if (outlineWidth > 0) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = outlineWidth * 2;
    ctx.strokeStyle = style.outlineColor?.trim() ? style.outlineColor : '#000000';
  }

  // 1. Drop shadow — an offset silhouette of the *decorated* glyph (stroke + fill),
  //    so an outlined caption casts the outline's shape, not the thinner glyph's.
  if (shadowColor && (shadowOffsetX !== 0 || shadowOffsetY !== 0 || shadowBlur > 0)) {
    ctx.save();
    ctx.shadowColor = shadowColor;
    ctx.shadowOffsetX = shadowOffsetX;
    ctx.shadowOffsetY = shadowOffsetY;
    ctx.shadowBlur = shadowBlur;
    if (outlineWidth > 0) {
      ctx.strokeText(text, x, y);
    }
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  // 2. Outline underlay.
  if (outlineWidth > 0) {
    ctx.strokeText(text, x, y);
  }

  // 3. Additive glow passes (canvas shadows accumulate, so a second pass is how a
  //    glow gets brighter rather than merely wider).
  if (glowBlur > 0 && glowPasses > 0) {
    ctx.save();
    ctx.shadowColor = style.glowColor?.trim() ? style.glowColor : style.color;
    ctx.shadowBlur = glowBlur;
    for (let pass = 0; pass < glowPasses; pass++) {
      ctx.fillText(text, x, y);
    }
    ctx.restore();
  }

  // 4. The plain fill on top.
  ctx.fillText(text, x, y);
}

/** Font + letter-spacing setup shared by the label and control caption painters. */
export interface TextStyleSetup {
  fontSize: number;
  fontFamily: string;
  fontWeight?: number | string;
  /** Extra px between glyphs; 0 (default) leaves the context's spacing alone. */
  letterSpacing?: number;
}

/**
 * Apply font + letter spacing to a context.
 *
 * `letterSpacing` is a fairly recent canvas property (Chrome 99+, Safari 17+,
 * Firefox 126+) — it is written through a feature guard and simply has no effect
 * where it is unsupported, which is the right failure for a purely typographic
 * nicety. It is also only written when non-zero, so nothing changes for text
 * that never asked for spacing.
 */
export function applyTextStyle(ctx: CanvasRenderingContext2D, style: TextStyleSetup): void {
  ctx.font = cssFont(style.fontSize, style.fontFamily, style.fontWeight);

  const spacing = style.letterSpacing ?? 0;
  const spacingCapable = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if (spacing !== 0 && 'letterSpacing' in spacingCapable) {
    spacingCapable.letterSpacing = `${spacing}px`;
  } else if (spacing === 0 && spacingCapable.letterSpacing) {
    // A pooled/reused context could carry spacing from a previous paint.
    spacingCapable.letterSpacing = '0px';
  }
}

/**
 * Extra logical px a canvas must grow on EACH side so an outline, a drop shadow
 * or a glow is not clipped at the box edge. Exactly 0 when every decoration is
 * off, which is what keeps undecorated captions byte-identical to before.
 */
export function styledTextPadding(style: {
  outlineWidth?: number;
  shadowColor?: string | null;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  shadowBlur?: number;
  glowBlur?: number;
}): number {
  const outline = Math.max(0, style.outlineWidth ?? 0);
  const glow = Math.max(0, style.glowBlur ?? 0);
  const hasShadow = Boolean(style.shadowColor?.trim());
  const shadow = hasShadow
    ? Math.max(Math.abs(style.shadowOffsetX ?? 0), Math.abs(style.shadowOffsetY ?? 0)) +
      Math.max(0, style.shadowBlur ?? 0)
    : 0;

  if (outline <= 0 && glow <= 0 && shadow <= 0) {
    return 0;
  }
  // The visible extent of a canvas shadow is ~1.5× its blur radius; the stroke is
  // centred on the glyph outline, so half of it sits outside.
  return Math.ceil(glow * 1.5 + outline + shadow + 2);
}
