import { describe, expect, it } from 'vitest';

import { StageZoomPanController, type StageViewport } from '@/ui/shared/stage-zoom-pan';
import {
  applyCropDrag,
  clampToImage,
  contentCropRect,
  cropRectToPixels,
  describeCropRect,
  initialCropRect,
  isApplicableCropRect,
  type CropDragState,
  type ImageSize,
} from './crop-geometry';

const IMAGE: ImageSize = { width: 320, height: 200 };

const STAGE_RECT = { left: 100, top: 50, width: 900, height: 600 } as DOMRect;

const viewport = (): StageViewport => ({
  rect: STAGE_RECT,
  contentWidth: IMAGE.width,
  contentHeight: IMAGE.height,
});

/**
 * Screen position of an image pixel under a given view — the inverse of
 * `toStageCoords`, so a test can say "press on image pixel (40, 30)" and let the
 * zoom/pan decide where that lands on screen.
 */
const screenPointFor = (
  view: StageZoomPanController,
  image: { x: number; y: number }
): { clientX: number; clientY: number } => ({
  clientX: STAGE_RECT.left + view.panX + image.x * view.zoom,
  clientY: STAGE_RECT.top + view.panY + image.y * view.zoom,
});

/** Drive a draw-drag from `from` to `to`, both given in image pixels. */
const drawSelection = (
  view: StageZoomPanController,
  from: { x: number; y: number },
  to: { x: number; y: number }
) => {
  const start = clampToImage(view.toStageCoords(screenPointFor(view, from), viewport()), IMAGE);
  const drag: CropDragState = {
    mode: 'draw',
    edges: '',
    originX: start.x,
    originY: start.y,
    startRectX: start.x,
    startRectY: start.y,
    startRectW: 0,
    startRectH: 0,
  };
  return applyCropDrag(drag, view.toStageCoords(screenPointFor(view, to), viewport()), IMAGE);
};

