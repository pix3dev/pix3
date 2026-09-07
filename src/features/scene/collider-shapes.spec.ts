import { describe, expect, it } from 'vitest';
import { Sprite2D } from '@pix3/runtime';
import {
  collectColliderShapes,
  mapImagePolygonToSpriteLocal,
  readColliderComponents,
} from './collider-shapes';

interface FakeComponent {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

function nodeWith(components: FakeComponent[], props: Record<string, unknown> = {}): Sprite2D {
  const node = new Sprite2D({ id: 'n1', name: 'N', width: 100, height: 50, ...props });
  (node as unknown as { components: FakeComponent[] }).components = components;
  return node;
}

const hitbox = (config: Record<string, unknown>): FakeComponent => ({
  id: 'c1',
  type: 'core:Hitbox2D',
  config,
});

describe('collider-shapes / readColliderComponents', () => {
  it('picks out collider components and ignores the rest', () => {
    const node = nodeWith([
      { id: 'a', type: 'core:Rotate', config: {} },
      hitbox({ shape: 'rect' }),
    ]);
    expect(readColliderComponents(node).map(c => c.id)).toEqual(['c1']);
  });

  it('returns nothing for a node with no components array', () => {
    const node = new Sprite2D({ id: 'n', name: 'N' });
    (node as unknown as { components?: unknown }).components = undefined;
    expect(readColliderComponents(node)).toEqual([]);
  });
});

describe('collider-shapes / collectColliderShapes', () => {
  it('resolves a rect to its four corners with the offset folded in', () => {
    const shapes = collectColliderShapes(
      nodeWith([hitbox({ shape: 'rect', width: 40, height: 20, offsetX: 5, offsetY: -3 })])
    );
    expect(shapes).toHaveLength(1);
    expect(shapes[0].kind).toBe('rect');
    expect(shapes[0].outline).toEqual([
      { x: -15, y: -13 },
      { x: 25, y: -13 },
      { x: 25, y: 7 },
      { x: -15, y: 7 },
    ]);
    expect(shapes[0].editable).toBe(false);
  });

  it('resolves a circle to a polygon approximation of the authored radius', () => {
    const shapes = collectColliderShapes(nodeWith([hitbox({ shape: 'circle', radius: 10 })]));
    expect(shapes[0].kind).toBe('circle');
    expect(shapes[0].outline.length).toBeGreaterThan(8);
    for (const point of shapes[0].outline) {
      expect(Math.hypot(point.x, point.y)).toBeCloseTo(10);
    }
  });

  it('resolves an authored polygon and marks it editable', () => {
    const shapes = collectColliderShapes(
      nodeWith([
        hitbox({
          shape: 'polygon',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 0, y: 10 },
          ],
        }),
      ])
    );
    expect(shapes[0].kind).toBe('polygon');
    expect(shapes[0].editable).toBe(true);
    expect(shapes[0].points).toHaveLength(3);
  });

  it('drops a polygon with too few vertices rather than falling back to a box', () => {
    const shapes = collectColliderShapes(
      nodeWith([hitbox({ shape: 'polygon', points: [{ x: 0, y: 0 }] })])
    );
    expect(shapes).toEqual([]);
  });

  it('reads a frame-sourced polygon and marks it NOT editable in the viewport', () => {
    const node = nodeWith([hitbox({ shape: 'polygon', polygonSource: 'frame' })]);
    (node as unknown as { getFrameCollisionPolygon: () => unknown }).getFrameCollisionPolygon =
      () => [
        { x: -5, y: -5 },
        { x: 5, y: -5 },
        { x: 0, y: 5 },
      ];
    const shapes = collectColliderShapes(node);
    expect(shapes).toHaveLength(1);
    expect(shapes[0].editable).toBe(false);
    expect(shapes[0].outline).toHaveLength(3);
  });

  it('yields nothing for a frame-sourced polygon on a node with no frames', () => {
    expect(
      collectColliderShapes(nodeWith([hitbox({ shape: 'polygon', polygonSource: 'frame' })]))
    ).toEqual([]);
  });

  it('carries the node world transform so the caller can place the outline', () => {
    const node = nodeWith([hitbox({ shape: 'rect', width: 10, height: 10 })]);
    node.position.set(120, -40, 0);
    node.rotation.z = Math.PI / 2;
    const [shape] = collectColliderShapes(node);
    expect(shape.transform.x).toBeCloseTo(120);
    expect(shape.transform.y).toBeCloseTo(-40);
    expect(shape.transform.rotation).toBeCloseTo(Math.PI / 2);
  });

  it('resolves every collider on a node, in declaration order', () => {
    const shapes = collectColliderShapes(
      nodeWith([
        { id: 'a', type: 'core:Hitbox2D', config: { shape: 'rect', width: 10, height: 10 } },
        { id: 'b', type: 'core:Hitbox2D', config: { shape: 'circle', radius: 4 } },
      ])
    );
    expect(shapes.map(s => s.componentId)).toEqual(['a', 'b']);
  });
});

describe('collider-shapes / mapImagePolygonToSpriteLocal', () => {
  const image = { width: 100, height: 50 };

  it('maps image corners onto the sprite quad for a centred anchor', () => {
    const mapped = mapImagePolygonToSpriteLocal(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 50 },
      ],
      image,
      { width: 200, height: 100, anchorX: 0.5, anchorY: 0.5 }
    );
    // Image top-left -> quad top-left, y flipped.
    expect(mapped[0]).toEqual({ x: -100, y: 50 });
    expect(mapped[1]).toEqual({ x: 100, y: 50 });
    expect(mapped[2]).toEqual({ x: 100, y: -50 });
  });

  it('shifts with the anchor exactly as Sprite2D offsets its quad', () => {
    // anchor (0, 0) is the bottom-left corner (y up), so the quad centre moves to
    // (+w/2, +h/2) and the image's bottom-left lands on the node origin.
    const mapped = mapImagePolygonToSpriteLocal([{ x: 0, y: 50 }], image, {
      width: 200,
      height: 100,
      anchorX: 0,
      anchorY: 0,
    });
    expect(mapped[0].x).toBeCloseTo(0);
    expect(mapped[0].y).toBeCloseTo(0);
  });

  it('returns nothing for a zero-sized image instead of dividing by zero', () => {
    expect(
      mapImagePolygonToSpriteLocal(
        [{ x: 1, y: 1 }],
        { width: 0, height: 0 },
        {
          width: 10,
          height: 10,
          anchorX: 0.5,
          anchorY: 0.5,
        }
      )
    ).toEqual([]);
  });
});
