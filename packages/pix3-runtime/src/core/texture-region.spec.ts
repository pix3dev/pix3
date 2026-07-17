import { describe, expect, it } from 'vitest';
import { Texture } from 'three';

import {
  applyTextureRegionToTexture,
  isSameTextureRegion,
  sanitizeTextureRegion,
} from './texture-region';
import { SceneSaver } from './SceneSaver';
import { Sprite2D } from '../nodes/2D/Sprite2D';

describe('sanitizeTextureRegion', () => {
  it('returns null for null/undefined', () => {
    expect(sanitizeTextureRegion(null)).toBeNull();
    expect(sanitizeTextureRegion(undefined)).toBeNull();
  });

  it('clamps offsets/sizes into UV space', () => {
    expect(sanitizeTextureRegion({ x: -1, y: 2, width: 5, height: 0.25 })).toEqual({
      x: 0,
      y: 1,
      width: 1,
      height: 0.25,
    });
  });

  it('rejects non-finite values', () => {
    expect(sanitizeTextureRegion({ x: NaN, y: 0, width: 1, height: 1 })).toBeNull();
    expect(sanitizeTextureRegion({ x: 0, y: 0, width: Infinity, height: 1 })).toBeNull();
  });

  it('rejects non-positive sizes', () => {
    expect(sanitizeTextureRegion({ x: 0, y: 0, width: 0, height: 0.5 })).toBeNull();
    expect(sanitizeTextureRegion({ x: 0, y: 0, width: 0.5, height: -0.2 })).toBeNull();
  });
});

describe('applyTextureRegionToTexture', () => {
  it('maps a region onto offset/repeat', () => {
    const texture = new Texture();
    applyTextureRegionToTexture(texture, { x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
    expect(texture.offset.x).toBeCloseTo(0.1);
    expect(texture.offset.y).toBeCloseTo(0.2);
    expect(texture.repeat.x).toBeCloseTo(0.3);
    expect(texture.repeat.y).toBeCloseTo(0.4);
  });

  it('resets to the full texture when region is null', () => {
    const texture = new Texture();
    texture.offset.set(0.5, 0.5);
    texture.repeat.set(0.1, 0.1);
    applyTextureRegionToTexture(texture, null);
    expect(texture.offset.x).toBe(0);
    expect(texture.offset.y).toBe(0);
    expect(texture.repeat.x).toBe(1);
    expect(texture.repeat.y).toBe(1);
  });
});

describe('isSameTextureRegion', () => {
  it('compares by value and handles null', () => {
    expect(isSameTextureRegion(null, null)).toBe(true);
    expect(isSameTextureRegion({ x: 0, y: 0, width: 1, height: 1 }, null)).toBe(false);
    expect(
      isSameTextureRegion(
        { x: 0, y: 0.5, width: 1, height: 0.5 },
        { x: 0, y: 0.5, width: 1, height: 0.5 }
      )
    ).toBe(true);
    expect(
      isSameTextureRegion(
        { x: 0, y: 0.5, width: 1, height: 0.5 },
        { x: 0, y: 0.6, width: 1, height: 0.5 }
      )
    ).toBe(false);
  });
});

describe('Sprite2D.setTextureRegion', () => {
  it('crops the current texture and survives a later setTexture', () => {
    const sprite = new Sprite2D({ id: 'odometer', name: 'Digit' });
    const first = new Texture();
    sprite.setTexture(first);

    // Show the 8th of 10 vertically-stacked glyphs.
    sprite.setTextureRegion({ x: 0, y: 1 - 8 / 10, width: 1, height: 1 / 10 });
    expect(first.repeat.y).toBeCloseTo(0.1);
    expect(first.offset.y).toBeCloseTo(0.2);

    // A texture swap must re-apply the stored crop, not reset to the full image.
    const second = new Texture();
    sprite.setTexture(second);
    expect(second.repeat.y).toBeCloseTo(0.1);
    expect(second.offset.y).toBeCloseTo(0.2);
  });

  it('null restores the full texture UVs', () => {
    const sprite = new Sprite2D({ id: 'odometer', name: 'Digit' });
    const texture = new Texture();
    sprite.setTexture(texture);
    sprite.setTextureRegion({ x: 0, y: 0, width: 1, height: 0.25 });
    sprite.setTextureRegion(null);
    expect(texture.repeat.x).toBe(1);
    expect(texture.repeat.y).toBe(1);
    expect(sprite.textureRegion).toBeNull();
  });
});

describe('Sprite2D textureRegion is transient (not serialized)', () => {
  it('serializes identically with and without an active region', () => {
    const saver = new SceneSaver();
    const build = () =>
      new Sprite2D({ id: 'odometer', name: 'Digit', texturePath: 'res://ui/digits.png', width: 32, height: 48 });

    const withoutRegion = build();
    const yamlWithout = saver.serializeScene({
      version: '1.0.0',
      metadata: {},
      rootNodes: [withoutRegion],
      nodeMap: new Map([[withoutRegion.nodeId, withoutRegion]]),
    });

    const withRegion = build();
    withRegion.setTextureRegion({ x: 0, y: 0.3, width: 1, height: 0.1 });
    const yamlWith = saver.serializeScene({
      version: '1.0.0',
      metadata: {},
      rootNodes: [withRegion],
      nodeMap: new Map([[withRegion.nodeId, withRegion]]),
    });

    expect(yamlWith).toBe(yamlWithout);
  });
});
