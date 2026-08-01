import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sliceImageBlob } from './image-ops';

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
