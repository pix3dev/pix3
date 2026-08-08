import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONTOUR_TOLERANCE,
  signedArea,
  simplifyPolygon,
  traceCollisionPolygon,
  traceMaskContour,
  type ContourMask,
  type ContourPoint,
} from './contour-trace';

/**
 * §9.12.2 — the alpha → collision-polygon math, exercised over hand-built masks so
 * every assertion is about the tracer itself and not about image decoding.
 *
 * Vertices are pixel corners: pixel `(x, y)` covers `[x, x+1] × [y, y+1]`, so a
 * 4×3 opaque block at `(2, 1)` has its bottom-right corner at `(6, 4)`.
 */

/** Build a mask from ASCII rows — `#` (or any non-space) is opaque, `.`/space is not. */
function maskFromRows(rows: string[]): ContourMask {
  const width = rows[0]?.length ?? 0;
  const height = rows.length;
  const data = new Uint8Array(width * height);
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] = row[x] === '#' ? 1 : 0;
    }
  });
  return { width, height, data };
}

/** Rotate a ring so its lexicographically smallest vertex leads — order preserved. */
function normalizeRing(points: readonly ContourPoint[]): ContourPoint[] {
  if (points.length === 0) {
    return [];
  }
  let start = 0;
  for (let index = 1; index < points.length; index += 1) {
    const candidate = points[index];
    const best = points[start];
    if (candidate.y < best.y || (candidate.y === best.y && candidate.x < best.x)) {
      start = index;
    }
  }
  return [...points.slice(start), ...points.slice(0, start)].map(point => ({
    x: point.x,
    y: point.y,
  }));
}

/** Distance from the polygon's edges to `center`, sampled along every edge. */
function sampleEdgeRadii(polygon: readonly ContourPoint[], center: ContourPoint): number[] {
  const radii: number[] = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const from = polygon[index];
    const to = polygon[(index + 1) % polygon.length];
    for (let step = 0; step <= 8; step += 1) {
      const t = step / 8;
      radii.push(
        Math.hypot(from.x + (to.x - from.x) * t - center.x, from.y + (to.y - from.y) * t - center.y)
      );
    }
  }
  return radii;
}

/** A filled disc of `radius` centred in a `size × size` mask. */
function discMask(size: number, radius: number): ContourMask {
  const data = new Uint8Array(size * size);
  const center = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Test the pixel's centre, so the raster edge sits at `radius` from the middle.
      const dx = x + 0.5 - center;
      const dy = y + 0.5 - center;
      data[y * size + x] = dx * dx + dy * dy <= radius * radius ? 1 : 0;
    }
  }
  return { width: size, height: size, data };
}

