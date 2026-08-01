import { describe, expect, it } from 'vitest';

import { StageZoomPanController, type StageViewport } from './stage-zoom-pan';

const viewport = (overrides: Partial<StageViewport> = {}): StageViewport => ({
  rect: { left: 100, top: 50, width: 800, height: 600 } as DOMRect,
  contentWidth: 200,
  contentHeight: 100,
  ...overrides,
});

const wheel = (deltaY: number, clientX: number, clientY: number): WheelEvent =>
  ({ deltaY, clientX, clientY }) as WheelEvent;

const pointer = (
  overrides: Partial<PointerEvent> & { pointerId: number }
): PointerEvent =>
  ({
    button: 1,
    clientX: 0,
    clientY: 0,
    altKey: false,
    currentTarget: null,
    ...overrides,
  }) as unknown as PointerEvent;

describe('StageZoomPanController', () => {
  it('keeps the content point under the cursor fixed while wheel-zooming', () => {
    const controller = new StageZoomPanController();
    const view = viewport();
    // Content pixel under the cursor before zooming.
    const before = controller.toStageCoords({ clientX: 300, clientY: 150 }, view);

    controller.zoomAtPointer(wheel(-100, 300, 150), view);

    expect(controller.zoom).toBeGreaterThan(1);
    const after = controller.toStageCoords({ clientX: 300, clientY: 150 }, view);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('zooms out on a positive wheel delta and still pins the cursor', () => {
    const controller = new StageZoomPanController();
    const view = viewport();
    const before = controller.toStageCoords({ clientX: 700, clientY: 500 }, view);

    controller.zoomAtPointer(wheel(120, 700, 500), view);

    expect(controller.zoom).toBeLessThan(1);
    const after = controller.toStageCoords({ clientX: 700, clientY: 500 }, view);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('clamps zoom and does not move the pan once clamped', () => {
    const controller = new StageZoomPanController({ minZoom: 0.5, maxZoom: 2 });
    const view = viewport();
    controller.setZoom(2);
    controller.setPan(11, 22);

    controller.zoomAtPointer(wheel(-100, 300, 150), view);

    expect(controller.zoom).toBe(2);
    expect(controller.panX).toBe(11);
    expect(controller.panY).toBe(22);
  });

  it('fits and centres content without upscaling past 1x', () => {
    const controller = new StageZoomPanController();
    controller.fitToViewport(viewport(), 24);

    // Content is far smaller than the viewport, so it stays at 1x and centres.
    expect(controller.zoom).toBe(1);
    expect(controller.panX).toBe((800 - 200) / 2);
    expect(controller.panY).toBe((600 - 100) / 2);
  });

  it('scales oversized content down to fit inside the padding', () => {
    const controller = new StageZoomPanController();
    controller.fitToViewport(viewport({ contentWidth: 2000, contentHeight: 1000 }), 25);

    // (800 - 50) / 2000 = 0.375 horizontally, (600 - 50) / 1000 = 0.55 vertically.
    expect(controller.zoom).toBeCloseTo(0.375);
  });

  it('only pans for middle-button or alt-modified drags', () => {
    const controller = new StageZoomPanController();

    expect(controller.beginPan(pointer({ pointerId: 1, button: 0 }))).toBe(false);
    expect(controller.beginPan(pointer({ pointerId: 1, button: 2 }))).toBe(false);
    expect(controller.beginPan(pointer({ pointerId: 1, button: 0, altKey: true }))).toBe(true);
    expect(controller.isPanning).toBe(true);
  });

  it('translates a pan drag into a pan offset and releases cleanly', () => {
    const controller = new StageZoomPanController();
    controller.beginPan(pointer({ pointerId: 7, clientX: 100, clientY: 100 }));

    controller.updatePan(pointer({ pointerId: 7, clientX: 130, clientY: 80 }));
    expect(controller.panX).toBe(30);
    expect(controller.panY).toBe(-20);

    // A different pointer must not hijack the drag.
    expect(controller.updatePan(pointer({ pointerId: 8, clientX: 999, clientY: 999 }))).toBe(false);
    expect(controller.panX).toBe(30);

    expect(controller.endPan(pointer({ pointerId: 7 }))).toBe(true);
    expect(controller.isPanning).toBe(false);
  });

  it('normalizes stage coordinates and clamps them to the content rect', () => {
    const controller = new StageZoomPanController();
    const view = viewport();

    expect(controller.toNormalizedCoords({ clientX: 200, clientY: 100 }, view)).toEqual({
      x: 0.5,
      y: 0.5,
    });
    // Far off the content: clamped rather than reported as out of range.
    expect(controller.toNormalizedCoords({ clientX: 0, clientY: 0 }, view)).toEqual({ x: 0, y: 0 });
    expect(controller.toNormalizedCoords({ clientX: 5000, clientY: 5000 }, view)).toEqual({
      x: 1,
      y: 1,
    });
  });
});
