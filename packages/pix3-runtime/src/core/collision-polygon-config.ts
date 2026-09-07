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
export function normalizePolygonConfig(value: unknown): Point2D[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }

  // Flat coordinate run: `[x, y, x, y, ...]`.
  if (typeof value[0] === 'number') {
    const out: Point2D[] = [];
    for (let i = 0; i + 1 < value.length; i += 2) {
      const x = Number(value[i]);
      const y = Number(value[i + 1]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        out.push({ x, y });
      }
    }
    return out;
  }

  const out: Point2D[] = [];
  for (const entry of value) {
    if (Array.isArray(entry)) {
      const x = Number(entry[0]);
      const y = Number(entry[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        out.push({ x, y });
      }
      continue;
    }
    if (entry && typeof entry === 'object') {
      const x = Number((entry as { x?: unknown }).x);
      const y = Number((entry as { y?: unknown }).y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        out.push({ x, y });
      }
    }
  }
  return out;
}

/**
 * The serialized form: plain `{x, y}` objects, rounded to a hundredth of a pixel.
 *
 * Rounding is not cosmetic. Viewport drags produce full float noise, and an
 * un-rounded array makes every polygon edit rewrite the whole `points` block in
 * the `.pix3scene` with a diff nobody can read — and, in a collab session, a
 * conflict on vertices that did not move.
 */
export function serializePolygonConfig(points: readonly Point2D[]): Point2D[] {
  return points.map(p => ({
    x: Math.round(p.x * 100) / 100,
    y: Math.round(p.y * 100) / 100,
  }));
}
