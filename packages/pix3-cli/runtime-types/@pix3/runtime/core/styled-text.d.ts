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
export declare function cssFontFamily(family: string): string;
/** Normalize a weight to the CSS token used in the font shorthand (`''` = normal). */
export declare function cssFontWeight(weight: number | string | undefined): string;
/** Build a valid CSS `font` shorthand: `[weight ]<size>px <quoted family list>`. */
export declare function cssFont(fontSize: number, fontFamily: string, fontWeight?: number | string): string;
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
export declare function drawStyledText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, style: StyledTextDecoration): void;
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
export declare function applyTextStyle(ctx: CanvasRenderingContext2D, style: TextStyleSetup): void;
/**
 * Extra logical px a canvas must grow on EACH side so an outline, a drop shadow
 * or a glow is not clipped at the box edge. Exactly 0 when every decoration is
 * off, which is what keeps undecorated captions byte-identical to before.
 */
export declare function styledTextPadding(style: {
    outlineWidth?: number;
    shadowColor?: string | null;
    shadowOffsetX?: number;
    shadowOffsetY?: number;
    shadowBlur?: number;
    glowBlur?: number;
}): number;
