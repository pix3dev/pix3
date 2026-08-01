/**
 * Zoom/pan behaviour for an image-editing stage — the part the animation editor's
 * frame stage and the Sprite Editor's canvas genuinely have in common. Their
 * *overlays* differ completely (anchor / bounding box / collision polygon vs a
 * crop rectangle), which is why this is a plain controller class and not a shared
 * component: the host keeps its own markup and asks the controller where things
 * are.
 *
 * Framework-free and DOM-light on purpose — it owns no elements, only numbers and
 * the pointer-capture bookkeeping a drag needs. Hosts render `zoom`/`panX`/`panY`
 * however they like (CSS transform, explicit sizing, canvas transform) and call
 * back into {@link toStageCoords} to turn a pointer event into content pixels.
 */

export interface StageZoomPanOptions {
  /** Smallest allowed zoom factor. Default 0.1. */
  minZoom?: number;
  /** Largest allowed zoom factor. Default 16. */
  maxZoom?: number;
  /** Multiplier applied per wheel notch. Default 1.1. */
  wheelStep?: number;
  /** Called after any change so a Lit host can request an update. */
  onChange?: () => void;
}

export interface StageViewport {
  /** Bounding rect of the element the content is drawn inside. */
  readonly rect: DOMRect;
  /** Intrinsic content size in stage (image) pixels. */
  readonly contentWidth: number;
  readonly contentHeight: number;
}

/** A point in stage (content-pixel) space, origin at the content's top-left. */
export interface StagePoint {
  x: number;
  y: number;
}

const DEFAULT_MIN_ZOOM = 0.1;
const DEFAULT_MAX_ZOOM = 16;
const DEFAULT_WHEEL_STEP = 1.1;

export class StageZoomPanController {
  private _zoom = 1;
  private _panX = 0;
  private _panY = 0;
  private panPointerId: number | null = null;
  private panOriginX = 0;
  private panOriginY = 0;
  private panStartX = 0;
  private panStartY = 0;

  private readonly minZoom: number;
  private readonly maxZoom: number;
  private readonly wheelStep: number;
  private readonly onChange?: () => void;

  constructor(options: StageZoomPanOptions = {}) {
    this.minZoom = options.minZoom ?? DEFAULT_MIN_ZOOM;
    this.maxZoom = options.maxZoom ?? DEFAULT_MAX_ZOOM;
    this.wheelStep = options.wheelStep ?? DEFAULT_WHEEL_STEP;
    this.onChange = options.onChange;
  }

  get zoom(): number {
    return this._zoom;
  }

  /** Pan offset in *screen* pixels — how far the content is shifted in its box. */
  get panX(): number {
    return this._panX;
  }

  get panY(): number {
    return this._panY;
  }

  /** True while a pan drag is in flight (hosts use this to show a grab cursor). */
  get isPanning(): boolean {
    return this.panPointerId !== null;
  }

  /** CSS transform that applies the current pan+zoom to a content element. */
  get transform(): string {
    return `translate(${this._panX}px, ${this._panY}px) scale(${this._zoom})`;
  }

  setZoom(zoom: number): void {
    const next = clamp(zoom, this.minZoom, this.maxZoom);
    if (next === this._zoom) {
      return;
    }
    this._zoom = next;
    this.onChange?.();
  }

  /** Step the zoom by whole notches, keeping the stage centre fixed. */
  adjustZoom(notches: number): void {
    this.setZoom(this._zoom * Math.pow(this.wheelStep, notches));
  }

  setPan(x: number, y: number): void {
    if (x === this._panX && y === this._panY) {
      return;
    }
    this._panX = x;
    this._panY = y;
    this.onChange?.();
  }

  reset(): void {
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
    this.onChange?.();
  }

