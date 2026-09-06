import { describe, expect, it } from 'vitest';
import { Physics2DService } from './Physics2DService';
import { PhysicsBody2DBehavior } from '../behaviors/PhysicsBody2DBehavior';
import { Collider2DBehavior } from '../behaviors/Collider2DBehavior';
import { Sprite2D } from '../nodes/2D/Sprite2D';
import type { NodeBase } from '../nodes/NodeBase';

const STEP = 1 / 60;

function node(name: string, x = 0, y = 0): Sprite2D {
  const sprite = new Sprite2D({ id: name, name, width: 32, height: 32 });
  sprite.position.set(x, y, 0);
  return sprite;
}

let seq = 0;

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

/**
 * A level: floor with its top surface at y = 0, and a wall whose left face is at
 * x = 100. The character is a 32x32 box, so it rests at y = 16 and stops at x = 84.
 */
function level(): { world: Physics2DService; hero: Sprite2D } {
  const world = new Physics2DService();
  world.setGravity(0, -1960);

  const floor = node('Floor', 0, -50);
  addCollider(world, floor, { shape: 'rect', width: 4000, height: 100 });

  const wall = node('Wall', 200, 100);
  addCollider(world, wall, { shape: 'rect', width: 200, height: 400 });

  const hero = node('Hero', 0, 16);
  addBody(world, hero, { bodyType: 'kinematic' });
  addCollider(world, hero, { shape: 'rect', width: 32, height: 32 });

  world.step(STEP);
  return { world, hero };
}

describe('Physics2DService — moveAndCollide', () => {
  it('moves the full distance through open space', () => {
    const { world, hero } = level();
    const result = world.moveAndCollide(hero, 40, 0);
    expect(result.collided).toBe(false);
    expect(result.movedX).toBeCloseTo(40);
    expect(hero.position.x).toBeCloseTo(40);
  });

  it('stops at a wall and reports the outward normal', () => {
    const { world, hero } = level();
    const result = world.moveAndCollide(hero, 400, 0);
    expect(result.collided).toBe(true);
    // Wall's left face at x = 100, hero half-width 16 -> centre stops at 84.
    expect(hero.position.x).toBeLessThanOrEqual(85);
    expect(hero.position.x).toBeGreaterThan(80);
    // The normal points back out of the wall, i.e. -x.
    expect(result.normalX).toBeCloseTo(-1, 1);
    expect(result.collider?.name).toBe('Wall');
  });

  it('does not tunnel through a thin wall at high speed', () => {
    const world = new Physics2DService();
    world.setGravity(0, 0);
    const wall = node('Thin', 300, 0);
    addCollider(world, wall, { shape: 'rect', width: 8, height: 2000 });

    const hero = node('Hero', 0, 0);
    addBody(world, hero, { bodyType: 'kinematic' });
    addCollider(world, hero, { shape: 'rect', width: 32, height: 32 });
    world.step(STEP);

    // One call asking for 900 px — far past a wall 8 px thick.
    const result = world.moveAndCollide(hero, 900, 0);
    expect(result.collided).toBe(true);
    expect(hero.position.x).toBeLessThan(300);
  });

  it('reports nothing for a node with no body', () => {
    const { world } = level();
    const result = world.moveAndCollide(node('Loose'), 10, 0);
    expect(result.collided).toBe(false);
    expect(result.movedX).toBe(0);
  });

  it('ignores sensors — a trigger must not block a character', () => {
    const world = new Physics2DService();
    world.setGravity(0, 0);
    const trigger = node('Trigger', 100, 0);
    addCollider(world, trigger, { shape: 'rect', width: 100, height: 400, sensor: true });

    const hero = node('Hero', 0, 0);
    addBody(world, hero, { bodyType: 'kinematic' });
    addCollider(world, hero, { shape: 'rect', width: 32, height: 32 });
    world.step(STEP);

    const result = world.moveAndCollide(hero, 300, 0);
    expect(result.collided).toBe(false);
    expect(hero.position.x).toBeCloseTo(300);
  });
});

