import { describe, expect, it } from 'vitest';

import {
  stepBall,
  sweepCircleSegment,
  type BallOptions,
  type BallState,
  type CircleCollider,
  type SegmentCollider,
} from './files/scripts/ball-collision';

/**
 * The bouncer recipe carries its own continuous collision because the engine has
 * no rigidbody solver and `core:Hitbox2D` is an axis-aligned overlap test. These
 * are the two properties the recipe promises: at max speed the ball never
 * tunnels, and it stays in the box indefinitely.
 */

const HALF_W = 500;
const HALF_H = 800;
const RADIUS = 24;

/** The four walls of a box, as inward-facing segments. */
function boxWalls(restitution = 1): SegmentCollider[] {
  return [
    { ax: -HALF_W, ay: -HALF_H, bx: -HALF_W, by: HALF_H, restitution, id: 'left' },
    { ax: HALF_W, ay: -HALF_H, bx: HALF_W, by: HALF_H, restitution, id: 'right' },
    { ax: -HALF_W, ay: HALF_H, bx: HALF_W, by: HALF_H, restitution, id: 'top' },
    { ax: -HALF_W, ay: -HALF_H, bx: HALF_W, by: -HALF_H, restitution, id: 'bottom' },
  ];
}

function options(overrides: Partial<BallOptions> = {}): BallOptions {
  return {
    radius: RADIUS,
    gravity: 0,
    maxSpeed: 0,
    minSpeed: 0,
    damping: 1,
    substeps: 1,
    ...overrides,
  };
}

function inside(ball: BallState): boolean {
  return (
    Math.abs(ball.x) <= HALF_W - RADIUS + 1 && Math.abs(ball.y) <= HALF_H - RADIUS + 1
  );
}

describe('ball-collision sweep', () => {
  it('reflects a ball that would cross a wall inside one frame instead of losing it', () => {
    // 60 000 px/s over 1/60 s = 1000 px of travel — twice the box half-width, so
    // any discrete overlap test would miss the wall entirely.
    const ball: BallState = { x: 0, y: 0, vx: 60000, vy: 0 };
    const hits = stepBall(ball, options(), boxWalls(), [], 1 / 60);

    expect(hits.length).toBeGreaterThan(0);
    expect(ball.vx).toBeLessThan(0);
    expect(inside(ball)).toBe(true);
  });

  it('does not tunnel at any speed, in any direction', () => {
    for (const speed of [1_000, 25_000, 250_000, 5_000_000]) {
      for (const angle of [0, 0.3, 1.1, 2.4, 3.9, 5.2]) {
        const ball: BallState = {
          x: 0,
          y: 0,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
        };
        stepBall(ball, options({ substeps: 2 }), boxWalls(), [], 1 / 60);
        expect(inside(ball), `speed ${speed} angle ${angle}`).toBe(true);
      }
    }
  });

  it('keeps the ball inside the box over 60 simulated seconds of bouncing', () => {
    const ball: BallState = { x: 40, y: 120, vx: 780, vy: 1120 };
    const opts = options({
      gravity: -2200,
      maxSpeed: 3200,
      minSpeed: 420,
      damping: 0.999,
      substeps: 4,
    });
    const walls = boxWalls(0.97);
    const bumpers: CircleCollider[] = [
      { cx: -180, cy: 260, r: 60, restitution: 1.15, id: 'bumper-a' },
      { cx: 210, cy: -140, r: 60, restitution: 1.15, id: 'bumper-b' },
    ];

    for (let frame = 0; frame < 60 * 60; frame++) {
      stepBall(ball, opts, walls, bumpers, 1 / 60);
      expect(inside(ball), `escaped on frame ${frame} at ${ball.x},${ball.y}`).toBe(true);
      expect(Number.isFinite(ball.x) && Number.isFinite(ball.y)).toBe(true);
    }
    // Still moving: minSpeed keeps a bouncer alive.
    expect(Math.hypot(ball.vx, ball.vy)).toBeGreaterThan(100);
  });

  it('reflects off a rotated segment along its true normal', () => {
    // A 45° segment: a ball falling straight down leaves horizontally.
    const wall: SegmentCollider[] = [
      { ax: -200, ay: 200, bx: 200, by: -200, restitution: 1, id: 'ramp' },
    ];
    const ball: BallState = { x: 0, y: 300, vx: 0, vy: -600 };
    const hits: string[] = [];
    for (let frame = 0; frame < 120 && hits.length === 0; frame++) {
      hits.push(...stepBall(ball, options({ substeps: 1 }), wall, [], 1 / 60).map(h => h.id));
    }

    expect(hits).toContain('ramp');
    expect(ball.vx).toBeGreaterThan(500);
    expect(Math.abs(ball.vy)).toBeLessThan(50);
  });

  it('adds energy on a bumper with restitution > 1', () => {
    const bumper: CircleCollider[] = [{ cx: 0, cy: 0, r: 50, restitution: 1.4, id: 'bumper' }];
    const ball: BallState = { x: -300, y: 0, vx: 900, vy: 0 };
    const before = Math.hypot(ball.vx, ball.vy);
    const hits = stepBall(ball, options({ substeps: 2 }), [], bumper, 1 / 60);

    expect(hits.map(h => h.id)).toContain('bumper');
    expect(ball.vx).toBeLessThan(0);
    expect(Math.hypot(ball.vx, ball.vy)).toBeGreaterThan(before);
  });

  it('ignores a segment it is already moving away from', () => {
    expect(sweepCircleSegment(0, 30, 0, 100, RADIUS, -100, 0, 100, 0)).toBeNull();
  });
});
