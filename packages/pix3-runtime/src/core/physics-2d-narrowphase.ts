import { circleIntersectsPolygon, type Point2D } from './collision-shapes-2d';

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

const EPSILON = 1e-9;

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
export const CONTACT_MARGIN = 0.5;

/** Circle vs circle. `null` when they do not overlap. */
export function collideCircles(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number
): Manifold2D | null {
  const dx = bx - ax;
  const dy = by - ay;
  const distSq = dx * dx + dy * dy;
  const radius = ar + br;
  const reach = radius + CONTACT_MARGIN;
  if (distSq > reach * reach) {
    return null;
  }

  const dist = Math.sqrt(distSq);
  // Concentric circles have no meaningful normal; pick +x so the pair still
  // separates instead of accumulating an impulse along NaN.
  const normalX = dist > EPSILON ? dx / dist : 1;
  const normalY = dist > EPSILON ? dy / dist : 0;
  const penetration = radius - dist;

  return {
    normalX,
    normalY,
    contacts: [
      {
        x: ax + normalX * (ar - penetration / 2),
        y: ay + normalY * (ar - penetration / 2),
        penetration,
        featureId: 0,
      },
    ],
  };
}

/**
 * Circle vs convex polygon. The normal points from the **circle** towards the
 * polygon, matching {@link collideCircles}' A-to-B convention with the circle as A.
 */
export function collideCirclePolygon(
  cx: number,
  cy: number,
  radius: number,
  polygon: readonly Point2D[]
): Manifold2D | null {
  const n = polygon.length;
  if (n < 3) {
    return null;
  }

  // Deepest face: for a CCW loop the outward normal of edge j->i is (dy, -dx).
  let maxSeparation = -Infinity;
  let faceIndex = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ex = polygon[i].x - polygon[j].x;
    const ey = polygon[i].y - polygon[j].y;
    const len = Math.hypot(ex, ey);
    if (len < EPSILON) {
      continue;
    }
    const nx = ey / len;
    const ny = -ex / len;
    const separation = (cx - polygon[j].x) * nx + (cy - polygon[j].y) * ny;
    if (separation > maxSeparation) {
      maxSeparation = separation;
      faceIndex = j;
    }
  }

  if (maxSeparation > radius + CONTACT_MARGIN) {
    return null;
  }

  const a = polygon[faceIndex];
  const b = polygon[(faceIndex + 1) % n];

  // Centre inside the polygon: push straight out through the nearest face.
  //
  // The returned normal is the face's INWARD normal, not its outward one. The
  // contract is "from the circle towards the polygon", and the circle has to
  // travel *out* along the outward normal — so with A = circle, the impulse
  // that moves A outwards is -n. Returning the outward normal here (the obvious
  // reading) drives a deeply-penetrating body further in, which is exactly how a
  // ball dropped fast enough to reach the inside of the floor in one step sank
  // through it instead of bouncing.
  if (maxSeparation < EPSILON) {
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey) || 1;
    const outX = ey / len;
    const outY = -ex / len;
    return {
      normalX: -outX,
      normalY: -outY,
      contacts: [
        {
          // Projection of the centre onto the face plane.
          x: cx + outX * -maxSeparation,
          y: cy + outY * -maxSeparation,
          penetration: radius - maxSeparation,
          featureId: faceIndex,
        },
      ],
    };
  }

  // Outside: the nearest feature is a vertex or the face interior.
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const lenSq = ex * ex + ey * ey;
  let t = lenSq > EPSILON ? ((cx - a.x) * ex + (cy - a.y) * ey) / lenSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = a.x + ex * t;
  const py = a.y + ey * t;

  const dx = px - cx;
  const dy = py - cy;
  const dist = Math.hypot(dx, dy);
  if (dist > radius + CONTACT_MARGIN) {
    return null;
  }

  const normalX = dist > EPSILON ? dx / dist : 0;
  const normalY = dist > EPSILON ? dy / dist : 1;
  return {
    normalX,
    normalY,
    contacts: [{ x: px, y: py, penetration: radius - dist, featureId: faceIndex }],
  };
}

