import { svg } from 'lit';

import { html } from '@/fw';
import type { StagePoint } from '@/ui/shared/stage-zoom-pan';
import type { AnimationFrame } from '@pix3/runtime';

import type { AnimationDocumentController } from './animation-document-controller';

/**
 * What the frame stage draws over the current frame — the anchor marker, the
 * bounding box, the collision polygon and the named frame points — plus the
 * pointer state machine that edits them.
 *
 * **Coordinate contract (§9.2).** Everything here is in *frame-pixel* space:
 * origin at the frame's top-left, one unit = one texture pixel, y down. The host
 * supplies {@link FrameOverlayControllerDeps.toFramePoint}, which is the only
 * place a stage's DOM model shows up — the old animation panel derives it from
 * its zoom-sized frame element, the unified sprite canvas will derive it from
 * `StageZoomPanController.toStageCoords`. Nothing in this module may assume
 * either.
 *
 * The render functions are pure: they take the frame plus what the host already
 * computed and return a template. Their CSS lives with the host (`.stage-bbox`,
 * `.stage-point`, ... are scoped under the host's tag), so a second host has to
 * bring its own copy of those rules — deliberate, since Light-DOM styles here are
 * global and an unscoped set would leak across panels.
 *
 * The three that go *inside* the host's `<svg>` are tagged with lit's `svg`
 * rather than `html`: a standalone `html` template is parsed in the HTML
 * namespace, which turns `<rect>`/`<circle>`/`<polyline>` into unknown elements
 * that render nothing. Inline in one big template this was invisible; split into
 * child parts it is not.
 */

/** Which overlay the stage's left-drag edits. */
export type AnimationEditMode = 'anchor' | 'polygon' | 'bbox' | 'points';

/** Frame size in frame pixels, as reported by `AnimationDocumentController`. */
export interface FrameMetrics {
  frameWidth: number;
  frameHeight: number;
}

/** Length (frame px) of the direction handle drawn from a point in points mode. */
export const POINT_ANGLE_HANDLE_LENGTH = 28;

// --- pure overlay templates -------------------------------------------------

/**
 * The frame's origin marker. Lives outside the overlay `<svg>` because it is
 * positioned in percentages of the frame box, not in the SVG's user units.
 */
export function renderAnchorOverlay(frame: AnimationFrame, options: { editable: boolean }) {
  return html`
    <div
      class="stage-anchor ${options.editable ? 'is-editable' : ''}"
      style=${`left:${frame.anchor.x * 100}%; top:${frame.anchor.y * 100}%;`}
      aria-hidden="true"
    ></div>
  `;
}

/** The frame's bounding box, in absolute frame pixels. */
export function renderBboxOverlay(frame: AnimationFrame) {
  if (frame.boundingBox.width <= 0 || frame.boundingBox.height <= 0) {
    return null;
  }

  return svg`
    <rect
      class="stage-bbox"
      x=${frame.boundingBox.x}
      y=${frame.boundingBox.y}
      width=${frame.boundingBox.width}
      height=${frame.boundingBox.height}
    ></rect>
  `;
}

/**
 * The collision polygon: the outline plus one grab handle per vertex. Vertices
 * carry `data-vertex-index`, which is how {@link FrameOverlayController} tells a
 * grab of an existing vertex from a click that appends a new one.
 */
export function renderPolygonOverlay(frame: AnimationFrame, options: { editable: boolean }) {
  const polygonPoints = frame.collisionPolygon.map(point => `${point.x},${point.y}`).join(' ');

  return svg`
    ${
      frame.collisionPolygon.length >= 2
        ? svg`
          <polyline
            class="stage-polygon"
            points=${polygonPoints}
            ?data-closed=${frame.collisionPolygon.length >= 3}
          ></polyline>
        `
        : null
    }
    ${frame.collisionPolygon.map(
      (point, index) => svg`
        <circle
          class="stage-polygon-vertex ${options.editable ? 'is-editable' : ''}"
          cx=${point.x}
          cy=${point.y}
          r="4"
          data-vertex-index=${index}
        ></circle>
      `
    )}
  `;
}

