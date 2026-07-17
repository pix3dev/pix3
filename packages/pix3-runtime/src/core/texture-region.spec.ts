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
  // The material is private; read its map to observe what the sprite renders.
  const mapOf = (sprite: Sprite2D): Texture | null =>
    (sprite as unknown as { material: { map: Texture | null } }).material.map;

  it('crops via a private clone, never mutating the shared cached texture', () => {
    const sprite = new Sprite2D({ id: 'odometer', name: 'Digit' });
    const shared = new Texture();
    sprite.setTexture(shared);

    // Show the 8th of 10 vertically-stacked glyphs.
    sprite.setTextureRegion({ x: 0, y: 1 - 8 / 10, width: 1, height: 1 / 10 });

    // The shared texture handed to setTexture must stay at the full region so
    // other sprites reusing it are unaffected (the play-mode bug this fixes).
    expect(shared.repeat.y).toBe(1);
    expect(shared.offset.y).toBe(0);

    // The crop lands on a per-sprite clone that the material now renders.
    const map = mapOf(sprite);
    expect(map).not.toBe(shared);
    expect(map).not.toBeNull();
    expect(map!.repeat.y).toBeCloseTo(0.1);
    expect(map!.offset.y).toBeCloseTo(0.2);
  });

  it('lets two sprites sharing one cached texture crop independently', () => {
    // Simulates the odometer: every digit sprite reuses the same cached strip
    // texture but must show a different cell.
    const shared = new Texture();
    const a = new Sprite2D({ id: 'a', name: 'DigitA' });
    const b = new Sprite2D({ id: 'b', name: 'DigitB' });
    a.setTexture(shared);
    b.setTexture(shared);

    a.setTextureRegion({ x: 0, y: 0.2, width: 1, height: 0.1 });
    b.setTextureRegion({ x: 0, y: 0.7, width: 1, height: 0.1 });

    const mapA = mapOf(a)!;
    const mapB = mapOf(b)!;
    expect(mapA).not.toBe(shared);
    expect(mapB).not.toBe(shared);
    expect(mapA).not.toBe(mapB);
    expect(mapA.offset.y).toBeCloseTo(0.2);
    expect(mapB.offset.y).toBeCloseTo(0.7);
    // Shared texture is untouched.
    expect(shared.offset.y).toBe(0);
    expect(shared.repeat.y).toBe(1);
  });

  it('re-applies the crop to a clone of the new texture after a swap', () => {
    const sprite = new Sprite2D({ id: 'odometer', name: 'Digit' });
    const first = new Texture();
    sprite.setTexture(first);
    sprite.setTextureRegion({ x: 0, y: 1 - 8 / 10, width: 1, height: 1 / 10 });

    // A texture swap must re-apply the stored crop to a clone of the NEW image,
    // never mutate the incoming shared texture.
    const second = new Texture();
    sprite.setTexture(second);

    const map = mapOf(sprite)!;
    expect(map).not.toBe(second);
    expect(map.repeat.y).toBeCloseTo(0.1);
    expect(map.offset.y).toBeCloseTo(0.2);
    expect(second.repeat.y).toBe(1);
    expect(second.offset.y).toBe(0);
  });

  it('null reverts to the shared texture and clears the crop', () => {
    const sprite = new Sprite2D({ id: 'odometer', name: 'Digit' });
    const shared = new Texture();
    sprite.setTexture(shared);
    sprite.setTextureRegion({ x: 0, y: 0, width: 1, height: 0.25 });
    sprite.setTextureRegion(null);

    // Back to rendering the shared texture directly at its full region.
    expect(mapOf(sprite)).toBe(shared);
    expect(shared.repeat.x).toBe(1);
    expect(shared.repeat.y).toBe(1);
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
