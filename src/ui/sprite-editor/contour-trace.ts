/**
 * Alpha-mask → collision-polygon tracing for the Sprite Editor (§9.12.2).
 *
 * Sibling of {@link import('./crop-geometry')} and {@link import('./place-geometry')},
 * and deliberately shaped like them: pure functions, no DOM, no canvas. The host
 * decodes the frame's pixels into a boolean mask (`readAlphaMask` in
 * `@/services/image-gen/image-ops`) and hands it over, so the tracing math is
 * testable without mounting a component or decoding an image.
 *
 * **Coordinate contract.** Vertices are *pixel-corner* coordinates: pixel `(x, y)`
 * of the mask covers the square `[x, x+1] × [y, y+1]`, so a vertex ranges over
 * `0..width` / `0..height`, y down. That is exactly the **absolute frame-pixel**
 * space `AnimationFrame.collisionPolygon` stores and `restampFrameGeometry` maps —
 * a traced polygon can be written straight into a frame, and survives a later crop
 * or flip like a hand-drawn one.
 *
 * The pipeline is the classic two-stage one:
 *
 * 1. {@link traceMaskContour} — a marching-squares boundary walk that returns the
 *    outer outline of the largest opaque blob as a staircase of corner vertices.
 * 2. {@link simplifyPolygon} — Ramer–Douglas–Peucker with a tolerance in pixels,
 *    which turns that staircase into the handful of vertices a collider wants.
 *
 * {@link traceCollisionPolygon} is the entry point that runs both and enforces the
 * degenerate-case guarantees (empty mask, fully opaque mask, over-large tolerance).
 */

/** A polygon vertex, in absolute frame pixels. Structurally `AnimationPolygonPoint`. */
export interface ContourPoint {
  x: number;
  y: number;
}

/** Row-major opacity flags. Non-zero / `true` = opaque. */
export type ContourMaskData = Uint8Array | readonly boolean[];

/** A decoded alpha channel reduced to one flag per pixel. */
export interface ContourMask {
  readonly width: number;
  readonly height: number;
  /** `width * height` entries, row-major, origin top-left. */
  readonly data: ContourMaskData;
}

export interface TraceCollisionPolygonOptions {
  /**
   * Ramer–Douglas–Peucker tolerance, in pixels: no simplified edge strays further
   * than this from the traced outline. 0 keeps the raw staircase. Default 2.
   */
  tolerance?: number;
}

/** What {@link traceCollisionPolygon} simplifies at when the caller says nothing. */
export const DEFAULT_CONTOUR_TOLERANCE = 2;

/** Below this a polygon is not a collider at all, so the guard in §9.12.2 kicks in. */
const MIN_POLYGON_VERTICES = 3;

/** Walk directions, in `[right, down, left, up]` order (y is down). */
const DIRECTIONS: ReadonlyArray<ContourPoint> = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
];

const RIGHT = 0;

/**
 * Rotate a heading counter-clockwise on screen (`(x, y) → (y, -x)`).
 *
 * This is the tie-breaker at a checkerboard vertex, where two opaque pixels meet
 * corner to corner and the outline could either cross the diagonal or turn back.
 * Taking the counter-clockwise turn crosses it, i.e. treats the foreground as
 * 8-connected — which is what a sprite artist means by "the same shape", and it
 * keeps the tracer from cutting a thin diagonal limb off a character.
 */
const rotateCounterClockwise = (direction: number): number => (direction + 3) % 4;

/**
 * Trace the outer outline of the mask's **largest** opaque blob, as a closed ring
 * of corner vertices (no repeated final vertex, no collinear points in between).
 *
 * Largest rather than first-found on purpose: a stray dot in a corner is a common
 * artefact of background removal, and a collider drawn around it would be useless.
 * Interior holes are ignored — a collision polygon is a single ring.
 *
 * Returns an empty array when no pixel is opaque.
 */
