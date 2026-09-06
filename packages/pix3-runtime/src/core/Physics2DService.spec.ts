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

interface Rig {
  world: Physics2DService;
  step(times?: number): void;
}

function rig(gravityY = -1960): Rig {
  const world = new Physics2DService();
  world.setGravity(0, gravityY);
  return {
    world,
    step(times = 1) {
      for (let i = 0; i < times; i++) {
        world.step(STEP);
      }
    },
  };
}

function addBody(
  world: Physics2DService,
  target: NodeBase,
  bodyConfig: Record<string, unknown> = {}
): PhysicsBody2DBehavior {
  const body = new PhysicsBody2DBehavior(`${target.name}-body`, 'core:PhysicsBody2D');
  Object.assign(body.config, bodyConfig);
  body.node = target;
  world.registerBody(body);
  return body;
}

function addCollider(
  world: Physics2DService,
  target: NodeBase,
  config: Record<string, unknown>
): Collider2DBehavior {
  const collider = new Collider2DBehavior(`${target.name}-col`, 'core:Collider2D');
  Object.assign(collider.config, config);
  collider.node = target;
  world.registerCollider(collider);
  return collider;
}

/** A wide static floor whose top surface sits at y = 0. */
function addFloor(world: Physics2DService, halfWidth = 2000): Sprite2D {
  const floor = node('Floor', 0, -50);
  addCollider(world, floor, {
    shape: 'rect',
    width: halfWidth * 2,
    height: 100,
    restitution: 0,
  });
  return floor;
}

describe('Physics2DService — bodies and gravity', () => {
  it('does nothing without colliders', () => {
    const { world, step } = rig();
    const box = node('Box', 0, 100);
    addBody(world, box);
    step(10);
    expect(box.position.y).toBe(100);
  });

  it('accelerates a dynamic body under gravity', () => {
    const { world, step } = rig();
    const box = node('Box', 0, 1000);
    addBody(world, box);
    addCollider(world, box, { shape: 'rect', width: 32, height: 32 });
    step(30);
    expect(box.position.y).toBeLessThan(1000);
    // Half a second of 1960 px/s^2 is roughly 245 px of fall.
    expect(box.position.y).toBeGreaterThan(1000 - 400);
    expect(box.position.y).toBeLessThan(1000 - 150);
  });

  it('leaves a static body where it was authored', () => {
    const { world, step } = rig();
    const wall = node('Wall', 0, 500);
    addBody(world, wall, { bodyType: 'static' });
    addCollider(world, wall, { shape: 'rect', width: 32, height: 32 });
    step(30);
    expect(wall.position.y).toBe(500);
  });

  it('honours gravityScale, including a negative one', () => {
    const { world, step } = rig();
    const floater = node('Floater', 0, 0);
    addBody(world, floater, { gravityScale: 0 });
    addCollider(world, floater, { shape: 'rect', width: 32, height: 32 });

    const balloon = node('Balloon', 200, 0);
    addBody(world, balloon, { gravityScale: -1 });
    addCollider(world, balloon, { shape: 'rect', width: 32, height: 32 });

    step(30);
    expect(floater.position.y).toBeCloseTo(0, 3);
    expect(balloon.position.y).toBeGreaterThan(100);
  });

  it('exposes a script handle that moves the body', () => {
    const { world, step } = rig(0);
    const box = node('Box', 0, 0);
    addBody(world, box);
    addCollider(world, box, { shape: 'rect', width: 32, height: 32 });

    const handle = world.getBody(box);
    expect(handle).not.toBeNull();
    handle!.setVelocity(600, 0);
    step(30);
    expect(box.position.x).toBeGreaterThan(250);
    expect(handle!.velocityX).toBeCloseTo(600, 0);
  });

  it('returns null for a node with no body', () => {
    const world = new Physics2DService();
    expect(world.getBody(node('Loose'))).toBeNull();
  });
});

