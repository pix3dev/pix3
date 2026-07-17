import { describe, expect, it } from 'vitest';
import {
  LABEL_LINE_HEIGHT_FACTOR,
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
  const paint = (
    overrides: Partial<Parameters<typeof paintLabelCanvas>[1]>
  ): FillTextCall[] => {
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
