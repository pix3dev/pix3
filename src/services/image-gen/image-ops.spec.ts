import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  chromaKeyImage,
  colorLuminance,
  extractPalette,
  hexToRgb,
  quantizePixels,
  readImagePixels,
  rgbToHex,
  samplePixelColor,
  sliceImageBlob,
  tintImage,
  tintPixelsInPlace,
  type ImagePixels,
} from './image-ops';

interface DrawCall {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dw: number;
  dh: number;
}

/**
 * `sliceImageBlob` is pure raster work, so the interesting behaviour (cell count, ordering, source
 * rectangles) is observable through the canvas calls it makes. happy-dom has no real canvas or
 * `createImageBitmap`, so both are stubbed with recording doubles.
 */
describe('sliceImageBlob', () => {
  let drawCalls: DrawCall[] = [];
  let createElementSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    drawCalls = [];
    vi.stubGlobal('createImageBitmap', async () => ({
      width: 100,
      height: 40,
      close: () => {},
    }));

    createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName !== 'canvas') {
        throw new Error(`unexpected createElement(${tagName})`);
      }
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low',
          drawImage: (
            _bitmap: unknown,
            sx: number,
            sy: number,
            sw: number,
            sh: number,
            _dx: number,
            _dy: number,
            dw: number,
            dh: number
          ) => {
            drawCalls.push({ sx, sy, sw, sh, dw, dh });
          },
        }),
        toBlob: (callback: (blob: Blob | null) => void) => {
          callback(new Blob([`cell-${drawCalls.length}`], { type: 'image/png' }));
        },
      };
      return canvas as unknown as HTMLElement;
    }) as unknown as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    createElementSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('produces columns × rows cells in row-major order', async () => {
    const cells = await sliceImageBlob(new Blob(), { columns: 4, rows: 2 });

    expect(cells).toHaveLength(8);
    // 100 / 4 = 25 wide, 40 / 2 = 20 tall.
    expect(drawCalls[0]).toMatchObject({ sx: 0, sy: 0, sw: 25, sh: 20, dw: 25, dh: 20 });
    expect(drawCalls[1]).toMatchObject({ sx: 25, sy: 0 });
    expect(drawCalls[3]).toMatchObject({ sx: 75, sy: 0 });
    // Second row starts back at x=0.
    expect(drawCalls[4]).toMatchObject({ sx: 0, sy: 20 });
    expect(drawCalls[7]).toMatchObject({ sx: 75, sy: 20 });
  });

  it('keeps fractional cells whole by rounding the output size up', async () => {
    await sliceImageBlob(new Blob(), { columns: 3, rows: 1 });

    // 100 / 3 = 33.33 — the source rect stays fractional so nothing is skipped, while the output
    // canvas rounds to whole pixels.
    expect(drawCalls[0].sw).toBeCloseTo(100 / 3);
    expect(drawCalls[0].dw).toBe(33);
    expect(drawCalls[2].sx).toBeCloseTo((100 / 3) * 2);
  });

  it('clamps degenerate grids to a single cell', async () => {
    const cells = await sliceImageBlob(new Blob(), { columns: 0, rows: -3 });

    expect(cells).toHaveLength(1);
    expect(drawCalls[0]).toMatchObject({ sx: 0, sy: 0, sw: 100, sh: 40 });
  });
});

/**
 * §9.12.3. The distance maths, the ramp and the alpha bookkeeping are the whole
 * function, so nothing here is doubled except the two browser APIs happy-dom
 * lacks (`createImageBitmap` and the 2D canvas) — and those stand over a real
 * RGBA buffer, so the shipping loop runs over real bytes.
 *
 * The greys are chosen so the arithmetic is exact against a **black** key: a grey
 * of value v sits at distance v·√3, i.e. at exactly v/255 of the maximum RGB
 * distance. So 51 is 20 % away, 102 is 40 %, 204 is 80 %.
 */