interface FaceSeparation {
  separation: number;
  edgeIndex: number;
}

/**
 * Largest separation of `b` from any face plane of `a`, and which face achieved
 * it. A positive result is a separating axis, i.e. no collision.
 */
function findMaxSeparation(a: readonly Point2D[], b: readonly Point2D[]): FaceSeparation {
  let best = -Infinity;
  let bestEdge = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) {
    const p1 = a[i];
    const p2 = a[(i + 1) % n];
    const ex = p2.x - p1.x;
    const ey = p2.y - p1.y;
    const len = Math.hypot(ex, ey);
    if (len < EPSILON) {
      continue;
    }
    const nx = ey / len;
    const ny = -ex / len;

    // Support point of b in the -normal direction: the vertex that reaches
    // deepest through this face plane.
    let minProjection = Infinity;
    for (const point of b) {
      const projection = (point.x - p1.x) * nx + (point.y - p1.y) * ny;
      if (projection < minProjection) {
        minProjection = projection;
      }
    }
    if (minProjection > best) {
      best = minProjection;
      bestEdge = i;
    }
  }
  return { separation: best, edgeIndex: bestEdge };
}

/** The edge of `polygon` whose outward normal opposes `(nx, ny)` most strongly. */
function findIncidentEdge(polygon: readonly Point2D[], nx: number, ny: number): number {
  const n = polygon.length;
  let bestDot = Infinity;
  let bestEdge = 0;
  for (let i = 0; i < n; i++) {
    const p1 = polygon[i];
    const p2 = polygon[(i + 1) % n];
    const ex = p2.x - p1.x;
    const ey = p2.y - p1.y;
    const len = Math.hypot(ex, ey);
    if (len < EPSILON) {
      continue;
    }
    const dot = (ey / len) * nx + (-ex / len) * ny;
    if (dot < bestDot) {
      bestDot = dot;
      bestEdge = i;
    }
  }
  return bestEdge;
}

interface ClipVertex {
  x: number;
  y: number;
  id: number;
}

/** Sutherland–Hodgman clip of a segment against one half-plane. */
function clipSegmentToLine(
  input: readonly ClipVertex[],
  nx: number,
  ny: number,
  offset: number,
  clipId: number
): ClipVertex[] {
  const out: ClipVertex[] = [];
  const d0 = nx * input[0].x + ny * input[0].y - offset;
  const d1 = nx * input[1].x + ny * input[1].y - offset;

  if (d0 <= 0) out.push(input[0]);
  if (d1 <= 0) out.push(input[1]);

  if (d0 * d1 < 0) {
    const t = d0 / (d0 - d1);
    out.push({
      x: input[0].x + t * (input[1].x - input[0].x),
      y: input[0].y + t * (input[1].y - input[0].y),
      // The clipped end takes the clipping plane's identity, so the point keeps
      // the same id from step to step while the geometry slides along the face.
      id: clipId,
    });
  }
  return out;
}

/**
 * Convex polygon vs convex polygon. The normal points from `a` towards `b`;
 * up to two contact points come out of clipping the incident face against the
 * reference face's side planes.
 */