export function traceMaskContour(mask: ContourMask): ContourPoint[] {
  const width = Math.max(0, Math.floor(mask.width));
  const height = Math.max(0, Math.floor(mask.height));
  if (width <= 0 || height <= 0) {
    return [];
  }

  const isOpaque = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && Boolean(mask.data[y * width + x]);

  // Outgoing boundary edges at the grid vertex (x, y), whose four surrounding
  // pixels are A (up-left), B (up-right), C (down-left), D (down-right). Each
  // boundary edge is walked with the opaque side on its right, so the outer
  // contour comes out clockwise on screen.
  const outgoing = (x: number, y: number, into: number[]): number[] => {
    const a = isOpaque(x - 1, y - 1);
    const b = isOpaque(x, y - 1);
    const c = isOpaque(x - 1, y);
    const d = isOpaque(x, y);
    into.length = 0;
    if (d && !b) into.push(0); // right
    if (c && !d) into.push(1); // down
    if (a && !c) into.push(2); // left
    if (b && !a) into.push(3); // up
    return into;
  };

  const visited = new Set<number>();
  const edgeKey = (x: number, y: number, direction: number): number =>
    (y * (width + 1) + x) * 4 + direction;
  // A closed walk can be no longer than the number of boundary edges there are.
  const maxSteps = 4 * width * height + 8;

  const walkFrom = (startX: number, startY: number): ContourPoint[] => {
    const points: ContourPoint[] = [];
    const options: number[] = [];
    let x = startX;
    let y = startY;
    let direction = RIGHT;

    for (let step = 0; step < maxSteps; step += 1) {
      visited.add(edgeKey(x, y, direction));
      const delta = DIRECTIONS[direction];
      x += delta.x;
      y += delta.y;

      const choices = outgoing(x, y, options);
      let nextDirection: number;
      if (choices.length === 0) {
        // Cannot happen for a well-formed mask; bail rather than spin.
        break;
      } else if (choices.length === 1) {
        nextDirection = choices[0];
      } else {
        const preferred = rotateCounterClockwise(direction);
        nextDirection = choices.includes(preferred) ? preferred : choices[0];
      }

      // Only turns are corners; the pixels in between are collinear filler.
      if (nextDirection !== direction) {
        points.push({ x, y });
      }
      direction = nextDirection;

      if (x === startX && y === startY && direction === RIGHT) {
        break;
      }
    }

    return points;
  };

  let best: ContourPoint[] = [];
  let bestArea = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // A pixel with nothing above it owns a top edge, which every *outer*
      // contour has at least one of (a hole's topmost edge points the other way,
      // so holes are never seeded — exactly what we want).
      if (!isOpaque(x, y) || isOpaque(x, y - 1) || visited.has(edgeKey(x, y, RIGHT))) {
        continue;
      }
      const loop = walkFrom(x, y);
      if (loop.length < MIN_POLYGON_VERTICES) {
        continue;
      }
      const area = Math.abs(signedArea(loop));
      if (area > bestArea) {
        bestArea = area;
        best = loop;
      }
    }
  }

  return best;
}

/**
 * Ramer–Douglas–Peucker over a **closed** ring: no output edge strays further than
 * `tolerance` pixels from the input outline.
 *
 * A ring has no natural endpoints, so it is split at two anchors — the first vertex
 * and the vertex farthest from it — and each half is simplified as an open
 * polyline. Anchoring on the farthest vertex (rather than, say, index `n/2`) keeps
 * both anchors on genuine extremes of the shape, so neither corner of the split is
 * an arbitrary bump the simplification then has to preserve.
 *
 * The result may be shorter than three vertices for a large tolerance; that guard
 * belongs to {@link traceCollisionPolygon}, not here.
 */