describe('crop geometry in image-pixel space', () => {
  it('yields the same image-pixel rect at 1x and at 2.5x with a pan offset', () => {
    const identity = new StageZoomPanController();

    const zoomed = new StageZoomPanController();
    zoomed.setZoom(2.5);
    zoomed.setPan(-137, 64);
    expect(zoomed.zoom).toBe(2.5);

    const from = { x: 40, y: 30 };
    const to = { x: 220, y: 150 };

    const atIdentity = drawSelection(identity, from, to);
    const atZoom = drawSelection(zoomed, from, to);

    expect(atZoom.x).toBeCloseTo(atIdentity.x);
    expect(atZoom.y).toBeCloseTo(atIdentity.y);
    expect(atZoom.w).toBeCloseTo(atIdentity.w);
    expect(atZoom.h).toBeCloseTo(atIdentity.h);

    // What actually decides the output blob: identical source rects.
    expect(cropRectToPixels(atZoom, IMAGE)).toEqual(cropRectToPixels(atIdentity, IMAGE));
    expect(cropRectToPixels(atIdentity, IMAGE)).toEqual({ sx: 40, sy: 30, sw: 180, sh: 120 });
  });

  it('survives a wheel zoom mid-session: the rect keeps meaning the same pixels', () => {
    const view = new StageZoomPanController();
    const rect = drawSelection(view, { x: 10, y: 12 }, { x: 110, y: 92 });

    view.zoomAtPointer({ deltaY: -100, clientX: 500, clientY: 300 } as WheelEvent, viewport());
    expect(view.zoom).toBeGreaterThan(1);

    // The stored rect is untouched by the zoom, and still crops the same pixels.
    expect(cropRectToPixels(rect, IMAGE)).toEqual({ sx: 10, sy: 12, sw: 100, sh: 80 });
  });

  it('clamps a draw drag that runs off the image, at any zoom', () => {
    const view = new StageZoomPanController();
    view.setZoom(4);
    view.setPan(-300, -200);

    const rect = drawSelection(view, { x: -80, y: -50 }, { x: 900, y: 900 });

    expect(rect).toEqual({ x: 0, y: 0, w: IMAGE.width, h: IMAGE.height });
  });

  it('moves a selection by the raw pointer delta and clamps it inside the image', () => {
    const drag: CropDragState = {
      mode: 'move',
      edges: '',
      originX: 50,
      originY: 50,
      startRectX: 40,
      startRectY: 40,
      startRectW: 100,
      startRectH: 60,
    };

    expect(applyCropDrag(drag, { x: 70, y: 65 }, IMAGE)).toEqual({ x: 60, y: 55, w: 100, h: 60 });
    // Dragged far past the right/bottom edge: size preserved, origin clamped.
    expect(applyCropDrag(drag, { x: 5000, y: 5000 }, IMAGE)).toEqual({
      x: IMAGE.width - 100,
      y: IMAGE.height - 60,
      w: 100,
      h: 60,
    });
  });

  it('resizes from the grabbed edges only, keeping at least one pixel', () => {
    const drag: CropDragState = {
      mode: 'resize',
      edges: 'se',
      originX: 140,
      originY: 100,
      startRectX: 40,
      startRectY: 40,
      startRectW: 100,
      startRectH: 60,
    };

    expect(applyCropDrag(drag, { x: 200, y: 150 }, IMAGE)).toEqual({
      x: 40,
      y: 40,
      w: 160,
      h: 110,
    });
    // Collapsed past the opposite edge: pinned to a 1px floor, origin unmoved.
    expect(applyCropDrag(drag, { x: -500, y: -500 }, IMAGE)).toEqual({ x: 40, y: 40, w: 1, h: 1 });

    const west: CropDragState = { ...drag, edges: 'w' };
    expect(applyCropDrag(west, { x: 90, y: 999 }, IMAGE)).toEqual({ x: 90, y: 40, w: 50, h: 60 });
  });

  it('starts a session with a centred 70% selection', () => {
    expect(initialCropRect(IMAGE)).toEqual({ x: 48, y: 30, w: 224, h: 140 });
    expect(cropRectToPixels(initialCropRect(IMAGE), IMAGE)).toEqual({
      sx: 48,
      sy: 30,
      sw: 224,
      sh: 140,
    });
  });

  it('clips the source rect to the image and never emits an empty one', () => {
    expect(cropRectToPixels({ x: -20, y: -20, w: 10_000, h: 10_000 }, IMAGE)).toEqual({
      sx: 0,
      sy: 0,
      sw: IMAGE.width,
      sh: IMAGE.height,
    });
    expect(cropRectToPixels({ x: 319.6, y: 199.6, w: 0, h: 0 }, IMAGE)).toEqual({
      sx: 319,
      sy: 199,
      sw: 1,
      sh: 1,
    });
    expect(cropRectToPixels({ x: 0, y: 0, w: 4, h: 4 }, { width: 0, height: 0 })).toBeNull();
  });

  it('gates Apply on a selection worth at least one pixel', () => {
    expect(isApplicableCropRect(null)).toBe(false);
    expect(isApplicableCropRect({ x: 0, y: 0, w: 0, h: 0 })).toBe(false);
    expect(isApplicableCropRect({ x: 0, y: 0, w: 0.4, h: 8 })).toBe(false);
    expect(isApplicableCropRect({ x: 0, y: 0, w: 1, h: 1 })).toBe(true);
  });

  it('reports the selection size in image pixels, not display pixels', () => {
    expect(describeCropRect({ x: 4, y: 4, w: 63.7, h: 32.2 })).toBe('64 × 32 px');
    expect(describeCropRect({ x: 4, y: 4, w: 0, h: 0 })).toBe('1 × 1 px');
  });
});

describe('contentCropRect', () => {
  it('opens the selection on the opaque bounds', () => {
    expect(contentCropRect({ x: 40, y: 30, width: 100, height: 60 }, IMAGE)).toEqual({
      x: 40,
      y: 30,
      w: 100,
      h: 60,
    });
  });

  it('falls back to the centred box when nothing is opaque', () => {
    expect(contentCropRect(null, IMAGE)).toEqual(initialCropRect(IMAGE));
  });

  it('falls back to the centred box when the content fills the canvas', () => {
    // An opaque sheet (or a halo the threshold missed): a frame on the border has nothing to grab
    // and would crop nothing.
    expect(
      contentCropRect({ x: 0, y: 0, width: IMAGE.width, height: IMAGE.height }, IMAGE)
    ).toEqual(initialCropRect(IMAGE));
  });

  it('keeps a full-width band that is not full-height', () => {
    expect(contentCropRect({ x: 0, y: 80, width: IMAGE.width, height: 40 }, IMAGE)).toEqual({
      x: 0,
      y: 80,
      w: IMAGE.width,
      h: 40,
    });
  });

  it('clamps bounds that overflow the image', () => {
    expect(contentCropRect({ x: 300, y: 190, width: 999, height: 999 }, IMAGE)).toEqual({
      x: 300,
      y: 190,
      w: 20,
      h: 10,
    });
  });

  it('ignores degenerate bounds', () => {
    expect(contentCropRect({ x: 10, y: 10, width: 0, height: 0 }, IMAGE)).toEqual(
      initialCropRect(IMAGE)
    );
  });
});
