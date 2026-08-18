/**
 * Crop-rectangle geometry for the Sprite Editor canvas.
 *
 * Everything here is in **image-pixel space** — the same space
 * {@link import('@/ui/shared/stage-zoom-pan').StageZoomPanController.toStageCoords}
 * reports. That is the whole point: the canvas used to keep its selection in
 * letterboxed *display* pixels, which meant the rect meant something different
 * at every zoom level and could not be shared with the animation stage's
 * overlays. Storing image pixels makes the selection zoom-invariant — the same
 * gesture over the same part of the image yields the same rect whether the
 * stage is at 100% or 250% with a pan offset.
 *
 * Pure functions, no DOM: the host converts pointer events to stage coordinates
 * and hands them over, so this math is testable without mounting a component.
 */

import type { StagePoint } from '@/ui/shared/stage-zoom-pan';

/** Crop selection rectangle, in image (natural) pixels. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Intrinsic size of the working image, in image pixels. */
export interface ImageSize {
  width: number;
  height: number;
}

export type CropDragMode = 'draw' | 'move' | 'resize';

export interface CropDragState {
  mode: CropDragMode;
  /** Combination of `n`/`s`/`e`/`w` for resize handles; empty otherwise. */
  edges: string;
  /** Grab point in image pixels (unclamped — `move` needs the raw delta). */
  originX: number;
  originY: number;
  startRectX: number;
  startRectY: number;
  startRectW: number;
  startRectH: number;
}

/** Source rectangle handed to `drawImage`, in whole image pixels. */
export interface CropPixelRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** Fraction of each edge the default selection leaves out. */
const DEFAULT_CROP_INSET = 0.15;

/** Smallest selection the Apply button accepts, in image pixels. */
const MIN_CROP_SIZE = 1;

export const clampToImage = (point: StagePoint, size: ImageSize): StagePoint => ({
  x: clamp(point.x, 0, size.width),
  y: clamp(point.y, 0, size.height),
});

/** The selection a freshly opened crop session starts with: a centred 70% box. */
export const initialCropRect = (size: ImageSize, inset = DEFAULT_CROP_INSET): CropRect => {
  const insetX = size.width * inset;
  const insetY = size.height * inset;
  return {
    x: insetX,
    y: insetY,
    w: size.width - insetX * 2,
    h: size.height - insetY * 2,
  };
};

/**
 * Where a crop session opens: the bounding box of the image's opaque pixels, expressed in image
 * pixels. `bounds` comes from `opaqueBounds` (image-ops) and is passed as null when the image could
 * not be decoded or is fully transparent.
 *
 * Falls back to {@link initialCropRect} in the two cases where content bounds say nothing useful:
 * nothing opaque at all, and content that already fills the canvas (an opaque sheet, or a halo the
 * threshold did not catch) — a selection sitting exactly on the border has no handles to grab and
 * would crop nothing, so the centred box is the more useful starting point there.
 */
export const contentCropRect = (
  bounds: { x: number; y: number; width: number; height: number } | null,
  size: ImageSize,
  inset = DEFAULT_CROP_INSET
): CropRect => {
  if (!bounds || bounds.width < MIN_CROP_SIZE || bounds.height < MIN_CROP_SIZE) {
    return initialCropRect(size, inset);
  }
  const x = clamp(bounds.x, 0, size.width);
  const y = clamp(bounds.y, 0, size.height);
  const w = clamp(bounds.width, MIN_CROP_SIZE, size.width - x);
  const h = clamp(bounds.height, MIN_CROP_SIZE, size.height - y);
  if (x <= 0 && y <= 0 && w >= size.width && h >= size.height) {
    return initialCropRect(size, inset);
  }
  return { x, y, w, h };
};

/**
 * Advance a crop drag to `point` (image pixels, unclamped — pass exactly what
 * `toStageCoords` returned). Draw and resize clamp the pointer to the image;
 * move keeps the raw delta so the rect slides predictably once the cursor has
 * run off the edge, then clamps the resulting origin.
 */
export const applyCropDrag = (
  drag: CropDragState,
  point: StagePoint,
  size: ImageSize
): CropRect => {
  const maxX = size.width;
  const maxY = size.height;
  const px = clamp(point.x, 0, maxX);
  const py = clamp(point.y, 0, maxY);

  if (drag.mode === 'draw') {
    return {
      x: Math.min(px, drag.originX),
      y: Math.min(py, drag.originY),
      w: Math.abs(px - drag.originX),
      h: Math.abs(py - drag.originY),
    };
  }

  if (drag.mode === 'move') {
    const w = drag.startRectW;
    const h = drag.startRectH;
    return {
      x: clamp(drag.startRectX + (point.x - drag.originX), 0, maxX - w),
      y: clamp(drag.startRectY + (point.y - drag.originY), 0, maxY - h),
      w,
      h,
    };
  }

  let left = drag.startRectX;
  let top = drag.startRectY;
  let right = drag.startRectX + drag.startRectW;
  let bottom = drag.startRectY + drag.startRectH;
  if (drag.edges.includes('w')) {
    left = clamp(px, 0, right - MIN_CROP_SIZE);
  }
  if (drag.edges.includes('e')) {
    right = clamp(px, left + MIN_CROP_SIZE, maxX);
  }
  if (drag.edges.includes('n')) {
    top = clamp(py, 0, bottom - MIN_CROP_SIZE);
  }
  if (drag.edges.includes('s')) {
    bottom = clamp(py, top + MIN_CROP_SIZE, maxY);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
};

/** True when the selection is big enough to bake into an image. */
export const isApplicableCropRect = (rect: CropRect | null): boolean =>
  rect !== null && Math.round(rect.w) >= MIN_CROP_SIZE && Math.round(rect.h) >= MIN_CROP_SIZE;

/**
 * Snap the selection to whole pixels and clip it to the image — the exact
 * source rect `drawImage` is given, so this decides the output blob.
 */
export const cropRectToPixels = (rect: CropRect, size: ImageSize): CropPixelRect | null => {
  if (size.width <= 0 || size.height <= 0) {
    return null;
  }
  const sx = clamp(Math.round(rect.x), 0, size.width - 1);
  const sy = clamp(Math.round(rect.y), 0, size.height - 1);
  return {
    sx,
    sy,
    sw: clamp(Math.round(rect.w), 1, size.width - sx),
    sh: clamp(Math.round(rect.h), 1, size.height - sy),
  };
};

/** Human-readable size of the selection, in image pixels. */
export const describeCropRect = (rect: CropRect): string =>
  `${Math.max(1, Math.round(rect.w))} × ${Math.max(1, Math.round(rect.h))} px`;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));
