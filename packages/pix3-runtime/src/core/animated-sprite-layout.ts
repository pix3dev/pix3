import type { AnimationFrame, AnimationFramePoint, AnimationSize } from './AnimationResource';

/**
 * How a frame's raster fills the node's box.
 *
 * - `stretch` (default, and what every pre-existing scene assumes): every frame
 *   is scaled to exactly `width × height`.
 * - `native`: each frame renders at its own `sourceSize` scaled by a per-clip
 *   factor derived from the clip's first frame, so tightly-cropped frames of
 *   differing sizes keep their relative proportions and, with per-frame anchors,
 *   stay aligned. Resizing the node scales the whole animation uniformly.
 */
export type AnimatedSpriteSizeMode = 'stretch' | 'native';

/** Normalized pivot in local sprite space, matching `Sprite2D`'s (y is up). */
export interface AnimatedSpriteAnchor2D {
  x: number;
  y: number;
}

export interface AnimatedSpriteLayoutInput {
  nodeWidth: number;
  nodeHeight: number;
  /** Node-level pivot (y up). */
  anchor: AnimatedSpriteAnchor2D;
  sizeMode: AnimatedSpriteSizeMode;
  /** The frame being displayed, or `null` when the clip has none. */
  frame: AnimationFrame | null;
  /** Native pixel size of {@link frame}, or `null` when unknown. */
  frameSourceSize: AnimationSize | null;
  /** Native pixel size of the clip's FIRST frame — the `native` scale reference. */
  clipFirstFrameSourceSize: AnimationSize | null;
}

export interface AnimatedSpriteFrameLayout {
  /** Quad size in node-local units. */
  width: number;
  height: number;
  /** Quad centre offset from the node origin, in node-local units (y up). */
  offsetX: number;
  offsetY: number;
}

/**
 * Resolve the displayed quad for one animation frame.
 *
 * Two anchors are in play and they mean different things:
 *
 * - the **node anchor** is a global pivot inside the node's own `width × height`
 *   box, y up, identical in meaning to `Sprite2D.anchor`;
 * - the **frame anchor** is the frame's own origin inside its — possibly tightly
 *   cropped — raster, normalized to the frame rect with y measured from the TOP
 *   (the image convention shared with `boundingBox`/`collisionPolygon`, and what
 *   the editor's overlay draws at `top: anchor.y * 100%`).
 *
 * They compose: the quad is placed so the frame anchor lands on the node origin,
 * then shifted by the node pivot. Cropping a frame tighter and moving its anchor
 * to the old visual centre therefore leaves the animation pixel-identical while
 * the PNG (and later the atlas) shrinks.
 *
 * This lives in one shared module because the editor viewport draws SEPARATE
 * proxy meshes rather than the runtime nodes — both callers must apply exactly
 * this math or the editor and the game disagree about where a frame sits.
 */
export function resolveAnimatedSpriteFrameLayout(
  input: AnimatedSpriteLayoutInput
): AnimatedSpriteFrameLayout {
  const nodeWidth = Number.isFinite(input.nodeWidth) ? input.nodeWidth : 0;
  const nodeHeight = Number.isFinite(input.nodeHeight) ? input.nodeHeight : 0;

  let width = nodeWidth;
  let height = nodeHeight;

  // `native` needs BOTH this frame's size and the clip's reference size; without
  // either (legacy content that has never been stamped) the frame silently falls
  // back to stretch, which is exactly how it rendered before this existed.
  if (input.sizeMode === 'native') {
    const frameSize = input.frameSourceSize;
    const referenceSize = input.clipFirstFrameSourceSize ?? frameSize;
    if (
      frameSize &&
      frameSize.width > 0 &&
      frameSize.height > 0 &&
      referenceSize &&
      referenceSize.width > 0
    ) {
      const clipScale = nodeWidth / referenceSize.width;
      width = frameSize.width * clipScale;
      height = frameSize.height * clipScale;
    }
  }

  const frameAnchorX = input.frame?.anchor.x ?? 0.5;
  const frameAnchorY = input.frame?.anchor.y ?? 0.5;

  return {
    width,
    height,
    offsetX: (0.5 - input.anchor.x) * nodeWidth + (0.5 - frameAnchorX) * width,
    // Frame anchor y is top-down while local space is y-up, hence the flipped term.
    offsetY: (0.5 - input.anchor.y) * nodeHeight + (frameAnchorY - 0.5) * height,
  };
}

/** A frame point resolved into node-local space. */
export interface ResolvedFramePoint {
  x: number;
  y: number;
  /** Degrees, clockwise, 0 = pointing right. */
  angle: number;
}

/**
 * Map a frame point's normalized frame-space coordinates onto the laid-out quad,
 * yielding node-local coordinates directly usable as a child node's position.
 * Composed through the same layout as the visible pixels, so a point stays glued
 * to the art through `sizeMode`, per-clip scaling, and both anchors.
 */
export function resolveFramePointToLocal(
  point: AnimationFramePoint,
  layout: AnimatedSpriteFrameLayout
): ResolvedFramePoint {
  return {
    x: layout.offsetX + (point.x - 0.5) * layout.width,
    // Point y is top-down (frame space); local space is y-up.
    y: layout.offsetY + (0.5 - point.y) * layout.height,
    angle: point.angle ?? 0,
  };
}
