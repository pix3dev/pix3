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
export declare const MIN_POLYGON_VERTICES = 3;
/**
 * Upper bound on vertices a single authored polygon may carry. Traced outlines
 * simplify well below this; the cap exists so a pathological input cannot make
 * the worst-case decomposition hang the frame.
 */
export declare const MAX_POLYGON_VERTICES = 512;
/** Signed area; positive for counter-clockwise loops in a y-up space. */
export declare function polygonSignedArea(points: readonly Point2D[]): number;
/** Unsigned area of a simple polygon. */
export declare function polygonArea(points: readonly Point2D[]): number;
/** Area centroid. Falls back to the vertex average for a degenerate (zero-area) loop. */
export declare function polygonCentroid(points: readonly Point2D[]): Point2D;
/** True when every turn has the same sign — i.e. the loop is convex (either winding). */
export declare function isPolygonConvex(points: readonly Point2D[]): boolean;
/** Copy of `points` wound counter-clockwise (y up). */
export declare function ensureCounterClockwise(points: readonly Point2D[]): Point2D[];
/**
 * Drop vertices that repeat or sit on the straight line between their neighbours.
 * Traced outlines arrive with long collinear runs; leaving them in costs SAT an
 * axis per duplicate edge and makes {@link isPolygonConvex} fragile.
 */
export declare function cleanPolygon(points: readonly Point2D[], tolerance?: number): Point2D[];
/** Andrew's monotone chain — the fallback for input this module cannot trust. */
export declare function convexHull(points: readonly Point2D[]): Point2D[];
/** World-space axis-aligned bounds of a vertex loop. */
export declare function polygonBounds(points: readonly Point2D[]): Bounds2D;
/**
 * Local vertices to world vertices, applying scale, then rotation, then position.
 * A mirrored scale (`scaleX * scaleY < 0`) reverses the loop so the result stays
 * counter-clockwise for callers that depend on outward normals.
 */
export declare function transformPolygon(points: readonly Point2D[], transform: ShapeTransform2D): Point2D[];
/** The four corners of a centred, possibly offset box — an OBB once transformed. */
export declare function boxPolygon(halfWidth: number, halfHeight: number, offset?: Point2D): Point2D[];
/** A regular n-gon approximating a circle — how the polygon path renders a disc. */
export declare function circlePolygon(radius: number, segments?: number, offset?: Point2D): Point2D[];
/**
 * A capsule (Godot's CapsuleShape2D: a box with semicircular caps, upright along
 * local Y) as a closed convex loop — a "stadium".
 *
 * Sampling the caps rather than carrying a true segment-plus-radius shape is a
 * deliberate trade. A real capsule needs its own narrowphase against every other
 * shape kind, with its own deep-penetration and two-point-manifold cases; a
 * stadium is *already* a convex polygon, so it inherits SAT, reference-face
 * clipping, warm starting and stacking with no new code and no new failure modes.
 * The cost is that the caps are faceted: at 8 segments per cap the radial error
 * is under 2% of the radius — sub-pixel for anything a 2D playable draws. A shape
 * that must roll perfectly smoothly wants `circle`, which is exact.
 *
 * `height` is the TOTAL height including both caps, matching Godot; a height at
 * or below `2 * radius` degenerates to a circle.
 */
export declare function capsulePolygon(height: number, radius: number, capSegments?: number, offset?: Point2D): Point2D[];
/** Even-odd ray crossing. Correct for concave loops; boundary hits are unspecified. */
export declare function pointInPolygon(x: number, y: number, points: readonly Point2D[]): boolean;
/** Shortest distance from a point to a polygon's boundary (sign-free). */
export declare function distanceToPolygonBoundary(x: number, y: number, points: readonly Point2D[]): number;
/** Circle vs (possibly concave) polygon — centre inside, or boundary within `radius`. */
export declare function circleIntersectsPolygon(cx: number, cy: number, radius: number, points: readonly Point2D[]): boolean;
/**
 * Axis-aligned rect vs a possibly **concave** loop. Unlike
 * {@link rectIntersectsConvexPolygon} this makes no separating-axis assumption:
 * it answers by containment either way plus edge crossings, which is what the
 * query tier needs for a traced sprite outline.
 */
export declare function rectIntersectsPolygon(cx: number, cy: number, halfWidth: number, halfHeight: number, points: readonly Point2D[]): boolean;
/**
 * Axis-aligned rect (centre + half-extents) vs a **convex** loop, as a rect-shaped
 * call into {@link convexPolygonsIntersect}.
 */
export declare function rectIntersectsConvexPolygon(cx: number, cy: number, halfWidth: number, halfHeight: number, points: readonly Point2D[]): boolean;
/**
 * Separating-axis test for two **convex** loops. Concave callers must decompose
 * first — a concave polygon has no separating-axis guarantee and this would
 * report false positives.
 */
export declare function convexPolygonsIntersect(a: readonly Point2D[], b: readonly Point2D[]): boolean;
/**
 * Smallest `t` in `[0, 1]` at which the segment `origin + t * delta` enters the
 * polygon, or `null`. An origin already inside returns 0, matching the circle and
 * AABB raycasts in `Collision2DService`.
 */
export declare function segmentPolygonT(ox: number, oy: number, dx: number, dy: number, points: readonly Point2D[]): number | null;
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
export declare function decomposeConvex(points: readonly Point2D[]): Point2D[][];
