/**
 * Shared multiline text layout + painting for Label2D.
 *
 * Both the runtime node (canvas texture) and the editor viewport proxy
 * (ViewportRenderService) render label text through these helpers so
 * wrapping, alignment and typewriter clipping stay pixel-identical.
 *
 * Text measurement is injected as a function so layout stays testable in
 * environments without a real canvas 2D context (happy-dom).
 */

export type LabelHAlign = 'left' | 'center' | 'right';
export type LabelVAlign = 'top' | 'middle' | 'bottom';

export const LABEL_H_ALIGN_VALUES: readonly LabelHAlign[] = ['left', 'center', 'right'];
export const LABEL_V_ALIGN_VALUES: readonly LabelVAlign[] = ['top', 'middle', 'bottom'];

/** Line height as a multiple of the font size. */
export const LABEL_LINE_HEIGHT_FACTOR = 1.25;

/** Extra logical px around auto-sized label boxes so glyph overhang isn't clipped. */
export const LABEL_AUTO_SIZE_BLEED = 4;

/** Upper bound for `Label2D.glowStrength` (more passes stop reading as glow). */
export const LABEL_GLOW_STRENGTH_LIMIT = 4;

/**
 * Blur radius in logical px for one glow pass. Scales with the font size so a
 * 12 px HUD label and a 96 px title glow proportionally at the same strength.
 */
export function labelGlowBlurPx(fontSize: number, glowStrength: number): number {
  if (!(glowStrength > 0) || !(fontSize > 0)) {
    return 0;
  }
  return fontSize * 0.35 * Math.min(glowStrength, LABEL_GLOW_STRENGTH_LIMIT);
}

/**
 * How many times the glyph is re-filled under `shadowBlur`. Canvas shadows are
 * additive, so a second/third pass is how a glow gets *brighter* rather than
 * merely wider.
 */
export function labelGlowPasses(glowStrength: number): number {
  if (!(glowStrength > 0)) {
    return 0;
  }
  return Math.min(3, Math.max(1, Math.ceil(glowStrength)));
}

/**
 * Extra logical px the label canvas must grow on EACH side so a glow blur or an
 * outline stroke is not clipped at the box edge. Exactly 0 while both are off, so
 * an undecorated label keeps its historical canvas size (and pixels).
 */
export function labelDecorationPadding(
  fontSize: number,
  glowStrength = 0,
  outlineWidth = 0
): number {
  const blur = labelGlowBlurPx(fontSize, glowStrength);
  const outline = outlineWidth > 0 ? outlineWidth : 0;
  if (blur <= 0 && outline <= 0) {
    return 0;
  }
  // The visible extent of a canvas shadow is ~1.5× its blur radius; the stroke is
  // centred on the glyph outline, so half of it sits outside.
  return Math.ceil(blur * 1.5 + outline + 2);
}

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
export function layoutLabelText(
  text: string,
  measure: (text: string) => number,
  options: LabelLayoutOptions
): LabelLayout {
  const maxWidth = options.maxWidth && options.maxWidth > 0 ? options.maxWidth : 0;
  const lineHeight = options.fontSize * (options.lineHeightFactor ?? LABEL_LINE_HEIGHT_FACTOR);

  const lines: LabelLayoutLine[] = [];
  const pushLine = (lineText: string): void => {
    lines.push({ text: lineText, width: lineText.length > 0 ? measure(lineText) : 0 });
  };

  for (const paragraph of text.split('\n')) {
    if (maxWidth <= 0 || paragraph.length === 0 || measure(paragraph) <= maxWidth) {
      pushLine(paragraph);
      continue;
    }

    let current = '';
    for (const word of paragraph.split(' ')) {
      const candidate = current.length > 0 ? `${current} ${word}` : word;
      if (measure(candidate) <= maxWidth || current.length === 0) {
        current = candidate;
        continue;
      }
      pushLine(current);
      current = word;
    }
    // Break oversized words (URLs, digit runs) character by character.
    while (current.length > 1 && measure(current) > maxWidth) {
      let cut = current.length - 1;
      while (cut > 1 && measure(current.slice(0, cut)) > maxWidth) {
        cut -= 1;
      }
      pushLine(current.slice(0, cut));
      current = current.slice(cut);
    }
    pushLine(current);
  }

  let textWidth = 0;
  let totalChars = 0;
  for (const line of lines) {
    textWidth = Math.max(textWidth, line.width);
    totalChars += line.text.length;
  }

  return {
    lines,
    lineHeight,
    textWidth,
    textHeight: lines.length * lineHeight,
    totalChars,
  };
}

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
}

/**
 * Paint a laid-out label into a canvas 2D context. The context is expected to
 * be transformed to logical pixels already (DPR scale applied by the caller);
 * the box `[0,0..width,height]` is cleared before drawing.
 */
export function paintLabelCanvas(ctx: CanvasRenderingContext2D, options: LabelPaintOptions): void {
  const { layout, width, height } = options;
  const paddingX = options.paddingX ?? 0;
  const paddingY = options.paddingY ?? 0;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = options.color;
  ctx.font = `${options.fontSize}px ${options.fontFamily}`;
  ctx.textBaseline = 'middle';

  let x = width / 2;
  if (options.align === 'left') {
    ctx.textAlign = 'left';
    x = paddingX;
  } else if (options.align === 'right') {
    ctx.textAlign = 'right';
    x = width - paddingX;
  } else {
    ctx.textAlign = 'center';
  }

  let startY = (height - layout.textHeight) / 2;
  if (options.vAlign === 'top') {
    startY = paddingY;
  } else if (options.vAlign === 'bottom') {
    startY = height - paddingY - layout.textHeight;
  }

  // Decoration (off by default): an outline underlay drawn with strokeText, then
  // additive glow passes under ctx.shadowBlur, then the plain fill on top.
  const glowStrength = Math.min(LABEL_GLOW_STRENGTH_LIMIT, Math.max(0, options.glowStrength ?? 0));
  const glowBlur = labelGlowBlurPx(options.fontSize, glowStrength);
  const glowPasses = labelGlowPasses(glowStrength);
  const glowColor = options.glowColor?.trim() ? options.glowColor : options.color;
  const outlineWidth = Math.max(0, options.outlineWidth ?? 0);
  if (outlineWidth > 0) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = outlineWidth * 2;
    ctx.strokeStyle = options.outlineColor?.trim() ? options.outlineColor : '#000000';
  }

  let budget = options.visibleCharacters ?? Infinity;
  for (let i = 0; i < layout.lines.length; i++) {
    if (budget <= 0) {
      break;
    }
    const line = layout.lines[i].text;
    const shown = budget >= line.length ? line : line.slice(0, Math.max(0, Math.floor(budget)));
    budget -= line.length;
    if (shown.length === 0) {
      continue;
    }
    const y = startY + i * layout.lineHeight + layout.lineHeight / 2;
    if (outlineWidth > 0) {
      ctx.strokeText(shown, x, y);
    }
    if (glowBlur > 0) {
      ctx.save();
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = glowBlur;
      for (let pass = 0; pass < glowPasses; pass++) {
        ctx.fillText(shown, x, y);
      }
      ctx.restore();
    }
    ctx.fillText(shown, x, y);
  }
}