export interface PointsOverlayOptions {
  /** Frame drawn on the stage. */
  frame: AnimationFrame;
  /** Frame before it in the clip — ghosted while editing as a mini onion-skin. */
  previousFrame: AnimationFrame | null;
  metrics: FrameMetrics;
  editable: boolean;
  selectedPointName: string | null;
}

/**
 * Named frame points (sockets): a dot per point plus a direction handle for its
 * angle. Point coordinates are normalized to the frame, so they are scaled by
 * `metrics` on the way in. The previous frame's points ghost behind them so a
 * socket can be kept continuous while animating.
 */
export function renderPointsOverlay(options: PointsOverlayOptions) {
  const { frame, previousFrame, metrics, editable, selectedPointName } = options;
  const points = frame.points ?? [];
  if (points.length === 0 && !editable) {
    return null;
  }

  const toStage = (point: { x: number; y: number }): StagePoint => ({
    x: point.x * metrics.frameWidth,
    y: point.y * metrics.frameHeight,
  });
  const ghostPoints = editable ? (previousFrame?.points ?? []) : [];

  return svg`
    ${ghostPoints.map(point => {
      const at = toStage(point);
      return svg`<circle
        class="stage-point stage-point--ghost"
        cx=${at.x}
        cy=${at.y}
        r="3"
      ></circle>`;
    })}
    ${points.map(point => {
      const at = toStage(point);
      const angleRadians = ((point.angle ?? 0) * Math.PI) / 180;
      return svg`
        <line
          class="stage-point-angle ${editable ? 'is-editable' : ''}"
          x1=${at.x}
          y1=${at.y}
          x2=${at.x + Math.cos(angleRadians) * POINT_ANGLE_HANDLE_LENGTH}
          y2=${at.y + Math.sin(angleRadians) * POINT_ANGLE_HANDLE_LENGTH}
          data-point-angle=${point.name}
        ></line>
        <circle
          class="stage-point ${editable ? 'is-editable' : ''} ${
            selectedPointName === point.name ? 'is-selected' : ''
          }"
          cx=${at.x}
          cy=${at.y}
          r="5"
          data-point-name=${point.name}
        ></circle>
      `;
    })}
  `;
}

// --- the pointer state machine ----------------------------------------------

interface StageDragState {
  pointerId: number;
  mode: AnimationEditMode;
  origin: StagePoint;
  vertexIndex?: number;
  /** Points mode: name of the point being dragged, and whether it's the angle handle. */
  pointName?: string;
  pointAngleHandle?: boolean;
}

export interface FrameOverlayControllerDeps {
  /** The document being edited, or null while the host has none bound. */
  getDocument(): AnimationDocumentController | null;
  /**
   * Pointer event → frame-pixel space, unclamped and unrounded (the controller
   * clamps to the frame and snaps to whole pixels). Return null when the stage
   * cannot map the event — no element, or a zero-sized box.
   */
  toFramePoint(event: PointerEvent): StagePoint | null;
}

/**
 * Owns the stage's edit mode, its point selection and the drag in flight.
 *
 * A plain class in the same style as `AnimationDocumentController`: deps in,
 * listener set out. It holds no DOM and no Lit state, so the same instance can
 * drive the interim animation panel and the unified sprite shell. Every mutation
 * it makes goes through the document controller's frame-draft API, i.e. through
 * `UpdateAnimationDocumentOperation` — one drag is one undo step.
 */