describe('chromaKeyImage', () => {
  const BLACK = { r: 0, g: 0, b: 0 };

  /** RGBA bytes for a 1-pixel-tall strip of `[grey, alpha]` pairs. */
  function strip(pixels: ReadonlyArray<[number, number]>): Uint8ClampedArray {
    const data = new Uint8ClampedArray(pixels.length * 4);
    pixels.forEach(([grey, alpha], index) => {
      data[index * 4] = grey;
      data[index * 4 + 1] = grey;
      data[index * 4 + 2] = grey;
      data[index * 4 + 3] = alpha;
    });
    return data;
  }

  /**
   * Stand up the decode path over `data`. Returns the same array the function
   * mutates in place, which is how the assertions read the keyed result.
   */
  function stubDecode(data: Uint8ClampedArray, width: number, height = 1): Uint8ClampedArray {
    vi.stubGlobal('createImageBitmap', async () => ({ width, height, close: () => undefined }));
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName !== 'canvas') {
        throw new Error(`unexpected createElement(${tagName})`);
      }
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low',
          drawImage: () => undefined,
          getImageData: () => ({ data, width, height }),
          putImageData: () => undefined,
        }),
        toBlob: (callback: (blob: Blob | null) => void) =>
          callback(new Blob(['keyed'], { type: 'image/png' })),
      } as unknown as HTMLElement;
    });
    return data;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('cuts hard at the tolerance and leaves everything past it untouched', async () => {
    // 0 % away, 20 %, 40 %, 80 % — plus a pixel that is already transparent.
    const data = stubDecode(
      strip([
        [0, 255],
        [51, 255],
        [102, 255],
        [204, 255],
        [0, 0],
      ]),
      5
    );

    const result = await chromaKeyImage(new Blob(['src']), BLACK, { tolerance: 0.25 });

    expect([...data].filter((_byte, index) => index % 4 === 3)).toEqual([0, 0, 255, 255, 0]);
    // The already-transparent pixel is skipped, not counted a second time.
    expect(result.keyedPixels).toBe(2);
    expect(result.softenedPixels).toBe(0);
    expect(result.width).toBe(5);
    expect(result.blob.type).toBe('image/png');
  });

  it('ramps alpha across the soft band instead of cutting', async () => {
    const data = stubDecode(
      strip([
        [0, 255],
        [51, 255],
        [102, 255],
        [204, 255],
      ]),
      4
    );

    const result = await chromaKeyImage(new Blob(['src']), BLACK, {
      tolerance: 0.25,
      softness: 0.25,
    });

    // 40 % is exactly 60 % of the way across a band running 25 % → 50 %:
    // (0.40 − 0.25) / 0.25 = 0.6, so 255 · 0.6 = 153.
    expect([...data].filter((_byte, index) => index % 4 === 3)).toEqual([0, 0, 153, 255]);
    expect(result.keyedPixels).toBe(2);
    expect(result.softenedPixels).toBe(1);
  });

  it('scales existing alpha rather than overwriting it', async () => {
    // Re-keying an already cut-out image must not resurrect its transparency.
    const data = stubDecode(strip([[102, 100]]), 1);

    await chromaKeyImage(new Blob(['src']), BLACK, { tolerance: 0.25, softness: 0.25 });

    expect(data[3]).toBe(60); // 100 · 0.6, not 153.
  });

  it('reads a pixel colour back out of a decoded image', async () => {
    stubDecode(
      strip([
        [10, 255],
        [200, 255],
      ]),
      2
    );

    const pixels = await readImagePixels(new Blob(['src']));
    if (!pixels) {
      throw new Error('no pixels decoded');
    }

    expect(pixels).toMatchObject({ width: 2, height: 1 });
    // Floats floor into the pixel they are inside — 1.9 is still pixel 1.
    expect(samplePixelColor(pixels, 1.9, 0.4)).toEqual({ r: 200, g: 200, b: 200 });
    expect(samplePixelColor(pixels, 0, 0)).toEqual({ r: 10, g: 10, b: 10 });
    // Outside the image is "no colour", never a clamped edge pixel.
    expect(samplePixelColor(pixels, 2, 0)).toBeNull();
    expect(samplePixelColor(pixels, -1, 0)).toBeNull();
  });
});

