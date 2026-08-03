import { describe, expect, it } from 'vitest';

import { StageZoomPanController, type StageViewport } from '@/ui/shared/stage-zoom-pan';
import type { ImageSize } from './crop-geometry';
import {
  applyPlaceDrag,
  clampPlaceScale,
  describePlaceRect,
  isApplicablePlaceRect,
  quickFitRect,
  scalePlaceRect,
  type PlaceDragState,
} from './place-geometry';

/** Landscape working image (1.6:1) — the thing being placed. */
const IMAGE: ImageSize = { width: 320, height: 200 };

/** Frame that is *wider* relative to the image (2:1) — fit letterboxes left/right. */
const WIDE_FRAME: ImageSize = { width: 400, height: 200 };
/** Frame that is *taller* relative to the image (0.8:1) — fit letterboxes top/bottom. */
const TALL_FRAME: ImageSize = { width: 160, height: 200 };

const STAGE_RECT = { left: 100, top: 50, width: 900, height: 600 } as DOMRect;

const viewport = (frame: ImageSize): StageViewport => ({
  rect: STAGE_RECT,
  contentWidth: frame.width,
  contentHeight: frame.height,
});

/** Inverse of `toStageCoords`: where a frame pixel lands on screen under a given view. */
const screenPointFor = (
  view: StageZoomPanController,
  point: { x: number; y: number }
): { clientX: number; clientY: number } => ({
  clientX: STAGE_RECT.left + view.panX + point.x * view.zoom,
  clientY: STAGE_RECT.top + view.panY + point.y * view.zoom,
});

