import { describe, it, expect } from 'vitest';
import {
  boxPolygon,
  circleIntersectsPolygon,
  cleanPolygon,
  convexHull,
  convexPolygonsIntersect,
  decomposeConvex,
  distanceToPolygonBoundary,
  ensureCounterClockwise,
  isPolygonConvex,
  pointInPolygon,
  polygonArea,
  polygonBounds,
  polygonCentroid,
  polygonSignedArea,
  rectIntersectsConvexPolygon,
  segmentPolygonT,
  transformPolygon,
  type Point2D,
} from './collision-shapes-2d';

/** An L: concave, counter-clockwise, area 3 of a 2x2 grid of unit cells. */
const L_SHAPE: Point2D[] = [
  { x: 0, y: 0 },
  { x: 2, y: 0 },
  { x: 2, y: 1 },
  { x: 1, y: 1 },
  { x: 1, y: 2 },
  { x: 0, y: 2 },
];

/** A four-pointed star — four reflex vertices, the decomposition stress case. */
const STAR: Point2D[] = [
  { x: 0, y: 4 },
  { x: -1, y: 1 },
  { x: -4, y: 0 },
  { x: -1, y: -1 },
  { x: 0, y: -4 },
  { x: 1, y: -1 },
  { x: 4, y: 0 },
  { x: 1, y: 1 },
];

const UNIT_SQUARE = boxPolygon(1, 1);

describe('collision-shapes-2d / winding and measures', () => {
  it('reports positive signed area for counter-clockwise loops', () => {
    expect(polygonSignedArea(UNIT_SQUARE)).toBeCloseTo(4);
    expect(polygonSignedArea([...UNIT_SQUARE].reverse())).toBeCloseTo(-4);
    expect(polygonArea([...UNIT_SQUARE].reverse())).toBeCloseTo(4);
  });

  it('normalizes clockwise input to counter-clockwise', () => {
    const cw = [...L_SHAPE].reverse();
    expect(polygonSignedArea(cw)).toBeLessThan(0);
    expect(polygonSignedArea(ensureCounterClockwise(cw))).toBeGreaterThan(0);
  });

  it('computes the area centroid, not the vertex average', () => {
    // The L's vertex average sits at (1, 1); its area centroid does not.
    const centroid = polygonCentroid(L_SHAPE);
    expect(centroid.x).toBeCloseTo(5 / 6);
    expect(centroid.y).toBeCloseTo(5 / 6);
  });

  it('classifies convexity independently of winding', () => {
    expect(isPolygonConvex(UNIT_SQUARE)).toBe(true);
    expect(isPolygonConvex([...UNIT_SQUARE].reverse())).toBe(true);
    expect(isPolygonConvex(L_SHAPE)).toBe(false);
    expect(isPolygonConvex(STAR)).toBe(false);
  });

  it('treats collinear vertices as convex rather than as a reflex turn', () => {
    const withMidpoint: Point2D[] = [
      { x: -1, y: -1 },
      { x: 0, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
    ];
    expect(isPolygonConvex(withMidpoint)).toBe(true);
  });

  it('bounds a loop', () => {
    expect(polygonBounds(L_SHAPE)).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 2 });
  });
});

