import { describe, expect, it } from 'vitest';

import type { AnimationFrame } from '@pix3/runtime';

import { mapFrameAngle, buildFramePixelMap, restampFrameGeometry } from './frame-restamp';

/**
 * The pixel math behind the §9.5 write-back. One affine old-pixel → new-pixel map
 * has to carry a frame's normalized fields (anchor, points) and its absolute ones
 * (boundingBox, collisionPolygon) through a crop, a quarter-turn, a flip and a
 * whole-frame replacement.
 */
function createFrame(overrides: Partial<AnimationFrame> = {}): AnimationFrame {
  return {
    textureIndex: 0,
    offset: { x: 0, y: 0 },
    repeat: { x: 1, y: 1 },
    durationMultiplier: 1,
    anchor: { x: 0.5, y: 1 },
    texturePath: 'res://sprites/walk/idle_0001.png',
    boundingBox: { x: 0, y: 0, width: 0, height: 0 },
    collisionPolygon: [],
    ...overrides,
  };
}

describe('restampFrameGeometry', () => {
  it('keeps a cropped frame rendering identically', () => {
    const frame = createFrame({
      anchor: { x: 0.4, y: 0.25 },
      collisionPolygon: [{ x: 30, y: 20 }],
      boundingBox: { x: 20, y: 10, width: 40, height: 30 },
    });

    const next = restampFrameGeometry(
      frame,
      { kind: 'crop', x: 20, y: 10 },
      { width: 100, height: 80 },
      { width: 40, height: 30 }
    );

    // a' = (a·W − cropX) / w
    expect(next.anchor.x).toBeCloseTo(0.5, 6);
    expect(next.anchor.y).toBeCloseTo(1 / 3, 6);
    expect(next.collisionPolygon).toEqual([{ x: 10, y: 10 }]);
    expect(next.boundingBox).toEqual({ x: 0, y: 0, width: 40, height: 30 });
    expect(next.sourceSize).toEqual({ width: 40, height: 30 });
  });

  it('turns geometry with a quarter-turn clockwise', () => {
    const frame = createFrame({
      anchor: { x: 0, y: 0 },
      points: [{ name: 'muzzle', x: 1, y: 0, angle: 0 }],
      boundingBox: { x: 0, y: 0, width: 20, height: 10 },
    });

    const next = restampFrameGeometry(
      frame,
      { kind: 'rotate', quarterTurns: 1 },
      { width: 100, height: 80 },
      { width: 80, height: 100 }
    );

    // Top-left goes to top-right; the top-right point goes to bottom-right.
    expect(next.anchor).toEqual({ x: 1, y: 0 });
    expect(next.points?.[0]).toMatchObject({ x: 1, y: 1, angle: 90 });
    expect(next.boundingBox).toEqual({ x: 70, y: 0, width: 10, height: 20 });
  });

  it('mirrors a flipped frame, including a point direction', () => {
    const frame = createFrame({
      anchor: { x: 0.25, y: 0.5 },
      points: [{ name: 'muzzle', x: 0.75, y: 0.5, angle: 0 }],
    });

    const next = restampFrameGeometry(
      frame,
      { kind: 'flip', axis: 'horizontal' },
      { width: 100, height: 80 },
      { width: 100, height: 80 }
    );

    expect(next.anchor).toEqual({ x: 0.75, y: 0.5 });
    // A muzzle that pointed right now points left.
    expect(next.points?.[0]).toMatchObject({ x: 0.25, angle: 180 });
  });

  it('leaves normalized fields alone for a differently-sized replacement', () => {
    const frame = createFrame({
      anchor: { x: 0.4, y: 0.25 },
      points: [{ name: 'muzzle', x: 0.6, y: 0.5 }],
      boundingBox: { x: 25, y: 20, width: 50, height: 40 },
    });

    const next = restampFrameGeometry(
      frame,
      { kind: 'replace' },
      { width: 100, height: 80 },
      { width: 50, height: 40 }
    );

    expect(next.anchor).toEqual({ x: 0.4, y: 0.25 });
    // No angle was authored and the map does not rotate, so none is written.
    expect(next.points?.[0]).toEqual({ name: 'muzzle', x: 0.6, y: 0.5, angle: undefined });
    // Absolute pixels scale with the frame.
    expect(next.boundingBox).toEqual({ x: 13, y: 10, width: 25, height: 20 });
    expect(next.sourceSize).toEqual({ width: 50, height: 40 });
  });

  it('leaves an unset bounding box unset', () => {
    const next = restampFrameGeometry(
      createFrame(),
      { kind: 'crop', x: 20, y: 10 },
      { width: 100, height: 80 },
      { width: 40, height: 30 }
    );

    expect(next.boundingBox).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('refuses to guess when a size is unknown', () => {
    // The 256px placeholder space (§9.7 risk 2) must never reach the document.
    const frame = createFrame({ anchor: { x: 0.4, y: 0.25 } });
    const next = restampFrameGeometry(
      frame,
      { kind: 'crop', x: 20, y: 10 },
      { width: 0, height: 0 },
      { width: 40, height: 30 }
    );

    expect(next.anchor).toEqual({ x: 0.4, y: 0.25 });
    expect(next.sourceSize).toEqual({ width: 40, height: 30 });
  });

  it('carries an angle through an identity map untouched', () => {
    const map = buildFramePixelMap(
      { kind: 'crop', x: 5, y: 5 },
      { width: 10, height: 10 },
      { width: 5, height: 5 }
    );

    expect(mapFrameAngle(map, 37)).toBeCloseTo(37, 6);
  });
});
