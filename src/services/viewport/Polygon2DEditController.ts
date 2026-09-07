import { inject, injectable } from '@/fw/di';
import { appState } from '@/state';
import type { Point2D } from '@pix3/runtime';
import { serializePolygonConfig } from '@pix3/runtime';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { UpdateComponentPropertyCommand } from '@/features/scripts/UpdateComponentPropertyCommand';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';

/**
 * The viewport's collision-polygon tool: drag a vertex, insert one on an edge,
 * delete one.
 *
 * Gestures run through the mutation gateway like every other edit, using
 * `UpdateComponentPropertyCommand`'s `preview`/`commit` history modes — every
 * pointer move applies but pushes nothing, and the pointer-up pushes a single
 * entry carrying the vertex list as it was when the drag started. So a drag is
 * one Ctrl+Z, not one per mouse move, and nothing writes `component.config`
 * behind the gateway's back.
 *
 * The controller owns *gesture* state only; what is being edited lives in
 * `appState.ui.polygonEditing` (the inspector opens it) and the drawing lives in
 * `ViewportColliderGizmos`.
 */
@injectable()
export class Polygon2DEditController {
  @inject(ViewportRendererService)
  private readonly viewportRenderer!: ViewportRendererService;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  private drag: {
    nodeId: string;
    componentId: string;
    vertexIndex: number;
    /** Vertices before the gesture — the undo value for the single pushed entry. */
    startPoints: Point2D[];
    /** Grab offset, so a vertex does not jump to the pointer on the first move. */
    grabOffset: Point2D;
    moved: boolean;
  } | null = null;

  /** True while a vertex drag is in flight. */
  get isDragging(): boolean {
    return this.drag !== null;
  }

  /** True when a polygon is open for editing and the tool should get first refusal on pointers. */
  get isActive(): boolean {
    return appState.ui.polygonEditing !== null;
  }

  /** Open a polygon for editing (or close it with `null`). */
  setTarget(target: { nodeId: string; componentId: string } | null): void {
    appState.ui.polygonEditing = target ? { ...target } : null;
    this.viewportRenderer.setPolygonEditTarget(target);
    this.drag = null;
  }

  /**
   * Close the tool if the open polygon's node is no longer selected — otherwise
   * handles keep floating over a node the user has navigated away from, and the
   * next click lands on a vertex they cannot see the owner of.
   */
  syncWithSelection(): void {
    const target = appState.ui.polygonEditing;
    if (target && !appState.selection.nodeIds.includes(target.nodeId)) {
      this.setTarget(null);
    }
  }

  /**
   * Returns true when the tool consumed the press — the caller must then not
   * treat it as a selection click or a transform-handle grab.
   */
  handlePointerDown(event: PointerEvent, screenX: number, screenY: number): boolean {
    const target = appState.ui.polygonEditing;
    if (!target || event.button !== 0) {
      return false;
    }
    const shape = this.viewportRenderer.getEditedColliderShape();
    const hit = this.viewportRenderer.getPolygonHandleAt(screenX, screenY);
    if (!shape || !hit) {
      return false;
    }

    const points = shape.points.map(p => ({ x: p.x, y: p.y }));

    if (hit.kind === 'vertex') {
      // Alt-click removes, matching the Sprite Editor's polygon overlay. Three
      // vertices is the floor: fewer is not a polygon and the collider would
      // silently stop registering.
      if (event.altKey) {
        if (points.length <= 3) {
          return true;
        }
        points.splice(hit.index, 1);
        void this.commit(target, points, shape.points);
        return true;
      }

      const local = this.viewportRenderer.screenToPolygonLocal(screenX, screenY);
      this.drag = {
        ...target,
        vertexIndex: hit.index,
        startPoints: shape.points.map(p => ({ x: p.x, y: p.y })),
        grabOffset: local
          ? { x: points[hit.index].x - local.x, y: points[hit.index].y - local.y }
          : { x: 0, y: 0 },
        moved: false,
      };
      return true;
    }

    // Edge midpoint: insert a vertex there and grab it immediately, so one press
    // both adds and positions it (Figma's pen-on-edge behaviour).
    const a = points[hit.index];
    const b = points[(hit.index + 1) % points.length];
    const inserted: Point2D = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const insertAt = hit.index + 1;
    points.splice(insertAt, 0, inserted);

    const startPoints = shape.points.map(p => ({ x: p.x, y: p.y }));
    void this.preview(target, points);
    this.drag = {
      ...target,
      vertexIndex: insertAt,
      startPoints,
      grabOffset: { x: 0, y: 0 },
      moved: true,
    };
    return true;
  }

  /** Returns true when a drag consumed the move. */
  handlePointerMove(screenX: number, screenY: number): boolean {
    const drag = this.drag;
    if (!drag) {
      return false;
    }
    const shape = this.viewportRenderer.getEditedColliderShape();
    const local = this.viewportRenderer.screenToPolygonLocal(screenX, screenY);
    if (!shape || !local || drag.vertexIndex >= shape.points.length) {
      return true;
    }

    const points = shape.points.map(p => ({ x: p.x, y: p.y }));
    points[drag.vertexIndex] = {
      x: local.x + drag.grabOffset.x,
      y: local.y + drag.grabOffset.y,
    };
    drag.moved = true;
    void this.preview(drag, points);
    return true;
  }

  /** Returns true when a drag was in flight and this release ended it. */
  handlePointerUp(): boolean {
    const drag = this.drag;
    if (!drag) {
      return false;
    }
    this.drag = null;

    const shape = this.viewportRenderer.getEditedColliderShape();
    if (!drag.moved || !shape) {
      return true;
    }

    // The preview writes already left the final vertices on the component; the
    // commit re-applies them as one history entry against the pre-drag list.
    void this.commit(drag, shape.points, drag.startPoints);
    return true;
  }

  /** Abandon a drag without committing (pointer cancel, tab switch). */
  cancelDrag(): void {
    const drag = this.drag;
    this.drag = null;
    if (drag?.moved) {
      void this.preview(drag, drag.startPoints);
    }
  }

  private preview(
    target: { nodeId: string; componentId: string },
    points: readonly Point2D[]
  ): Promise<unknown> {
    return this.commandDispatcher.execute(
      new UpdateComponentPropertyCommand({
        nodeId: target.nodeId,
        componentId: target.componentId,
        propertyName: 'points',
        value: serializePolygonConfig(points),
        historyMode: 'preview',
      })
    );
  }

  private commit(
    target: { nodeId: string; componentId: string },
    points: readonly Point2D[],
    previousPoints: readonly Point2D[]
  ): Promise<unknown> {
    return this.commandDispatcher.execute(
      new UpdateComponentPropertyCommand({
        nodeId: target.nodeId,
        componentId: target.componentId,
        propertyName: 'points',
        value: serializePolygonConfig(points),
        previousValue: serializePolygonConfig(previousPoints),
        historyMode: 'commit',
      })
    );
  }
}
