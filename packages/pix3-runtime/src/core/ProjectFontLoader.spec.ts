import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadProjectFonts, resetProjectFontRegistry } from './ProjectFontLoader';

/**
 * The loader exists so a caption is never painted in a substituted face. These pin the two
 * properties that make it safe to await before the first frame: it registers what it can, and a
 * missing or slow file degrades to a warning rather than stopping the game from starting.
 */

class FakeFontFace {
  static readonly created: { family: string; descriptors: Record<string, string> }[] = [];
  constructor(
    readonly family: string,
    _source: ArrayBuffer,
    readonly descriptors: Record<string, string> = {}
  ) {
    FakeFontFace.created.push({ family, descriptors });
  }
  load(): Promise<this> {
    return Promise.resolve(this);
  }
}

const installFontStubs = (): Set<unknown> => {
  const added = new Set<unknown>();
  (globalThis as unknown as { FontFace: unknown }).FontFace = FakeFontFace;
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { add: (face: unknown) => added.add(face) },
  });
  return added;
};

const reader = {
  readBlob: vi.fn(async (path: string) => {
    if (path.includes('missing')) throw new Error('no such file');
    return new Blob([new Uint8Array([1, 2, 3])]);
  }),
};

afterEach(() => {
  resetProjectFontRegistry();
  FakeFontFace.created.length = 0;
  reader.readBlob.mockClear();
});

describe('loadProjectFonts', () => {
  it('registers each declared face with its weight and subset range', async () => {
    const added = installFontStubs();
    const report = await loadProjectFonts(
      [
        { family: 'Nunito', path: 'fonts/nunito-900-latin.woff2', weight: 900, style: 'normal' },
        {
          family: 'Nunito',
          path: 'fonts/nunito-900-cyrillic.woff2',
          weight: 900,
          style: 'normal',
          unicodeRange: 'U+0400-045F',
        },
      ],
      reader
    );

    expect(report.loaded).toHaveLength(2);
    expect(report.failed).toHaveLength(0);
    expect(added.size).toBe(2);
    // The range travels with the face: both are declared at one family and weight, and without
    // it the last rule would answer for Latin too and have no glyphs for it.
    expect(FakeFontFace.created[1]?.descriptors.unicodeRange).toBe('U+0400-045F');
    expect(FakeFontFace.created[0]?.descriptors.weight).toBe('900');
    // The path is read through the resource seam, `res://` and all.
    expect(reader.readBlob).toHaveBeenCalledWith('res://fonts/nunito-900-latin.woff2');
  });

  it('reports a missing file instead of throwing, so the game still starts', async () => {
    installFontStubs();
    const report = await loadProjectFonts(
      [{ family: 'Ghost', path: 'fonts/missing.woff2', weight: 400, style: 'normal' }],
      reader
    );
    expect(report.loaded).toHaveLength(0);
    expect(report.failed[0]?.reason).toContain('no such file');
  });

  it('registers a face once, however often play mode is re-entered', async () => {
    installFontStubs();
    const face = [
      { family: 'Nunito', path: 'fonts/nunito-900-latin.woff2', weight: 900, style: 'normal' },
    ] as const;
    await loadProjectFonts(face, reader);
    await loadProjectFonts(face, reader);
    expect(FakeFontFace.created).toHaveLength(1);
  });

  it('does nothing at all when the project declares no fonts', async () => {
    installFontStubs();
    const report = await loadProjectFonts(undefined, reader);
    expect(report.loaded).toHaveLength(0);
    expect(reader.readBlob).not.toHaveBeenCalled();
  });
});
