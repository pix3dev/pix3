import type { AnimationFrame, AnimationSize } from '@pix3/runtime';

/**
 * How a frame's **new** raster relates to the one it replaces, described in the
 * old frame's pixel space (§9.5 step 3).
 *
 * Every geometric field a frame carries is either normalized to the frame rect
 * (`anchor`, `points`) or expressed in absolute frame pixels (`boundingBox`,
 * `collisionPolygon`), so one pixel→pixel map re-derives all of them at once —
 * which is why crop, rotate, flip and a whole-frame replacement of a different
 * size can share a single write-back path instead of four.
 */
export type FrameRasterTransform =
  /** Cut to a sub-rect whose top-left sits at (`x`, `y`) in the old frame. */
  | { readonly kind: 'crop'; readonly x: number; readonly y: number }
  /** Turned by `quarterTurns` × 90° clockwise. */
  | { readonly kind: 'rotate'; readonly quarterTurns: number }
  | { readonly kind: 'flip'; readonly axis: 'horizontal' | 'vertical' }
  /**
   * Whole-frame swap (a generated image, a background removal). Geometry is
   * rescaled proportionally into the new size, so a normalized anchor stays
   * exactly where it was and only `sourceSize` really changes.
   */
  | { readonly kind: 'replace' };

/**
 * Affine old-pixel → new-pixel map: `x' = xx·x + xy·y + tx`, `y' = yx·x + yy·y + ty`.
 * Y is measured from the top throughout, matching the frame schema.
 */
export interface FramePixelMap {
  readonly xx: number;
  readonly xy: number;
  readonly tx: number;
  readonly yx: number;
  readonly yy: number;
  readonly ty: number;
}

const IDENTITY: FramePixelMap = { xx: 1, xy: 0, tx: 0, yx: 0, yy: 1, ty: 0 };

export function buildFramePixelMap(
  transform: FrameRasterTransform,
  from: AnimationSize,
  to: AnimationSize
): FramePixelMap {
  switch (transform.kind) {
    case 'crop':
      return { ...IDENTITY, tx: -transform.x, ty: -transform.y };
    case 'flip':
      return transform.axis === 'horizontal'
        ? { xx: -1, xy: 0, tx: from.width, yx: 0, yy: 1, ty: 0 }
        : { xx: 1, xy: 0, tx: 0, yx: 0, yy: -1, ty: from.height };
    case 'rotate': {
      // Normalize to 0..3; each turn is 90° clockwise in a y-down space.
      const turns = ((Math.round(transform.quarterTurns) % 4) + 4) % 4;
      switch (turns) {
        case 1:
          return { xx: 0, xy: -1, tx: from.height, yx: 1, yy: 0, ty: 0 };
        case 2:
          return { xx: -1, xy: 0, tx: from.width, yx: 0, yy: -1, ty: from.height };
        case 3:
          return { xx: 0, xy: 1, tx: 0, yx: -1, yy: 0, ty: from.width };
        default:
          return IDENTITY;
      }
    }
    case 'replace':
      return { ...IDENTITY, xx: to.width / from.width, yy: to.height / from.height };
  }
}

export function mapFramePixel(map: FramePixelMap, x: number, y: number): { x: number; y: number } {
  return { x: map.xx * x + map.xy * y + map.tx, y: map.yx * x + map.yy * y + map.ty };
}

/**
 * Carry a frame point's `angle` (degrees, clockwise, 0 = pointing right) through
 * the map by transforming its direction vector — so a flip mirrors a muzzle
 * direction and a quarter-turn rotates it, while a crop leaves it alone.
 */
export function mapFrameAngle(map: FramePixelMap, angleDegrees: number): number {
  const radians = (angleDegrees * Math.PI) / 180;
  const dx = Math.cos(radians);
  const dy = Math.sin(radians);
  const mappedX = map.xx * dx + map.xy * dy;
  const mappedY = map.yx * dx + map.yy * dy;
  if (mappedX === 0 && mappedY === 0) {
    return angleDegrees;
  }
  // `atan2` already folds to (-180, 180]; the rounding kills float dust so an
  // identity map is a literal no-op.
  return roundTo((Math.atan2(mappedY, mappedX) * 180) / Math.PI, 6);
}

const roundTo = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/**
 * Re-derive every geometric field of `frame` against a new raster, keeping the
 * on-screen result unchanged for a crop (`a' = (a·W − cropX)/w`, §8.8/§8.11.3)
 * and pixel-faithful for the other transforms.
 *
 * `texturePath` is deliberately NOT touched — the caller owns the file it wrote
 * and the operation that points the frame at it. Returns the frame untouched
 * when either size is unknown: `boundingBox`/`collisionPolygon` are absolute
 * pixels, so guessing a size would author them into a fake space (§9.7 risk 2).
 */
export function restampFrameGeometry(
  frame: AnimationFrame,
  transform: FrameRasterTransform,
  from: AnimationSize,
  to: AnimationSize
): AnimationFrame {
  if (from.width <= 0 || from.height <= 0 || to.width <= 0 || to.height <= 0) {
    return { ...frame, sourceSize: { width: to.width, height: to.height } };
  }

  const map = buildFramePixelMap(transform, from, to);
  const toNormalized = (x: number, y: number): { x: number; y: number } => {
    const mapped = mapFramePixel(map, x * from.width, y * from.height);
    return { x: roundTo(mapped.x / to.width, 6), y: roundTo(mapped.y / to.height, 6) };
  };

  const anchor = toNormalized(frame.anchor.x, frame.anchor.y);
  const points = frame.points?.map(point => {
    const moved = toNormalized(point.x, point.y);
    const mappedAngle = mapFrameAngle(map, point.angle ?? 0);
    return {
      ...point,
      x: moved.x,
      y: moved.y,
      // An absent angle stays absent while the map leaves it at zero, so a crop
      // does not sprinkle `angle: 0` through the document.
      angle: point.angle === undefined && mappedAngle === 0 ? undefined : mappedAngle,
    };
  });

  return {
    ...frame,
    anchor,
    ...(points ? { points } : {}),
    boundingBox: mapBoundingBox(frame, map),
    collisionPolygon: frame.collisionPolygon.map(vertex => {
      const moved = mapFramePixel(map, vertex.x, vertex.y);
      return { x: Math.round(moved.x), y: Math.round(moved.y) };
    }),
    sourceSize: { width: to.width, height: to.height },
  };
}

/**
 * Map the box by its two opposite corners and re-normalize, so a rotate/flip
 * that swaps them still yields a positive-extent box. An unset box (the
 * `0×0` convention) stays unset rather than being translated into a real one.
 */
function mapBoundingBox(frame: AnimationFrame, map: FramePixelMap): AnimationFrame['boundingBox'] {
  const box = frame.boundingBox;
  if (box.width <= 0 && box.height <= 0) {
    return { ...box };
  }

  const first = mapFramePixel(map, box.x, box.y);
  const second = mapFramePixel(map, box.x + box.width, box.y + box.height);
  return {
    x: Math.round(Math.min(first.x, second.x)),
    y: Math.round(Math.min(first.y, second.y)),
    width: Math.round(Math.abs(second.x - first.x)),
    height: Math.round(Math.abs(second.y - first.y)),
  };
}
