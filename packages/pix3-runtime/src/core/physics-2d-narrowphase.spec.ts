import { describe, expect, it } from 'vitest';
import { boxPolygon, transformPolygon, type Point2D } from './collision-shapes-2d';
import {
  collideCirclePolygon,
  collideCircles,
  collidePolygons,
  sweepCircleAgainstPolygon,
} from './physics-2d-narrowphase';

const box = (halfW: number, halfH: number, x = 0, y = 0, rotation = 0): Point2D[] =>
  transformPolygon(boxPolygon(halfW, halfH), { x, y, rotation, scaleX: 1, scaleY: 1 });

describe('physics narrowphase / circles', () => {
  it('reports the overlap depth and the A-to-B normal', () => {
    const manifold = collideCircles(0, 0, 10, 15, 0, 10);
    expect(manifold).not.toBeNull();
    expect(manifold!.normalX).toBeCloseTo(1);
    expect(manifold!.normalY).toBeCloseTo(0);
    expect(manifold!.contacts[0].penetration).toBeCloseTo(5);
  });

  it('misses when the gap exceeds the radii', () => {
    expect(collideCircles(0, 0, 10, 25, 0, 10)).toBeNull();
  });

  it('picks a usable normal for concentric circles instead of NaN', () => {
    const manifold = collideCircles(0, 0, 10, 0, 0, 10);
    expect(manifold).not.toBeNull();
    expect(Number.isFinite(manifold!.normalX)).toBe(true);
    expect(Math.hypot(manifold!.normalX, manifold!.normalY)).toBeCloseTo(1);
  });
});

describe('physics narrowphase / circle vs polygon', () => {
  it('finds the face contact with the normal pointing from the circle', () => {
    // Circle just left of a box spanning x in [-10, 10].
    const manifold = collideCirclePolygon(-18, 0, 10, box(10, 10));
    expect(manifold).not.toBeNull();
    expect(manifold!.normalX).toBeCloseTo(1);
    expect(manifold!.contacts[0].penetration).toBeCloseTo(2);
  });

  it('finds a corner contact with a diagonal normal', () => {
    const manifold = collideCirclePolygon(-14, -14, 10, box(10, 10));
    expect(manifold).not.toBeNull();
    expect(manifold!.normalX).toBeCloseTo(Math.SQRT1_2, 2);
    expect(manifold!.normalY).toBeCloseTo(Math.SQRT1_2, 2);
  });

  it('misses a circle that only reaches the corner diagonally', () => {
    expect(collideCirclePolygon(-20, -20, 10, box(10, 10))).toBeNull();
  });

  it('pushes a circle whose centre is inside back out through the nearest face', () => {
    // Centre at x = 8 inside a box spanning [-10, 10]: the way out is +x, so the
    // A-to-B normal (circle to polygon) must point -x. Getting this backwards
    // drives a deep body further in instead of ejecting it.
    const manifold = collideCirclePolygon(8, 0, 4, box(10, 10));
    expect(manifold).not.toBeNull();
    expect(manifold!.normalX).toBeCloseTo(-1);
    expect(manifold!.contacts[0].penetration).toBeGreaterThan(4);
    // The contact sits on the face it will be pushed out through.
    expect(manifold!.contacts[0].x).toBeCloseTo(10);
  });
});

describe('physics narrowphase / polygon vs polygon', () => {
  it('produces two contact points for a face-on-face overlap', () => {
    const a = box(10, 10, 0, 0);
    const b = box(10, 10, 18, 0);
    const manifold = collidePolygons(a, b);
    expect(manifold).not.toBeNull();
    expect(manifold!.contacts).toHaveLength(2);
    expect(manifold!.normalX).toBeCloseTo(1);
    expect(manifold!.normalY).toBeCloseTo(0);
    for (const contact of manifold!.contacts) {
      expect(contact.penetration).toBeCloseTo(2);
    }
  });

  it('orients the normal from A towards B in both argument orders', () => {
    const a = box(10, 10, 0, 0);
    const b = box(10, 10, 0, 18);
    expect(collidePolygons(a, b)!.normalY).toBeCloseTo(1);
    expect(collidePolygons(b, a)!.normalY).toBeCloseTo(-1);
  });

  it('separates boxes that do not touch', () => {
    expect(collidePolygons(box(10, 10, 0, 0), box(10, 10, 30, 0))).toBeNull();
  });

  it('needs the rotated axis: a 45-degree box overlaps where an axis-aligned one does not', () => {
    const a = box(10, 10, 0, 0);
    expect(collidePolygons(a, box(10, 10, 24, 0, Math.PI / 4))).not.toBeNull();
    expect(collidePolygons(a, box(10, 10, 24, 0))).toBeNull();
  });

  it('gives a resting box a stable normal and two points (the stacking case)', () => {
    const ground = box(200, 10, 0, -10);
    const crate = box(10, 10, 0, 9.5);
    const manifold = collidePolygons(ground, crate);
    expect(manifold).not.toBeNull();
    expect(manifold!.normalY).toBeCloseTo(1);
    expect(manifold!.contacts).toHaveLength(2);
  });

  it('keeps contact ids stable while a box slides along a face', () => {
    const ground = box(200, 10, 0, -10);
    const first = collidePolygons(ground, box(10, 10, 0, 9.5))!;
    const slid = collidePolygons(ground, box(10, 10, 3, 9.5))!;
    expect(slid.contacts.map(c => c.featureId)).toEqual(first.contacts.map(c => c.featureId));
  });

  it('handles a corner-on-face overlap with a single point', () => {
    const manifold = collidePolygons(box(10, 10, 0, 0), box(10, 10, 13, 13, Math.PI / 4));
    expect(manifold).not.toBeNull();
    expect(manifold!.contacts.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects degenerate operands', () => {
    expect(collidePolygons(box(10, 10), [{ x: 0, y: 0 }])).toBeNull();
  });
});

describe('physics narrowphase / swept circle (CCD)', () => {
  const wall = box(5, 200, 100, 0);

  it('catches a wall a discrete step would tunnel through', () => {
    // 4 px ball at x = 0 moving 400 px right in one step; the wall is 10 px thick
    // at x = 100, so both endpoints of the step are clear of it.
    const t = sweepCircleAgainstPolygon(0, 0, 400, 0, 4, wall);
    expect(t).not.toBeNull();
    // First touch at x = 95 - 4 = 91, i.e. 91/400 of the way.
    expect(t as number).toBeCloseTo(91 / 400, 3);
  });

  it('returns null for a motion that stops short', () => {
    expect(sweepCircleAgainstPolygon(0, 0, 50, 0, 4, wall)).toBeNull();
  });

  it('returns null for a motion that passes the wall by', () => {
    expect(sweepCircleAgainstPolygon(0, 500, 400, 0, 4, wall)).toBeNull();
  });

  it('reports 0 when the circle already overlaps at the start', () => {
    expect(sweepCircleAgainstPolygon(97, 0, 100, 0, 4, wall)).toBe(0);
  });

  it('catches a corner approach', () => {
    // Aimed at the wall's top-right corner region from below-right.
    const t = sweepCircleAgainstPolygon(140, -260, -60, 260, 4, box(5, 200, 100, 0));
    expect(t).not.toBeNull();
  });
});
