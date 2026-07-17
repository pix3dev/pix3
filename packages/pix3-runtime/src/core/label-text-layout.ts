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
    ctx.fillText(shown, x, startY + i * layout.lineHeight + layout.lineHeight / 2);
  }
}
