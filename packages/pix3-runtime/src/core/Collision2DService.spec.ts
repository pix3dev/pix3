import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { Collision2DService } from './Collision2DService';
import type { Hitbox2DShape, Hitbox2DSource } from './Collision2DService';
import type { NodeBase } from '../nodes/NodeBase';

interface StubOptions {
  x?: number;
  y?: number;
  scale?: number;
  shape?: Hitbox2DShape;
  width?: number;
  height?: number;
  radius?: number;
  offsetX?: number;
  offsetY?: number;
  group?: string;
  enabled?: boolean;
  visible?: boolean;
}

function makeSource(options: StubOptions = {}): Hitbox2DSource {
  const object = new Object3D();
  object.position.set(options.x ?? 0, options.y ?? 0, 0);
  const scale = options.scale ?? 1;
  object.scale.set(scale, scale, 1);
  object.visible = options.visible ?? true;
  object.updateMatrixWorld(true);
  return {
    node: object as unknown as NodeBase,
    enabled: options.enabled ?? true,
    getHitboxShape: () => options.shape ?? 'rect',
    getHitboxSize: () => ({
      width: options.width ?? 100,
      height: options.height ?? 100,
      radius: options.radius ?? 50,
    }),
    getHitboxOffset: () => ({ x: options.offsetX ?? 0, y: options.offsetY ?? 0 }),
    getHitboxGroup: () => options.group ?? 'default',
  };
}

describe('Collision2DService', () => {
  it('overlapPoint hits a rect and respects its bounds', () => {
    const service = new Collision2DService();
    service.register(makeSource({ x: 200, y: 100, width: 100, height: 50 }));

    expect(service.overlapPoint(200, 100)).toHaveLength(1);
    expect(service.overlapPoint(249, 124)).toHaveLength(1);
    expect(service.overlapPoint(251, 100)).toHaveLength(0);
    expect(service.overlapPoint(200, 126)).toHaveLength(0);
  });

  it('overlapCircle hits circles and rects', () => {
    const service = new Collision2DService();
    service.register(makeSource({ x: 0, y: 0, shape: 'circle', radius: 30 }));
    service.register(makeSource({ x: 300, y: 0, width: 60, height: 60 }));

    // 10 px gap: circle edge at x=30, probe circle spans [40..60] → miss
    expect(service.overlapCircle(50, 0, 10)).toHaveLength(0);
    // Touching: probe spans [25..65]
    expect(service.overlapCircle(45, 0, 20)).toHaveLength(1);
    // Rect: box spans [270..330]; probe circle at 260 with r=15 reaches 275 → hit
    expect(service.overlapCircle(260, 0, 15)).toHaveLength(1);
  });

  it('filters by group', () => {
    const service = new Collision2DService();
    service.register(makeSource({ group: 'enemy' }));
    service.register(makeSource({ group: 'pickup' }));

    expect(service.overlapPoint(0, 0)).toHaveLength(2);
    expect(service.overlapPoint(0, 0, 'enemy')).toHaveLength(1);
    expect(service.overlapPoint(0, 0, 'none')).toHaveLength(0);
  });

  it('skips disabled and invisible hitboxes', () => {
    const service = new Collision2DService();
    service.register(makeSource({ enabled: false }));
    service.register(makeSource({ visible: false }));

    expect(service.overlapPoint(0, 0)).toHaveLength(0);
  });

  it('honors world scale and offset', () => {
    const service = new Collision2DService();
    // 100x100 rect at scale 2 → world 200x200; offset (50,0) scaled → center at (100,0)
    service.register(makeSource({ scale: 2, offsetX: 50 }));

    expect(service.overlapPoint(199, 0)).toHaveLength(1);
    expect(service.overlapPoint(201, 0)).toHaveLength(0);
    expect(service.overlapPoint(1, 0)).toHaveLength(1);
    expect(service.overlapPoint(-1, 0)).toHaveLength(0);
  });

  it('raycast returns the closest hit with entry point and distance', () => {
    const service = new Collision2DService();
    service.register(makeSource({ x: 300, y: 0, width: 100, height: 100, group: 'far' }));
    service.register(makeSource({ x: 150, y: 0, shape: 'circle', radius: 25, group: 'near' }));

    const hit = service.raycast(0, 0, 500, 0);
    expect(hit).not.toBeNull();
    expect(hit?.group).toBe('near');
    expect(hit?.x).toBeCloseTo(125, 3);
    expect(hit?.distance).toBeCloseTo(125, 3);

    const farHit = service.raycast(0, 0, 500, 0, 'far');
    expect(farHit?.group).toBe('far');
    expect(farHit?.x).toBeCloseTo(250, 3);

    expect(service.raycast(0, 200, 500, 200)).toBeNull();
  });

  it('unregister removes the hitbox', () => {
    const service = new Collision2DService();
    const source = makeSource({});
    service.register(source);
    expect(service.overlapPoint(0, 0)).toHaveLength(1);
    service.unregister(source);
    expect(service.overlapPoint(0, 0)).toHaveLength(0);
  });
});
