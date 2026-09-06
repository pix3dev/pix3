import type { NodeBase, Point2D, ShapeTransform2D } from '@pix3/runtime';
import {
  boxPolygon,
  circlePolygon,
  normalizePolygonConfig,
  readWorldTransform2D,
} from '@pix3/runtime';

/**
 * Reading a node's authored collision shapes for the **editor**.
 *
 * The editor viewport draws proxy meshes rather than the runtime nodes and never
 * runs a hitbox's own `debugDraw`, so a collider is invisible while authoring
 * unless something reads it back out of the component config and draws it. That
 * is this module: config bag in, an outline in node-local pixels out, plus the
 * node's world transform so the caller can place it.
 *
 * Everything here works off the component's `config` rather than the behavior
 * instance, because in the editor a component may exist as authored data whose
 * class was never constructed.
 */

/** Component ids this module understands, in the order they should be drawn. */
export const COLLIDER_COMPONENT_TYPES = ['core:Hitbox2D'] as const;

export type ColliderShapeKind = 'rect' | 'circle' | 'polygon';

export interface ColliderShape {
  nodeId: string;
  componentId: string;
  componentType: string;
  kind: ColliderShapeKind;
  /**
   * The outline in node-local pixels (y up), offset already folded in. A circle
   * arrives as a polygon approximation, so every consumer draws one thing.
   */
  outline: Point2D[];
  /** The node's world transform, for placing {@link outline}. */
  transform: ShapeTransform2D;
  /**
   * True when dragging a vertex is meaningful: a `polygon` shape whose vertices
   * come from `points`. A `polygonSource: 'frame'` outline belongs to the
   * animation frame and is edited in the Sprite Editor, not here.
   */
  editable: boolean;
  /** Raw authored vertices for an editable polygon (no offset applied). */
  points: Point2D[];
  /** Offset applied on top of {@link points}, in node-local pixels. */
  offset: Point2D;
}

interface ComponentLike {
  id: string;
  type: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/** Segments used to draw a circle collider — enough to read as round at any zoom. */
const CIRCLE_SEGMENTS = 32;

/** The collider components authored on a node, in declaration order. */
export function readColliderComponents(node: NodeBase): ComponentLike[] {
  const components = (node as unknown as { components?: ComponentLike[] }).components;
  if (!Array.isArray(components)) {
    return [];
  }
  return components.filter(component =>
    (COLLIDER_COMPONENT_TYPES as readonly string[]).includes(component?.type)
  );
}

/**
 * Every collider shape authored on `node`, resolved to a drawable outline.
 *
 * Returns `[]` — never a fallback box — when a shape cannot be resolved (a
 * polygon with fewer than three vertices, a frame-sourced polygon on a node that
 * has no frames). Drawing a box the user did not author would misreport what the
 * collider actually is.
 */
export function collectColliderShapes(node: NodeBase): ColliderShape[] {
  const shapes: ColliderShape[] = [];
  const transform = readWorldTransform2D(node);

  for (const component of readColliderComponents(node)) {
    const config = component.config ?? {};
    const offset: Point2D = {
      x: Number(config.offsetX) || 0,
      y: Number(config.offsetY) || 0,
    };
    const rawShape = String(config.shape ?? 'rect');
    const kind: ColliderShapeKind =
      rawShape === 'circle' ? 'circle' : rawShape === 'polygon' ? 'polygon' : 'rect';

    if (kind === 'polygon') {
      const fromFrame = config.polygonSource === 'frame';
      const points = fromFrame ? readFramePolygon(node) : normalizePolygonConfig(config.points);
      if (points.length < 3) {
        continue;
      }
      shapes.push({
        nodeId: node.nodeId,
        componentId: component.id,
        componentType: component.type,
        kind,
        outline: points.map(p => ({ x: p.x + offset.x, y: p.y + offset.y })),
        transform: { ...transform },
        editable: !fromFrame,
        points,
        offset,
      });
      continue;
    }

    const outline =
      kind === 'circle'
        ? circlePolygon(Math.abs(Number(config.radius) || 0), CIRCLE_SEGMENTS, offset)
        : boxPolygon(
            (Math.abs(Number(config.width) || 0) || 0) / 2,
            (Math.abs(Number(config.height) || 0) || 0) / 2,
            offset
          );
    if (outline.length < 3) {
      continue;
    }

    shapes.push({
      nodeId: node.nodeId,
      componentId: component.id,
      componentType: component.type,
      kind,
      outline,
      transform: { ...transform },
      editable: false,
      points: [],
      offset,
    });
  }

  return shapes;
}

/**
 * The current animation frame's collision polygon, for a node that provides one.
 * Duck-typed for the same reason the runtime behavior is: this must not drag the
 * `AnimatedSprite2D` class into modules that only need an outline.
 */
function readFramePolygon(node: NodeBase): Point2D[] {
  const provider = node as unknown as { getFrameCollisionPolygon?: () => Point2D[] };
  return typeof provider.getFrameCollisionPolygon === 'function'
    ? provider.getFrameCollisionPolygon()
    : [];
}

/**
 * Map a polygon traced from a sprite's own texture into that sprite's node-local
 * space (y up), so `traceCollisionPolygon`'s output can be written straight into
 * a `core:Hitbox2D`'s `points`.
 *
 * The tracer works in **absolute image pixels with y down**; a `Sprite2D` draws
 * its texture as a `width x height` quad whose centre is offset by the anchor
 * (`(0.5 - anchor) * size`, y up — see `Sprite2D.applyAnchorOffset`). This is the
 * one place that conversion lives, so the traced outline lands exactly on the
 * pixels it was traced from at any anchor.
 */
export function mapImagePolygonToSpriteLocal(
  polygon: readonly Point2D[],
  image: { width: number; height: number },
  sprite: { width: number; height: number; anchorX: number; anchorY: number }
): Point2D[] {
  if (image.width <= 0 || image.height <= 0) {
    return [];
  }
  const centerX = (0.5 - sprite.anchorX) * sprite.width;
  const centerY = (0.5 - sprite.anchorY) * sprite.height;
  return polygon.map(point => ({
    x: centerX + (point.x / image.width - 0.5) * sprite.width,
    y: centerY + (0.5 - point.y / image.height) * sprite.height,
  }));
}
