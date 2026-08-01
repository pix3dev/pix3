import { describe, expect, it } from 'vitest';
import { MathUtils } from 'three';

import { AnimatedSprite2D } from './AnimatedSprite2D';
import { Node2D } from '../Node2D';
import { normalizeAnimationResource } from '../../core/AnimationResource';
import { PointAttachmentBehavior } from '../../behaviors/PointAttachmentBehavior';

const RESOURCE = normalizeAnimationResource({
  version: '1.0.0',
  texturePath: '',
  clips: [
    {
      name: 'idle',
      fps: 12,
      loop: true,
      frames: [
        {
          texturePath: 'res://sprites/hero/idle_0001.png',
          sourceSize: { width: 100, height: 100 },
          points: [
            { name: 'muzzle', x: 1, y: 0.5, angle: 90 },
            { name: 'hand', x: 0.25, y: 0.75 },
            // Unnamed / duplicate entries are dropped by the normalizer.
            { name: '', x: 0, y: 0 },
            { name: 'muzzle', x: 0, y: 0 },
          ],
        },
        {
          texturePath: 'res://sprites/hero/idle_0002.png',
          sourceSize: { width: 100, height: 100 },
          points: [{ name: 'muzzle', x: 0, y: 0 }],
        },
      ],
    },
  ],
});

function makeSprite(): AnimatedSprite2D {
  const sprite = new AnimatedSprite2D({
    id: 'hero',
    name: 'Hero',
    currentClip: 'idle',
    width: 100,
    height: 100,
  });
  sprite.setAnimationResource(RESOURCE);
  return sprite;
}

describe('AnimatedSprite2D frame points', () => {
  it('normalizes points, dropping unnamed and duplicate entries', () => {
    const points = RESOURCE.clips[0].frames[0].points ?? [];
    expect(points.map(point => point.name)).toEqual(['muzzle', 'hand']);
    expect(points[0].angle).toBe(90);
    // A zero angle is omitted rather than stored.
    expect(points[1].angle).toBeUndefined();
  });

  it('resolves a point into node-local space (y flipped from frame space)', () => {
    const sprite = makeSprite();

    // muzzle sits at the frame's right edge, vertically centred.
    expect(sprite.getFramePoint('muzzle')).toEqual({ x: 50, y: 0, angle: 90 });
    // hand is a quarter across and three quarters DOWN the frame.
    expect(sprite.getFramePoint('hand')).toEqual({ x: -25, y: -25, angle: 0 });
  });

  it('returns null for a point the frame does not define', () => {
    const sprite = makeSprite();
    sprite.currentFrame = 1;

    expect(sprite.getFramePoint('hand')).toBeNull();
    expect(sprite.getFramePoint('muzzle')).toEqual({ x: -50, y: 50, angle: 0 });
  });

  it('reads a specific frame without moving the playhead', () => {
    const sprite = makeSprite();

    expect(sprite.getFramePoint('muzzle', 1)).toEqual({ x: -50, y: 50, angle: 0 });
    expect(sprite.currentFrame).toBe(0);
  });

  it('lists every point name in the active clip', () => {
    expect(makeSprite().getClipPointNames()).toEqual(['muzzle', 'hand']);
  });

  it('accumulates the node transform and rotation in world space', () => {
    const sprite = makeSprite();
    sprite.position.set(200, 40, 0);
    sprite.rotation.z = MathUtils.degToRad(90);
    sprite.updateMatrixWorld(true);

    const world = sprite.getFramePointWorld('muzzle');
    // Local (50, 0) rotated 90° CCW becomes (0, 50), then translated.
    expect(world?.x).toBeCloseTo(200);
    expect(world?.y).toBeCloseTo(90);
    expect(world?.angle).toBeCloseTo(180);
  });
});

describe('core:PointAttachment', () => {
  it('parks a child node on the named point every tick', () => {
    const sprite = makeSprite();
    const item = new Node2D({ id: 'item', name: 'Item', type: 'Node2D' });
    sprite.add(item);

    const behavior = new PointAttachmentBehavior();
    behavior.point = 'hand';
    behavior.applyRotation = false;
    item.addComponent(behavior);
    behavior.onUpdate(0.016);

    expect(item.position.x).toBe(-25);
    expect(item.position.y).toBe(-25);
  });

  it('applies the point angle and the configured offset', () => {
    const sprite = makeSprite();
    const flash = new Node2D({ id: 'flash', name: 'Flash', type: 'Node2D' });
    sprite.add(flash);

    const behavior = new PointAttachmentBehavior();
    behavior.point = 'muzzle';
    behavior.offsetX = 5;
    flash.addComponent(behavior);
    behavior.onUpdate(0.016);

    expect(flash.position.x).toBe(55);
    expect(flash.rotation.z).toBeCloseTo(MathUtils.degToRad(90));
  });

  it('leaves the node alone on a frame that does not define the point', () => {
    const sprite = makeSprite();
    sprite.currentFrame = 1;
    const item = new Node2D({ id: 'item', name: 'Item', type: 'Node2D' });
    item.position.set(7, 9, 0);
    sprite.add(item);

    const behavior = new PointAttachmentBehavior();
    behavior.point = 'hand';
    item.addComponent(behavior);
    behavior.onUpdate(0.016);

    expect(item.position.x).toBe(7);
    expect(item.position.y).toBe(9);
  });
});
