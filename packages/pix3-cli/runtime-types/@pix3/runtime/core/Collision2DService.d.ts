import type { NodeBase } from '../nodes/NodeBase';
import { type Point2D } from './collision-shapes-2d';
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
    getHitboxSize(): {
        width: number;
        height: number;
        radius: number;
    };
    getHitboxOffset(): {
        x: number;
        y: number;
    };
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
export declare class Collision2DService {
    private readonly sources;
    register(source: Hitbox2DSource): void;
    unregister(source: Hitbox2DSource): void;
    /** Number of registered hitboxes (diagnostics). */
    get count(): number;
    /** All hitboxes whose shape contains the world-space point. */
    overlapPoint(x: number, y: number, group?: string): Hit2D[];
    /** All hitboxes intersecting the world-space circle. */
    overlapCircle(x: number, y: number, radius: number, group?: string): Hit2D[];
    /** All hitboxes intersecting the world-space axis-aligned rect (center + size). */
    overlapRect(cx: number, cy: number, width: number, height: number, group?: string): Hit2D[];
    /**
     * Closest hitbox intersected by the world-space segment (x1,y1)→(x2,y2),
     * or `null`. The hit carries the entry point and its distance — this is the
     * sniper-laser / line-of-sight query.
     */
    raycast(x1: number, y1: number, x2: number, y2: number, group?: string): Hit2D | null;
    /** Resolve live world-space shapes for all enabled hitboxes (optionally one group). */
    private resolve;
}
