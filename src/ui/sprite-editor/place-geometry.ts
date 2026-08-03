/**
 * Place-mode geometry for the Sprite Editor canvas (§9.11.1).
 *
 * Sibling of {@link import('./crop-geometry')} and deliberately shaped like it:
 * pure functions, no DOM, the host converts pointer events and hands over
 * coordinates. The space here is **frame-pixel space** — what `toImagePoint()`
 * reports and what `getStageContentSize()` sizes — so a rect means the same
 * pixels at 100% and at 250% with a pan offset.
 *
 * The one deliberate difference from crop: nothing is clamped to the content box.
 * An image being placed is allowed to hang off the frame; that is precisely what
 * "fill" (cover) means, and cropping the overflow is the composite's job, not the
 * rect's.
 */

import type { StagePoint } from '@/ui/shared/stage-zoom-pan';
import type { ImageSize } from './crop-geometry';

/** Destination rect of the incoming image, in frame pixels. May extend outside the frame. */
export interface PlaceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PlaceQuickFit = 'fit' | 'fill' | 'actual';

export type PlaceDragMode = 'move' | 'resize';

export interface PlaceDragState {
  mode: PlaceDragMode;
  /** `nw`/`ne`/`se`/`sw` for resize; empty for move. Corners only — no edge handles in v1. */
  corner: string;
  originX: number;
  originY: number;
  startRect: PlaceRect;
}

/** Smallest extent a placed rect may be driven to, in frame pixels. */
const MIN_PLACE_SIZE = 1;

/** On-screen scale bounds relative to the image's native size. */
const MIN_PLACE_SCALE = 1 / 32;
const MAX_PLACE_SCALE = 32;

/**
 * Where a freshly opened session (or a Fit/Fill/1:1 quick action) puts the image.
 * All three centre on the frame: `fit` contains it (letterboxed), `fill` covers it
 * (overflow cut evenly), `actual` is 1:1 pixels.
 */
export const quickFitRect = (
  image: ImageSize,
  frame: ImageSize,
  mode: PlaceQuickFit
): PlaceRect => {
  if (image.width <= 0 || image.height <= 0) {
    // Nothing sane to scale — hand back the frame itself rather than a NaN rect.
    return { x: 0, y: 0, w: frame.width, h: frame.height };
  }
  const scaleX = frame.width / image.width;
  const scaleY = frame.height / image.height;
  const scale =
    mode === 'actual' ? 1 : mode === 'fill' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
  const w = image.width * scale;
  const h = image.height * scale;
  return { x: (frame.width - w) / 2, y: (frame.height - h) / 2, w, h };
};

/**
 * Advance a place drag to `point` (frame pixels, unclamped — pass exactly what
 * `toStageCoords` returned).
 *
 * `move` translates by the raw delta with no clamping. `resize` scales about the
 * **opposite** corner with the aspect ratio locked to the rect the drag started
 * from: corner handles scale, they never stretch. The driving axis is whichever of
 * the two the pointer changed most (relative to the start rect), so dragging a
 * handle mostly sideways still shrinks as well as grows.
 */
export const applyPlaceDrag = (drag: PlaceDragState, point: StagePoint): PlaceRect => {
  const start = drag.startRect;
  if (drag.mode === 'move') {
    return {
      x: start.x + (point.x - drag.originX),
      y: start.y + (point.y - drag.originY),
      w: start.w,
      h: start.h,
    };
  }

  const isWest = drag.corner.includes('w');
  const isNorth = drag.corner.includes('n');
  // The corner that stays put for the whole gesture.
  const anchorX = isWest ? start.x + start.w : start.x;
  const anchorY = isNorth ? start.y + start.h : start.y;

  const startW = Math.max(start.w, MIN_PLACE_SIZE);
  const startH = Math.max(start.h, MIN_PLACE_SIZE);
  const drivenW = isWest ? anchorX - point.x : point.x - anchorX;
  const drivenH = isNorth ? anchorY - point.y : point.y - anchorY;
  const ratioW = drivenW / startW;
  const ratioH = drivenH / startH;
  const dominant = Math.abs(ratioW - 1) >= Math.abs(ratioH - 1) ? ratioW : ratioH;
  // Aspect is locked, so the floor has to hold on whichever axis is shorter.
  const minScale = Math.max(MIN_PLACE_SIZE / startW, MIN_PLACE_SIZE / startH);
  const scale = Math.max(dominant, minScale);

  const w = startW * scale;
  const h = startH * scale;
  return {
    x: isWest ? anchorX - w : anchorX,
    y: isNorth ? anchorY - h : anchorY,
    w,
    h,
  };
};

/**
 * Wheel zoom about the cursor: `pivot` keeps the same relative position inside the
 * rect, so the pixel under the pointer stays under the pointer. Aspect preserved.
 */
export const scalePlaceRect = (rect: PlaceRect, factor: number, pivot: StagePoint): PlaceRect => ({
  x: pivot.x - (pivot.x - rect.x) * factor,
  y: pivot.y - (pivot.y - rect.y) * factor,
  w: rect.w * factor,
  h: rect.h * factor,
});

/**
 * Keep the placed rect within `[1/32, 32]` of the image's native size, so a fast
 * wheel spin can neither collapse it nor blow it up past anything usable. Out of
 * range the rect is rescaled about its own centre — the pivot moves, but only at
 * the very extremes, where there is nothing left to keep fixed anyway.
 */
export const clampPlaceScale = (rect: PlaceRect, image: ImageSize): PlaceRect => {
  if (image.width <= 0 || image.height <= 0 || rect.w <= 0 || rect.h <= 0) {
    return rect;
  }
  const scale = rect.w / image.width;
  const clamped = Math.min(Math.max(scale, MIN_PLACE_SCALE), MAX_PLACE_SCALE);
  if (clamped === scale) {
    return rect;
  }
  const factor = clamped / scale;
  return scalePlaceRect(rect, factor, { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
};

/** `"128 × 96 px · 150%"` — size in frame pixels, scale relative to the image's native width. */
export const describePlaceRect = (rect: PlaceRect, image: ImageSize): string => {
  const percent = image.width > 0 ? Math.round((rect.w / image.width) * 100) : 100;
  return `${Math.max(1, Math.round(rect.w))} × ${Math.max(1, Math.round(rect.h))} px · ${percent}%`;
};

/** True when the placement is big enough to composite. */
export const isApplicablePlaceRect = (rect: PlaceRect | null): boolean =>
  rect !== null && Math.round(rect.w) >= MIN_PLACE_SIZE && Math.round(rect.h) >= MIN_PLACE_SIZE;