describe('collision-shapes-2d / cleanPolygon', () => {
  it('drops duplicate, wrapped-duplicate and collinear vertices', () => {
    const noisy: Point2D[] = [
      { x: -1, y: -1 },
      { x: 0, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
      { x: -1, y: -1 },
    ];
    expect(cleanPolygon(noisy)).toEqual([
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
    ]);
  });

  it('skips non-finite vertices instead of poisoning the loop', () => {
    const cleaned = cleanPolygon([
      { x: 0, y: 0 },
      { x: Number.NaN, y: 1 },
      { x: 2, y: 0 },
      { x: 0, y: 2 },
    ]);
    expect(cleaned).toHaveLength(3);
    expect(cleaned.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });

  it('returns fewer than three vertices for a degenerate loop', () => {
    expect(
      cleanPolygon([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ]).length
    ).toBeLessThan(3);
  });
});

describe('collision-shapes-2d / transformPolygon', () => {
  it('applies scale, then rotation, then position', () => {
    const rotated = transformPolygon(UNIT_SQUARE, {
      x: 10,
      y: 5,
      rotation: Math.PI / 2,
      scaleX: 2,
      scaleY: 1,
    });
    // (-2, -1) scaled, rotated 90 deg CCW -> (1, -2), then translated.
    expect(rotated[0].x).toBeCloseTo(11);
    expect(rotated[0].y).toBeCloseTo(3);
  });

  it('re-reverses the loop when a mirrored scale flips the winding', () => {
    const mirrored = transformPolygon(UNIT_SQUARE, {
      x: 0,
      y: 0,
      rotation: 0,
      scaleX: -1,
      scaleY: 1,
    });
    expect(polygonSignedArea(mirrored)).toBeGreaterThan(0);
  });

  it('keeps the winding for a uniform negative scale (a 180 degree rotation)', () => {
    const flipped = transformPolygon(L_SHAPE, {
      x: 0,
      y: 0,
      rotation: 0,
      scaleX: -1,
      scaleY: -1,
    });
    expect(polygonSignedArea(flipped)).toBeGreaterThan(0);
  });
});

describe('collision-shapes-2d / point and circle queries', () => {
  it('answers point-in-polygon for a concave loop', () => {
    expect(pointInPolygon(0.5, 0.5, L_SHAPE)).toBe(true);
    expect(pointInPolygon(0.5, 1.5, L_SHAPE)).toBe(true);
    // The missing quadrant of the L.
    expect(pointInPolygon(1.5, 1.5, L_SHAPE)).toBe(false);
    expect(pointInPolygon(5, 5, L_SHAPE)).toBe(false);
  });

  it('measures distance to the boundary from inside and outside', () => {
    expect(distanceToPolygonBoundary(0, 0, UNIT_SQUARE)).toBeCloseTo(1);
    expect(distanceToPolygonBoundary(3, 0, UNIT_SQUARE)).toBeCloseTo(2);
  });

  it('intersects a circle with a concave polygon by centre and by boundary', () => {
    expect(circleIntersectsPolygon(0.5, 0.5, 0.1, L_SHAPE)).toBe(true);
    // Centre sits in the L's missing quadrant but the corner is within reach.
    expect(circleIntersectsPolygon(1.5, 1.5, 0.8, L_SHAPE)).toBe(true);
    expect(circleIntersectsPolygon(1.5, 1.5, 0.2, L_SHAPE)).toBe(false);
  });
});

describe('collision-shapes-2d / SAT', () => {
  it('separates and overlaps two convex boxes', () => {
    const a = boxPolygon(1, 1);
    const near = transformPolygon(a, { x: 1.5, y: 0, rotation: 0, scaleX: 1, scaleY: 1 });
    const far = transformPolygon(a, { x: 2.5, y: 0, rotation: 0, scaleX: 1, scaleY: 1 });
    expect(convexPolygonsIntersect(a, near)).toBe(true);
    expect(convexPolygonsIntersect(a, far)).toBe(false);
  });

  it('needs rotation to be honoured: a 45 degree box reaches further along its diagonal', () => {
    const a = boxPolygon(1, 1);
    const diagonal = transformPolygon(a, {
      x: 2.2,
      y: 0,
      rotation: Math.PI / 4,
      scaleX: 1,
      scaleY: 1,
    });
    const axisAligned = transformPolygon(a, {
      x: 2.2,
      y: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
    });
    expect(convexPolygonsIntersect(a, diagonal)).toBe(true);
    expect(convexPolygonsIntersect(a, axisAligned)).toBe(false);
  });

  it('is winding-agnostic — a reversed loop still overlaps', () => {
    const a = boxPolygon(1, 1);
    const b = [...transformPolygon(a, { x: 1, y: 0, rotation: 0, scaleX: 1, scaleY: 1 })].reverse();
    expect(convexPolygonsIntersect(a, b)).toBe(true);
  });

  it('rejects degenerate operands', () => {
    expect(convexPolygonsIntersect(UNIT_SQUARE, [{ x: 0, y: 0 }])).toBe(false);
  });
});

describe('collision-shapes-2d / segment queries', () => {
  it('returns the near entry point, not the far one', () => {
    const t = segmentPolygonT(-5, 0, 10, 0, UNIT_SQUARE);
    expect(t).not.toBeNull();
    // Enters at x = -1, i.e. 4 units into a 10 unit ray.
    expect(t as number).toBeCloseTo(0.4);
  });

  it('returns 0 when the origin is already inside', () => {
    expect(segmentPolygonT(0, 0, 5, 0, UNIT_SQUARE)).toBe(0);
  });

  it('returns null for a ray that stops short', () => {
    expect(segmentPolygonT(-5, 0, 1, 0, UNIT_SQUARE)).toBeNull();
  });

  it('threads the concave notch of an L without a false hit', () => {
    // A ray through the L's missing quadrant only, from above right to below right.
    expect(segmentPolygonT(1.5, 3, 0, -1.5, L_SHAPE)).toBeNull();
    // The same ray, extended, does eventually hit the L's bottom arm.
    expect(segmentPolygonT(1.5, 3, 0, -3, L_SHAPE)).not.toBeNull();
  });
});

describe('collision-shapes-2d / convex decomposition', () => {
  const totalArea = (parts: Point2D[][]): number =>
    parts.reduce((sum, part) => sum + polygonArea(part), 0);

  it('passes a convex polygon through as a single part', () => {
    const parts = decomposeConvex(UNIT_SQUARE);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toHaveLength(4);
  });

  it('splits an L into convex parts that conserve area', () => {
    const parts = decomposeConvex(L_SHAPE);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(isPolygonConvex)).toBe(true);
    expect(totalArea(parts)).toBeCloseTo(polygonArea(L_SHAPE));
  });

  it('splits a four-point star into convex parts that conserve area', () => {
    const parts = decomposeConvex(STAR);
    expect(parts.every(isPolygonConvex)).toBe(true);
    expect(totalArea(parts)).toBeCloseTo(polygonArea(STAR));
  });

  it('normalizes every part to counter-clockwise regardless of input winding', () => {
    const parts = decomposeConvex([...STAR].reverse());
    expect(parts.every(part => polygonSignedArea(part) > 0)).toBe(true);
    expect(totalArea(parts)).toBeCloseTo(polygonArea(STAR));
  });

  it('covers the interior: every part point that is inside a part is inside the source', () => {
    for (const part of decomposeConvex(STAR)) {
      const centroid = polygonCentroid(part);
      expect(pointInPolygon(centroid.x, centroid.y, ensureCounterClockwise(STAR))).toBe(true);
    }
  });

  it('returns nothing for input that is not a polygon', () => {
    expect(decomposeConvex([])).toEqual([]);
    expect(
      decomposeConvex([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ])
    ).toEqual([]);
  });

  it('falls back to the hull for a self-intersecting bowtie instead of hanging', () => {
    const bowtie: Point2D[] = [
      { x: -1, y: -1 },
      { x: 1, y: 1 },
      { x: 1, y: -1 },
      { x: -1, y: 1 },
    ];
    const parts = decomposeConvex(bowtie);
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.every(isPolygonConvex)).toBe(true);
  });
});

describe('collision-shapes-2d / convex hull', () => {
  it('drops interior points', () => {
    const hull = convexHull([
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
      { x: 0, y: 0 },
    ]);
    expect(hull).toHaveLength(4);
    expect(hull.some(p => p.x === 0 && p.y === 0)).toBe(false);
  });
});

describe('collision-shapes-2d / rect vs polygon', () => {
  it('overlaps a rect against a rotated polygon', () => {
    const rotated = transformPolygon(boxPolygon(1, 1), {
      x: 2,
      y: 0,
      rotation: Math.PI / 4,
      scaleX: 1,
      scaleY: 1,
    });
    expect(rectIntersectsConvexPolygon(0, 0, 1, 1, rotated)).toBe(true);
    expect(rectIntersectsConvexPolygon(-5, 0, 1, 1, rotated)).toBe(false);
  });
});