  /**
   * Zoom around the cursor: the content point under the pointer stays under the
   * pointer. This is the whole reason the controller exists — getting the pan
   * compensation right by hand in two places is how they drift apart.
   */
  zoomAtPointer(event: WheelEvent, viewport: StageViewport): void {
    const previousZoom = this._zoom;
    const notches = -Math.sign(event.deltaY);
    const nextZoom = clamp(
      previousZoom * Math.pow(this.wheelStep, notches),
      this.minZoom,
      this.maxZoom
    );
    if (nextZoom === previousZoom) {
      return;
    }

    // Cursor position relative to the (already panned) content origin.
    const cursorX = event.clientX - viewport.rect.left - this._panX;
    const cursorY = event.clientY - viewport.rect.top - this._panY;
    const scaleRatio = nextZoom / previousZoom;

    this._zoom = nextZoom;
    this._panX += cursorX - cursorX * scaleRatio;
    this._panY += cursorY - cursorY * scaleRatio;
    this.onChange?.();
  }

  /**
   * Scale and centre the content so it fits inside the viewport with `padding`
   * screen pixels of margin. Never upscales past 1× — a 16×16 sprite should not
   * fill a 900 px stage just because it can.
   */
  fitToViewport(viewport: StageViewport, padding = 24): void {
    const availableWidth = Math.max(1, viewport.rect.width - padding * 2);
    const availableHeight = Math.max(1, viewport.rect.height - padding * 2);
    if (viewport.contentWidth <= 0 || viewport.contentHeight <= 0) {
      return;
    }

    const zoom = clamp(
      Math.min(availableWidth / viewport.contentWidth, availableHeight / viewport.contentHeight, 1),
      this.minZoom,
      this.maxZoom
    );
    this._zoom = zoom;
    this._panX = (viewport.rect.width - viewport.contentWidth * zoom) / 2;
    this._panY = (viewport.rect.height - viewport.contentHeight * zoom) / 2;
    this.onChange?.();
  }

  /**
   * Begin a pan drag. Returns false when this event isn't a pan gesture, so the
   * host can fall through to its own tool handling — middle button and
   * space/alt-modified left drags pan, everything else belongs to the tool.
   */
  beginPan(event: PointerEvent, options: { allowLeftButton?: boolean } = {}): boolean {
    const isMiddle = event.button === 1;
    const isModifiedLeft = event.button === 0 && (event.altKey || options.allowLeftButton === true);
    if (!isMiddle && !isModifiedLeft) {
      return false;
    }

    this.panPointerId = event.pointerId;
    this.panOriginX = event.clientX;
    this.panOriginY = event.clientY;
    this.panStartX = this._panX;
    this.panStartY = this._panY;
    (event.currentTarget as Element | null)?.setPointerCapture?.(event.pointerId);
    return true;
  }

  /** Continue a pan drag. Returns false when this pointer isn't the panning one. */
  updatePan(event: PointerEvent): boolean {
    if (this.panPointerId !== event.pointerId) {
      return false;
    }
    this.setPan(
      this.panStartX + (event.clientX - this.panOriginX),
      this.panStartY + (event.clientY - this.panOriginY)
    );
    return true;
  }

  /** Finish a pan drag. Returns false when this pointer wasn't the panning one. */
  endPan(event: PointerEvent): boolean {
    if (this.panPointerId !== event.pointerId) {
      return false;
    }
    this.panPointerId = null;
    (event.currentTarget as Element | null)?.releasePointerCapture?.(event.pointerId);
    return true;
  }

  /**
   * Convert a pointer event into stage (content-pixel) coordinates, origin at the
   * content's top-left. Values outside `[0, contentWidth/Height]` mean the
   * pointer is off the content; the caller decides whether to clamp.
   */
  toStageCoords(event: { clientX: number; clientY: number }, viewport: StageViewport): StagePoint {
    return {
      x: (event.clientX - viewport.rect.left - this._panX) / this._zoom,
      y: (event.clientY - viewport.rect.top - this._panY) / this._zoom,
    };
  }

  /** {@link toStageCoords}, normalized to 0..1 of the content rect and clamped. */
  toNormalizedCoords(
    event: { clientX: number; clientY: number },
    viewport: StageViewport
  ): StagePoint {
    const point = this.toStageCoords(event, viewport);
    return {
      x: viewport.contentWidth > 0 ? clamp(point.x / viewport.contentWidth, 0, 1) : 0,
      y: viewport.contentHeight > 0 ? clamp(point.y / viewport.contentHeight, 0, 1) : 0,
    };
  }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));