export class FrameOverlayController {
  private _editMode: AnimationEditMode = 'anchor';
  private _selectedPointName: string | null = null;
  private dragState: StageDragState | null = null;

  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: FrameOverlayControllerDeps) {}

  get editMode(): AnimationEditMode {
    return this._editMode;
  }

  /** Points mode: the point highlighted on the stage and in the side list. */
  get selectedPointName(): string | null {
    return this._selectedPointName;
  }

  get isDragging(): boolean {
    return this.dragState !== null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setEditMode(mode: AnimationEditMode): void {
    if (this._editMode === mode) {
      return;
    }

    this._editMode = mode;
    this.notify();
  }

  setSelectedPointName(name: string | null): void {
    if (this._selectedPointName === name) {
      return;
    }

    this._selectedPointName = name;
    this.notify();
  }

  /**
   * Whether `mode` is both the active tool and safe to author with right now.
   *
   * §9.7 risk 2: `getFrameMetrics` reports a 256x256 placeholder until the
   * frame's texture decodes. The bounding box and the collision polygon are
   * stored in absolute frame pixels, and a point's angle is measured in that same
   * space, so a drag made against the placeholder writes coordinates for a frame
   * size that does not exist. The anchor is exempt — it is a ratio of the frame
   * box, and the pointer position is measured against the very same (placeholder)
   * box, so the ratio comes out right whatever the metrics say.
   */
  canEdit(mode: AnimationEditMode): boolean {
    if (this._editMode !== mode) {
      return false;
    }

    const document = this.deps.getDocument();
    const frame = document?.selectedFrame ?? null;
    if (!document || !frame) {
      return false;
    }

    return mode === 'anchor' || document.hasResolvedFrameMetrics(frame);
  }

  /**
   * Drop an in-flight drag whose draft vanished under it — a document reload
   * clears the frame draft, leaving the gesture bound to a frame that no longer
   * exists. Hosts call this from their document-changed handler.
   */
  handleDocumentChanged(): void {
    if (!this.dragState) {
      return;
    }

    if (!this.deps.getDocument()?.frameDraft) {
      this.dragState = null;
      this.notify();
    }
  }

  handlePointerDown(event: PointerEvent): void {
    const document = this.deps.getDocument();
    const frame = document?.selectedFrame ?? null;
    if (!document || !frame || !this.canEdit(this._editMode)) {
      return;
    }

    const point = this.resolveFramePoint(event, document, frame);
    if (!point) {
      return;
    }

    const target = event.target as HTMLElement | SVGElement | null;
    if (!document.beginFrameDraft()) {
      return;
    }

    if (this._editMode === 'points') {
      const angleHandleName = target?.getAttribute('data-point-angle') ?? null;
      const pointName = target?.getAttribute('data-point-name') ?? angleHandleName;
      if (!pointName) {
        // Empty stage click in points mode: nothing to grab.
        document.clearFrameDraft();
        return;
      }
      this._selectedPointName = pointName;
      this.dragState = {
        pointerId: event.pointerId,
        mode: 'points',
        origin: point,
        pointName,
        pointAngleHandle: Boolean(angleHandleName),
      };
    } else if (this._editMode === 'anchor') {
      document.updateFrameDraft(draft => ({
        ...draft,
        anchor: toNormalizedAnchor(point, document.getFrameMetrics(frame)),
      }));
      this.dragState = {
        pointerId: event.pointerId,
        mode: 'anchor',
        origin: point,
      };
    } else if (this._editMode === 'bbox') {
      document.updateFrameDraft(draft => ({
        ...draft,
        boundingBox: { x: point.x, y: point.y, width: 0, height: 0 },
      }));
      this.dragState = {
        pointerId: event.pointerId,
        mode: 'bbox',
        origin: point,
      };
    } else {
      const vertexIndex = Number(target?.getAttribute('data-vertex-index'));
      if (Number.isInteger(vertexIndex) && vertexIndex >= 0) {
        this.dragState = {
          pointerId: event.pointerId,
          mode: 'polygon',
          origin: point,
          vertexIndex,
        };
      } else {
        let appendedVertexIndex = 0;
        document.updateFrameDraft(draft => {
          appendedVertexIndex = draft.collisionPolygon.length;
          return { ...draft, collisionPolygon: [...draft.collisionPolygon, point] };
        });
        this.dragState = {
          pointerId: event.pointerId,
          mode: 'polygon',
          origin: point,
          vertexIndex: appendedVertexIndex,
        };
      }
    }

    (event.currentTarget as Element | null)?.setPointerCapture?.(event.pointerId);
    this.notify();
  }

  handlePointerMove(event: PointerEvent): void {
    const document = this.deps.getDocument();
    const dragState = this.dragState;
    const frame = document?.selectedFrame ?? null;
    if (
      !document ||
      !dragState ||
      !frame ||
      dragState.pointerId !== event.pointerId ||
      !document.frameDraft
    ) {
      return;
    }

    const point = this.resolveFramePoint(event, document, frame);
    if (!point) {
      return;
    }

    if (dragState.mode === 'points') {
      const pointName = dragState.pointName;
      if (!pointName) {
        return;
      }
      const metrics = document.getFrameMetrics(frame);
      document.updateFrameDraft(draft => ({
        ...draft,
        points: (draft.points ?? []).map(candidate => {
          if (candidate.name !== pointName) {
            return candidate;
          }
          if (!dragState.pointAngleHandle) {
            return {
              ...candidate,
              x: Number((point.x / metrics.frameWidth).toFixed(4)),
              y: Number((point.y / metrics.frameHeight).toFixed(4)),
            };
          }
          // Dragging the handle rotates the point around itself.
          const originX = candidate.x * metrics.frameWidth;
          const originY = candidate.y * metrics.frameHeight;
          const angle = (Math.atan2(point.y - originY, point.x - originX) * 180) / Math.PI;
          return { ...candidate, angle: Math.round(angle) };
        }),
      }));
      return;
    }

    if (dragState.mode === 'anchor') {
      document.updateFrameDraft(draft => ({
        ...draft,
        anchor: toNormalizedAnchor(point, document.getFrameMetrics(frame)),
      }));
      return;
    }

    if (dragState.mode === 'bbox') {
      const x = Math.min(dragState.origin.x, point.x);
      const y = Math.min(dragState.origin.y, point.y);
      const width = Math.abs(point.x - dragState.origin.x);
      const height = Math.abs(point.y - dragState.origin.y);
      document.updateFrameDraft(draft => ({
        ...draft,
        boundingBox: { x, y, width, height },
      }));
      return;
    }

    const vertexIndex = dragState.vertexIndex ?? -1;
    if (vertexIndex < 0) {
      return;
    }

    document.updateFrameDraft(draft => {
      const nextPolygon = [...draft.collisionPolygon];
      nextPolygon[vertexIndex] = point;
      return { ...draft, collisionPolygon: nextPolygon };
    });
  }

  async handlePointerUp(event: PointerEvent): Promise<void> {
    const dragState = this.dragState;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    (event.currentTarget as Element | null)?.releasePointerCapture?.(event.pointerId);
    this.dragState = null;
    this.notify();

    const document = this.deps.getDocument();
    if (!document) {
      return;
    }

    await document.commitFrameDraft(`Update frame ${dragState.mode}: ${document.activeClipName}`);
  }

  /**
   * Host coordinates → the frame pixel the tools work in: clamped to the frame
   * box and snapped to whole pixels, so a polygon vertex or bounding box is never
   * authored at a fractional or off-frame coordinate.
   */
  private resolveFramePoint(
    event: PointerEvent,
    document: AnimationDocumentController,
    frame: AnimationFrame
  ): StagePoint | null {
    const rawPoint = this.deps.toFramePoint(event);
    if (!rawPoint) {
      return null;
    }

    const metrics = document.getFrameMetrics(frame);
    return {
      x: Math.round(Math.min(metrics.frameWidth, Math.max(0, rawPoint.x))),
      y: Math.round(Math.min(metrics.frameHeight, Math.max(0, rawPoint.y))),
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** Frame pixel → the frame-relative ratio `AnimationFrame.anchor` stores. */
function toNormalizedAnchor(point: StagePoint, metrics: FrameMetrics): StagePoint {
  return {
    x: Number((point.x / metrics.frameWidth).toFixed(3)),
    y: Number((point.y / metrics.frameHeight).toFixed(3)),
  };
}
