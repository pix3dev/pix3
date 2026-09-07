import { describe, expect, it } from 'vitest';
import { Physics2DService } from './Physics2DService';
import { PhysicsBody2DBehavior } from '../behaviors/PhysicsBody2DBehavior';
import { Collider2DBehavior } from '../behaviors/Collider2DBehavior';
import { RevoluteJoint2DBehavior } from '../behaviors/RevoluteJoint2DBehavior';
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

function addJoint(
  world: Physics2DService,
  target: NodeBase,
  config: Record<string, unknown>
): RevoluteJoint2DBehavior {
  const joint = new RevoluteJoint2DBehavior(`j${seq++}`, 'core:RevoluteJoint2D');
  Object.assign(joint.config, config);
  joint.node = target;
  world.registerJoint(joint);
  return joint;
}

/** An arm pinned to the world at its left end, free to swing under gravity. */
function armRig(jointConfig: Record<string, unknown> = {}): {
  world: Physics2DService;
  arm: Sprite2D;
  joint: RevoluteJoint2DBehavior;
} {
  const world = new Physics2DService();
  world.setGravity(0, -1960);

  const arm = node('Arm', 0, 0);
  addBody(world, arm, { canSleep: false });
  // A long thin bar whose centre is the node origin; the pivot is its left end.
  addCollider(world, arm, { shape: 'rect', width: 200, height: 20 });
  const joint = addJoint(world, arm, { anchorX: -100, anchorY: 0, ...jointConfig });

  return { world, arm, joint };
}

/** The joint's pivot in world space, derived from the arm's current pose. */
function pivotWorld(arm: Sprite2D): { x: number; y: number } {
  const cos = Math.cos(arm.rotation.z);
  const sin = Math.sin(arm.rotation.z);
  return {
    x: arm.position.x + -100 * cos,
    y: arm.position.y + -100 * sin,
  };
}

