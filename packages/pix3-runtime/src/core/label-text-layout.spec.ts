import { describe, expect, it } from 'vitest';
import {
  LABEL_GLOW_STRENGTH_LIMIT,
  LABEL_LINE_HEIGHT_FACTOR,
  labelDecorationPadding,
  labelGlowBlurPx,
  labelGlowPasses,
  layoutLabelText,
  paintLabelCanvas,
  type LabelLayout,
} from './label-text-layout';

// 10 px per character keeps expected widths trivial to compute.
const measure = (text: string): number => text.length * 10;

const layout = (text: string, maxWidth = 0): LabelLayout =>
  layoutLabelText(text, measure, { fontSize: 16, maxWidth });

interface FillTextCall {
  text: string;
  x: number;
  y: number;
}

function fakeContext(): { ctx: CanvasRenderingContext2D; calls: FillTextCall[] } {
  const calls: FillTextCall[] = [];
  const ctx = {
    clearRect: () => undefined,
    fillText: (text: string, x: number, y: number) => {
      calls.push({ text, x, y });
    },
    fillStyle: '',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe('layoutLabelText', () => {
  it('keeps a short text as a single line', () => {
    const result = layout('hello');
    expect(result.lines.map(l => l.text)).toEqual(['hello']);
    expect(result.textWidth).toBe(50);
    expect(result.textHeight).toBe(16 * LABEL_LINE_HEIGHT_FACTOR);
    expect(result.totalChars).toBe(5);
  });

  it('splits on explicit newlines even without a wrap width', () => {
    const result = layout('one\ntwo three\n\nfour');
    expect(result.lines.map(l => l.text)).toEqual(['one', 'two three', '', 'four']);
    expect(result.textHeight).toBe(4 * 16 * LABEL_LINE_HEIGHT_FACTOR);
  });

  it('word-wraps paragraphs to the box width', () => {
    // 12 chars max per line at 10px/char.
    const result = layout('the quick brown fox jumps', 120);
    expect(result.lines.map(l => l.text)).toEqual(['the quick', 'brown fox', 'jumps']);
    expect(result.textWidth).toBe(90);
  });

  it('breaks a single oversized word mid-word instead of overflowing', () => {
    const result = layout('abcdefghij', 40);
    expect(result.lines.map(l => l.text)).toEqual(['abcd', 'efgh', 'ij']);
    for (const line of result.lines) {
      expect(line.width).toBeLessThanOrEqual(40);
    }
  });

  it('counts typewriter budget over drawn characters only', () => {
    const result = layout('aa bb\ncc', 20);
    // 'aa' / 'bb' / 'cc' — wrap and newline whitespace is not drawn.
    expect(result.totalChars).toBe(6);
  });
});

describe('paintLabelCanvas', () => {
  const paint = (overrides: Partial<Parameters<typeof paintLabelCanvas>[1]>): FillTextCall[] => {
    const { ctx, calls } = fakeContext();
    paintLabelCanvas(ctx, {
      layout: layout('aaa\nbb'),
      fontFamily: 'Arial',
      fontSize: 16,
      color: '#fff',
      align: 'left',
      vAlign: 'top',
      width: 200,
      height: 100,
      ...overrides,
    });
    return calls;
  };

  it('positions lines from the top with vAlign=top', () => {
    const calls = paint({});
    const lineHeight = 16 * LABEL_LINE_HEIGHT_FACTOR;
    expect(calls.map(c => c.text)).toEqual(['aaa', 'bb']);
    expect(calls[0].y).toBeCloseTo(lineHeight / 2);
    expect(calls[1].y).toBeCloseTo(lineHeight * 1.5);
  });

  it('centers the block with vAlign=middle and pins it down with bottom', () => {
    const lineHeight = 16 * LABEL_LINE_HEIGHT_FACTOR;
    const middle = paint({ vAlign: 'middle' });
    expect(middle[0].y).toBeCloseTo((100 - 2 * lineHeight) / 2 + lineHeight / 2);
    const bottom = paint({ vAlign: 'bottom' });
    expect(bottom[1].y).toBeCloseTo(100 - lineHeight / 2);
  });

  it('maps horizontal alignment to canvas anchor x', () => {
    expect(paint({ align: 'left' })[0].x).toBe(0);
    expect(paint({ align: 'center' })[0].x).toBe(100);
    expect(paint({ align: 'right' })[0].x).toBe(200);
  });

  it('clips to visibleCharacters across wrapped lines (typewriter)', () => {
    expect(paint({ visibleCharacters: 0 }).map(c => c.text)).toEqual([]);
    expect(paint({ visibleCharacters: 2 }).map(c => c.text)).toEqual(['aa']);
    expect(paint({ visibleCharacters: 4 }).map(c => c.text)).toEqual(['aaa', 'b']);
    expect(paint({ visibleCharacters: 99 }).map(c => c.text)).toEqual(['aaa', 'bb']);
  });
});

describe('label glow / outline decoration', () => {
  it('pads the canvas only when a glow or an outline is on, and grows with strength', () => {
    // Off by default — this is what keeps existing scenes pixel-identical.
    expect(labelDecorationPadding(32)).toBe(0);
    expect(labelDecorationPadding(32, 0, 0)).toBe(0);

    const subtle = labelDecorationPadding(32, 1);
    const strong = labelDecorationPadding(32, 3);
    expect(subtle).toBeGreaterThan(0);
    expect(strong).toBeGreaterThan(subtle);

    // A bigger font glows proportionally further, and an outline pads on its own.
    expect(labelDecorationPadding(64, 1)).toBeGreaterThan(subtle);
    expect(labelDecorationPadding(32, 0, 4)).toBeGreaterThan(0);
  });

  it('caps blur and passes at the strength limit', () => {
    expect(labelGlowBlurPx(32, 0)).toBe(0);
    expect(labelGlowBlurPx(32, 99)).toBe(labelGlowBlurPx(32, LABEL_GLOW_STRENGTH_LIMIT));
    expect(labelGlowPasses(0)).toBe(0);
    expect(labelGlowPasses(1)).toBe(1);
    expect(labelGlowPasses(99)).toBe(3);
  });

  it('paints an outline underlay and additive glow passes under the plain fill', () => {
    const fills: FillTextCall[] = [];
    const strokes: FillTextCall[] = [];
    const shadows: { color: string; blur: number }[] = [];
    let depth = 0;
    const ctx = {
      clearRect: () => undefined,
      save: () => {
        depth += 1;
      },
      restore: () => {
        depth -= 1;
      },
      fillText: (text: string, x: number, y: number) => {
        if (depth > 0) {
          shadows.push({ color: String(ctx.shadowColor), blur: Number(ctx.shadowBlur) });
        }
        fills.push({ text, x, y });
      },
      strokeText: (text: string, x: number, y: number) => {
        strokes.push({ text, x, y });
      },
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      lineJoin: 'miter',
      miterLimit: 10,
      shadowColor: '',
      shadowBlur: 0,
      font: '',
      textAlign: 'left',
      textBaseline: 'alphabetic',
    } as unknown as CanvasRenderingContext2D & { shadowColor: string; shadowBlur: number };

    paintLabelCanvas(ctx, {
      layout: layout('hi'),
      fontFamily: 'Arial',
      fontSize: 20,
      color: '#ffcf33',
      align: 'center',
      vAlign: 'middle',
      width: 100,
      height: 40,
      glowStrength: 2,
      outlineColor: '#101014',
      outlineWidth: 2,
    });

    // Outline once per line, two glow passes (strength 2), then the plain fill.
    expect(strokes.map(s => s.text)).toEqual(['hi']);
    expect(fills.map(f => f.text)).toEqual(['hi', 'hi', 'hi']);
    expect(shadows).toHaveLength(2);
    // An empty glowColor falls back to the text colour.
    expect(shadows[0].color).toBe('#ffcf33');
    expect(shadows[0].blur).toBeCloseTo(labelGlowBlurPx(20, 2), 6);
    // The shadow state is scoped: the final fill runs outside the save/restore.
    expect(depth).toBe(0);
    expect(ctx.lineWidth).toBe(4);
    expect(ctx.strokeStyle).toBe('#101014');
  });
});
