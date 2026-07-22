import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Navigation2DController } from '@/services/viewport/Navigation2DController';
import { appState } from '@/state';

describe('Navigation2DController', () => {
  let controller: Navigation2DController;
  let viewportRenderer: {
    pan2D: ReturnType<typeof vi.fn>;
    pan2DByDrag: ReturnType<typeof vi.fn>;
    zoom2D: ReturnType<typeof vi.fn>;
    zoom2DAroundPoint: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    controller = new Navigation2DController();
    viewportRenderer = {
      pan2D: vi.fn(),
      pan2DByDrag: vi.fn(),
      zoom2D: vi.fn(),
      zoom2DAroundPoint: vi.fn(),
    };

    Object.defineProperty(controller, 'viewportRenderer', {
      value: viewportRenderer,
      configurable: true,
    });

    appState.ui.navigationMode = '2d';
  });

  it('activates touch gesture navigation when a second touch pointer is added', () => {
    expect(controller.startTouchPointer(1, 10, 20)).toBe(true);
    expect(controller.isTouchGestureActive()).toBe(false);

    expect(controller.startTouchPointer(2, 30, 40)).toBe(true);
    expect(controller.isTouchGestureActive()).toBe(true);
  });

  it('uses two-finger movement to pan and pinch around the gesture midpoint', () => {
    controller.startTouchPointer(1, 0, 0);
    controller.startTouchPointer(2, 10, 0);

    expect(controller.updateTouchPointer(2, 20, 0)).toBe(true);
    expect(viewportRenderer.pan2DByDrag).toHaveBeenCalledWith(-5, -0);
    expect(viewportRenderer.zoom2DAroundPoint).toHaveBeenCalledWith(2, 10, 0);
  });

  it('applies the same touch pan speed multiplier to direct one-finger panning', () => {
    controller.startPan(1, 10, 20);

    controller.updateTouchPan(16, 24);

    expect(viewportRenderer.pan2DByDrag).toHaveBeenCalledWith(-6, -4);
  });

  it('does not treat single-touch moves as viewport navigation', () => {
    controller.startTouchPointer(1, 15, 25);

    expect(controller.updateTouchPointer(1, 30, 45)).toBe(false);
    expect(viewportRenderer.pan2D).not.toHaveBeenCalled();
    expect(viewportRenderer.pan2DByDrag).not.toHaveBeenCalled();
    expect(viewportRenderer.zoom2DAroundPoint).not.toHaveBeenCalled();
  });

  it('clears touch gesture state when tracked pointers end', () => {
    controller.startTouchPointer(1, 0, 0);
    controller.startTouchPointer(2, 20, 0);

    expect(controller.isTouchGestureActive()).toBe(true);
    expect(controller.endTouchPointer(2)).toBe(true);
    expect(controller.isTouchGestureActive()).toBe(false);
    expect(controller.isTouchPointerTracked(1)).toBe(true);
    expect(controller.endTouchPointer(1)).toBe(true);
    expect(controller.isTouchPointerTracked(1)).toBe(false);
  });
});