describe('Physics2DService — moveAndSlide', () => {
  it('reports standing on the floor and zeroes the fall speed', () => {
    const { world, hero } = level();
    const result = world.moveAndSlide(hero, 0, -600, STEP);
    expect(result.isOnFloor).toBe(true);
    expect(result.isOnCeiling).toBe(false);
    expect(result.floorNormalY).toBeCloseTo(1, 1);
    expect(result.velocityY).toBeCloseTo(0, 3);
    expect(hero.position.y).toBeGreaterThan(15);
  });

  it('keeps along-wall speed when walking into a wall', () => {
    const { world, hero } = level();
    // One frame of `velocity * dt` is a few pixels, so walk into the wall over
    // several frames the way a game actually would.
    let result = world.moveAndSlide(hero, 900, 300, STEP);
    for (let i = 0; i < 30 && !result.isOnWall; i++) {
      result = world.moveAndSlide(hero, 900, 300, STEP);
    }
    expect(result.isOnWall).toBe(true);
    // The x component is blocked by the wall; the y component is untouched.
    expect(result.velocityX).toBeCloseTo(0, 3);
    expect(result.velocityY).toBeCloseTo(300, 3);
  });

  it('slides along a slope instead of stopping dead', () => {
    const world = new Physics2DService();
    world.setGravity(0, -1960);
    // A 30-degree ramp, as a triangle rising to the right.
    const ramp = node('Ramp', 0, 0);
    addCollider(world, ramp, {
      shape: 'polygon',
      points: [
        { x: -200, y: -100 },
        { x: 200, y: -100 },
        { x: 200, y: 100 },
      ],
    });

    const hero = node('Hero', -100, 40);
    addBody(world, hero, { bodyType: 'kinematic' });
    addCollider(world, hero, { shape: 'rect', width: 32, height: 32 });
    world.step(STEP);

    // The character's own loop, as a game writes it: gravity only while airborne,
    // and a small downward bias when grounded so it stays glued to the slope.
    // Applying full gravity every frame regardless would just slide it back down,
    // which is correct physics and a bad test.
    let vy = 0;
    let grounded = false;
    let landedX = 0;
    let landedY = 0;
    // 100 frames, not more: the ramp's top-right corner is at x = 200, and a
    // character that walks off the end is in free fall — which would be measuring
    // gravity, not the slide.
    for (let i = 0; i < 100; i++) {
      vy = grounded ? -60 : vy - 1960 * STEP;
      const r = world.moveAndSlide(hero, 200, vy, STEP, { floorMaxAngle: 50 });
      if (!grounded && r.isOnFloor) {
        landedX = hero.position.x;
        landedY = hero.position.y;
      }
      grounded = r.isOnFloor;
    }
    expect(grounded).toBe(true);
    // Walking right up a rising ramp gains both ground and height, rather than
    // stopping at the slope or sliding back down it.
    expect(hero.position.x).toBeGreaterThan(landedX + 100);
    expect(hero.position.y).toBeGreaterThan(landedY + 50);
  });

  it('classifies a ceiling separately from a floor', () => {
    const world = new Physics2DService();
    world.setGravity(0, 0);
    const ceiling = node('Ceiling', 0, 200);
    addCollider(world, ceiling, { shape: 'rect', width: 1000, height: 100 });

    const hero = node('Hero', 0, 0);
    addBody(world, hero, { bodyType: 'kinematic' });
    addCollider(world, hero, { shape: 'rect', width: 32, height: 32 });
    world.step(STEP);

    const result = world.moveAndSlide(hero, 0, 12000, STEP);
    expect(result.isOnCeiling).toBe(true);
    expect(result.isOnFloor).toBe(false);
    expect(result.velocityY).toBeCloseTo(0, 3);
  });

  it('honours a custom up direction', () => {
    const world = new Physics2DService();
    world.setGravity(0, 0);
    const wall = node('Wall', 200, 0);
    addCollider(world, wall, { shape: 'rect', width: 100, height: 1000 });

    const hero = node('Hero', 0, 0);
    addBody(world, hero, { bodyType: 'kinematic' });
    addCollider(world, hero, { shape: 'rect', width: 32, height: 32 });
    world.step(STEP);

    // With "up" pointing -x, the wall's left face IS the floor.
    let result = world.moveAndSlide(hero, 6000, 0, STEP, { upX: -1, upY: 0 });
    for (let i = 0; i < 30 && !result.isOnFloor; i++) {
      result = world.moveAndSlide(hero, 6000, 0, STEP, { upX: -1, upY: 0 });
    }
    expect(result.isOnFloor).toBe(true);
    expect(result.isOnWall).toBe(false);
  });

  it('leaves an unobstructed move untouched', () => {
    const { world, hero } = level();
    const startY = hero.position.y;
    const result = world.moveAndSlide(hero, 60, 0, STEP);
    expect(result.isOnFloor).toBe(false);
    expect(result.isOnWall).toBe(false);
    expect(result.velocityX).toBeCloseTo(60);
    expect(hero.position.x).toBeCloseTo(1, 1);
    expect(hero.position.y).toBeCloseTo(startY);
  });

  it('walks a character along the floor across many frames without sinking', () => {
    const { world, hero } = level();
    let vy = 0;
    for (let i = 0; i < 120; i++) {
      vy -= 1960 * STEP;
      const result = world.moveAndSlide(hero, 120, vy, STEP);
      vy = result.isOnFloor ? 0 : result.velocityY;
    }
    expect(hero.position.y).toBeGreaterThan(15);
    expect(hero.position.y).toBeLessThan(17);
    // Two seconds at 120 px/s, stopped by the wall at x = 84.
    expect(hero.position.x).toBeGreaterThan(80);
    expect(hero.position.x).toBeLessThanOrEqual(85);
  });
});
