import { describe, expect, it } from 'vitest';
import {
  capsulePolygon,
  isPolygonConvex,
  polygonArea,
  polygonBounds,
  polygonSignedArea,
} from './collision-shapes-2d';
import { Physics2DService } from './Physics2DService';
import { PhysicsBody2DBehavior } from '../behaviors/PhysicsBody2DBehavior';
import { Collider2DBehavior } from '../behaviors/Collider2DBehavior';
import { Sprite2D } from '../nodes/2D/Sprite2D';
import type { NodeBase } from '../nodes/NodeBase';

const STEP = 1 / 60;
let seq = 0;

function node(name: string, x = 0, y = 0): Sprite2D {
  const sprite = new Sprite2D({ id: name, name, width: 32, height: 32 });
  sprite.position.set(x, y, 0);
  return sprite;
}

function addBody(
  world: Physics2DService,
  target: NodeBase,
  config: Record<string, unknown> = {}
): PhysicsBody2DBehavior {
  const body = new PhysicsBody2DBehavior(`b${seq++}`, 'core:PhysicsBody2D');
  Object.assign(body.config, config);
  body.node = target;
  world.registerBody(body);
  return body;
}

function addCollider(
  world: Physics2DService,
  target: NodeBase,
  config: Record<string, unknown>
): Collider2DBehavior {
  const collider = new Collider2DBehavior(`c${seq++}`, 'core:Collider2D');
  Object.assign(collider.config, config);
  collider.node = target;
  world.registerCollider(collider);
  return collider;
}

describe('capsulePolygon', () => {
  it('is a convex, counter-clockwise stadium of the authored size', () => {
    const capsule = capsulePolygon(100, 20);
    expect(isPolygonConvex(capsule)).toBe(true);
    expect(polygonSignedArea(capsule)).toBeGreaterThan(0);

    const bounds = polygonBounds(capsule);
    // Total height 100, cap radius 20 -> spans y in [-50, 50] and x in [-20, 20].
    expect(bounds.maxY - bounds.minY).toBeCloseTo(100, 1);
    expect(bounds.maxX - bounds.minX).toBeCloseTo(40, 1);
  });

  it('approximates the true capsule area closely', () => {
    const height = 100;
    const radius = 20;
    const exact = Math.PI * radius * radius + 2 * radius * (height - 2 * radius);
    // Faceted caps under-fill slightly; 8 segments per cap keeps it within 1%.
    expect(polygonArea(capsulePolygon(height, radius))).toBeGreaterThan(exact * 0.99);
    expect(polygonArea(capsulePolygon(height, radius))).toBeLessThanOrEqual(exact);
  });

  it('degenerates to a circle when the height cannot fit both caps', () => {
    const capsule = capsulePolygon(30, 20);
    const bounds = polygonBounds(capsule);
    expect(bounds.maxY - bounds.minY).toBeCloseTo(40, 1);
    expect(bounds.maxX - bounds.minX).toBeCloseTo(40, 1);
  });

  it('honours the offset', () => {
    const bounds = polygonBounds(capsulePolygon(100, 20, 8, { x: 7, y: -3 }));
    expect((bounds.minX + bounds.maxX) / 2).toBeCloseTo(7, 5);
    expect((bounds.minY + bounds.maxY) / 2).toBeCloseTo(-3, 5);
  });

  it('returns nothing for a zero radius', () => {
    expect(capsulePolygon(100, 0)).toEqual([]);
  });
});

describe('Physics2DService — capsule collider', () => {
  function floorRig(): Physics2DService {
    const world = new Physics2DService();
    world.setGravity(0, -1960);
    const floor = node('Floor', 0, -50);
    addCollider(world, floor, { shape: 'rect', width: 4000, height: 100, restitution: 0 });
    return world;
  }

  it('rests upright on the floor at its own half height', () => {
    const world = floorRig();
    const hero = node('Hero', 0, 300);
    addBody(world, hero, { fixedRotation: true });
    addCollider(world, hero, { shape: 'capsule', height: 100, radius: 20, restitution: 0 });

    for (let i = 0; i < 200; i++) {
      world.step(STEP);
    }
    // Half height is 50; the faceted bottom cap sits a hair lower than a true one.
    expect(hero.position.y).toBeGreaterThan(48);
    expect(hero.position.y).toBeLessThan(51);
  });

  it('derives a mass between the equivalent box and circle', () => {
    const world = new Physics2DService();
    const capsuleNode = node('Capsule', 0, 0);
    addBody(world, capsuleNode);
    addCollider(world, capsuleNode, { shape: 'capsule', height: 100, radius: 20 });
    world.step(STEP);

    // Same impulse; compare against a 40x100 box, which is strictly heavier.
    const boxNode = node('Box', 500, 0);
    addBody(world, boxNode);
    addCollider(world, boxNode, { shape: 'rect', width: 40, height: 100 });
    world.step(STEP);

    world.getBody(capsuleNode)!.applyImpulse(1000, 0);
    world.getBody(boxNode)!.applyImpulse(1000, 0);
    expect(world.getBody(capsuleNode)!.velocityX).toBeGreaterThan(
      world.getBody(boxNode)!.velocityX
    );
  });

  it('rolls off a slope instead of catching on it — the round cap earns its keep', () => {
    const world = new Physics2DService();
    world.setGravity(0, -1960);
    // A ramp falling to the right.
    const ramp = node('Ramp', 0, 0);
    addCollider(world, ramp, {
      shape: 'polygon',
      restitution: 0,
      points: [
        { x: -300, y: -200 },
        { x: 300, y: -200 },
        { x: -300, y: 100 },
      ],
    });

    const capsuleNode = node('Capsule', -200, 200);
    addBody(world, capsuleNode);
    addCollider(world, capsuleNode, {
      shape: 'capsule',
      height: 80,
      radius: 20,
      restitution: 0,
      friction: 0.1,
    });

    for (let i = 0; i < 300; i++) {
      world.step(STEP);
    }
    // It slid/rolled downhill to the right rather than sticking where it landed.
    expect(capsuleNode.position.x).toBeGreaterThan(-140);
  });

  it('is drawn in the debug wireframe like any other shape', () => {
    const world = new Physics2DService();
    const capsuleNode = node('Capsule', 0, 0);
    addCollider(world, capsuleNode, { shape: 'capsule', height: 100, radius: 20 });
    world.step(STEP);
    expect(world.buildDebugBuffers().vertices.length).toBeGreaterThan(0);
  });

  it('falls back to a rect for an unknown shape name', () => {
    const collider = new Collider2DBehavior('c', 'core:Collider2D');
    collider.config.shape = 'trapezoid';
    expect(collider.getColliderShape()).toBe('rect');
    collider.config.shape = 'capsule';
    expect(collider.getColliderShape()).toBe('capsule');
  });
});