describe('place geometry in frame-pixel space', () => {
  it('contains, covers and 1:1-centres against a frame wider than the image', () => {
    // contain: the height is the binding edge, so the image keeps its native size
    // and is letterboxed left/right.
    expect(quickFitRect(IMAGE, WIDE_FRAME, 'fit')).toEqual({ x: 40, y: 0, w: 320, h: 200 });
    // cover: the width binds, and the overflow is cut evenly top and bottom —
    // negative y is expected, the rect is allowed to hang off the frame.
    expect(quickFitRect(IMAGE, WIDE_FRAME, 'fill')).toEqual({ x: 0, y: -25, w: 400, h: 250 });
    expect(quickFitRect(IMAGE, WIDE_FRAME, 'actual')).toEqual({ x: 40, y: 0, w: 320, h: 200 });
  });

  it('contains, covers and 1:1-centres against a frame taller than the image', () => {
    expect(quickFitRect(IMAGE, TALL_FRAME, 'fit')).toEqual({ x: 0, y: 50, w: 160, h: 100 });
    expect(quickFitRect(IMAGE, TALL_FRAME, 'fill')).toEqual({ x: -80, y: 0, w: 320, h: 200 });
    expect(quickFitRect(IMAGE, TALL_FRAME, 'actual')).toEqual({ x: -80, y: 0, w: 320, h: 200 });
  });

  it('collapses fit and fill when the aspect ratios match exactly', () => {
    const square: ImageSize = { width: 128, height: 128 };
    const frame: ImageSize = { width: 64, height: 64 };
    expect(quickFitRect(square, frame, 'fit')).toEqual({ x: 0, y: 0, w: 64, h: 64 });
    expect(quickFitRect(square, frame, 'fill')).toEqual({ x: 0, y: 0, w: 64, h: 64 });
    // 1:1 still means 1:1 — the image overhangs the frame on all four sides.
    expect(quickFitRect(square, frame, 'actual')).toEqual({ x: -32, y: -32, w: 128, h: 128 });
  });

  it('never emits a NaN rect for a degenerate image', () => {
    expect(quickFitRect({ width: 0, height: 0 }, WIDE_FRAME, 'fit')).toEqual({
      x: 0,
      y: 0,
      w: 400,
      h: 200,
    });
  });

  it('moves by the raw delta and accepts coordinates outside the frame', () => {
    const drag: PlaceDragState = {
      mode: 'move',
      corner: '',
      originX: 50,
      originY: 50,
      startRect: { x: 10, y: 10, w: 100, h: 50 },
    };

    expect(applyPlaceDrag(drag, { x: 70, y: 65 })).toEqual({ x: 30, y: 25, w: 100, h: 50 });
    // Unlike crop, nothing is clamped: an image may hang off the frame entirely.
    expect(applyPlaceDrag(drag, { x: -40, y: -30 })).toEqual({ x: -80, y: -70, w: 100, h: 50 });
    expect(applyPlaceDrag(drag, { x: 5000, y: 5000 })).toEqual({
      x: 4960,
      y: 4960,
      w: 100,
      h: 50,
    });
  });

  it('scales a corner about the opposite corner with the aspect locked', () => {
    const start = { x: 40, y: 40, w: 100, h: 50 };
    const southEast: PlaceDragState = {
      mode: 'resize',
      corner: 'se',
      originX: 140,
      originY: 90,
      startRect: start,
    };

    // Dragged to twice the width; the height follows the locked 2:1 aspect and the
    // north-west corner has not moved.
    const grown = applyPlaceDrag(southEast, { x: 240, y: 90 });
    expect(grown).toEqual({ x: 40, y: 40, w: 200, h: 100 });
    expect(grown.w / grown.h).toBeCloseTo(start.w / start.h);

    // Collapsed past the anchor: pinned to a 1px floor on the shorter axis.
    expect(applyPlaceDrag(southEast, { x: -500, y: -500 })).toEqual({
      x: 40,
      y: 40,
      w: 2,
      h: 1,
    });

    // The opposite corner of a north-west grab is the south-east one at (140, 90).
    const northWest: PlaceDragState = {
      mode: 'resize',
      corner: 'nw',
      originX: 40,
      originY: 40,
      startRect: start,
    };
    const pulled = applyPlaceDrag(northWest, { x: -60, y: 90 });
    expect(pulled).toEqual({ x: -60, y: -10, w: 200, h: 100 });
    expect(pulled.x + pulled.w).toBeCloseTo(140);
    expect(pulled.y + pulled.h).toBeCloseTo(90);
  });

  it('keeps the wheel pivot at the same relative position inside the rect', () => {
    const rect = { x: 0, y: 0, w: 100, h: 50 };
    const pivot = { x: 25, y: 10 };

    const zoomed = scalePlaceRect(rect, 2, pivot);
    expect(zoomed).toEqual({ x: -25, y: -10, w: 200, h: 100 });
    expect((pivot.x - zoomed.x) / zoomed.w).toBeCloseTo((pivot.x - rect.x) / rect.w);
    expect((pivot.y - zoomed.y) / zoomed.h).toBeCloseTo((pivot.y - rect.y) / rect.h);

    // ...and back out again lands exactly where it started.
    expect(scalePlaceRect(zoomed, 0.5, pivot)).toEqual(rect);
  });

  it('clamps the on-screen scale to 1/32..32 of native, about the rect centre', () => {
    const tooBig = clampPlaceScale({ x: 0, y: 0, w: 12_800, h: 8000 }, IMAGE);
    expect(tooBig.w / IMAGE.width).toBeCloseTo(32);
    expect(tooBig).toEqual({ x: 1280, y: 800, w: 10_240, h: 6400 });

    const tooSmall = clampPlaceScale({ x: 0, y: 0, w: 5, h: 3.125 }, IMAGE);
    expect(tooSmall.w / IMAGE.width).toBeCloseTo(1 / 32);
    expect(tooSmall).toEqual({ x: -2.5, y: -1.5625, w: 10, h: 6.25 });

    // In range: the rect is handed straight back, pivot and all.
    const inRange = { x: 3, y: 4, w: 320, h: 200 };
    expect(clampPlaceScale(inRange, IMAGE)).toBe(inRange);
    expect(clampPlaceScale({ x: 0, y: 0, w: 0, h: 0 }, IMAGE)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('yields the same frame-pixel rect at 1x and at 2.5x with a pan offset', () => {
    const identity = new StageZoomPanController();
    const zoomed = new StageZoomPanController();
    zoomed.setZoom(2.5);
    zoomed.setPan(-137, 64);

    const dragFor = (view: StageZoomPanController): PlaceDragState => {
      const origin = view.toStageCoords(
        screenPointFor(view, { x: 60, y: 40 }),
        viewport(WIDE_FRAME)
      );
      return {
        mode: 'move',
        corner: '',
        originX: origin.x,
        originY: origin.y,
        startRect: quickFitRect(IMAGE, WIDE_FRAME, 'fit'),
      };
    };

    const at = (view: StageZoomPanController) =>
      applyPlaceDrag(
        dragFor(view),
        view.toStageCoords(screenPointFor(view, { x: 210, y: 130 }), viewport(WIDE_FRAME))
      );

    const atIdentity = at(identity);
    const atZoom = at(zoomed);
    expect(atZoom.x).toBeCloseTo(atIdentity.x);
    expect(atZoom.y).toBeCloseTo(atIdentity.y);
    expect(atZoom.w).toBeCloseTo(atIdentity.w);
    expect(atZoom.h).toBeCloseTo(atIdentity.h);
    expect(atIdentity).toEqual({ x: 190, y: 90, w: 320, h: 200 });
  });

  it('reports the placed size in frame pixels and the scale against native width', () => {
    expect(describePlaceRect({ x: 0, y: 0, w: 480, h: 300 }, IMAGE)).toBe('480 × 300 px · 150%');
    expect(describePlaceRect({ x: 0, y: 0, w: 320, h: 200 }, IMAGE)).toBe('320 × 200 px · 100%');
    expect(describePlaceRect({ x: 0, y: 0, w: 63.7, h: 32.2 }, IMAGE)).toBe('64 × 32 px · 20%');
    expect(describePlaceRect({ x: 0, y: 0, w: 0, h: 0 }, { width: 0, height: 0 })).toBe(
      '1 × 1 px · 100%'
    );
  });

  it('gates Apply on a placement worth at least one pixel', () => {
    expect(isApplicablePlaceRect(null)).toBe(false);
    expect(isApplicablePlaceRect({ x: 0, y: 0, w: 0, h: 0 })).toBe(false);
    expect(isApplicablePlaceRect({ x: 0, y: 0, w: 0.4, h: 8 })).toBe(false);
    expect(isApplicablePlaceRect({ x: -50, y: -50, w: 1, h: 1 })).toBe(true);
  });
});
