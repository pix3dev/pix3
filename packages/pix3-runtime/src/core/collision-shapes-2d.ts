/**
 * Shared 2D collision-shape math — the geometry layer under both
 * {@link import('./Collision2DService').Collision2DService} (query tier) and the
 * physics solver.
 *
 * **Coordinate contract.** Everything here is plain 2D design pixels with **y
 * up**, the space `Node2D` lives in. Polygon vertices are authored in *node-local*
 * units (before the node's own scale and rotation); {@link transformPolygon}
 * lifts them into world space. Nothing in this module knows about three.js,
 * nodes, or components — it is pure functions over `{x, y}` so the tricky parts
 * (winding, convex decomposition, SAT) are testable without a scene.
 *
 * **Winding.** Every function that needs an orientation expects/produces
 * counter-clockwise vertices in a y-up space (positive {@link polygonSignedArea}).
 * {@link ensureCounterClockwise} normalizes authored input, and
 * {@link transformPolygon} re-reverses when a mirrored scale
 * (`scaleX * scaleY < 0`) flips the winding — miss that and every SAT normal
 * points inward for flipped sprites.
 *
 * **Convexity.** Authored collision polygons are routinely concave (a traced
 * sprite outline almost always is), while SAT and the contact solver only work on
 * convex pieces. {@link decomposeConvex} splits a simple polygon into convex
 * parts once, at load time; callers cache the result.
 * Self-intersecting input is out of contract: the decomposition falls back to the
 * convex hull rather than looping forever.
 */

export interface Point2D {
  x: number;
  y: number;
}

/** A convex, counter-clockwise vertex loop. */
export type ConvexPolygon2D = readonly Point2D[];

/** Axis-aligned bounds, the broadphase currency. */
export interface Bounds2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Position + rotation (radians, CCW) + non-uniform scale, as a node reports it. */
export interface ShapeTransform2D {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

/** Vertices below this are not a polygon at all (matches the sprite editor's guard). */
export const MIN_POLYGON_VERTICES = 3;

/**
 * Upper bound on vertices a single authored polygon may carry. Traced outlines
 * simplify well below this; the cap exists so a pathological input cannot make
 * the worst-case decomposition hang the frame.
 */
export const MAX_POLYGON_VERTICES = 512;

const EPSILON = 1e-9;

/** Twice-the-area sign test: > 0 when `a -> b -> c` turns left (CCW in a y-up space). */
function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** Signed area; positive for counter-clockwise loops in a y-up space. */
export function polygonSignedArea(points: readonly Point2D[]): number {
  const n = points.length;
  if (n < 3) {
    return 0;
  }
  let sum = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    sum += points[j].x * points[i].y - points[i].x * points[j].y;
  }
  return sum / 2;
}

/** Unsigned area of a simple polygon. */
export function polygonArea(points: readonly Point2D[]): number {
  return Math.abs(polygonSignedArea(points));
}