export function simplifyPolygon(
  points: readonly ContourPoint[],
  tolerance: number
): ContourPoint[] {
  if (points.length <= MIN_POLYGON_VERTICES || !(tolerance > 0)) {
    return points.map(point => ({ x: point.x, y: point.y }));
  }

  const anchor = farthestIndexFrom(points, 0);
  if (anchor <= 0) {
    return points.map(point => ({ x: point.x, y: point.y }));
  }

  const first = simplifyPolyline(points.slice(0, anchor + 1), tolerance);
  const second = simplifyPolyline([...points.slice(anchor), points[0]], tolerance);
  // Each chain repeats its far end as the next chain's start; drop the duplicates.
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

/**
 * Mask + tolerance → the polygon to write into `AnimationFrame.collisionPolygon`.
 *
 * The degenerate cases §9.12.2 calls out, all handled before simplification so the
 * tolerance cannot turn them into something unusable:
 *
 * - **No opaque pixel at all** → an empty polygon. The caller decides whether that
 *   is an error; it must not become a random triangle.
 * - **Every pixel opaque** → the frame rectangle, whatever the tolerance. This is
 *   the common case for an opaque background plate, and a collider that is not the
 *   full rect there would be plainly wrong.
 * - **A tolerance that would collapse the outline below three vertices** → the
 *   largest triangle inscribed in the traced outline instead. A 2- or 1-vertex
 *   "polygon" is not a collider, and silently returning one would make the tool
 *   look broken at the top of its own slider.
 */
export function traceCollisionPolygon(
  mask: ContourMask,
  options: TraceCollisionPolygonOptions = {}
): ContourPoint[] {
  const width = Math.max(0, Math.floor(mask.width));
  const height = Math.max(0, Math.floor(mask.height));
  if (width <= 0 || height <= 0) {
    return [];
  }

  let opaqueCount = 0;
  for (let index = 0; index < width * height; index += 1) {
    if (mask.data[index]) {
      opaqueCount += 1;
    }
  }
  if (opaqueCount === 0) {
    return [];
  }
  if (opaqueCount === width * height) {
    return [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ];
  }

  const contour = traceMaskContour(mask);
  if (contour.length < MIN_POLYGON_VERTICES) {
    return contour;
  }

  const tolerance = Math.max(0, options.tolerance ?? DEFAULT_CONTOUR_TOLERANCE);
  const simplified = simplifyPolygon(contour, tolerance);
  return simplified.length >= MIN_POLYGON_VERTICES ? simplified : inscribedTriangle(contour);
}

/** Shoelace area; positive for a clockwise ring in y-down screen space. */
export function signedArea(points: readonly ContourPoint[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    total += current.x * next.y - next.x * current.y;
  }
  return total / 2;
}

/**
 * Three vertices of `points` that span it: the two farthest apart plus the one
 * farthest off the line between them. Not the provably maximal triangle (that is
 * O(n²) for a gain nobody can see at this tolerance) but always a real triangle
 * enclosed by real outline vertices.
 */
function inscribedTriangle(points: readonly ContourPoint[]): ContourPoint[] {
  if (points.length < MIN_POLYGON_VERTICES) {
    return points.map(point => ({ x: point.x, y: point.y }));
  }

  const first = farthestIndexFrom(points, 0);
  const second = farthestIndexFrom(points, first);
  const start = points[first];
  const end = points[second];
  let apex = -1;
  let apexDistance = -1;
  for (let index = 0; index < points.length; index += 1) {
    if (index === first || index === second) {
      continue;
    }
    const distance = perpendicularDistance(points[index], start, end);
    if (distance > apexDistance) {
      apexDistance = distance;
      apex = index;
    }
  }
  if (apex < 0) {
    return points.slice(0, MIN_POLYGON_VERTICES).map(point => ({ x: point.x, y: point.y }));
  }

  // Keep the ring's own winding: emit the three indices in ascending order.
  return [first, second, apex]
    .sort((left, right) => left - right)
    .map(index => ({ x: points[index].x, y: points[index].y }));
}

/** Index of the vertex farthest (euclidean) from `points[from]`. */
function farthestIndexFrom(points: readonly ContourPoint[], from: number): number {
  const origin = points[from];
  let best = from;
  let bestDistance = -1;
  for (let index = 0; index < points.length; index += 1) {
    const dx = points[index].x - origin.x;
    const dy = points[index].y - origin.y;
    const distance = dx * dx + dy * dy;
    if (distance > bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

/**
 * RDP over an **open** polyline, iteratively. The recursion is spelled out with an
 * explicit stack because a traced outline can carry thousands of staircase
 * vertices, and the worst case (an already-simplified chain) recurses once per
 * vertex — deep enough to blow a JS stack on a large sprite.
 */
function simplifyPolyline(points: readonly ContourPoint[], tolerance: number): ContourPoint[] {
  if (points.length <= 2) {
    return points.map(point => ({ x: point.x, y: point.y }));
  }

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [start, end] = stack.pop() as [number, number];
    if (end - start < 2) {
      continue;
    }
    let farthest = -1;
    let farthestDistance = tolerance;
    for (let index = start + 1; index < end; index += 1) {
      const distance = perpendicularDistance(points[index], points[start], points[end]);
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthest = index;
      }
    }
    if (farthest < 0) {
      continue;
    }
    keep[farthest] = 1;
    stack.push([start, farthest], [farthest, end]);
  }

  const result: ContourPoint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    if (keep[index]) {
      result.push({ x: points[index].x, y: points[index].y });
    }
  }
  return result;
}

/** Distance from `point` to the segment `start`–`end` (to the point when degenerate). */
function perpendicularDistance(
  point: ContourPoint,
  start: ContourPoint,
  end: ContourPoint
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  return (
    Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) /
    Math.sqrt(lengthSquared)
  );
}
