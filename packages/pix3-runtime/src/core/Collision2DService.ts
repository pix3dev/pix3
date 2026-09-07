import { Vector3 } from 'three';
import type { NodeBase } from '../nodes/NodeBase';
import {
  circleIntersectsPolygon,
  pointInPolygon,
  polygonCentroid,
  rectIntersectsPolygon,
  segmentPolygonT,
  transformPolygon,
  type Point2D,
  type ShapeTransform2D,
} from './collision-shapes-2d';
import { readWorldTransform2D } from './world-transform-2d';

/**
 * Collision2DService — lightweight 2D overlap/raycast queries for gameplay.
 *
 * Design (Godot Area2D + Unity Physics2D hybrid): hitboxes are attached to
 * nodes as `core:Hitbox2D` components and register themselves here. The
 * service answers *queries* (`overlapPoint` / `overlapCircle` / `overlapRect` /
 * `raycast`) — it does not run its own solver step, so it costs nothing when
 * nobody asks. Filtering uses Godot-style string groups (`group` on the
 * hitbox, optional `group` argument on every query).
 *
 * Scope (documented, intentional):
 * - Shapes: axis-aligned rect + circle + **polygon**. Rect and circle ignore
 *   node/world rotation and honor scale — the original v1 contract, kept because
 *   the tapper/arena templates and the Flash-era `hitTest` semantics depend on
 *   it. `polygon` is fully rotation-aware: an authored outline that ignored the
 *   node's rotation would be wrong the moment the sprite turned, and unlike a
 *   rect there is no cheap axis-aligned reading of it to preserve.
 * - Polygons may be concave (a traced sprite outline usually is). Every test
 *   here is concave-safe; only the physics solver needs convex pieces.
 * - Broadphase: linear scan. Fine for hundreds of hitboxes; swap for a
 *   spatial hash behind the same API when profiling demands it.
 *
 * Scripts reach it via `this.scene.collision2d`.
 */

export type Hitbox2DShape = 'rect' | 'circle' | 'polygon';

/**
 * The contract a hitbox provider implements (see `Hitbox2DBehavior`).
 * The service reads these live on every query, so inspector edits apply
 * immediately without re-registration.
 */
export interface Hitbox2DSource {
  readonly node: NodeBase | null;
  readonly enabled: boolean;
  getHitboxShape(): Hitbox2DShape;
  getHitboxSize(): { width: number; height: number; radius: number };
  getHitboxOffset(): { x: number; y: number };
  getHitboxGroup(): string;
  /**
   * Node-local vertices (y up, before the node's own scale and rotation) for a
   * `polygon` hitbox. Optional so implementations that predate polygons — and
   * external ones in consumer projects — keep satisfying the interface; a source
   * that reports `polygon` without it is skipped rather than treated as a rect,
   * because a silent fallback to the wrong shape is worse than no hit at all.
   */
  getHitboxPolygon?(): readonly Point2D[];
}

/** A single query hit. */
export interface Hit2D {
  node: NodeBase;
  source: Hitbox2DSource;
  group: string;
  /** World-space hit point (raycast: entry point; overlaps: shape center). */
  x: number;
  y: number;
  /** Raycast only: distance from the ray origin to the entry point. */
  distance?: number;
}

interface ResolvedShape {
  source: Hitbox2DSource;
  node: NodeBase;
  group: string;
  shape: Hitbox2DShape;
  /** World center: rect/circle centre, or the polygon's area centroid. */
  cx: number;
  cy: number;
  /** Rect world half-extents. */
  hw: number;
  hh: number;
  /** Circle world radius. */
  r: number;
  /** World-space vertices, `polygon` only. */
  polygon: readonly Point2D[] | null;
}

const scratchPos = new Vector3();
const scratchScale = new Vector3();
const scratchTransform: ShapeTransform2D = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };

export class Collision2DService {
  private readonly sources = new Set<Hitbox2DSource>();

  register(source: Hitbox2DSource): void {
    this.sources.add(source);
  }

  unregister(source: Hitbox2DSource): void {
    this.sources.delete(source);
  }

  /** Number of registered hitboxes (diagnostics). */
  get count(): number {
    return this.sources.size;
  }

  /** All hitboxes whose shape contains the world-space point. */
  overlapPoint(x: number, y: number, group?: string): Hit2D[] {
    const hits: Hit2D[] = [];
    for (const resolved of this.resolve(group)) {
      const inside = resolved.polygon
        ? pointInPolygon(x, y, resolved.polygon)
        : resolved.shape === 'circle'
          ? distSq(x, y, resolved.cx, resolved.cy) <= resolved.r * resolved.r
          : Math.abs(x - resolved.cx) <= resolved.hw && Math.abs(y - resolved.cy) <= resolved.hh;
      if (inside) {
        hits.push(toHit(resolved));
      }
    }
    return hits;
  }

  /** All hitboxes intersecting the world-space circle. */
  overlapCircle(x: number, y: number, radius: number, group?: string): Hit2D[] {
    const hits: Hit2D[] = [];
    for (const resolved of this.resolve(group)) {
      let intersects: boolean;
      if (resolved.polygon) {
        intersects = circleIntersectsPolygon(x, y, radius, resolved.polygon);
      } else if (resolved.shape === 'circle') {
        const rr = resolved.r + radius;
        intersects = distSq(x, y, resolved.cx, resolved.cy) <= rr * rr;
      } else {
        // Circle vs AABB: clamp center to the box, compare to radius.
        const nx = clamp(x, resolved.cx - resolved.hw, resolved.cx + resolved.hw);
        const ny = clamp(y, resolved.cy - resolved.hh, resolved.cy + resolved.hh);
        intersects = distSq(x, y, nx, ny) <= radius * radius;
      }
      if (intersects) {
        hits.push(toHit(resolved));
      }
    }
    return hits;
  }