/** Area centroid. Falls back to the vertex average for a degenerate (zero-area) loop. */
export function polygonCentroid(points: readonly Point2D[]): Point2D {
  const n = points.length;
  if (n === 0) {
    return { x: 0, y: 0 };
  }
  const area = polygonSignedArea(points);
  if (Math.abs(area) < EPSILON) {
    let sx = 0;
    let sy = 0;
    for (const p of points) {
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / n, y: sy / n };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = points[j];
    const b = points[i];
    const w = a.x * b.y - b.x * a.y;
    cx += (a.x + b.x) * w;
    cy += (a.y + b.y) * w;
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

/** True when every turn has the same sign — i.e. the loop is convex (either winding). */
export function isPolygonConvex(points: readonly Point2D[]): boolean {
  const n = points.length;
  if (n < 3) {
    return false;
  }
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const c = points[(i + 2) % n];
    const turn = cross(a.x, a.y, b.x, b.y, c.x, c.y);
    if (Math.abs(turn) < EPSILON) {
      continue; // collinear vertices do not break convexity
    }
    const turnSign = turn > 0 ? 1 : -1;
    if (sign === 0) {
      sign = turnSign;
    } else if (sign !== turnSign) {
      return false;
    }
  }
  return true;
}

/** Copy of `points` wound counter-clockwise (y up). */
export function ensureCounterClockwise(points: readonly Point2D[]): Point2D[] {
  const copy = points.map(p => ({ x: p.x, y: p.y }));
  if (polygonSignedArea(copy) < 0) {
    copy.reverse();
  }
  return copy;
}

/**
 * Drop vertices that repeat or sit on the straight line between their neighbours.
 * Traced outlines arrive with long collinear runs; leaving them in costs SAT an
 * axis per duplicate edge and makes {@link isPolygonConvex} fragile.
 */
export function cleanPolygon(points: readonly Point2D[], tolerance = 1e-6): Point2D[] {
  const deduped: Point2D[] = [];
  for (const p of points) {
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) {
      continue;
    }
    const last = deduped[deduped.length - 1];
    if (last && Math.abs(last.x - p.x) <= tolerance && Math.abs(last.y - p.y) <= tolerance) {
      continue;
    }
    deduped.push({ x: p.x, y: p.y });
  }
  while (deduped.length > 1) {
    const first = deduped[0];
    const last = deduped[deduped.length - 1];
    if (Math.abs(first.x - last.x) <= tolerance && Math.abs(first.y - last.y) <= tolerance) {
      deduped.pop();
    } else {
      break;
    }
  }
  if (deduped.length < 3) {
    return deduped;
  }

  const result: Point2D[] = [];
  const n = deduped.length;
  for (let i = 0; i < n; i++) {
    const prev = deduped[(i - 1 + n) % n];
    const cur = deduped[i];
    const next = deduped[(i + 1) % n];
    if (Math.abs(cross(prev.x, prev.y, cur.x, cur.y, next.x, next.y)) <= tolerance) {
      continue;
    }
    result.push(cur);
  }
  return result.length >= 3 ? result : deduped;
}

/** Andrew's monotone chain — the fallback for input this module cannot trust. */
export function convexHull(points: readonly Point2D[]): Point2D[] {
  const sorted = points
    .filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y))
    .map(p => ({ x: p.x, y: p.y }))
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  if (sorted.length < 3) {
    return sorted;
  }

  const build = (source: readonly Point2D[]): Point2D[] => {
    const chain: Point2D[] = [];
    for (const p of source) {
      while (chain.length >= 2) {
        const a = chain[chain.length - 2];
        const b = chain[chain.length - 1];
        if (cross(a.x, a.y, b.x, b.y, p.x, p.y) > EPSILON) {
          break;
        }
        chain.pop();
      }
      chain.push(p);
    }
    chain.pop();
    return chain;
  };

  const lower = build(sorted);
  const upper = build([...sorted].reverse());
  return [...lower, ...upper];
}

