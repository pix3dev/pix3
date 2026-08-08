import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chromaKeyImage, readImagePixels, samplePixelColor, sliceImageBlob } from './image-ops';

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