export function collidePolygons(a: readonly Point2D[], b: readonly Point2D[]): Manifold2D | null {
  if (a.length < 3 || b.length < 3) {
    return null;
  }

  const sepA = findMaxSeparation(a, b);
  if (sepA.separation > CONTACT_MARGIN) {
    return null;
  }
  const sepB = findMaxSeparation(b, a);
  if (sepB.separation > CONTACT_MARGIN) {
    return null;
  }

  // Prefer A's face unless B's is meaningfully deeper. The bias keeps the choice
  // from flip-flopping between steps on a near-tie, which would reset warm
  // starting every frame and make a resting box buzz.
  const preferB = sepB.separation > sepA.separation + 1e-5;
  const reference = preferB ? b : a;
  const incident = preferB ? a : b;
  const referenceEdge = preferB ? sepB.edgeIndex : sepA.edgeIndex;

  const rn = reference.length;
  const r1 = reference[referenceEdge];
  const r2 = reference[(referenceEdge + 1) % rn];
  const ex = r2.x - r1.x;
  const ey = r2.y - r1.y;
  const edgeLength = Math.hypot(ex, ey);
  if (edgeLength < EPSILON) {
    return null;
  }
  const tangentX = ex / edgeLength;
  const tangentY = ey / edgeLength;
  const normalX = tangentY;
  const normalY = -tangentX;

  const incidentEdge = findIncidentEdge(incident, normalX, normalY);
  const inN = incident.length;
  const i1 = incident[incidentEdge];
  const i2 = incident[(incidentEdge + 1) % inN];

  let clipped: ClipVertex[] = [
    { x: i1.x, y: i1.y, id: incidentEdge * 4 + 0 },
    { x: i2.x, y: i2.y, id: incidentEdge * 4 + 1 },
  ];

  // Side planes of the reference face, pointing outwards along the face.
  clipped = clipSegmentToLine(
    clipped,
    -tangentX,
    -tangentY,
    -(tangentX * r1.x + tangentY * r1.y),
    referenceEdge * 4 + 2
  );
  if (clipped.length < 2) {
    return null;
  }
  clipped = clipSegmentToLine(
    clipped,
    tangentX,
    tangentY,
    tangentX * r2.x + tangentY * r2.y,
    referenceEdge * 4 + 3
  );
  if (clipped.length < 2) {
    return null;
  }

  const frontOffset = normalX * r1.x + normalY * r1.y;
  const contacts: Contact2D[] = [];
  for (const point of clipped) {
    const separation = normalX * point.x + normalY * point.y - frontOffset;
    if (separation <= CONTACT_MARGIN) {
      contacts.push({
        x: point.x,
        y: point.y,
        penetration: -separation,
        featureId: point.id,
      });
    }
  }
  if (contacts.length === 0) {
    return null;
  }

  // The normal must always point A -> B; it currently points out of `reference`.
  return preferB
    ? { normalX: -normalX, normalY: -normalY, contacts }
    : { normalX, normalY, contacts };
}

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
export function sweepCircleAgainstPolygon(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  radius: number,
  polygon: readonly Point2D[]
): number | null {
  const n = polygon.length;
  if (n < 3) {
    return null;
  }

  // Already touching at t = 0. The face and vertex-cap tests below both assume
  // the circle starts outside, so without this an overlapping start reports
  // "clear" — the one answer a caller must never get from a sweep.
  if (circleIntersectsPolygon(ox, oy, radius, polygon)) {
    return 0;
  }

  let earliest: number | null = null;
  const consider = (t: number): void => {
    if (t >= 0 && t <= 1 && (earliest === null || t < earliest)) {
      earliest = t;
    }
  };

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < EPSILON) {
      continue;
    }
    const nx = ey / len;
    const ny = -ex / len;

    // Face plane pushed out by the radius.
    const denominator = dx * nx + dy * ny;
    if (denominator < -EPSILON) {
      const distance = (ox - a.x) * nx + (oy - a.y) * ny - radius;
      const t = -distance / denominator;
      if (t >= 0 && t <= 1) {
        // Only count it where the touch point actually lies within the face span.
        const px = ox + dx * t - nx * radius;
        const py = oy + dy * t - ny * radius;
        const along = ((px - a.x) * ex + (py - a.y) * ey) / (len * len);
        if (along >= 0 && along <= 1) {
          consider(t);
        }
      }
    }

    // Vertex cap: ray vs a circle of `radius` at the vertex.
    const t = raySphereT(ox, oy, dx, dy, a.x, a.y, radius);
    if (t !== null) {
      consider(t);
    }
  }

  return earliest;
}

/** Smallest `t` in [0, 1] where the ray enters a circle, or `null`. */
function raySphereT(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  cx: number,
  cy: number,
  radius: number
): number | null {
  const fx = ox - cx;
  const fy = oy - cy;
  const a = dx * dx + dy * dy;
  if (a < EPSILON) {
    return null;
  }
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - radius * radius;
  if (c <= 0) {
    return 0;
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) {
    return null;
  }
  const t = (-b - Math.sqrt(discriminant)) / (2 * a);
  return t >= 0 && t <= 1 ? t : null;
}
