import type { Point2D } from './collision-shapes-2d';
/**
 * Read an authored `points` config value into vertices the collision math can use.
 *
 * The value comes out of a `.pix3scene`'s `components: [{ config: { points } }]`
 * bag, which is untyped YAML — and out of the agent's `set_component_property`,
 * which passes model JSON straight through. Three spellings are accepted because
 * all three are things a human or a model plausibly writes:
 *
 * - `[{ x: 1, y: 2 }, ...]` — what the editor writes and what YAML round-trips;
 * - `[[1, 2], ...]` — the compact pair form;
 * - `[1, 2, 3, 4, ...]` — a flat coordinate run (an odd trailing value is dropped).
 *
 * Anything else in the array — a string, a null, a NaN — is skipped rather than
 * coerced to 0, because a vertex silently pinned to the origin turns a collider
 * into a shape nobody authored and nothing reports.
 */
export declare function normalizePolygonConfig(value: unknown): Point2D[];
/**
 * The serialized form: plain `{x, y}` objects, rounded to a hundredth of a pixel.
 *
 * Rounding is not cosmetic. Viewport drags produce full float noise, and an
 * un-rounded array makes every polygon edit rewrite the whole `points` block in
 * the `.pix3scene` with a diff nobody can read — and, in a collab session, a
 * conflict on vertices that did not move.
 */
export declare function serializePolygonConfig(points: readonly Point2D[]): Point2D[];
