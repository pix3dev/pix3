import { describe, expect, it } from 'vitest';
import { Collision2DService, type Hitbox2DSource } from './Collision2DService';
import { Sprite2D } from '../nodes/2D/Sprite2D';
import { Hitbox2DBehavior } from '../behaviors/Hitbox2DBehavior';
import type { Point2D } from './collision-shapes-2d';

/**
 * A right triangle pointing +x, 100 px on each leg, centred on the node origin —
 * asymmetric on purpose, so a query that ignores rotation cannot accidentally pass.
 */
const TRIANGLE: Point2D[] = [
  { x: -50, y: -50 },
  { x: 50, y: 0 },
  { x: -50, y: 50 },
];

/** An L, concave: a rect hitbox over the same extent would answer differently. */
const L_SHAPE: Point2D[] = [
  { x: -50, y: -50 },
  { x: 50, y: -50 },
  { x: 50, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 50 },
  { x: -50, y: 50 },
];

function polygonSource(node: Sprite2D, points: Point2D[], group = 'default'): Hitbox2DSource {
  return {
    node,
    enabled: true,
    getHitboxShape: () => 'polygon',
    getHitboxSize: () => ({ width: 0, height: 0, radius: 0 }),
    getHitboxOffset: () => ({ x: 0, y: 0 }),
    getHitboxGroup: () => group,
    getHitboxPolygon: () => points,
  };
}

function makeNode(): Sprite2D {
  return new Sprite2D({ id: 'n', name: 'N', width: 100, height: 100 });
}

describe('Collision2DService — polygon shapes', () => {
  it('hit-tests a point against a concave polygon, not its bounding box', () => {
    const service = new Collision2DService();
    service.register(polygonSource(makeNode(), L_SHAPE));

    // Inside the L's arm.
    expect(service.overlapPoint(-25, 25)).toHaveLength(1);
    // Inside the bounding box, outside the L's missing quadrant.
    expect(service.overlapPoint(25, 25)).toHaveLength(0);
  });

  it('follows the node position', () => {
    const node = makeNode();
    const service = new Collision2DService();
    service.register(polygonSource(node, TRIANGLE));

    expect(service.overlapPoint(0, 0)).toHaveLength(1);
    node.position.set(500, 0, 0);
    expect(service.overlapPoint(0, 0)).toHaveLength(0);
    expect(service.overlapPoint(500, 0)).toHaveLength(1);
  });

  it('follows the node rotation — the whole reason polygons are not axis-aligned', () => {
    const node = makeNode();
    const service = new Collision2DService();
    service.register(polygonSource(node, TRIANGLE));

    // The triangle narrows towards its +x tip: at x = -40 it still spans y = +-45,
    // at x = +40 only y = +-5. So (-40, 20) is inside and (40, 20) is not...
    expect(service.overlapPoint(-40, 20)).toHaveLength(1);
    expect(service.overlapPoint(40, 20)).toHaveLength(0);

    // ...and after a half turn the two swap.
    node.rotation.z = Math.PI;
    expect(service.overlapPoint(-40, 20)).toHaveLength(0);
    expect(service.overlapPoint(40, 20)).toHaveLength(1);
  });

  it('follows the node scale', () => {
    const node = makeNode();
    const service = new Collision2DService();
    service.register(polygonSource(node, TRIANGLE));

    // At x = 0 the triangle spans y = +-25; doubling the node takes that to +-50.
    expect(service.overlapPoint(0, 40)).toHaveLength(0);
    node.scale.set(2, 2, 1);
    expect(service.overlapPoint(0, 40)).toHaveLength(1);
  });

  it('accumulates a parent transform', () => {
    const parent = makeNode();
    const child = makeNode();
    parent.add(child);
    parent.position.set(300, 0, 0);
    child.position.set(100, 0, 0);

    const service = new Collision2DService();
    service.register(polygonSource(child, TRIANGLE));

    expect(service.overlapPoint(400, 0)).toHaveLength(1);
    expect(service.overlapPoint(100, 0)).toHaveLength(0);
  });

  it('overlaps a circle by the polygon boundary, not only by containment', () => {
    const service = new Collision2DService();
    service.register(polygonSource(makeNode(), TRIANGLE));

    expect(service.overlapCircle(120, 0, 10)).toHaveLength(0);
    expect(service.overlapCircle(120, 0, 100)).toHaveLength(1);
  });

  it('overlaps a rect against a concave polygon without false positives', () => {
    const service = new Collision2DService();
    service.register(polygonSource(makeNode(), L_SHAPE));

    // A small rect sitting entirely in the L's missing quadrant.
    expect(service.overlapRect(30, 30, 20, 20)).toHaveLength(0);
    // The same rect nudged onto the arm.
    expect(service.overlapRect(-30, 30, 20, 20)).toHaveLength(1);
    // A rect that swallows the whole polygon.
    expect(service.overlapRect(0, 0, 500, 500)).toHaveLength(1);
  });

  it('raycasts to the near edge and reports the distance along the ray', () => {
    const service = new Collision2DService();
    service.register(polygonSource(makeNode(), TRIANGLE));

    const hit = service.raycast(200, 0, -200, 0);
    expect(hit).not.toBeNull();
    // The triangle's tip is at x = 50, i.e. 150 px from the ray origin.
    expect(hit?.x).toBeCloseTo(50);
    expect(hit?.distance).toBeCloseTo(150);
  });

  it('misses a ray that passes through the notch of a concave polygon', () => {
    const service = new Collision2DService();
    service.register(polygonSource(makeNode(), L_SHAPE));

    // Straight down through the missing quadrant, stopping above the bottom arm.
    expect(service.raycast(25, 100, 25, 10)).toBeNull();
    // Extended into the arm, it hits.
    expect(service.raycast(25, 100, 25, -10)).not.toBeNull();
  });

  it('filters by group like every other shape', () => {
    const service = new Collision2DService();
    service.register(polygonSource(makeNode(), TRIANGLE, 'walls'));

    expect(service.overlapPoint(0, 0, 'walls')).toHaveLength(1);
    expect(service.overlapPoint(0, 0, 'enemies')).toHaveLength(0);
  });

  it('skips a polygon source with too few vertices instead of falling back to a rect', () => {
    const service = new Collision2DService();
    service.register(
      polygonSource(makeNode(), [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ])
    );
    expect(service.overlapPoint(0, 0)).toHaveLength(0);
  });

  it('skips a source that claims `polygon` but implements no polygon getter', () => {
    const node = makeNode();
    const service = new Collision2DService();
    service.register({
      node,
      enabled: true,
      getHitboxShape: () => 'polygon',
      getHitboxSize: () => ({ width: 100, height: 100, radius: 50 }),
      getHitboxOffset: () => ({ x: 0, y: 0 }),
      getHitboxGroup: () => 'default',
    });
    expect(service.overlapPoint(0, 0)).toHaveLength(0);
  });

  it('reports the polygon centroid as the overlap hit point', () => {
    const service = new Collision2DService();
    service.register(polygonSource(makeNode(), TRIANGLE));

    const [hit] = service.overlapPoint(0, 0);
    expect(hit.x).toBeCloseTo(-50 / 3);
    expect(hit.y).toBeCloseTo(0);
  });

  it('keeps rect hitboxes axis-aligned — the documented v1 contract is unchanged', () => {
    const node = makeNode();
    const service = new Collision2DService();
    service.register({
      node,
      enabled: true,
      getHitboxShape: () => 'rect',
      getHitboxSize: () => ({ width: 100, height: 20, radius: 0 }),
      getHitboxOffset: () => ({ x: 0, y: 0 }),
      getHitboxGroup: () => 'default',
    });

    node.rotation.z = Math.PI / 2;
    // A rotated rect would no longer cover (45, 0); the axis-aligned one still does.
    expect(service.overlapPoint(45, 0)).toHaveLength(1);
  });
});