/** World-space axis-aligned bounds of a vertex loop. */
export function polygonBounds(points: readonly Point2D[]): Bounds2D {
  if (points.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Local vertices to world vertices, applying scale, then rotation, then position.
 * A mirrored scale (`scaleX * scaleY < 0`) reverses the loop so the result stays
 * counter-clockwise for callers that depend on outward normals.
 */
export function transformPolygon(
  points: readonly Point2D[],
  transform: ShapeTransform2D
): Point2D[] {
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  const out: Point2D[] = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const lx = points[i].x * transform.scaleX;
    const ly = points[i].y * transform.scaleY;
    out[i] = {
      x: transform.x + lx * cos - ly * sin,
      y: transform.y + lx * sin + ly * cos,
    };
  }
  if (transform.scaleX * transform.scaleY < 0) {
    out.reverse();
  }
  return out;
}

/** The four corners of a centred, possibly offset box — an OBB once transformed. */
export function boxPolygon(halfWidth: number, halfHeight: number, offset?: Point2D): Point2D[] {
  const ox = offset?.x ?? 0;
  const oy = offset?.y ?? 0;
  const hw = Math.abs(halfWidth);
  const hh = Math.abs(halfHeight);
  return [
    { x: ox - hw, y: oy - hh },
    { x: ox + hw, y: oy - hh },
    { x: ox + hw, y: oy + hh },
    { x: ox - hw, y: oy + hh },
  ];
}

/** A regular n-gon approximating a circle — how the polygon path renders a disc. */
export function circlePolygon(radius: number, segments = 16, offset?: Point2D): Point2D[] {
  const ox = offset?.x ?? 0;
  const oy = offset?.y ?? 0;
  const count = Math.max(3, Math.floor(segments));
  const out: Point2D[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    out[i] = { x: ox + Math.cos(a) * radius, y: oy + Math.sin(a) * radius };
  }
  return out;
}

/** Even-odd ray crossing. Correct for concave loops; boundary hits are unspecified. */
export function pointInPolygon(x: number, y: number, points: readonly Point2D[]): boolean {
  const n = points.length;
  if (n < 3) {
    return false;
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = points[j];
    const b = points[i];
    if (a.y > y !== b.y > y) {
      const t = (y - a.y) / (b.y - a.y);
      if (x < a.x + t * (b.x - a.x)) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** Squared distance from `(x, y)` to the segment `a -> b`. */
function distanceSqToSegment(x: number, y: number, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > EPSILON ? ((x - a.x) * dx + (y - a.y) * dy) / lenSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = a.x + dx * t - x;
  const py = a.y + dy * t - y;
  return px * px + py * py;
}

/** Shortest distance from a point to a polygon's boundary (sign-free). */
export function distanceToPolygonBoundary(
  x: number,
  y: number,
  points: readonly Point2D[]
): number {
  let best = Infinity;
  const n = points.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const d = distanceSqToSegment(x, y, points[j], points[i]);
    if (d < best) {
      best = d;
    }
  }
  return Math.sqrt(best);
}

/** Circle vs (possibly concave) polygon — centre inside, or boundary within `radius`. */
export function circleIntersectsPolygon(
  cx: number,
  cy: number,
  radius: number,
  points: readonly Point2D[]
): boolean {
  if (points.length < 3) {
    return false;
  }
  if (pointInPolygon(cx, cy, points)) {
    return true;
  }
  return distanceToPolygonBoundary(cx, cy, points) <= Math.abs(radius);
}

/**
 * Axis-aligned rect vs a possibly **concave** loop. Unlike
 * {@link rectIntersectsConvexPolygon} this makes no separating-axis assumption:
 * it answers by containment either way plus edge crossings, which is what the
 * query tier needs for a traced sprite outline.
 */
export function rectIntersectsPolygon(
  cx: number,
  cy: number,
  halfWidth: number,
  halfHeight: number,
  points: readonly Point2D[]
): boolean {
  const n = points.length;
  if (n < 3) {
    return false;
  }
  const hw = Math.abs(halfWidth);
  const hh = Math.abs(halfHeight);
  const minX = cx - hw;
  const maxX = cx + hw;
  const minY = cy - hh;
  const maxY = cy + hh;

  for (const p of points) {
    if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) {
      return true;
    }
  }

  const corners = boxPolygon(hw, hh, { x: cx, y: cy });
  // One corner inside is enough — and it is the only case left once no vertex of
  // the polygon is in the rect and no edges cross (rect fully contained).
  if (pointInPolygon(corners[0].x, corners[0].y, points)) {
    return true;
  }

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = points[j];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    for (let k = 0, m = 3; k < 4; m = k++) {
      if (segmentSegmentT(a.x, a.y, dx, dy, corners[m], corners[k]) !== null) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Axis-aligned rect (centre + half-extents) vs a **convex** loop, as a rect-shaped
 * call into {@link convexPolygonsIntersect}.
 */
export function rectIntersectsConvexPolygon(
  cx: number,
  cy: number,
  halfWidth: number,
  halfHeight: number,
  points: readonly Point2D[]
): boolean {
  return convexPolygonsIntersect(boxPolygon(halfWidth, halfHeight, { x: cx, y: cy }), points);
}

/**
 * Separating-axis test for two **convex** loops. Concave callers must decompose
 * first — a concave polygon has no separating-axis guarantee and this would
 * report false positives.
 */
export function convexPolygonsIntersect(a: readonly Point2D[], b: readonly Point2D[]): boolean {
  if (a.length < 3 || b.length < 3) {
    return false;
  }
  return !hasSeparatingAxis(a, b) && !hasSeparatingAxis(b, a);
}

function hasSeparatingAxis(a: readonly Point2D[], b: readonly Point2D[]): boolean {
  const n = a.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = a[i].x - a[j].x;
    const ay = a[i].y - a[j].y;
    const len = Math.hypot(ax, ay);
    if (len < EPSILON) {
      continue;
    }
    // Outward normal of a CCW loop.
    const nx = ay / len;
    const ny = -ax / len;
    let aMin = Infinity;
    let aMax = -Infinity;
    for (const p of a) {
      const d = p.x * nx + p.y * ny;
      if (d < aMin) aMin = d;
      if (d > aMax) aMax = d;
    }
    let bMin = Infinity;
    let bMax = -Infinity;
    for (const p of b) {
      const d = p.x * nx + p.y * ny;
      if (d < bMin) bMin = d;
      if (d > bMax) bMax = d;
    }
    if (aMax < bMin - EPSILON || bMax < aMin - EPSILON) {
      return true;
    }
  }
  return false;
}

/**
 * Smallest `t` in `[0, 1]` at which the segment `origin + t * delta` enters the
 * polygon, or `null`. An origin already inside returns 0, matching the circle and
 * AABB raycasts in `Collision2DService`.
 */
export function segmentPolygonT(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  points: readonly Point2D[]
): number | null {
  const n = points.length;
  if (n < 3) {
    return null;
  }
  if (pointInPolygon(ox, oy, points)) {
    return 0;
  }
  let best: number | null = null;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const t = segmentSegmentT(ox, oy, dx, dy, points[j], points[i]);
    if (t !== null && (best === null || t < best)) {
      best = t;
    }
  }
  return best;
}

/** `t` along the ray where it crosses the segment `a -> b`, or `null`. */
function segmentSegmentT(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  a: Point2D,
  b: Point2D
): number | null {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < EPSILON) {
    return null; // parallel; a collinear grazing hit is not a crossing
  }
  const px = a.x - ox;
  const py = a.y - oy;
  const t = (px * ey - py * ex) / denom;
  const u = (px * dy - py * dx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) {
    return null;
  }
  return t;
}

/**
 * Split a simple polygon into convex parts.
 *
 * Strategy: repeatedly find a reflex vertex and cut the polygon with the shortest
 * valid diagonal from it, recursing on both halves. Output is not vertex-count
 * optimal — it is *correct*, cheap to reason about, and runs once per authored
 * polygon.
 *
 * For input this module does not trust — fewer than three vertices, a
 * self-intersecting loop, more than {@link MAX_POLYGON_VERTICES} vertices, or a
 * recursion that finds no valid diagonal — it returns the convex hull, so a
 * collider always has *some* shape instead of silently vanishing.
 */
export function decomposeConvex(points: readonly Point2D[]): Point2D[][] {
  const cleaned = cleanPolygon(points);
  if (cleaned.length < MIN_POLYGON_VERTICES) {
    return [];
  }
  if (cleaned.length > MAX_POLYGON_VERTICES) {
    const hull = convexHull(cleaned);
    return hull.length >= MIN_POLYGON_VERTICES ? [ensureCounterClockwise(hull)] : [];
  }

  const out: Point2D[][] = [];
  decomposeInto(ensureCounterClockwise(cleaned), out, 0);
  return out;
}

/** Depth cap: one split removes at least one vertex, so `n` levels is the real bound. */
const MAX_DECOMPOSE_DEPTH = MAX_POLYGON_VERTICES;

function decomposeInto(points: Point2D[], out: Point2D[][], depth: number): void {
  if (points.length < MIN_POLYGON_VERTICES) {
    return;
  }
  if (points.length === 3 || isPolygonConvex(points)) {
    out.push(points);
    return;
  }
  if (depth >= MAX_DECOMPOSE_DEPTH) {
    const hull = convexHull(points);
    if (hull.length >= MIN_POLYGON_VERTICES) {
      out.push(ensureCounterClockwise(hull));
    }
    return;
  }

  const n = points.length;
  for (let i = 0; i < n; i++) {
    if (!isReflex(points, i)) {
      continue;
    }
    let bestJ = -1;
    let bestDistSq = Infinity;
    for (let step = 2; step <= n - 2; step++) {
      const j = (i + step) % n;
      if (!isDiagonalValid(points, i, j)) {
        continue;
      }
      const dx = points[j].x - points[i].x;
      const dy = points[j].y - points[i].y;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestJ = j;
      }
    }
    if (bestJ < 0) {
      continue;
    }
    decomposeInto(sliceLoop(points, i, bestJ), out, depth + 1);
    decomposeInto(sliceLoop(points, bestJ, i), out, depth + 1);
    return;
  }

  // No reflex vertex found a diagonal: the loop is not simple. Ship the hull.
  const hull = convexHull(points);
  if (hull.length >= MIN_POLYGON_VERTICES) {
    out.push(ensureCounterClockwise(hull));
  }
}

