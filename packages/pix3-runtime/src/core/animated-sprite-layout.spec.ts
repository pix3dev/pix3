import { describe, expect, it } from 'vitest';

import { resolveAnimatedSpriteFrameLayout } from './animated-sprite-layout';
import { normalizeAnimationResource, type AnimationFrame } from './AnimationResource';

const frameWith = (overrides: Partial<AnimationFrame>): AnimationFrame =>
  normalizeAnimationResource({
    clips: [{ name: 'idle', frames: [overrides] }],
  }).clips[0].frames[0];

const CENTERED = frameWith({});

describe('resolveAnimatedSpriteFrameLayout', () => {
  it('reproduces the pre-anchor behaviour for default content', () => {
    const layout = resolveAnimatedSpriteFrameLayout({
      nodeWidth: 64,
      nodeHeight: 48,
      anchor: { x: 0.5, y: 0.5 },
      sizeMode: 'stretch',
      frame: CENTERED,
      frameSourceSize: { width: 200, height: 100 },
      clipFirstFrameSourceSize: { width: 200, height: 100 },
    });

    expect(layout).toEqual({ width: 64, height: 48, offsetX: 0, offsetY: 0 });
  });

  it('places the frame anchor on the node origin (y measured from the top)', () => {
    // Anchor at the frame's top-left corner: the quad must move right and down
    // so that corner sits on the node position.
    const layout = resolveAnimatedSpriteFrameLayout({
      nodeWidth: 100,
      nodeHeight: 40,
      anchor: { x: 0.5, y: 0.5 },
      sizeMode: 'stretch',
      frame: frameWith({ anchor: { x: 0, y: 0 } }),
      frameSourceSize: null,
      clipFirstFrameSourceSize: null,
    });

    expect(layout.offsetX).toBe(50);
    expect(layout.offsetY).toBe(-20);
  });

  it('composes the node pivot on top of the frame anchor', () => {
    const layout = resolveAnimatedSpriteFrameLayout({
      nodeWidth: 100,
      nodeHeight: 40,
      // Node pivot at the bottom edge (Sprite2D semantics: y up).
      anchor: { x: 0.5, y: 0 },
      sizeMode: 'stretch',
      frame: frameWith({ anchor: { x: 1, y: 1 } }),
      frameSourceSize: null,
      clipFirstFrameSourceSize: null,
    });

    // node pivot: (0.5-0.5)*100 = 0 ; (0.5-0)*40 = +20
    // frame anchor bottom-right: (0.5-1)*100 = -50 ; (1-0.5)*40 = +20
    expect(layout.offsetX).toBe(-50);
    expect(layout.offsetY).toBe(40);
  });

  it('scales native frames uniformly from the clip’s first frame', () => {
    // First frame is 200 wide and the node is 100 wide → clipScale 0.5. A
    // half-size second frame must render at half the on-screen size, not be
    // stretched back up to the node box.
    const layout = resolveAnimatedSpriteFrameLayout({
      nodeWidth: 100,
      nodeHeight: 100,
      anchor: { x: 0.5, y: 0.5 },
      sizeMode: 'native',
      frame: CENTERED,
      frameSourceSize: { width: 100, height: 60 },
      clipFirstFrameSourceSize: { width: 200, height: 120 },
    });

    expect(layout.width).toBe(50);
    expect(layout.height).toBe(30);
  });

  it('falls back to stretch when a native frame has no known source size', () => {
    const layout = resolveAnimatedSpriteFrameLayout({
      nodeWidth: 64,
      nodeHeight: 64,
      anchor: { x: 0.5, y: 0.5 },
      sizeMode: 'native',
      frame: CENTERED,
      frameSourceSize: null,
      clipFirstFrameSourceSize: null,
    });

    expect(layout).toEqual({ width: 64, height: 64, offsetX: 0, offsetY: 0 });
  });

  it('keeps cropped frames visually identical when the anchor compensates', () => {
    // A 200×200 frame centred on the node, then cropped to its right half. Moving
    // the anchor from the centre to the crop's left edge keeps the visible pixels
    // in exactly the same place.
    const full = resolveAnimatedSpriteFrameLayout({
      nodeWidth: 200,
      nodeHeight: 200,
      anchor: { x: 0.5, y: 0.5 },
      sizeMode: 'native',
      frame: CENTERED,
      frameSourceSize: { width: 200, height: 200 },
      clipFirstFrameSourceSize: { width: 200, height: 200 },
    });
    const cropped = resolveAnimatedSpriteFrameLayout({
      nodeWidth: 200,
      nodeHeight: 200,
      anchor: { x: 0.5, y: 0.5 },
      sizeMode: 'native',
      frame: frameWith({ anchor: { x: 0, y: 0.5 } }),
      frameSourceSize: { width: 100, height: 200 },
      clipFirstFrameSourceSize: { width: 200, height: 200 },
    });

    // Full quad spans x ∈ [-100, 100]; the cropped right half must span [0, 100].
    expect(full.offsetX - full.width / 2).toBe(-100);
    expect(cropped.offsetX - cropped.width / 2).toBe(0);
    expect(cropped.offsetX + cropped.width / 2).toBe(100);
    expect(cropped.offsetY).toBe(full.offsetY);
  });
});

describe('AnimationFrame.sourceSize normalization', () => {
  it('materializes from the bounding box when not authored', () => {
    const frame = frameWith({ boundingBox: { x: 0, y: 0, width: 32, height: 48 } });
    expect(frame.sourceSize).toEqual({ width: 32, height: 48 });
  });

  it('prefers an explicit sourceSize over the bounding box', () => {
    const frame = frameWith({
      boundingBox: { x: 0, y: 0, width: 32, height: 48 },
      sourceSize: { width: 64, height: 64 },
    });
    expect(frame.sourceSize).toEqual({ width: 64, height: 64 });
  });

  it('is zero when nothing is known, which means "fall back to stretch"', () => {
    expect(CENTERED.sourceSize).toEqual({ width: 0, height: 0 });
  });
});