describe('Hitbox2DBehavior — polygon config', () => {
  const attach = (node: Sprite2D, config: Record<string, unknown>): Hitbox2DBehavior => {
    const behavior = new Hitbox2DBehavior('h1', 'core:Hitbox2D');
    Object.assign(behavior.config, config);
    behavior.node = node;
    return behavior;
  };

  it('reads `{x, y}` vertices out of the config bag', () => {
    const behavior = attach(makeNode(), { shape: 'polygon', points: TRIANGLE });
    expect(behavior.getHitboxShape()).toBe('polygon');
    expect(behavior.getHitboxPolygon()).toHaveLength(3);
  });

  it('accepts the flat and pair spellings a hand-edited scene may carry', () => {
    expect(
      attach(makeNode(), { shape: 'polygon', points: [0, 0, 10, 0, 0, 10] }).getHitboxPolygon()
    ).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ]);
    expect(
      attach(makeNode(), {
        shape: 'polygon',
        points: [
          [0, 0],
          [10, 0],
          [0, 10],
        ],
      }).getHitboxPolygon()
    ).toHaveLength(3);
  });

  it('caches the normalized vertices until the config array is replaced', () => {
    const behavior = attach(makeNode(), { shape: 'polygon', points: TRIANGLE });
    const first = behavior.getHitboxPolygon();
    expect(behavior.getHitboxPolygon()).toBe(first);

    behavior.config.points = [...TRIANGLE, { x: 0, y: 80 }];
    expect(behavior.getHitboxPolygon()).not.toBe(first);
    expect(behavior.getHitboxPolygon()).toHaveLength(4);
  });

  it('yields nothing for `polygonSource: frame` on a node that has no frames', () => {
    const behavior = attach(makeNode(), { shape: 'polygon', polygonSource: 'frame' });
    expect(behavior.getHitboxPolygon()).toEqual([]);
  });

  it('reads a frame polygon from any node that provides one', () => {
    const node = makeNode() as Sprite2D & { getFrameCollisionPolygon?: () => Point2D[] };
    node.getFrameCollisionPolygon = () => TRIANGLE;
    const behavior = attach(node, { shape: 'polygon', polygonSource: 'frame' });
    expect(behavior.getHitboxPolygon()).toEqual(TRIANGLE);
  });

  it('still defaults to a rect, so existing scenes are untouched', () => {
    const behavior = new Hitbox2DBehavior('h1', 'core:Hitbox2D');
    expect(behavior.getHitboxShape()).toBe('rect');
    expect(behavior.config.points).toEqual([]);
  });
});