describe('contour-trace (§9.12.2)', () => {
  it('traces a rectangle down to its four corners', () => {
    const mask = maskFromRows([
      '..........',
      '..####....',
      '..####....',
      '..####....',
      '..........',
    ]);

    const polygon = traceCollisionPolygon(mask, { tolerance: 1 });

    expect(normalizeRing(polygon)).toEqual([
      { x: 2, y: 1 },
      { x: 6, y: 1 },
      { x: 6, y: 4 },
      { x: 2, y: 4 },
    ]);
    // Clockwise on screen (y down), which is the winding the tracer promises.
    expect(signedArea(polygon)).toBeGreaterThan(0);
  });

  it('keeps all six corners of an L-shape', () => {
    const mask = maskFromRows([
      '..........',
      '.########.',
      '.########.',
      '.########.',
      '.########.',
      '.####.....',
      '.####.....',
      '.####.....',
      '.####.....',
      '..........',
    ]);

    const polygon = traceCollisionPolygon(mask, { tolerance: 1 });

    expect(polygon).toHaveLength(6);
    expect(normalizeRing(polygon)).toEqual([
      { x: 1, y: 1 },
      { x: 9, y: 1 },
      { x: 9, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 9 },
      { x: 1, y: 9 },
    ]);
  });

  it('accepts a boolean[] mask as well as a Uint8Array', () => {
    const rows = ['....', '.##.', '.##.', '....'];
    const data = rows.flatMap(row => [...row].map(cell => cell === '#'));

    const polygon = traceCollisionPolygon({ width: 4, height: 4, data }, { tolerance: 1 });

    expect(normalizeRing(polygon)).toEqual([
      { x: 1, y: 1 },
      { x: 3, y: 1 },
      { x: 3, y: 3 },
      { x: 1, y: 3 },
    ]);
  });

  it('collapses a blob sharply as the tolerance rises while hugging its outline', () => {
    const radius = 20;
    const mask = discMask(48, radius);
    const center = { x: 24, y: 24 };

    const raw = traceMaskContour(mask);
    const fine = traceCollisionPolygon(mask, { tolerance: 0.5 });
    const coarse = traceCollisionPolygon(mask, { tolerance: 3 });

    // The staircase is dozens of corners; a collider wants a handful.
    expect(raw.length).toBeGreaterThan(40);
    expect(fine.length).toBeLessThan(raw.length);
    expect(coarse.length).toBeLessThan(fine.length / 2);
    expect(coarse.length).toBeGreaterThanOrEqual(3);

    // ...and the coarse polygon still runs in a narrow band around the true circle:
    // never bulging past the raster edge, never cutting deeper than the tolerance
    // (plus the one-pixel staircase the raster itself has).
    for (const sampled of sampleEdgeRadii(coarse, center)) {
      expect(sampled).toBeLessThanOrEqual(radius + 2);
      expect(sampled).toBeGreaterThanOrEqual(radius - 3 - 2);
    }
    for (const sampled of sampleEdgeRadii(fine, center)) {
      expect(sampled).toBeLessThanOrEqual(radius + 2);
      expect(sampled).toBeGreaterThanOrEqual(radius - 0.5 - 2);
    }
  });

  it('ignores a stray dot and traces the largest blob', () => {
    const mask = maskFromRows([
      '#.........',
      '..........',
      '...####...',
      '...####...',
      '..........',
    ]);

    const polygon = traceCollisionPolygon(mask, { tolerance: 1 });

    expect(normalizeRing(polygon)).toEqual([
      { x: 3, y: 2 },
      { x: 7, y: 2 },
      { x: 7, y: 4 },
      { x: 3, y: 4 },
    ]);
  });

  it('returns an empty polygon for a mask with no opaque pixel', () => {
    const mask = maskFromRows(['....', '....', '....']);

    expect(traceCollisionPolygon(mask)).toEqual([]);
    expect(traceMaskContour(mask)).toEqual([]);
    expect(traceCollisionPolygon({ width: 0, height: 0, data: new Uint8Array(0) })).toEqual([]);
  });

  it('returns the frame rectangle for a fully opaque mask, at any tolerance', () => {
    const mask = maskFromRows(['####', '####', '####']);
    const rectangle = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 3 },
      { x: 0, y: 3 },
    ];

    expect(traceCollisionPolygon(mask, { tolerance: 0 })).toEqual(rectangle);
    expect(traceCollisionPolygon(mask, { tolerance: DEFAULT_CONTOUR_TOLERANCE })).toEqual(
      rectangle
    );
    // The guard that matters: a tolerance far bigger than the shape must not turn
    // an opaque plate into a triangle.
    expect(traceCollisionPolygon(mask, { tolerance: 500 })).toEqual(rectangle);
  });

  it('falls back to a triangle rather than returning something unusable as a collider', () => {
    const mask = discMask(48, 20);

    // A tolerance this large flattens the ring to its two split anchors...
    expect(simplifyPolygon(traceMaskContour(mask), 500).length).toBeLessThan(3);
    // ...but the entry point never hands that out.
    const polygon = traceCollisionPolygon(mask, { tolerance: 500 });
    expect(polygon).toHaveLength(3);
    expect(Math.abs(signedArea(polygon))).toBeGreaterThan(0);
    // Every vertex is a real outline vertex, so the triangle is inscribed.
    const outline = new Set(traceMaskContour(mask).map(point => `${point.x},${point.y}`));
    for (const vertex of polygon) {
      expect(outline.has(`${vertex.x},${vertex.y}`)).toBe(true);
    }
  });

  it('keeps the ring untouched when the tolerance is zero or the ring is a triangle', () => {
    const ring = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];

    expect(simplifyPolygon(ring, 0)).toEqual(ring);
    expect(simplifyPolygon(ring.slice(0, 3), 100)).toEqual(ring.slice(0, 3));
  });
});
