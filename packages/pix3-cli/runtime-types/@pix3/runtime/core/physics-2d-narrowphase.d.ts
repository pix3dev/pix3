import { type Point2D } from './collision-shapes-2d';
/**
 * Contact generation for the 2D solver: two shapes in, a contact manifold out.
 *
 * Separate from `collision-shapes-2d` because the query tier only ever asks
 * *whether* two things touch, while a solver needs to know **where**, **how
 * deep**, and **along which normal** — and needs it as a stable feature, because
 * a contact point whose identity flickers between steps cannot be warm-started
 * and a stack built on it visibly jitters.
 *
 * Everything here works on **convex, counter-clockwise** loops in world space
 * (`decomposeConvex` upstream guarantees that) and in design pixels with y up.
 * The math is the standard Erin Catto arrangement — SAT for the axis,
 * reference/incident face clipping for the points — because it is the one every
 * 2D engine converges on and the one whose failure modes are documented.
 */
/** One contact point of a manifold. */
export interface Contact2D {
    /** World-space position of the contact. */
    x: number;
    y: number;
    /** Positive overlap depth along the manifold normal. */
    penetration: number;
    /**
     * Stable identity of the feature pair that produced this point, so the solver
     * can carry an accumulated impulse across steps. Points that keep their id
     * keep their impulse; a point whose id changes starts cold.
     */
    featureId: number;
}
export interface Manifold2D {
    /** Unit normal pointing from shape A towards shape B. */
    normalX: number;
    normalY: number;
    contacts: Contact2D[];
}
/**
 * How far apart two shapes may be and still produce a manifold, in design pixels.
 *
 * These are **speculative** contacts: a pair within the margin reports a contact
 * with a *negative* penetration, and the solver turns that into "you may approach
 * only fast enough to close this gap" rather than a push. They exist because a
 * resting body sits exactly at separation zero and jitters across it by a
 * fraction of a pixel every step — without a margin the manifold blinks in and
 * out, which resets the warm-started impulses (so a stack sinks and recovers
 * forever) and fires a contact-started/ended pair per blink.
 */
export declare const CONTACT_MARGIN = 0.5;
/** Circle vs circle. `null` when they do not overlap. */
export declare function collideCircles(ax: number, ay: number, ar: number, bx: number, by: number, br: number): Manifold2D | null;
/**
 * Circle vs convex polygon. The normal points from the **circle** towards the
 * polygon, matching {@link collideCircles}' A-to-B convention with the circle as A.
 */
export declare function collideCirclePolygon(cx: number, cy: number, radius: number, polygon: readonly Point2D[]): Manifold2D | null;
/**
 * Convex polygon vs convex polygon. The normal points from `a` towards `b`;
 * up to two contact points come out of clipping the incident face against the
 * reference face's side planes.
 */
export declare function collidePolygons(a: readonly Point2D[], b: readonly Point2D[]): Manifold2D | null;
/**
 * Earliest fraction of the segment `(ox, oy) -> +(dx, dy)` at which a circle of
 * `radius` first touches a **static** convex polygon, or `null`.
 *
 * This is the continuous test that stops a pinball tunnelling through a flipper:
 * a discrete step samples only the endpoints, and at 2000 px/s a 1/60 step moves
 * a ball 33 px — further than most walls are thick. Implemented as a ray against
 * the polygon expanded by `radius` (Minkowski sum), approximated by testing the
 * offset faces and the vertex caps, which is exact for the face case and
 * conservative (slightly early) at the corners.
 */
export declare function sweepCircleAgainstPolygon(ox: number, oy: number, dx: number, dy: number, radius: number, polygon: readonly Point2D[]): number | null;
