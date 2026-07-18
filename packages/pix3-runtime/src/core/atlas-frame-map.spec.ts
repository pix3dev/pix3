import { describe, it, expect } from 'vitest';
import { Texture } from 'three';
import { composeTextureRegion } from './texture-region';
import {
  baseRegionOf,
  atlasSizeOf,
  stampAtlasView,
  copyAtlasMetadata,
  createAtlasResolver,
  type AtlasManifest,
} from './atlas-frame-map';

describe('composeTextureRegion', () => {
  const frame = { x: 0.25, y: 0.5, width: 0.25, height: 0.25 };

  it('returns the local region unchanged when there is no base (non-atlased)', () => {
    const local = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    expect(composeTextureRegion(null, local)).toEqual(local);
  });

  it('returns the base frame when there is no local crop (the sequence-frame trap fix)', () => {
    // A sequence frame / no-crop path must resolve to the packed frame region,
    // NOT (0,0)-(1,1), which would sample the whole sheet.
    expect(composeTextureRegion(frame, null)).toEqual(frame);
  });

  it('nests a local rect inside the base frame', () => {
    // Take the bottom-left quarter of the frame.
    const composed = composeTextureRegion(frame, { x: 0, y: 0, width: 0.5, height: 0.5 });
    expect(composed).toEqual({ x: 0.25, y: 0.5, width: 0.125, height: 0.125 });
  });

  it('offsets a local rect by the base origin', () => {
    // The top-right quarter of the frame.
    const composed = composeTextureRegion(frame, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
    expect(composed).toEqual({ x: 0.375, y: 0.625, width: 0.125, height: 0.125 });
  });

  it('returns null when both are null', () => {
    expect(composeTextureRegion(null, null)).toBeNull();
  });
});

describe('atlas view userData helpers', () => {
  it('stamps and reads back region + size', () => {
    const texture = new Texture();
    const region = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    stampAtlasView(texture, region, { width: 64, height: 48 });
    expect(baseRegionOf(texture)).toEqual(region);
    expect(atlasSizeOf(texture)).toEqual({ width: 64, height: 48 });
  });

  it('returns null for a plain texture and for null', () => {
    expect(baseRegionOf(new Texture())).toBeNull();
    expect(atlasSizeOf(new Texture())).toBeNull();
    expect(baseRegionOf(null)).toBeNull();
  });

  it('copies metadata onto a clone (Texture.copy is not relied upon)', () => {
    const source = new Texture();
    stampAtlasView(source, { x: 0.5, y: 0, width: 0.5, height: 1 }, { width: 32, height: 32 });
    const clone = new Texture();
    copyAtlasMetadata(source, clone);
    expect(baseRegionOf(clone)).toEqual(baseRegionOf(source));
    expect(atlasSizeOf(clone)).toEqual({ width: 32, height: 32 });
  });
});

describe('createAtlasResolver', () => {
  const manifest: AtlasManifest = {
    formatVersion: 1,
    packerVersion: 1,
    contentHash: 'abc',
    textureFiltering: 'linear',
    sheets: [{ id: 'sheet-0', file: 'sheet-0.png', width: 100, height: 200 }],
    frames: {
      // Pixel coords, origin top-left: a 40x50 frame at (10, 20).
      'res://a.png': { sheet: 'sheet-0', x: 10, y: 20, w: 40, h: 50 },
    },
    excluded: [],
  };

  it('converts pixel frames to bottom-left UV regions and resolves the sheet path', () => {
    const resolver = createAtlasResolver(manifest, id => `pix3atlas://h/${id}`);
    const frame = resolver.resolve('res://a.png');
    expect(frame).not.toBeNull();
    expect(frame!.sheetPath).toBe('pix3atlas://h/sheet-0');
    expect(frame!.pixelWidth).toBe(40);
    expect(frame!.pixelHeight).toBe(50);
    // x = 10/100; y = 1 - (20+50)/200 = 1 - 0.35 = 0.65; w = 40/100; h = 50/200
    expect(frame!.region.x).toBeCloseTo(0.1, 6);
    expect(frame!.region.y).toBeCloseTo(0.65, 6);
    expect(frame!.region.width).toBeCloseTo(0.4, 6);
    expect(frame!.region.height).toBeCloseTo(0.25, 6);
  });

  it('returns null for unknown paths', () => {
    const resolver = createAtlasResolver(manifest, id => id);
    expect(resolver.resolve('res://missing.png')).toBeNull();
  });
});