  /** All hitboxes intersecting the world-space axis-aligned rect (center + size). */
  overlapRect(cx: number, cy: number, width: number, height: number, group?: string): Hit2D[] {
    const hw = Math.abs(width) / 2;
    const hh = Math.abs(height) / 2;
    const hits: Hit2D[] = [];
    for (const resolved of this.resolve(group)) {
      let intersects: boolean;
      if (resolved.polygon) {
        intersects = rectIntersectsPolygon(cx, cy, hw, hh, resolved.polygon);
      } else if (resolved.shape === 'circle') {
        const nx = clamp(resolved.cx, cx - hw, cx + hw);
        const ny = clamp(resolved.cy, cy - hh, cy + hh);
        intersects = distSq(resolved.cx, resolved.cy, nx, ny) <= resolved.r * resolved.r;
      } else {
        intersects =
          Math.abs(resolved.cx - cx) <= resolved.hw + hw &&
          Math.abs(resolved.cy - cy) <= resolved.hh + hh;
      }
      if (intersects) {
        hits.push(toHit(resolved));
      }
    }
    return hits;
  }

  /**
   * Closest hitbox intersected by the world-space segment (x1,y1)→(x2,y2),
   * or `null`. The hit carries the entry point and its distance — this is the
   * sniper-laser / line-of-sight query.
   */
  raycast(x1: number, y1: number, x2: number, y2: number, group?: string): Hit2D | null {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len <= 1e-6) {
      const hits = this.overlapPoint(x1, y1, group);
      return hits.length > 0 ? { ...hits[0], distance: 0, x: x1, y: y1 } : null;
    }

    let best: Hit2D | null = null;
    let bestT = Infinity;
    for (const resolved of this.resolve(group)) {
      const t = resolved.polygon
        ? segmentPolygonT(x1, y1, dx, dy, resolved.polygon)
        : resolved.shape === 'circle'
          ? segmentCircleT(x1, y1, dx, dy, resolved.cx, resolved.cy, resolved.r)
          : segmentAabbT(
              x1,
              y1,
              dx,
              dy,
              resolved.cx - resolved.hw,
              resolved.cy - resolved.hh,
              resolved.cx + resolved.hw,
              resolved.cy + resolved.hh
            );
      if (t !== null && t < bestT) {
        bestT = t;
        best = {
          node: resolved.node,
          source: resolved.source,
          group: resolved.group,
          x: x1 + dx * t,
          y: y1 + dy * t,
          distance: len * t,
        };
      }
    }
    return best;
  }

  /** Resolve live world-space shapes for all enabled hitboxes (optionally one group). */
  private *resolve(group?: string): Generator<ResolvedShape> {
    for (const source of this.sources) {
      const node = source.node;
      if (!node || !source.enabled || !node.visible) {
        continue;
      }
      const sourceGroup = source.getHitboxGroup();
      if (group !== undefined && sourceGroup !== group) {
        continue;
      }
      const offset = source.getHitboxOffset();
      const size = source.getHitboxSize();
      const shape = source.getHitboxShape();

      if (shape === 'polygon') {
        const local = source.getHitboxPolygon?.();
        if (!local || local.length < 3) {
          continue;
        }
        readWorldTransform2D(node, scratchTransform);
        const world = transformPolygon(
          local.map(p => ({ x: p.x + offset.x, y: p.y + offset.y })),
          scratchTransform
        );
        const centroid = polygonCentroid(world);
        yield {
          source,
          node,
          group: sourceGroup,
          shape,
          cx: centroid.x,
          cy: centroid.y,
          hw: 0,
          hh: 0,
          r: 0,
          polygon: world,
        };
        continue;
      }

      node.getWorldPosition(scratchPos);
      node.getWorldScale(scratchScale);
      const sx = Math.abs(scratchScale.x) || 1;
      const sy = Math.abs(scratchScale.y) || 1;
      yield {
        source,
        node,
        group: sourceGroup,
        shape,
        cx: scratchPos.x + offset.x * sx,
        cy: scratchPos.y + offset.y * sy,
        hw: (Math.abs(size.width) / 2) * sx,
        hh: (Math.abs(size.height) / 2) * sy,
        r: Math.abs(size.radius) * Math.max(sx, sy),
        polygon: null,
      };
    }
  }
}

function toHit(resolved: ResolvedShape): Hit2D {
  return {
    node: resolved.node,
    source: resolved.source,
    group: resolved.group,
    x: resolved.cx,
    y: resolved.cy,
  };
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function distSq(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return dx * dx + dy * dy;
}

/** Segment(origin + t*d, t∈[0,1]) vs circle — smallest t or null. */
function segmentCircleT(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  cx: number,
  cy: number,
  r: number
): number | null {
  const fx = ox - cx;
  const fy = oy - cy;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) {
    return 0; // origin already inside
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0 || a <= 1e-12) {
    return null;
  }
  const sqrtDisc = Math.sqrt(disc);
  const t1 = (-b - sqrtDisc) / (2 * a);
  if (t1 >= 0 && t1 <= 1) {
    return t1;
  }
  return null;
}

/** Segment vs AABB (slab method) — smallest entry t in [0,1] or null. */
function segmentAabbT(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): number | null {
  let tMin = 0;
  let tMax = 1;

  for (const [o, d, lo, hi] of [
    [ox, dx, minX, maxX],
    [oy, dy, minY, maxY],
  ] as const) {
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) {
        return null;
      }
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) {
        return null;
      }
    }
  }
  return tMin;
}
