import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  chromaKeyImage,
  colorLuminance,
  extractPalette,
  extractStylePalette,
  hexToRgb,
  opaqueBounds,
  pickStylePalette,
  quantizePixels,
  rgbToHsl,
  readImagePixels,
  rgbToHex,
  samplePixelColor,
  sliceImageBlob,
  stylePaletteFromPixels,
  tintImage,
  tintPixelsInPlace,
  type ImagePixels,
  type PaletteSwatch,
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
const pixelRow = (
  colors: ReadonlyArray<readonly [number, number, number, number]>
): ImagePixels => {
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

/**
 * The picker is the half that keeps a neon reference neon. Coverage order alone handed the role
 * mapper five shades of the backdrop (`#564979, #003f65, #01507d, #4d2400, #3b004b` off a synthwave
 * mock), so the properties proven here are the ones the roles depend on: the ground colour lands at
 * index 0, the colour that must POP lands last, the middle is not five samples of one glow, and a
 * reference with nothing to pick still yields a full palette instead of throwing.
 */

/** mulberry32 — a tiny seeded PRNG so the fuzz below is the same run every time. */
const seededRandom = (seed: number): (() => number) => {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Smallest RGB distance between any two colours of a palette. */
const minPairDistance = (palette: readonly string[]): number => {
  let min = Infinity;
  for (let i = 0; i < palette.length; i += 1) {
    for (let j = i + 1; j < palette.length; j += 1) {
      const a = hexToRgb(palette[i]);
      const b = hexToRgb(palette[j]);
      if (!a || !b) {
        throw new Error(`bad palette hex ${palette[i]}/${palette[j]}`);
      }
      min = Math.min(min, Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2));
    }
  }
  return min;
};

describe('pickStylePalette', () => {
  const swatch = (hex: string, weight: number): PaletteSwatch => {
    const color = hexToRgb(hex);
    if (!color) {
      throw new Error(`bad test hex ${hex}`);
    }
    return { color, hex, weight };
  };

  const hueOf = (hex: string): number => {
    const color = hexToRgb(hex);
    if (!color) {
      throw new Error(`bad test hex ${hex}`);
    }
    return rgbToHsl(color).h;
  };

  /** Shortest angular hue distance, mirroring what the picker dedupes on. */
  const hueGap = (a: string, b: string): number => {
    const diff = Math.abs(hueOf(a) - hueOf(b)) % 360;
    return diff > 180 ? 360 - diff : diff;
  };

  /** Euclidean RGB distance between two hexes — the separation the palette must never violate. */
  const distance = (a: string, b: string): number => {
    const left = hexToRgb(a);
    const right = hexToRgb(b);
    if (!left || !right) {
      throw new Error(`bad test hex ${a}/${b}`);
    }
    return Math.sqrt((left.r - right.r) ** 2 + (left.g - right.g) ** 2 + (left.b - right.b) ** 2);
  };

  /** A synthwave-shaped reference: most of the frame is dark purple, the life of it is not. */
  const neon = (): PaletteSwatch[] => [
    swatch('#1a0b2e', 0.6), // dominant backdrop
    swatch('#241040', 0.12), // second-most-covering, but the SAME backdrop a shade along
    swatch('#ff2fa0', 0.1), // pink
    swatch('#2ff0ff', 0.09), // cyan glow
    swatch('#ffd23f', 0.06), // gold coins
    swatch('#7a2f8f', 0.03), // mid purple
  ];

  it('puts the ground colour first and the accent that pops hardest last', () => {
    const palette = pickStylePalette(neon(), 5);

    expect(palette).toHaveLength(5);
    expect(palette[0]).toBe('#1a0b2e');
    // The player colour must pop off index 0. Pink and cyan are equally saturated and equally lit,
    // and the old picker let coverage (0.10 vs 0.09) hand pink the slot; the role-aware picker
    // measures what actually reads on the ground — cyan's WCAG contrast against `#1a0b2e` is 13,
    // pink's 6.6 — so the ball is cyan and pink is the hazard. Intended change.
    expect(palette[4]).toBe('#2ff0ff');
    expect(palette[3]).toBe('#ff2fa0');
    // The collectible slot (index 1) is the picture's gold — a warm colour is claimed for it before
    // the hazard search can spend it as "the farthest hue".
    expect(palette[1]).toBe('#ffd23f');
    // The ui slot (index 2) is the remaining hue, the mid purple — raised to L ≥ 0.6 so HUD text in
    // it reads on the ground, rather than the shadow-dark `#7a2f8f` as measured. Intended change.
    const ui = hexToRgb(palette[2]) ?? { r: 0, g: 0, b: 0 };
    expect(Math.abs(rgbToHsl(ui).h - hueOf('#7a2f8f'))).toBeLessThan(2);
    expect(rgbToHsl(ui).l).toBeGreaterThanOrEqual(0.6);
  });

  it('does not spend an accent slot on the background wearing another shade', () => {
    // `#241040` out-covers every accent, and coverage-first quantization is exactly why the old
    // palette was five browns. It is within the merge distance of `#1a0b2e`, so it is not an accent.
    expect(pickStylePalette(neon(), 5)).not.toContain('#241040');
  });

  it('keeps the accents on distinct hues', () => {
    const palette = pickStylePalette(neon(), 5);
    const accents = palette.slice(1);
    for (let i = 0; i < accents.length; i += 1) {
      for (let j = i + 1; j < accents.length; j += 1) {
        expect(hueGap(accents[i], accents[j])).toBeGreaterThanOrEqual(28);
      }
    }
  });

  it('skips a second copy of a hue it already picked', () => {
    const palette = pickStylePalette(
      [
        swatch('#101010', 0.7),
        swatch('#ff2fa0', 0.1),
        swatch('#f52f96', 0.09), // ~1.4° from the pink above
        swatch('#2ff0ff', 0.06),
      ],
      3
    );

    // Three slots = [ground, hazard, player]. `#f52f96` is skipped as a copy of the pink; cyan is the
    // player because it reads harder on the ground (see the test above). Intended change of order.
    expect(palette).toEqual(['#101010', '#ff2fa0', '#2ff0ff']);
  });

  /**
   * The live failure this design round fixed. `references/mood-2.png` was a neon phone MOCKUP: the
   * game is the bright screen, but ~60% of the pixels are the black device body, so coverage handed
   * the role mapper `#363d55, #000201, #010100, #060813, #eec2ae` — three near-blacks holding the
   * hazard and UI slots.
   */
  const phoneMockup = (): PaletteSwatch[] => [
    swatch('#000201', 0.3), // device body
    swatch('#010100', 0.2), // device body, another box
    swatch('#060813', 0.1), // the bezel's faint blue
    swatch('#1a0b2e', 0.2), // the GAME's background — dark, but lit and tinted
    swatch('#ff2fa0', 0.08),
    swatch('#2ff0ff', 0.07),
    swatch('#ffd23f', 0.05),
  ];

  it('treats the black device body as scenery, not as the game background', () => {
    const palette = pickStylePalette(phoneMockup(), 5);

    expect(palette[0]).toBe('#1a0b2e');
    expect(palette).not.toContain('#000201');
    expect(palette).not.toContain('#010100');
    expect(palette).not.toContain('#060813');
  });

  it('fills the accent slots from the screen, not from the frame', () => {
    const palette = pickStylePalette(phoneMockup(), 5);

    expect(palette).toHaveLength(5);
    expect(palette).toContain('#ff2fa0');
    expect(palette).toContain('#2ff0ff');
    expect(palette).toContain('#ffd23f');
    // The pop colour is the accent that reads hardest on the ground (cyan, contrast 13 vs pink's
    // 6.6 — an intended change from coverage order), and the hazard slot is the other neon — never
    // a near-black.
    expect(palette[4]).toBe('#2ff0ff');
    expect(palette[3]).toBe('#ff2fa0');
    // A fourth accent does not exist in the reference, so it is INVENTED from the best one rather
    // than back-filled with a rejected dark box.
    for (const hex of palette.slice(1)) {
      const color = hexToRgb(hex);
      expect(color).not.toBeNull();
      expect(rgbToHsl(color ?? { r: 0, g: 0, b: 0 }).l).toBeGreaterThanOrEqual(0.12);
    }
  });

  it('never returns two colours closer than 24 in RGB', () => {
    for (const set of [neon(), phoneMockup()]) {
      const palette = pickStylePalette(set, 5);
      for (let i = 0; i < palette.length; i += 1) {
        for (let j = i + 1; j < palette.length; j += 1) {
          expect(distance(palette[i], palette[j])).toBeGreaterThanOrEqual(24);
        }
      }
    }
  });

  it('pads a near-monochrome reference with lightness variants, never with more of the ground', () => {
    // Nothing here is saturated and nothing is far from the background, so every filter rejects
    // everything — the picker must invent a ramp rather than hand the role mapper five near-greys
    // it cannot tell apart.
    const palette = pickStylePalette(
      [
        swatch('#3a3a3a', 0.5),
        swatch('#404040', 0.2),
        swatch('#454545', 0.15),
        swatch('#4a4a4a', 0.1),
        swatch('#505050', 0.05),
      ],
      5
    );

    expect(palette).toHaveLength(5);
    expect(palette[0]).toBe('#3a3a3a');
    // The measured shades are all within 48 of the ground, so none of them may appear.
    expect(palette.slice(1)).not.toContain('#404040');
    for (let i = 0; i < palette.length; i += 1) {
      for (let j = i + 1; j < palette.length; j += 1) {
        expect(distance(palette[i], palette[j])).toBeGreaterThanOrEqual(24);
      }
    }
  });

  it('takes accents from an explicit pool when one is given', () => {
    // The shipping path: the background is measured over the whole frame, the accents over a second
    // quantization of only its colourful pixels — where the minority neon screen has a majority.
    const palette = pickStylePalette([swatch('#000201', 0.75), swatch('#1a0b2e', 0.25)], 3, [
      swatch('#2ff0ff', 0.6),
      swatch('#ff2fa0', 0.4),
    ]);

    // Ground, then the second accent, then the strongest — the role mapper's index contract.
    expect(palette).toEqual(['#1a0b2e', '#ff2fa0', '#2ff0ff']);
  });

  it('returns nothing for an empty input and a full palette for a thin one', () => {
    expect(pickStylePalette([], 5)).toEqual([]);

    const thin = pickStylePalette([swatch('#1a0b2e', 0.8), swatch('#ff2fa0', 0.2)], 5);
    expect(thin).toHaveLength(5);
    expect(thin[0]).toBe('#1a0b2e');
    expect(thin[4]).toBe('#ff2fa0');
  });

  it('is deterministic for the same input', () => {
    expect(pickStylePalette(neon(), 5)).toEqual(pickStylePalette(neon(), 5));
  });

  /** HSL lightness of a hex. */
  const lightnessOf = (hex: string): number => {
    const color = hexToRgb(hex);
    if (!color) {
      throw new Error(`bad test hex ${hex}`);
    }
    return rgbToHsl(color).l;
  };

  /**
   * The corpus lesson. On a painted pinball mockup the shadow side of the purple board is 30% of the
   * picture and saturated; the neon strokes a person names are 1–2%. The old score multiplied by
   * `coverage^0.35`, so it returned `#364078 #28134c #4a0856 #085b7a #da96c2` — three shadows.
   */
  const paintedMockup = (): PaletteSwatch[] => [
    swatch('#0d0a1f', 0.5), // ground
    swatch('#3a0a5c', 0.3), // large, saturated, DARK — the board's shadow side
    swatch('#1a2a6b', 0.1), // large saturated navy gutter
    swatch('#4aeef7', 0.02), // the neon cyan ball
    swatch('#fde940', 0.015), // gold "+25"
    swatch('#f36f8f', 0.01), // hot pink bumper rim
  ];

  it('never lets a large dark saturated region beat a small bright accent', () => {
    const palette = pickStylePalette(paintedMockup(), 5);

    expect(palette[0]).toBe('#0d0a1f');
    expect(palette).not.toContain('#3a0a5c');
    expect(palette).not.toContain('#1a2a6b');
    expect(palette).toContain('#4aeef7');
    expect(palette).toContain('#fde940');
    expect(palette).toContain('#f36f8f');
    // The player is one of the neons, whatever their coverage.
    expect(['#4aeef7', '#fde940', '#f36f8f']).toContain(palette[4]);
  });

  it('keeps every accent above the lightness floor while brighter vivid colours exist', () => {
    // Even the slot the three neons leave open is filled from a *raised* purple, not from the
    // navy or the shadow as measured.
    for (const hex of pickStylePalette(paintedMockup(), 5).slice(1)) {
      expect(lightnessOf(hex)).toBeGreaterThanOrEqual(0.45);
    }
  });

  it('assigns roles by what the colour is for, not by rank', () => {
    const five = pickStylePalette(neon(), 5);
    // [bg, collectible, ui, hazard, player]: the warm colour is the collectible…
    expect(five[1]).toBe('#ffd23f');
    // …and no accent shares a hue with the player within the spacing.
    expect(hueGap(five[4], five[3])).toBeGreaterThanOrEqual(28);

    // Shorter palettes drop roles from the middle first, keeping the contract's ends intact.
    expect(pickStylePalette(neon(), 4)).toEqual(['#1a0b2e', '#ffd23f', '#ff2fa0', '#2ff0ff']);
    expect(pickStylePalette(neon(), 3)).toEqual(['#1a0b2e', '#ff2fa0', '#2ff0ff']);
    expect(pickStylePalette(neon(), 2)).toEqual(['#1a0b2e', '#2ff0ff']);
    expect(pickStylePalette(neon(), 1)).toEqual(['#1a0b2e']);
  });

  it('does not invent a hue that is not in the picture', () => {
    // A two-hue reference (teal + orange): the two missing slots are lightness variants of those
    // hues, not a complementary colour conjured to make the palette look spread.
    const palette = pickStylePalette(
      [swatch('#164246', 0.9), swatch('#77f3f5', 0.06), swatch('#e79a3d', 0.04)],
      5
    );

    expect(palette).toHaveLength(5);
    for (const hex of palette.slice(1)) {
      const nearTeal = hueGap(hex, '#77f3f5') <= 8;
      const nearOrange = hueGap(hex, '#e79a3d') <= 8;
      expect(nearTeal || nearOrange).toBe(true);
    }
    // The two middle slots do not both wear the same hue when two exist.
    expect(hueGap(palette[1], palette[2])).toBeGreaterThan(28);
  });

  it('does not spend the only warm colour on the player when a collectible slot is waiting', () => {
    // Gold reads harder than magenta on this ground, but the contrast swap that would make it the
    // player yields to the collectible slot: coins are gold, the ball is the other neon.
    const palette = pickStylePalette(
      [
        swatch('#1e1c33', 0.8),
        swatch('#e63cd2', 0.1), // magenta, most prominent
        swatch('#e8ad32', 0.05), // gold, higher contrast
        swatch('#3cccd9', 0.05), // cyan
      ],
      5
    );

    expect(palette[1]).toBe('#e8ad32');
    expect(palette[4]).toBe('#e63cd2');
  });

  it('yields five distinct colours from a reference with a single usable hue', () => {
    // The invention path's failure class: every lightness target of the one hue lifts to the same
    // first legible lightness, so the old code fell through to a fixed gold — pushed without a
    // separation check, hence `#423006 #423006` and `#4b3b06 ×3`. Now every rung of the hue's
    // lightness ladder is a candidate and the floor is checked before anything is pushed.
    const cases: PaletteSwatch[][] = [
      [swatch('#808080', 1)],
      [swatch('#cd6c51', 0.97), swatch('#080606', 0.03)],
      [swatch('#a39512', 1)],
      [swatch('#d97490', 1)],
    ];
    for (const set of cases) {
      const palette = pickStylePalette(set, 5);
      expect(palette).toHaveLength(5);
      expect(minPairDistance(palette)).toBeGreaterThanOrEqual(24);
    }
  });

  it('keeps a grey reference grey — no fallback hue is invented', () => {
    const palette = pickStylePalette([swatch('#808080', 1)], 5);

    expect(palette).toHaveLength(5);
    for (const hex of palette) {
      const color = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
      expect(rgbToHsl(color).s).toBeLessThan(0.15);
    }
  });

  it('holds the separation floor across a seeded fuzz of swatch lists, deterministically', () => {
    // Random swatch lists (1–7 colours, counts 1–7, with and without an explicit accent pool).
    // Every palette must be pairwise ≥ 24 RGB apart and identical on a second call.
    const random = seededRandom(12345);
    const channel = (): number => Math.floor(random() * 256);
    for (let run = 0; run < 400; run += 1) {
      const size = 1 + Math.floor(random() * 7);
      const raw = Array.from({ length: size }, () => ({
        color: { r: channel(), g: channel(), b: channel() },
        weight: random(),
      }));
      const total = raw.reduce((sum, entry) => sum + entry.weight, 0);
      const swatches: PaletteSwatch[] = raw.map(entry => ({
        color: entry.color,
        hex: rgbToHex(entry.color),
        weight: entry.weight / total,
      }));
      const count = 1 + Math.floor(random() * 7);
      const accents =
        random() < 0.5 ? undefined : swatches.slice(0, Math.max(1, Math.floor(random() * size)));

      const palette = pickStylePalette(swatches, count, accents);
      expect(palette).toHaveLength(count);
      expect(minPairDistance(palette)).toBeGreaterThanOrEqual(24);
      expect(pickStylePalette(swatches, count, accents)).toEqual(palette);
    }
  });
});

/**
 * The pixel-level pipeline the editor runs after decoding (`stylePaletteFromPixels`): whole-frame
 * quantization for the ground, a hue histogram of the vivid pixels for the accents, role fill. Built
 * from raw RGBA so the histogram — not a hand-made swatch list — is what is under test.
 */
describe('stylePaletteFromPixels', () => {
  const fill = (
    into: Array<readonly [number, number, number, number]>,
    hex: string,
    count: number
  ): void => {
    const color = hexToRgb(hex);
    if (!color) {
      throw new Error(`bad test hex ${hex}`);
    }
    for (let index = 0; index < count; index += 1) {
      into.push([color.r, color.g, color.b, 255]);
    }
  };

  /** 5000 px of ground, 3000 px of saturated shadow, and ~1.5% of neon strokes. */
  const paintedMockup = (): ImagePixels => {
    const colors: Array<readonly [number, number, number, number]> = [];
    fill(colors, '#0d0a1f', 5000);
    fill(colors, '#3a0a5c', 3000);
    fill(colors, '#4aeef7', 60);
    fill(colors, '#fde940', 40);
    fill(colors, '#f36f8f', 30);
    return pixelRow(colors);
  };

  it('finds the neon strokes under a large dark saturated region', () => {
    const palette = stylePaletteFromPixels(paintedMockup(), 5);

    expect(palette).toHaveLength(5);
    expect(palette[0]).toBe('#0d0a1f');
    expect(palette).not.toContain('#3a0a5c');
    expect(palette).toContain('#4aeef7');
    expect(palette).toContain('#fde940');
    expect(palette).toContain('#f36f8f');
    for (const hex of palette.slice(1)) {
      const color = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
      expect(rgbToHsl(color).l).toBeGreaterThanOrEqual(0.45);
    }
  });

  it('represents a hue by its bright core, not by the average of its shadow', () => {
    // One hue, mostly shadow: 2000 px of dark magenta and 100 px of the neon it fades from. A
    // median cut over these averages them into a muddy mid-tone; the histogram bin is represented
    // by its brightest-chroma third, so the accent IS the neon.
    const colors: Array<readonly [number, number, number, number]> = [];
    fill(colors, '#101020', 4000);
    fill(colors, '#5a0a4a', 2000);
    fill(colors, '#ff2fa0', 100);
    const palette = stylePaletteFromPixels(pixelRow(colors), 3);

    expect(palette).toEqual(['#101020', expect.any(String), '#ff2fa0']);
  });

  it('is deterministic for the same pixels', () => {
    const first = stylePaletteFromPixels(paintedMockup(), 5);
    const second = stylePaletteFromPixels(paintedMockup(), 5);
    expect(first).toEqual(second);
  });

  it('returns nothing for an image with no opaque pixels', () => {
    expect(stylePaletteFromPixels(pixelRow([[255, 0, 0, 0]]), 5)).toEqual([]);
  });

  it('yields five distinct colours from a one- or two-colour image, in the picture’s own hues', () => {
    const solidMagenta = pixelRow([[255, 0, 255, 255]]);
    const solidRed: Array<readonly [number, number, number, number]> = [];
    fill(solidRed, '#f20929', 4096);
    const twoColour: Array<readonly [number, number, number, number]> = [];
    fill(twoColour, '#4fb0fa', 2048);
    fill(twoColour, '#bd076f', 2048);
    const greyRamp = pixelRow(
      Array.from({ length: 4096 }, (_, index): readonly [number, number, number, number] => {
        const value = Math.floor(index / 64) * 4;
        return [value, value, value, 255];
      })
    );

    for (const pixels of [solidMagenta, pixelRow(solidRed), pixelRow(twoColour), greyRamp]) {
      const palette = stylePaletteFromPixels(pixels, 5);
      expect(palette).toHaveLength(5);
      expect(minPairDistance(palette)).toBeGreaterThanOrEqual(24);
    }

    // One hue in, one hue out: every slot of the magenta image is a magenta.
    for (const hex of stylePaletteFromPixels(solidMagenta, 5)) {
      const color = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
      expect(Math.abs(rgbToHsl(color).h - 300)).toBeLessThanOrEqual(8);
    }
    // …and the grey ramp stays grey.
    for (const hex of stylePaletteFromPixels(greyRamp, 5)) {
      const color = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
      expect(rgbToHsl(color).s).toBeLessThan(0.15);
    }
  });

  it('holds the separation floor across a seeded fuzz of small images', () => {
    const random = seededRandom(777);
    const channel = (): number => Math.floor(random() * 256);
    for (let run = 0; run < 100; run += 1) {
      const width = 1 + Math.floor(random() * 40);
      const height = 1 + Math.floor(random() * 40);
      const colours = Array.from({ length: 1 + Math.floor(random() * 4) }, () => [
        channel(),
        channel(),
        channel(),
      ]);
      const data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const [r, g, b] = colours[(x * 7 + y * 3) % colours.length];
          const offset = (y * width + x) * 4;
          data[offset] = r;
          data[offset + 1] = g;
          data[offset + 2] = b;
          data[offset + 3] = 255;
        }
      }
      const palette = stylePaletteFromPixels({ width, height, data }, 5);
      expect(palette).toHaveLength(5);
      expect(minPairDistance(palette)).toBeGreaterThanOrEqual(24);
    }
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

  /**
   * The whole shipping path in one: a phone-mockup reference where the device body is most of the
   * image. The accents must come out of the *screen*, which only the second quantization (over the
   * colourful pixels alone) ever gets to see.
   */
  it('measures a mockup reference from its screen, not from its device body', async () => {
    const black: readonly [number, number, number, number] = [0, 2, 1, 255];
    const bezel: readonly [number, number, number, number] = [6, 8, 19, 255];
    const ground: readonly [number, number, number, number] = [26, 11, 46, 255];
    stubDecode(
      pixelRow([
        black,
        black,
        black,
        black,
        black,
        black,
        black,
        black,
        bezel,
        bezel,
        bezel,
        bezel,
        ground,
        ground,
        ground,
        ground,
        [255, 47, 160, 255],
        [255, 47, 160, 255],
        [47, 240, 255, 255],
        [255, 210, 63, 255],
      ])
    );

    const palette = await extractStylePalette(new Blob(['ref']), 5);

    expect(palette).toHaveLength(5);
    expect(palette[0]).toBe('#1a0b2e');
    // Cyan reads hardest on the purple ground, so it is the player (intended change from coverage
    // order); the pink and the gold hold the hazard and collectible slots.
    expect(palette[4]).toBe('#2ff0ff');
    expect(palette[3]).toBe('#ff2fa0');
    expect(palette[1]).toBe('#ffd23f');
    expect(palette.some(hex => hex === '#000201' || hex === '#060813')).toBe(false);
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

describe('opaqueBounds', () => {
  /** A `width`x`height` transparent image with one opaque rect painted into it. */
  const withRect = (
    width: number,
    height: number,
    rect: { x: number; y: number; w: number; h: number },
    alpha = 255
  ): ImagePixels => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        data[(y * width + x) * 4 + 3] = alpha;
      }
    }
    return { width, height, data };
  };

  it('returns the bounding box of the opaque pixels, inclusive of the last row/column', () => {
    expect(opaqueBounds(withRect(16, 10, { x: 3, y: 2, w: 5, h: 4 }))).toEqual({
      x: 3,
      y: 2,
      width: 5,
      height: 4,
    });
  });

  it('returns null when nothing is opaque', () => {
    expect(opaqueBounds({ width: 4, height: 4, data: new Uint8ClampedArray(64) })).toBeNull();
  });

  it('treats alpha at or below the threshold as empty', () => {
    const haloed = withRect(8, 8, { x: 0, y: 0, w: 8, h: 8 }, 6);
    // The halo counts as content at threshold 0 and disappears at 8 — which is why the crop tool
    // opens with a threshold rather than at 0.
    expect(opaqueBounds(haloed, 0)).toEqual({ x: 0, y: 0, width: 8, height: 8 });
    expect(opaqueBounds(haloed, 8)).toBeNull();
  });

  it('finds a single opaque pixel', () => {
    expect(opaqueBounds(withRect(5, 5, { x: 4, y: 0, w: 1, h: 1 }))).toEqual({
      x: 4,
      y: 0,
      width: 1,
      height: 1,
    });
  });
});