describe('Physics2DService — revolute joint', () => {
  it('holds the pivot in place while the arm swings down', () => {
    const { world, arm } = armRig();
    // An undamped pendulum oscillates, so track the extreme rather than sampling
    // a snapshot — the angle at any given frame says nothing about the swing.
    let lowest = 0;
    let worstPivotError = 0;
    for (let i = 0; i < 120; i++) {
      world.step(STEP);
      lowest = Math.min(lowest, arm.rotation.z);
      const pivot = pivotWorld(arm);
      worstPivotError = Math.max(worstPivotError, Math.hypot(pivot.x - -100, pivot.y - 0));
    }

    // The pivot must not move at any point: that is the whole constraint.
    expect(worstPivotError).toBeLessThan(1);
    // And the arm must actually swing — one that cannot move proves nothing.
    expect(lowest).toBeLessThan(-1.4);
  });

  it('does not drift off its pivot over a long run', () => {
    const { world, arm } = armRig();
    for (let i = 0; i < 1800; i++) {
      world.step(STEP);
    }
    const pivot = pivotWorld(arm);
    expect(Math.hypot(pivot.x - -100, pivot.y - 0)).toBeLessThan(1);
  });

  it('registers nothing for a node with no body', () => {
    const world = new Physics2DService();
    const orphan = node('Orphan');
    addJoint(world, orphan, {});
    expect(world.jointCount).toBe(0);
  });

  it('stops the swing at the lower angle limit', () => {
    const { world, arm } = armRig({
      limitEnabled: true,
      lowerAngle: -30,
      upperAngle: 30,
    });
    for (let i = 0; i < 300; i++) {
      world.step(STEP);
    }
    const degrees = (arm.rotation.z * 180) / Math.PI;
    // Gravity pulls it down to the lower limit and no further.
    expect(degrees).toBeGreaterThan(-33);
    expect(degrees).toBeLessThan(-27);
  });

  it('lifts the arm against gravity with the motor', () => {
    const { world, arm } = armRig({
      motorEnabled: true,
      motorSpeed: 120,
      maxMotorTorque: 1e9,
      limitEnabled: true,
      lowerAngle: -30,
      upperAngle: 60,
    });
    for (let i = 0; i < 120; i++) {
      world.step(STEP);
    }
    const degrees = (arm.rotation.z * 180) / Math.PI;
    expect(degrees).toBeGreaterThan(55);
    expect(degrees).toBeLessThan(63);
  });

  it('flips direction when the motor speed changes sign — the flipper loop', () => {
    const { world, arm, joint } = armRig({
      motorEnabled: true,
      motorSpeed: 600,
      maxMotorTorque: 1e9,
      limitEnabled: true,
      lowerAngle: -30,
      upperAngle: 30,
    });

    for (let i = 0; i < 60; i++) {
      world.step(STEP);
    }
    const raised = (arm.rotation.z * 180) / Math.PI;
    expect(raised).toBeGreaterThan(25);

    joint.config.motorSpeed = -600;
    for (let i = 0; i < 60; i++) {
      world.step(STEP);
    }
    const lowered = (arm.rotation.z * 180) / Math.PI;
    expect(lowered).toBeLessThan(-25);
  });

  it('a weak motor cannot lift the arm — maxMotorTorque is real', () => {
    const { world, arm } = armRig({
      motorEnabled: true,
      motorSpeed: 600,
      maxMotorTorque: 1,
    });
    let lowest = 0;
    for (let i = 0; i < 120; i++) {
      world.step(STEP);
      lowest = Math.min(lowest, arm.rotation.z);
    }
    // It still falls: a torque ceiling of 1 against a 4000-mass arm is nothing.
    expect(lowest).toBeLessThan(-1.4);
  });

  it('hinges two dynamic bodies to each other', () => {
    const world = new Physics2DService();
    world.setGravity(0, -1960);

    // `connectedNode` is resolved by name, so the two have to share a scene
    // graph — a joint whose lookup fails silently hinges to the world instead,
    // which looks almost right and is not what the test is checking.
    const root = node('Root', 0, 0);
    const anchorNode = node('Anchor', 0, 0);
    const link = node('Link', 100, 0);
    root.add(anchorNode);
    root.add(link);

    addBody(world, anchorNode, { bodyType: 'static' });
    addCollider(world, anchorNode, { shape: 'rect', width: 20, height: 20 });

    addBody(world, link, { canSleep: false });
    addCollider(world, link, { shape: 'rect', width: 200, height: 20 });
    const joint = addJoint(world, link, {
      anchorX: -100,
      anchorY: 0,
      connectedNode: 'Anchor',
    });
    expect(joint.getConnectedNode()?.name).toBe('Anchor');

    for (let i = 0; i < 240; i++) {
      world.step(STEP);
    }

    // The link's left end stays on the static anchor while the rest hangs.
    const cos = Math.cos(link.rotation.z);
    const sin = Math.sin(link.rotation.z);
    const endX = link.position.x + -100 * cos;
    const endY = link.position.y + -100 * sin;
    expect(Math.hypot(endX, endY)).toBeLessThan(2);
    expect(link.position.y).toBeLessThan(-50);
  });

  it('drops the constraint when the joint is unregistered', () => {
    const { world, arm, joint } = armRig({
      limitEnabled: true,
      lowerAngle: -5,
      upperAngle: 5,
    });
    for (let i = 0; i < 60; i++) {
      world.step(STEP);
    }
    expect(Math.abs(arm.position.y)).toBeLessThan(10);

    world.unregisterJoint(joint);
    expect(world.jointCount).toBe(0);
    for (let i = 0; i < 60; i++) {
      world.step(STEP);
    }
    // With nothing holding it, the arm is in free fall.
    expect(arm.position.y).toBeLessThan(-50);
  });

  it('converts authored degrees to radians for the solver', () => {
    const joint = new RevoluteJoint2DBehavior('j', 'core:RevoluteJoint2D');
    joint.config.lowerAngle = -90;
    joint.config.upperAngle = 180;
    joint.config.motorSpeed = 360;
    const config = joint.getJointConfig();
    expect(config.lowerAngle).toBeCloseTo(-Math.PI / 2);
    expect(config.upperAngle).toBeCloseTo(Math.PI);
    expect(config.motorSpeed).toBeCloseTo(Math.PI * 2);
  });
});
