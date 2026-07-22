import { injectable, inject } from '@/fw/di';
import { appState } from '@/state';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';

interface PanState {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
}

interface TouchPointerState {
  x: number;
  y: number;
}

interface TouchGestureState {
  midpointX: number;
  midpointY: number;
  distance: number;
}

@injectable()
export class Navigation2DController {
  @inject(ViewportRendererService)
  private readonly viewportRenderer!: ViewportRendererService;

  private activePan: PanState | null = null;
  private readonly activeTouchPointers = new Map<number, TouchPointerState>();
  private touchGestureState: TouchGestureState | null = null;

  private get panSensitivity(): number {
    return appState.ui.navigation2D?.panSensitivity ?? 0.75;
  }

  private get zoomSensitivity(): number {
    return appState.ui.navigation2D?.zoomSensitivity ?? 0.001;
  }

  private get touchPanSpeedMultiplier(): number {
    return 1;
  }

  handleWheel(event: WheelEvent): void {
    if (appState.ui.navigationMode !== '2d') {
      return;
    }

    event.preventDefault();

    const target = event.target as HTMLElement;
    if (target.closest('.top-toolbar')) {
      return;
    }

    if (event.deltaZ !== 0 || event.ctrlKey) {
      this.handleZoom(event);
      return;
    }

    if (event.shiftKey) {
      this.handleHorizontalPan(event);
      return;
    }

    this.handleVerticalPan(event);
  }

  startPan(pointerId: number, x: number, y: number): void {
    if (appState.ui.navigationMode !== '2d') {
      return;
    }

    this.activePan = {
      pointerId,
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
    };
  }

  updatePan(x: number, y: number): void {
    this.panFromPointerPosition(x, y);
  }

  updateTouchPan(x: number, y: number): void {
    this.panFromPointerPosition(x, y, this.touchPanSpeedMultiplier);
  }

  endPan(): void {
    this.activePan = null;
  }

  startTouchPointer(pointerId: number, x: number, y: number): boolean {
    if (appState.ui.navigationMode !== '2d') {
      return false;
    }

    if (this.activeTouchPointers.size >= 2 && !this.activeTouchPointers.has(pointerId)) {
      return false;
    }

    this.activeTouchPointers.set(pointerId, { x, y });
    this.touchGestureState = this.getTouchGestureState();
    return true;
  }

  updateTouchPointer(pointerId: number, x: number, y: number): boolean {
    if (appState.ui.navigationMode !== '2d' || !this.activeTouchPointers.has(pointerId)) {
      return false;
    }

    this.activeTouchPointers.set(pointerId, { x, y });

    const previousGestureState = this.touchGestureState;
    const nextGestureState = this.getTouchGestureState();
    this.touchGestureState = nextGestureState;

    if (!previousGestureState || !nextGestureState) {
      return false;
    }

    const deltaX = nextGestureState.midpointX - previousGestureState.midpointX;
    const deltaY = nextGestureState.midpointY - previousGestureState.midpointY;

    if (deltaX !== 0 || deltaY !== 0) {
      this.panByDragDelta(deltaX, deltaY, this.touchPanSpeedMultiplier);
    }

    if (previousGestureState.distance > 0 && nextGestureState.distance > 0) {
      const zoomFactor = nextGestureState.distance / previousGestureState.distance;
      if (Number.isFinite(zoomFactor) && zoomFactor > 0 && Math.abs(zoomFactor - 1) > 0.0001) {
        this.viewportRenderer.zoom2DAroundPoint(
          zoomFactor,
          nextGestureState.midpointX,
          nextGestureState.midpointY
        );
      }
    }

    return true;
  }

  endTouchPointer(pointerId: number): boolean {
    const didDelete = this.activeTouchPointers.delete(pointerId);
    if (!didDelete) {
      return false;
    }

    this.touchGestureState = this.getTouchGestureState();
    return true;
  }

  isTouchPointerTracked(pointerId: number): boolean {
    return this.activeTouchPointers.has(pointerId);
  }

  isTouchGestureActive(): boolean {
    return this.touchGestureState !== null;
  }

  clearTouchState(): void {
    this.activeTouchPointers.clear();
    this.touchGestureState = null;
  }

  private handleZoom(event: WheelEvent): void {
    const zoomDelta = event.deltaZ !== 0 ? event.deltaZ : event.deltaY;
    const zoomFactor = 1 - zoomDelta * this.zoomSensitivity;
    this.viewportRenderer.zoom2D(zoomFactor);
  }

  private handleVerticalPan(event: WheelEvent): void {
    let deltaY = event.deltaY;
    if (event.deltaMode === 0) {
      deltaY = deltaY * this.panSensitivity;
    } else {
      deltaY = deltaY * this.panSensitivity * 10;
    }
    this.viewportRenderer.pan2D(0, deltaY);
  }

  private handleHorizontalPan(event: WheelEvent): void {
    let deltaX = event.deltaX;
    if (event.deltaX === 0 && event.deltaY !== 0) {
      deltaX = event.deltaY;
    }
    if (event.deltaMode === 0) {
      deltaX = deltaX * this.panSensitivity;
    } else {
      deltaX = deltaX * this.panSensitivity * 10;
    }
    this.viewportRenderer.pan2D(deltaX, 0);
  }

  private getTouchGestureState(): TouchGestureState | null {
    if (this.activeTouchPointers.size < 2) {
      return null;
    }

    const [firstPointer, secondPointer] = Array.from(this.activeTouchPointers.values());
    const deltaX = secondPointer.x - firstPointer.x;
    const deltaY = secondPointer.y - firstPointer.y;

    return {
      midpointX: (firstPointer.x + secondPointer.x) / 2,
      midpointY: (firstPointer.y + secondPointer.y) / 2,
      distance: Math.hypot(deltaX, deltaY),
    };
  }

  private panFromPointerPosition(x: number, y: number, speedMultiplier = 1): void {
    if (!this.activePan || appState.ui.navigationMode !== '2d') {
      return;
    }

    const deltaX = x - this.activePan.lastX;
    const deltaY = y - this.activePan.lastY;

    this.activePan.lastX = x;
    this.activePan.lastY = y;

    this.panByDragDelta(deltaX, deltaY, speedMultiplier);
  }

  private panByDragDelta(deltaX: number, deltaY: number, speedMultiplier = 1): void {
    this.viewportRenderer.pan2DByDrag(-deltaX * speedMultiplier, -deltaY * speedMultiplier);
  }

  dispose(): void {
    this.activePan = null;
    this.clearTouchState();
  }
}
