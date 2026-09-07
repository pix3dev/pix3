import { describe, expect, it } from 'vitest';
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

/** A body drifting right at a constant speed, so interpolation is exactly linear. */
function driftRig(): { world: Physics2DService; mover: Sprite2D } {
  const world = new Physics2DService();
  world.setGravity(0, 0);
  const mover = node('Mover', 0, 0);
  addBody(world, mover, { canSleep: false });
  addCollider(world, mover, { shape: 'rect', width: 32, height: 32 });
  world.step(STEP);
  world.getBody(mover)!.setVelocity(600, 0);
  return { world, mover };
}

describe('Physics2DService — render interpolation', () => {
  it('places the body halfway between steps at alpha 0.5', () => {
    const { world, mover } = driftRig();
    world.step(STEP);
    const afterStep = mover.position.x;
    world.step(STEP);
    const nextStep = mover.position.x;

    // Re-run to the same point, then blend rather than stepping again.
    const { world: w2, mover: m2 } = driftRig();
    w2.step(STEP);
    w2.step(STEP);
    w2.interpolate(0.5);
    expect(m2.position.x).toBeCloseTo((afterStep + nextStep) / 2, 4);
  });

  it('is exact at both ends of the blend', () => {
    const { world, mover } = driftRig();
    world.step(STEP);
    const previous = mover.position.x;
    world.step(STEP);
    const current = mover.position.x;

    world.interpolate(0);
    expect(mover.position.x).toBeCloseTo(previous, 6);
    world.interpolate(1);
    expect(mover.position.x).toBeCloseTo(current, 6);
  });

  it('clamps an out-of-range alpha instead of extrapolating', () => {
    const { world, mover } = driftRig();
    world.step(STEP);
    world.step(STEP);
    const current = mover.position.x;
    world.interpolate(4);
    expect(mover.position.x).toBeCloseTo(current, 6);
  });

  it('does not disturb the solver — stepping on stays exact', () => {
    const { world, mover } = driftRig();
    for (let i = 0; i < 30; i++) {
      world.step(STEP);
      world.interpolate(0.37);
    }
    // Blending wrote an intermediate pose to the node every frame; the solver's
    // own state must be untouched by it.
    world.interpolate(1);
    expect(mover.position.x).toBeCloseTo(600 * STEP * 30, 3);
  });

  it('takes the short way round for a spin of more than half a turn per step', () => {
    const world = new Physics2DService();
    world.setGravity(0, 0);
    const spinner = node('Spinner', 0, 0);
    addBody(world, spinner, { canSleep: false });
    addCollider(world, spinner, { shape: 'rect', width: 40, height: 10 });
    world.step(STEP);
    // 400 rad/s is 6.67 rad per step — more than a half turn, so the raw
    // difference and the visually-short one disagree.
    world.getBody(spinner)!.setAngularVelocity(400);
    const beforeStep = spinner.rotation.z;
    world.step(STEP);

    // Read the two endpoints off the solver rather than predicting them: angular
    // damping shaves a little off the spin, and the point of the test is the path
    // taken between the endpoints, not what they are.
    const previous = beforeStep;
    const current = spinner.rotation.z;
    const raw = current - previous;
    expect(Math.abs(raw)).toBeGreaterThan(Math.PI); // the case that needs wrapping
    const shortWay = raw - Math.sign(raw) * Math.PI * 2;

    world.interpolate(0.5);
    // Blending the raw difference would land near 3.3 rad; the short way lands
    // near -0.19, which is what a viewer actually sees a fast wheel do.
    expect(spinner.rotation.z).toBeCloseTo(previous + shortWay / 2, 5);
  });

  it('snaps rather than blending across a teleport', () => {
    const { world, mover } = driftRig();
    world.step(STEP);
    world.step(STEP);

    world.getBody(mover)!.teleport(5000, 0);
    world.interpolate(0.5);
    // Blending would draw the body halfway to where it was moved.
    expect(mover.position.x).toBeCloseTo(5000, 3);
  });

  it('leaves static and sleeping bodies alone', () => {
    const world = new Physics2DService();
    world.setGravity(0, 0);
    const wall = node('Wall', 100, 0);
    addBody(world, wall, { bodyType: 'static' });
    addCollider(world, wall, { shape: 'rect', width: 32, height: 32 });
    world.step(STEP);

    world.interpolate(0.5);
    expect(wall.position.x).toBe(100);
  });

  it('is a no-op for an empty world', () => {
    const world = new Physics2DService();
    expect(() => world.interpolate(0.5)).not.toThrow();
  });
});
