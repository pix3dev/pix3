/**
 * ball-collision — swept (continuous) circle physics. Pure math, no engine
 * imports, so it is unit-testable and cheap to reason about.
 *
 * Why this exists: the engine has NO rigidbody solver, and `core:Hitbox2D` is an
 * axis-aligned overlap test (rotation ignored). A ball that moves 900 px in a
 * frame would tunnel straight through a wall under any discrete overlap test,
 * and a rotated paddle/flipper cannot be described by an AABB at all. So the
 * recipe carries its own: every collider is a SEGMENT (four per oriented box) or
 * a CIRCLE, and each substep sweeps the ball's whole displacement against them,
 * takes the earliest time of impact, reflects, and continues with what is left
 * of the step. No amount of speed can skip a collider.
 */

export interface SegmentCollider {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** 1 = perfect bounce, <1 absorbs, >1 kicks (bumpers). */
  restitution: number;
  /** Caller-defined tag, handed back on every hit. */
  id: string;
}

export interface CircleCollider {
  cx: number;
  cy: number;
  r: number;
  restitution: number;
  id: string;
}

export interface BallState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface BallOptions {
  radius: number;
  /** Vertical acceleration in px/s² (negative pulls down — Y is up). */
  gravity: number;
  maxSpeed: number;
  /** Re-energise the ball if it drops below this (0 = off). */
  minSpeed: number;
  /** Fraction of speed kept per second (1 = frictionless). */
  damping: number;
  /** Collision substeps per frame. More = more stable, never needed for tunneling. */
  substeps: number;
}

export interface BallHit {
  id: string;
  x: number;
  y: number;
  /** Impact speed along the contact normal (always positive). */
  speed: number;
}

interface SweepHit {
  t: number;
  nx: number;
  ny: number;
}

const EPS = 1e-9;
/** Pushed out this far along the normal after a hit so it cannot re-hit at t=0. */
const SKIN = 0.01;
const MAX_ITERATIONS = 6;

function closestPointOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): { x: number; y: number } {
  const ex = bx - ax;
  const ey = by - ay;
  const len2 = ex * ex + ey * ey;
  if (len2 < EPS) {
    return { x: ax, y: ay };
  }
  const s = Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey) / len2));
  return { x: ax + ex * s, y: ay + ey * s };
}

/** Sweep a moving circle against a static point (the endpoint caps of a segment). */
function sweepCirclePoint(
  px: number,
  py: number,
  vx: number,
  vy: number,
  r: number,
  cx: number,
  cy: number
): SweepHit | null {
  const mx = px - cx;
  const my = py - cy;
  const a = vx * vx + vy * vy;
  if (a < EPS) {
    return null;
  }
  const b = 2 * (mx * vx + my * vy);
  const c = mx * mx + my * my - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) {
    return null;
  }
  const root = Math.sqrt(disc);
  const t = (-b - root) / (2 * a);
  if (t < 0 || t > 1) {
    return null;
  }
  const hx = px + vx * t - cx;
  const hy = py + vy * t - cy;
  const len = Math.hypot(hx, hy) || 1;
  return { t, nx: hx / len, ny: hy / len };
}

/** Sweep a moving circle against a static segment. Returns the approaching hit only. */
export function sweepCircleSegment(
  px: number,
  py: number,
  vx: number,
  vy: number,
  r: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): SweepHit | null {
  const ex = bx - ax;
  const ey = by - ay;
  const len2 = ex * ex + ey * ey;
  if (len2 < EPS) {
    return approaching(sweepCirclePoint(px, py, vx, vy, r, ax, ay), vx, vy);
  }
  const len = Math.sqrt(len2);
  const nx = -ey / len;
  const ny = ex / len;
  const d0 = (px - ax) * nx + (py - ay) * ny;
  const dv = vx * nx + vy * ny;
  const side = d0 >= 0 ? 1 : -1;

  // Face hit: the moment the centre reaches distance r from the infinite line,
  // provided the contact point lies within the segment span.
  if (dv * side < -EPS) {
    const t = (side * r - d0) / dv;
    if (t >= 0 && t <= 1) {
      const hx = px + vx * t;
      const hy = py + vy * t;
      const s = ((hx - ax) * ex + (hy - ay) * ey) / len2;
      if (s >= 0 && s <= 1) {
        return approaching({ t, nx: nx * side, ny: ny * side }, vx, vy);
      }
    }
  }

  // Otherwise the only possible contacts are the rounded endpoints.
  const ha = sweepCirclePoint(px, py, vx, vy, r, ax, ay);
  const hb = sweepCirclePoint(px, py, vx, vy, r, bx, by);
  const best = ha && hb ? (ha.t <= hb.t ? ha : hb) : (ha ?? hb);
  return approaching(best, vx, vy);
}

