/**
 * Shared multiline text layout + painting for Label2D.
 *
 * Both the runtime node (canvas texture) and the editor viewport proxy
 * (ViewportRenderService) render label text through these helpers so
 * wrapping, alignment and typewriter clipping stay pixel-identical.
 *
 * Text measurement is injected as a function so layout stays testable in
 * environments without a real canvas 2D context (happy-dom).
 *
 * Glyph styling itself (font shorthand, outline, drop shadow, glow, letter
 * spacing) lives one level down in `styled-text.ts`, shared with `UIControl2D`
 * captions so the two paint identically.
 */
export type LabelHAlign = 'left' | 'center' | 'right';
export type LabelVAlign = 'top' | 'middle' | 'bottom';
export declare const LABEL_H_ALIGN_VALUES: readonly LabelHAlign[];
export declare const LABEL_V_ALIGN_VALUES: readonly LabelVAlign[];
/** Line height as a multiple of the font size. */
export declare const LABEL_LINE_HEIGHT_FACTOR = 1.25;
/** Extra logical px around auto-sized label boxes so glyph overhang isn't clipped. */
export declare const LABEL_AUTO_SIZE_BLEED = 4;
/** Upper bound for `Label2D.glowStrength` (more passes stop reading as glow). */
export declare const LABEL_GLOW_STRENGTH_LIMIT = 4;
/**
 * Blur radius in logical px for one glow pass. Scales with the font size so a
 * 12 px HUD label and a 96 px title glow proportionally at the same strength.
 */
export declare function labelGlowBlurPx(fontSize: number, glowStrength: number): number;
/**
 * How many times the glyph is re-filled under `shadowBlur`. Canvas shadows are
 * additive, so a second/third pass is how a glow gets *brighter* rather than
 * merely wider.
 */
export declare function labelGlowPasses(glowStrength: number): number;
/**
 * Extra logical px the label canvas must grow on EACH side so a glow blur or an
 * outline stroke is not clipped at the box edge. Exactly 0 while both are off, so
 * an undecorated label keeps its historical canvas size (and pixels).
 */
export declare function labelDecorationPadding(fontSize: number, glowStrength?: number, outlineWidth?: number, shadow?: {
    color?: string | null;
    offsetX?: number;
    offsetY?: number;
    blur?: number;
}): number;
export interface LabelLayoutLine {
    text: string;
    width: number;
}
export interface LabelLayout {
    lines: LabelLayoutLine[];
    /** Line advance in logical px (fontSize * LABEL_LINE_HEIGHT_FACTOR). */
    lineHeight: number;
    /** Width of the widest line in logical px. */
    textWidth: number;
    /** lines.length * lineHeight. */
    textHeight: number;
    /** Total drawable characters across all lines (typewriter budget). */
    totalChars: number;
}
export interface LabelLayoutOptions {
    fontSize: number;
    /**
     * Wrap width in logical px. 0 (or negative) disables word wrap — explicit
     * `\n` breaks still apply.
     */
    maxWidth?: number;
    lineHeightFactor?: number;
}
/**
 * Split `text` into wrapped lines. Explicit `\n` always breaks; when
 * `maxWidth` > 0 each paragraph is greedily word-wrapped, and a single word
 * wider than the box is broken mid-word rather than overflowing.
 */
export declare function layoutLabelText(text: string, measure: (text: string) => number, options: LabelLayoutOptions): LabelLayout;
export interface LabelPaintOptions {
    layout: LabelLayout;
    fontFamily: string;
    fontSize: number;
    color: string;
    align: LabelHAlign;
    vAlign: LabelVAlign;
    /** Logical box size the text is aligned within. */
    width: number;
    height: number;
    paddingX?: number;
    paddingY?: number;
    /**
     * Drawable characters to paint (typewriter clip). Infinity/undefined paints
     * everything.
     */
    visibleCharacters?: number;
    /** Glow colour; empty/omitted glows in the text {@link color}. */
    glowColor?: string;
    /** Glow amount 0..{@link LABEL_GLOW_STRENGTH_LIMIT}; 0 (default) = no glow. */
    glowStrength?: number;
    /** Outline colour (default `#000000`), used when {@link outlineWidth} > 0. */
    outlineColor?: string;
    /** Outline half-width in logical px; 0 (default) = no outline. */
    outlineWidth?: number;
    /** CSS font weight for the shorthand; omitted/`normal` = regular. */
    fontWeight?: number | string;
    /** Drop-shadow colour; empty/null (the default) = no shadow. */
    shadowColor?: string | null;
    shadowOffsetX?: number;
    shadowOffsetY?: number;
    /** Drop-shadow blur in logical px; 0 (default) = a hard offset silhouette. */
    shadowBlur?: number;
    /** Extra px between glyphs; 0 (default) = the font's own spacing. */
    letterSpacing?: number;
}
/**
 * Paint a laid-out label into a canvas 2D context. The context is expected to
 * be transformed to logical pixels already (DPR scale applied by the caller);
 * the box `[0,0..width,height]` is cleared before drawing.
 */
export declare function paintLabelCanvas(ctx: CanvasRenderingContext2D, options: LabelPaintOptions): void;