/** Interior angle greater than 180 degrees at `i`, for a counter-clockwise loop. */
function isReflex(points: readonly Point2D[], i: number): boolean {
  const n = points.length;
  const prev = points[(i - 1 + n) % n];
  const cur = points[i];
  const next = points[(i + 1) % n];
  return cross(prev.x, prev.y, cur.x, cur.y, next.x, next.y) < -EPSILON;
}

/** A diagonal is valid when it stays inside the polygon and crosses no edge. */
function isDiagonalValid(points: readonly Point2D[], i: number, j: number): boolean {
  const n = points.length;
  const a = points[i];
  const b = points[j];
  for (let k = 0, prev = n - 1; k < n; prev = k++) {
    if (prev === i || prev === j || k === i || k === j) {
      continue; // edges sharing an endpoint with the diagonal cannot invalidate it
    }
    if (segmentsProperlyIntersect(a, b, points[prev], points[k])) {
      return false;
    }
  }
  return pointInPolygon((a.x + b.x) / 2, (a.y + b.y) / 2, points);
}

function segmentsProperlyIntersect(p1: Point2D, p2: Point2D, p3: Point2D, p4: Point2D): boolean {
  const d1 = cross(p3.x, p3.y, p4.x, p4.y, p1.x, p1.y);
  const d2 = cross(p3.x, p3.y, p4.x, p4.y, p2.x, p2.y);
  const d3 = cross(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
  const d4 = cross(p1.x, p1.y, p2.x, p2.y, p4.x, p4.y);
  return (
    ((d1 > EPSILON && d2 < -EPSILON) || (d1 < -EPSILON && d2 > EPSILON)) &&
    ((d3 > EPSILON && d4 < -EPSILON) || (d3 < -EPSILON && d4 > EPSILON))
  );
}

/** The sub-loop walking forward from `from` to `to`, inclusive of both. */
function sliceLoop(points: readonly Point2D[], from: number, to: number): Point2D[] {
  const n = points.length;
  const out: Point2D[] = [];
  for (let i = from; ; i = (i + 1) % n) {
    out.push({ x: points[i].x, y: points[i].y });
    if (i === to) {
      break;
    }
  }
  return out;
}