/** Sweep a moving circle against a static circle. */
export function sweepCircleCircle(
  px: number,
  py: number,
  vx: number,
  vy: number,
  r: number,
  cx: number,
  cy: number,
  cr: number
): SweepHit | null {
  return approaching(sweepCirclePoint(px, py, vx, vy, r + cr, cx, cy), vx, vy);
}

/** Drop hits whose normal points along the motion (already separating). */
function approaching(hit: SweepHit | null, vx: number, vy: number): SweepHit | null {
  if (!hit) {
    return null;
  }
  return vx * hit.nx + vy * hit.ny < -EPS ? hit : null;
}

/** Push the ball out of anything it already overlaps (authored overlaps, rounding). */
function depenetrate(
  ball: BallState,
  radius: number,
  segments: readonly SegmentCollider[],
  circles: readonly CircleCollider[]
): void {
  for (const seg of segments) {
    const p = closestPointOnSegment(ball.x, ball.y, seg.ax, seg.ay, seg.bx, seg.by);
    const dx = ball.x - p.x;
    const dy = ball.y - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist < radius && dist > EPS) {
      ball.x = p.x + (dx / dist) * (radius + SKIN);
      ball.y = p.y + (dy / dist) * (radius + SKIN);
    }
  }
  for (const circle of circles) {
    const dx = ball.x - circle.cx;
    const dy = ball.y - circle.cy;
    const dist = Math.hypot(dx, dy);
    const min = radius + circle.r;
    if (dist < min && dist > EPS) {
      ball.x = circle.cx + (dx / dist) * (min + SKIN);
      ball.y = circle.cy + (dy / dist) * (min + SKIN);
    }
  }
}

/**
 * Advance the ball by `dt` seconds, resolving every collider continuously.
 * Mutates `ball`; returns one entry per contact resolved this frame.
 */
export function stepBall(
  ball: BallState,
  options: BallOptions,
  segments: readonly SegmentCollider[],
  circles: readonly CircleCollider[],
  dt: number
): BallHit[] {
  const hits: BallHit[] = [];
  if (dt <= 0) {
    return hits;
  }
  const substeps = Math.max(1, Math.min(16, Math.round(options.substeps) || 1));
  const radius = Math.max(0.001, options.radius);
  const subDt = dt / substeps;

  for (let step = 0; step < substeps; step++) {
    ball.vy += options.gravity * subDt;
    if (options.damping < 1) {
      const keep = Math.pow(Math.max(0, options.damping), subDt);
      ball.vx *= keep;
      ball.vy *= keep;
    }
    clampSpeed(ball, options);
    depenetrate(ball, radius, segments, circles);

    let remaining = subDt;
    for (let iteration = 0; iteration < MAX_ITERATIONS && remaining > EPS; iteration++) {
      const dx = ball.vx * remaining;
      const dy = ball.vy * remaining;

      let best: SweepHit | null = null;
      let bestId = '';
      let bestRestitution = 1;
      for (const seg of segments) {
        const hit = sweepCircleSegment(ball.x, ball.y, dx, dy, radius, seg.ax, seg.ay, seg.bx, seg.by);
        if (hit && (!best || hit.t < best.t)) {
          best = hit;
          bestId = seg.id;
          bestRestitution = seg.restitution;
        }
      }
      for (const circle of circles) {
        const hit = sweepCircleCircle(ball.x, ball.y, dx, dy, radius, circle.cx, circle.cy, circle.r);
        if (hit && (!best || hit.t < best.t)) {
          best = hit;
          bestId = circle.id;
          bestRestitution = circle.restitution;
        }
      }

      if (!best) {
        ball.x += dx;
        ball.y += dy;
        remaining = 0;
        break;
      }

      ball.x += dx * best.t + best.nx * SKIN;
      ball.y += dy * best.t + best.ny * SKIN;

      const vn = ball.vx * best.nx + ball.vy * best.ny;
      const impact = Math.abs(vn);
      ball.vx -= (1 + bestRestitution) * vn * best.nx;
      ball.vy -= (1 + bestRestitution) * vn * best.ny;
      clampSpeed(ball, options);

      hits.push({ id: bestId, x: ball.x, y: ball.y, speed: impact });
      remaining *= 1 - best.t;
    }
  }
  return hits;
}

function clampSpeed(ball: BallState, options: BallOptions): void {
  const speed = Math.hypot(ball.vx, ball.vy);
  if (options.maxSpeed > 0 && speed > options.maxSpeed) {
    ball.vx = (ball.vx / speed) * options.maxSpeed;
    ball.vy = (ball.vy / speed) * options.maxSpeed;
  } else if (options.minSpeed > 0 && speed > EPS && speed < options.minSpeed) {
    ball.vx = (ball.vx / speed) * options.minSpeed;
    ball.vy = (ball.vy / speed) * options.minSpeed;
  }
}