/** Build an {@link ImagePixels} out of `[r,g,b,a]` tuples, one row tall. */
const pixelRow = (colors: ReadonlyArray<readonly [number, number, number, number]>): ImagePixels => {
  const data = new Uint8ClampedArray(colors.length * 4);
  colors.forEach(([r, g, b, a], index) => {
    data[index * 4] = r;
    data[index * 4 + 1] = g;
    data[index * 4 + 2] = b;
    data[index * 4 + 3] = a;
  });
  return { width: colors.length, height: 1, data };
};

describe('hex colour helpers', () => {
  it('round-trips a colour through hex', () => {
    expect(rgbToHex({ r: 255, g: 207, b: 51 })).toBe('#ffcf33');
    expect(hexToRgb('#ffcf33')).toEqual({ r: 255, g: 207, b: 51 });
  });

  it('accepts short hex and a missing hash', () => {
    expect(hexToRgb('f0a')).toEqual({ r: 255, g: 0, b: 170 });
    expect(hexToRgb('#F0A')).toEqual({ r: 255, g: 0, b: 170 });
  });

  it('rejects anything that is not a colour instead of guessing black', () => {
    expect(hexToRgb('')).toBeNull();
    expect(hexToRgb('#12345')).toBeNull();
    expect(hexToRgb('deep blue')).toBeNull();
  });

  it('clamps and rounds out-of-range channels when formatting', () => {
    expect(rgbToHex({ r: -20, g: 300, b: 15.6 })).toBe('#00ff10');
  });

  it('orders colours light to dark by luminance', () => {
    expect(colorLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(255);
    expect(colorLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
    // Green reads far brighter than blue at the same channel value (BT.601 weights).
    expect(colorLuminance({ r: 0, g: 200, b: 0 })).toBeGreaterThan(
      colorLuminance({ r: 0, g: 0, b: 200 })
    );
  });
});

/**
 * The quantizer is what makes Flow's palette deterministic — a model is never asked for hex codes —
 * so the properties under test are the ones a reviewer would want proven: the split lands on the
 * widest channel, coverage decides the order, transparency is not a colour, and the same input
 * always produces the same output.
 */
describe('quantizePixels', () => {
  it('separates clusters on the widest channel and orders them by coverage', () => {
    const palette = quantizePixels(
      pixelRow([
        [200, 0, 0, 255],
        [210, 0, 0, 255],
        [190, 0, 0, 255],
        [0, 0, 200, 255],
      ]),
      2
    );

    expect(palette).toHaveLength(2);
    expect(palette[0].hex).toBe('#c80000');
    expect(palette[0].weight).toBeCloseTo(0.75);
    expect(palette[1].hex).toBe('#0000c8');
    expect(palette[1].weight).toBeCloseTo(0.25);
  });

  it('ignores transparent pixels — a cut-out background is not a colour', () => {
    const palette = quantizePixels(
      pixelRow([
        [255, 255, 255, 0],
        [255, 255, 255, 4],
        [10, 20, 30, 255],
      ]),
      3
    );

    expect(palette).toHaveLength(1);
    expect(palette[0].hex).toBe('#0a141e');
  });

  it('returns fewer swatches than asked rather than inventing duplicates', () => {
    const flat = pixelRow([
      [40, 60, 80, 255],
      [40, 60, 80, 255],
    ]);

    expect(quantizePixels(flat, 5)).toHaveLength(1);
    expect(quantizePixels(pixelRow([]), 5)).toEqual([]);
  });

  it('is deterministic for the same input (no random seeding)', () => {
    const image = pixelRow([
      [12, 200, 90, 255],
      [240, 30, 30, 255],
      [12, 205, 95, 255],
      [30, 30, 240, 255],
      [250, 250, 250, 255],
    ]);

    const first = quantizePixels(image, 4);
    const second = quantizePixels(image, 4);
    expect(first.map(swatch => swatch.hex)).toEqual(second.map(swatch => swatch.hex));
  });

  it('samples with a stride instead of reading every pixel of a huge image', () => {
    // 10 pixels capped at 2 samples => stride 5 => only indices 0 and 5 are read.
    const palette = quantizePixels(
      pixelRow([
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 255, 0, 255],
        [0, 255, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [0, 255, 0, 255],
        [0, 255, 0, 255],
        [0, 255, 0, 255],
        [0, 255, 0, 255],
      ]),
      4,
      { maxSamples: 2 }
    );

    expect(palette.map(swatch => swatch.hex).sort()).toEqual(['#0000ff', '#ff0000']);
  });
});

describe('tintPixelsInPlace', () => {
  it('multiplies each channel and leaves alpha alone', () => {
    // White is multiply's identity, so a white pixel becomes the tint exactly.
    const data = new Uint8ClampedArray([255, 255, 255, 128, 128, 128, 128, 255]);

    tintPixelsInPlace(data, { r: 255, g: 128, b: 0 });

    expect([...data.slice(0, 4)]).toEqual([255, 128, 0, 128]);
    // 128 * 128 / 255 = 64.25 -> 64; 128 * 0 / 255 = 0.
    expect([...data.slice(4)]).toEqual([128, 64, 0, 255]);
  });

  it('mixes back toward the source at partial strength', () => {
    const data = new Uint8ClampedArray([200, 200, 200, 255]);

    tintPixelsInPlace(data, { r: 0, g: 0, b: 0 }, { strength: 0.5 });

    expect([...data]).toEqual([100, 100, 100, 255]);
  });

  it('skips fully transparent pixels so a cut-out keeps its empty field', () => {
    const data = new Uint8ClampedArray([255, 255, 255, 0]);

    tintPixelsInPlace(data, { r: 255, g: 0, b: 0 });

    expect([...data]).toEqual([255, 255, 255, 0]);
  });
});

/**
 * End-to-end over the same recording canvas double the chroma-key suite uses, so the shipping loop
 * runs over real bytes; happy-dom supplies neither `createImageBitmap` nor a 2D context.
 */
describe('extractPalette / tintImage over a stubbed canvas', () => {
  let buffer: Uint8ClampedArray = new Uint8ClampedArray();

  const stubDecode = (pixels: ImagePixels): void => {
    buffer = pixels.data;
    vi.stubGlobal('createImageBitmap', async () => ({
      width: pixels.width,
      height: pixels.height,
      close: () => undefined,
    }));
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName !== 'canvas') {
        throw new Error(`unexpected createElement(${tagName})`);
      }
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low',
          drawImage: () => undefined,
          getImageData: () => ({ data: buffer, width: pixels.width, height: pixels.height }),
          putImageData: () => undefined,
        }),
        toBlob: (callback: (blob: Blob | null) => void) =>
          callback(new Blob(['tinted'], { type: 'image/png' })),
      } as unknown as HTMLElement;
    });
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('extracts the dominant colours of a decoded image', async () => {
    stubDecode(
      pixelRow([
        [255, 0, 0, 255],
        [255, 0, 0, 255],
        [255, 0, 0, 255],
        [0, 0, 255, 255],
      ])
    );

    const palette = await extractPalette(new Blob(['ref']), 2);

    expect(palette.map(swatch => swatch.hex)).toEqual(['#ff0000', '#0000ff']);
  });

  it('tints a near-white placeholder to the requested colour', async () => {
    stubDecode(
      pixelRow([
        [255, 255, 255, 255],
        [128, 128, 128, 200],
      ])
    );

    const result = await tintImage(new Blob(['ph']), '#3366ff');

    expect(result.blob.type).toBe('image/png');
    expect([...buffer.slice(0, 4)]).toEqual([51, 102, 255, 255]);
    // Shading survives: the mid-grey stays half as bright as the white pixel, alpha untouched.
    expect([...buffer.slice(4)]).toEqual([26, 51, 128, 200]);
  });

  it('returns the source untouched for a colour it cannot parse', async () => {
    stubDecode(pixelRow([[255, 255, 255, 255]]));
    const source = new Blob(['ph']);

    const result = await tintImage(source, 'not a colour');

    expect(result.blob).toBe(source);
    expect([...buffer]).toEqual([255, 255, 255, 255]);
  });
});