describe('Physics2DService — resting contact', () => {
  it('stops a falling box on static geometry near the surface', () => {
    const { world, step } = rig();
    addFloor(world);
    const box = node('Box', 0, 200);
    addBody(world, box);
    addCollider(world, box, { shape: 'rect', width: 32, height: 32, restitution: 0 });

    step(120);
    // Box half-height 16, floor top at 0 — resting centre is y = 16, within slop.
    expect(box.position.y).toBeGreaterThan(15);
    expect(box.position.y).toBeLessThan(17);
  });

  it('settles and then sleeps rather than buzzing', () => {
    const { world, step } = rig();
    addFloor(world);
    const box = node('Box', 0, 100);
    addBody(world, box);
    addCollider(world, box, { shape: 'rect', width: 32, height: 32, restitution: 0 });

    step(200);
    const handle = world.getBody(box)!;
    expect(handle.isSleeping).toBe(true);

    const settled = box.position.y;
    step(60);
    expect(box.position.y).toBe(settled);
  });

  it('keeps a stack of 8 boxes standing and separated', () => {
    const { world, step } = rig();
    addFloor(world);

    const boxes: Sprite2D[] = [];
    for (let i = 0; i < 8; i++) {
      // Start each box a little above its final resting height.
      const box = node(`Box${i}`, 0, 20 + i * 34);
      addBody(world, box);
      addCollider(world, box, {
        shape: 'rect',
        width: 32,
        height: 32,
        restitution: 0,
        friction: 0.6,
      });
      boxes.push(box);
    }

    step(600); // 10 seconds

    for (let i = 0; i < boxes.length; i++) {
      // Nothing sank through the floor or through the box below it.
      expect(boxes[i].position.y).toBeGreaterThan(10 + i * 30);
      // Nothing was ejected sideways or launched.
      expect(Math.abs(boxes[i].position.x)).toBeLessThan(20);
      expect(boxes[i].position.y).toBeLessThan(20 + i * 40);
    }
    // The stack is ordered bottom to top, i.e. it did not interleave.
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i].position.y).toBeGreaterThan(boxes[i - 1].position.y);
    }
  });

  it('bounces an elastic body back up', () => {
    const { world } = rig();
    addFloor(world);
    const ball = node('Ball', 0, 400);
    addBody(world, ball);
    addCollider(world, ball, { shape: 'circle', radius: 16, restitution: 0.8 });

    let peakAfterBounce = -Infinity;
    let hasLanded = false;
    for (let i = 0; i < 200; i++) {
      world.step(STEP);
      if (ball.position.y < 20) {
        hasLanded = true;
      }
      if (hasLanded) {
        peakAfterBounce = Math.max(peakAfterBounce, ball.position.y);
      }
    }
    expect(hasLanded).toBe(true);
    // A 0.8-restitution drop from ~384 px should rebound well clear of the floor.
    expect(peakAfterBounce).toBeGreaterThan(80);
  });

  it('does not bounce an inelastic body', () => {
    const { world } = rig();
    addFloor(world);
    const ball = node('Ball', 0, 400);
    addBody(world, ball);
    addCollider(world, ball, { shape: 'circle', radius: 16, restitution: 0 });

    let landed = false;
    let peakAfterLanding = -Infinity;
    for (let i = 0; i < 200; i++) {
      world.step(STEP);
      if (ball.position.y < 20) {
        landed = true;
      }
      if (landed) {
        peakAfterLanding = Math.max(peakAfterLanding, ball.position.y);
      }
    }
    expect(landed).toBe(true);
    expect(peakAfterLanding).toBeLessThan(30);
  });
});

describe('Physics2DService — shapes', () => {
  it('treats a collider with no body above it as static world geometry', () => {
    const { world, step } = rig();
    addFloor(world);
    const box = node('Box', 0, 200);
    addBody(world, box);
    addCollider(world, box, { shape: 'rect', width: 32, height: 32, restitution: 0 });
    step(120);
    expect(box.position.y).toBeGreaterThan(10);
  });

  it('rests a concave polygon collider on the floor without falling through', () => {
    const { world, step } = rig();
    addFloor(world);
    const shape = node('L', 0, 200);
    addBody(world, shape);
    addCollider(world, shape, {
      shape: 'polygon',
      restitution: 0,
      // A U: concave, so the solver only works if it was decomposed.
      points: [
        { x: -30, y: -20 },
        { x: 30, y: -20 },
        { x: 30, y: 20 },
        { x: 15, y: 20 },
        { x: 15, y: 0 },
        { x: -15, y: 0 },
        { x: -15, y: 20 },
        { x: -30, y: 20 },
      ],
    });

    step(300);
    // The U spans y in [-20, 20] locally, so resting on its legs puts the origin
    // at y = 20. A shape that fell through its own notch would sit far lower.
    expect(shape.position.y).toBeGreaterThan(18);
    expect(shape.position.y).toBeLessThan(23);
    expect(Math.abs(shape.rotation.z)).toBeLessThan(0.1);
  });

  it('scales a collider with the node', () => {
    const { world, step } = rig();
    addFloor(world);
    const box = node('Box', 0, 200);
    box.scale.set(4, 4, 1);
    addBody(world, box);
    addCollider(world, box, { shape: 'rect', width: 32, height: 32, restitution: 0 });

    step(200);
    // Half-height is 16 * 4 = 64, so the resting centre is far above 16.
    expect(box.position.y).toBeGreaterThan(60);
    expect(box.position.y).toBeLessThan(70);
  });

  it('derives a heavier mass from a larger collider', () => {
    const world = new Physics2DService();
    const small = node('Small', 0, 0);
    addBody(world, small);
    addCollider(world, small, { shape: 'rect', width: 10, height: 10 });
    const large = node('Large', 500, 0);
    addBody(world, large);
    addCollider(world, large, { shape: 'rect', width: 100, height: 100 });
    world.step(STEP);

    // Same impulse, very different resulting speed.
    world.getBody(small)!.applyImpulse(1000, 0);
    world.getBody(large)!.applyImpulse(1000, 0);
    expect(Math.abs(world.getBody(small)!.velocityX)).toBeGreaterThan(
      Math.abs(world.getBody(large)!.velocityX) * 10
    );
  });

  it('honours an authored mass over the derived one', () => {
    const world = new Physics2DService();
    const box = node('Box', 0, 0);
    addBody(world, box, { mass: 2 });
    addCollider(world, box, { shape: 'rect', width: 100, height: 100 });
    world.step(STEP);
    world.getBody(box)!.applyImpulse(2, 0);
    expect(world.getBody(box)!.velocityX).toBeCloseTo(1, 5);
  });
});

