import { describe, it, expect } from 'vitest';
import { CanvasTexture, Texture } from 'three';
import { AssetLoader } from './AssetLoader';
import type { ResourceManager } from './ResourceManager';
import { baseRegionOf, atlasSizeOf, type AtlasResolver } from './atlas-frame-map';

/**
 * These tests exercise only the resolver-HIT path, which never touches the file
 * loader (the sheet is pre-seeded), so they avoid the unhandled-rejection leak
 * that a real loadTexture miss would cause in happy-dom.
 */
function makeLoader(): AssetLoader {
  return new AssetLoader({} as unknown as ResourceManager);
}

function makeSheet(): CanvasTexture {
  const canvas = { width: 128, height: 128 } as unknown as HTMLCanvasElement;
  return new CanvasTexture(canvas);
}

function makeResolver(): AtlasResolver {
  return {
    resolve(path) {
      if (path === 'res://sprite.png') {
        return {
          sheetPath: 'pix3atlas://h/sheet-0',
          region: { x: 0.25, y: 0.5, width: 0.25, height: 0.25 },
          pixelWidth: 32,
          pixelHeight: 32,
        };
      }
      return null;
    },
  };
}

describe('AssetLoader atlas resolver', () => {
  it('returns a view onto the seeded sheet with the frame offset/repeat and metadata', async () => {
    const loader = makeLoader();
    const sheet = makeSheet();
    loader.seedTexture('pix3atlas://h/sheet-0', sheet);
    loader.setAtlasResolver(makeResolver());

    const view = await loader.loadTexture('res://sprite.png');

    expect(view).not.toBe(sheet);
    expect(view.source).toBe(sheet.source); // shares the sheet's GPU image
    expect(view.offset.x).toBeCloseTo(0.25, 6);
    expect(view.offset.y).toBeCloseTo(0.5, 6);
    expect(view.repeat.x).toBeCloseTo(0.25, 6);
    expect(view.repeat.y).toBeCloseTo(0.25, 6);
    expect(baseRegionOf(view)).toEqual({ x: 0.25, y: 0.5, width: 0.25, height: 0.25 });
    expect(atlasSizeOf(view)).toEqual({ width: 32, height: 32 });
  });

  it('caches the view under the original path (second load returns the same instance)', async () => {
    const loader = makeLoader();
    loader.seedTexture('pix3atlas://h/sheet-0', makeSheet());
    loader.setAtlasResolver(makeResolver());

    const first = await loader.loadTexture('res://sprite.png');
    const second = await loader.loadTexture('res://sprite.png');
    expect(second).toBe(first);
  });

  it('returns a seeded raw texture untouched when no resolver frame matches', async () => {
    const loader = makeLoader();
    loader.setAtlasResolver(makeResolver());
    const raw = new Texture();
    loader.seedTexture('res://other.png', raw);

    const result = await loader.loadTexture('res://other.png');
    expect(result).toBe(raw);
    expect(baseRegionOf(result)).toBeNull();
  });

  it('does not build a view when atlasing is disabled for the call', async () => {
    const loader = makeLoader();
    loader.seedTexture('pix3atlas://h/sheet-0', makeSheet());
    loader.setAtlasResolver(makeResolver());
    const raw = new Texture();
    loader.seedTexture('res://sprite.png', raw); // pretend a raw texture was cached first

    // Cache hit returns the raw texture; the resolver is never consulted.
    const result = await loader.loadTexture('res://sprite.png', { atlas: false });
    expect(result).toBe(raw);
  });

  it('clearing the resolver returns to the raw path', async () => {
    const loader = makeLoader();
    loader.seedTexture('pix3atlas://h/sheet-0', makeSheet());
    loader.setAtlasResolver(makeResolver());
    loader.setAtlasResolver(null);
    const raw = new Texture();
    loader.seedTexture('res://sprite.png', raw);

    const result = await loader.loadTexture('res://sprite.png');
    expect(result).toBe(raw);
  });
});