describe('Physics2DService — sensors and signals', () => {
  it('fires body-entered once when a body enters a sensor, and body-exited on leaving', () => {
    const { world, step } = rig(0);
    const sensor = node('Sensor', 0, 0);
    addCollider(world, sensor, { shape: 'rect', width: 100, height: 100, sensor: true });

    const entered: string[] = [];
    const exited: string[] = [];
    sensor.connect('body-entered', sensor, (...args: unknown[]) => {
      entered.push((args[0] as NodeBase).name);
    });
    sensor.connect('body-exited', sensor, () => {
      exited.push('exit');
    });

    const mover = node('Mover', -400, 0);
    addBody(world, mover);
    addCollider(world, mover, { shape: 'circle', radius: 10 });
    world.getBody(mover)!.setVelocity(600, 0);

    step(120);
    expect(entered).toEqual(['Mover']);
    expect(exited).toHaveLength(1);
  });

  it('does not push a body out of a sensor', () => {
    const { world, step } = rig(0);
    const sensor = node('Sensor', 0, 0);
    addCollider(world, sensor, { shape: 'rect', width: 100, height: 100, sensor: true });

    const mover = node('Mover', -400, 0);
    addBody(world, mover);
    addCollider(world, mover, { shape: 'circle', radius: 10 });
    world.getBody(mover)!.setVelocity(600, 0);

    step(120);
    // Straight through: it ends up well past the sensor, moving at full speed.
    expect(mover.position.x).toBeGreaterThan(300);
    expect(world.getBody(mover)!.velocityX).toBeCloseTo(600, 0);
  });

  it('stays silent on contact-started unless the body opted in', () => {
    const { world, step } = rig();
    const floor = addFloor(world);
    const events: string[] = [];
    floor.connect('contact-started', floor, () => events.push('floor'));

    const box = node('Box', 0, 100);
    addBody(world, box, { emitContacts: false });
    addCollider(world, box, { shape: 'rect', width: 32, height: 32 });
    box.connect('contact-started', box, () => events.push('box'));

    step(120);
    expect(events).toEqual([]);
  });

  it('reports contact-started to a body that opted in', () => {
    const { world, step } = rig();
    addFloor(world);
    const events: unknown[] = [];
    const box = node('Box', 0, 100);
    addBody(world, box, { emitContacts: true });
    addCollider(world, box, { shape: 'rect', width: 32, height: 32, restitution: 0 });
    box.connect('contact-started', box, (...args: unknown[]) => events.push(args[0]));

    step(120);
    expect(events).toHaveLength(1);
    expect((events[0] as NodeBase).name).toBe('Floor');
  });
});

describe('Physics2DService — continuous collision', () => {
  /**
   * 12000 px/s is 200 px per step: the wall at x = 500 is 10 px thick, and the
   * ball's discrete positions (200, 400, 600, ...) straddle it without ever
   * landing inside. That is exactly the sample-miss CCD exists for — and the
   * geometry has to be chosen deliberately, because a ball whose step happens to
   * land inside the wall is caught by the ordinary discrete solver and the test
   * would pass for the wrong reason.
   */
  const tunnelRig = (bullet: boolean) => {
    const { world, step } = rig(0);
    const wall = node('Wall', 500, 0);
    addCollider(world, wall, { shape: 'rect', width: 10, height: 2000 });

    const ball = node('Ball', 0, 0);
    addBody(world, ball, { bullet });
    addCollider(world, ball, { shape: 'circle', radius: 6, restitution: 0.5 });
    world.getBody(ball)!.setVelocity(12000, 0);
    return { ball, step };
  };

  it('stops a bullet body that a discrete step would tunnel through', () => {
    const { ball, step } = tunnelRig(true);
    step(20);
    expect(ball.position.x).toBeLessThan(510);
  });

  it('tunnels without the bullet flag — the flag is what does the work', () => {
    const { ball, step } = tunnelRig(false);
    step(20);
    expect(ball.position.x).toBeGreaterThan(700);
  });
});

describe('Physics2DService — queries', () => {
  function queryWorld(): Physics2DService {
    const world = new Physics2DService();
    const wall = node('Wall', 200, 0);
    addCollider(world, wall, { shape: 'rect', width: 40, height: 400, group: 'walls' });
    const pickup = node('Pickup', -200, 0);
    addCollider(world, pickup, { shape: 'circle', radius: 20, group: 'pickups' });
    world.step(STEP);
    return world;
  }

  it('raycasts to the nearest collider and reports the distance', () => {
    const hit = queryWorld().raycast(0, 0, 400, 0);
    expect(hit).not.toBeNull();
    expect(hit!.node.name).toBe('Wall');
    expect(hit!.x).toBeCloseTo(180, 0);
    expect(hit!.distance).toBeCloseTo(180, 0);
  });

  it('filters a raycast by group', () => {
    expect(queryWorld().raycast(0, 0, 400, 0, { group: 'pickups' })).toBeNull();
    expect(queryWorld().raycast(0, 0, -400, 0, { group: 'pickups' })?.node.name).toBe('Pickup');
  });

  it('overlaps a circle and a rect against the world', () => {
    const world = queryWorld();
    expect(world.overlapCircle(-200, 0, 5).map(n => n.name)).toEqual(['Pickup']);
    expect(world.overlapCircle(0, 0, 5)).toEqual([]);
    expect(world.overlapRect(200, 0, 10, 10).map(n => n.name)).toEqual(['Wall']);
  });

  it('excludes sensors from queries unless asked for', () => {
    const world = new Physics2DService();
    const trigger = node('Trigger', 0, 0);
    addCollider(world, trigger, { shape: 'rect', width: 100, height: 100, sensor: true });
    world.step(STEP);

    expect(world.overlapCircle(0, 0, 5)).toEqual([]);
    expect(world.overlapCircle(0, 0, 5, { includeSensors: true }).map(n => n.name)).toEqual([
      'Trigger',
    ]);
  });

  it('produces a debug wireframe buffer of line-segment endpoints', () => {
    const buffer = queryWorld().buildDebugVertices();
    // Two colliders: a 4-vertex rect and a 16-segment circle, 4 floats per segment.
    expect(buffer.length).toBe((4 + 16) * 4);
  });
});

describe('Physics2DService — lifecycle', () => {
  it('drops a collider on unregister so it stops blocking', () => {
    const { world, step } = rig();
    const floor = node('Floor', 0, -50);
    const floorCollider = addCollider(world, floor, { shape: 'rect', width: 4000, height: 100 });

    const box = node('Box', 0, 100);
    addBody(world, box);
    addCollider(world, box, { shape: 'rect', width: 32, height: 32 });

    step(60);
    const restingY = box.position.y;
    expect(restingY).toBeGreaterThan(10);

    // Removing the ground has to wake the body that settled on it.
    world.unregisterCollider(floorCollider);
    expect(world.getBody(box)!.isSleeping).toBe(false);
    step(60);
    expect(box.position.y).toBeLessThan(restingY - 50);
  });

  it('clear() empties the world', () => {
    const { world } = rig();
    const box = node('Box');
    addBody(world, box);
    addCollider(world, box, { shape: 'rect', width: 10, height: 10 });
    expect(world.bodyCount).toBe(1);
    expect(world.colliderCount).toBe(1);

    world.clear();
    expect(world.bodyCount).toBe(0);
    expect(world.colliderCount).toBe(0);
    expect(world.getBody(box)).toBeNull();
  });

  it('reproduces the same trajectory for the same inputs', () => {
    const run = (): number[] => {
      const { world, step } = rig();
      addFloor(world);
      const boxes: Sprite2D[] = [];
      for (let i = 0; i < 5; i++) {
        const box = node(`Box${i}`, i * 7, 100 + i * 40);
        addBody(world, box);
        addCollider(world, box, { shape: 'rect', width: 32, height: 32, restitution: 0.3 });
        boxes.push(box);
      }
      step(180);
      return boxes.flatMap(box => [box.position.x, box.position.y, box.rotation.z]);
    };
    expect(run()).toEqual(run());
  });
});
