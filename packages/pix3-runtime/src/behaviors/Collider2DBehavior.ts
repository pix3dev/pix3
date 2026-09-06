import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
import type { Collider2DShape, Collider2DSource } from '../core/Physics2DService';
import type { Point2D } from '../core/collision-shapes-2d';
import { normalizePolygonConfig } from '../core/collision-polygon-config';

/**
 * Collider2D (`core:Collider2D`) — the shape half of the physics pair.
 *
 * Attaches to the **nearest ancestor** `core:PhysicsBody2D` (Unity's compound
 * rule), or, with no body above it, becomes static world geometry. Shapes are
 * rect, circle, and polygon; an authored polygon may be concave — the service
 * decomposes it into convex parts once, so a traced sprite outline is usable
 * directly.
 *
 * `sensor: true` is Godot's Area2D role: it detects and reports
 * `body-entered` / `body-exited` but never pushes anything.
 *
 * Everything is rotation- and scale-aware, which is the difference between this
 * and `core:Hitbox2D`: the query tier keeps its axis-aligned contract for
 * compatibility, a physics collider cannot.
 */
export class Collider2DBehavior extends Script implements Collider2DSource {
  private polygonCacheInput: unknown = undefined;
  private polygonCache: Point2D[] = [];

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      shape: 'rect',
      width: 64,
      height: 64,
      radius: 32,
      offsetX: 0,
      offsetY: 0,
      points: [],
      polygonSource: 'manual',
      friction: 0.4,
      restitution: 0.2,
      density: 1,
      sensor: false,
      group: 'default',
    };
  }

  static getPropertySchema(): PropertySchema {
    const numberProp = (
      name: string,
      label: string,
      group: string,
      description: string,
      step = 1
    ) => ({
      name,
      type: 'number' as const,
      ui: { label, group, step, description },
      getValue: (c: unknown) => (c as Collider2DBehavior).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as Collider2DBehavior).config[name] = Number(v);
      },
    });

    return {
      nodeType: 'Collider2D',
      properties: [
        {
          name: 'shape',
          type: 'select',
          ui: {
            label: 'Shape',
            description:
              'All of them follow the node rotation and scale. A capsule is upright along local Y and sized by height + radius (Godot\u2019s convention). A polygon may be concave; it is split into convex parts for you.',
            group: 'Shape',
            options: ['rect', 'circle', 'polygon', 'capsule'],
          },
          getValue: (c: unknown) => (c as Collider2DBehavior).config.shape,
          setValue: (c: unknown, v: unknown) => {
            const shape = String(v);
            (c as Collider2DBehavior).config.shape = (
              ['circle', 'polygon', 'capsule'] as const
            ).includes(shape as 'circle' | 'polygon' | 'capsule')
              ? shape
              : 'rect';
          },
        },
        numberProp('width', 'Width', 'Shape', 'Rect width in design pixels.'),
        numberProp(
          'height',
          'Height',
          'Shape',
          'Rect height, or a capsule\u2019s TOTAL height including both caps.'
        ),
        numberProp(
          'radius',
          'Radius',
          'Shape',
          'Circle radius, or a capsule\u2019s cap radius (its half-width).'
        ),
        numberProp('offsetX', 'Offset X', 'Shape', 'Shape offset from the node origin.'),
        numberProp('offsetY', 'Offset Y', 'Shape', 'Shape offset from the node origin.'),
        {
          name: 'polygonSource',
          type: 'select',
          ui: {
            label: 'Polygon Source',
            description:
              'manual: the vertices below. frame: the collision polygon of the animation frame showing right now.',
            group: 'Shape',
            options: ['manual', 'frame'],
          },
          getValue: (c: unknown) => (c as Collider2DBehavior).config.polygonSource ?? 'manual',
          setValue: (c: unknown, v: unknown) => {
            (c as Collider2DBehavior).config.polygonSource = v === 'frame' ? 'frame' : 'manual';
          },
        },
        {
          name: 'points',
          type: 'object',
          ui: {
            label: 'Polygon',
            description: 'Vertices in node-local pixels (y up). Edit them in the viewport.',
            group: 'Shape',
            editor: 'collision-polygon',
          },
          getValue: (c: unknown) => (c as Collider2DBehavior).config.points ?? [],
          setValue: (c: unknown, v: unknown) => {
            (c as Collider2DBehavior).config.points = normalizePolygonConfig(v);
          },
        },
        numberProp(
          'friction',
          'Friction',
          'Material',
          'Coulomb friction. Combined between two colliders as the geometric mean.',
          0.05
        ),
        numberProp(
          'restitution',
          'Restitution',
          'Material',
          'Bounciness, 0 to 1. Combined as the maximum of the two. Slow contacts never bounce.',
          0.05
        ),
        numberProp(
          'density',
          'Density',
          'Material',
          'Mass per unit area, used when the body derives its own mass.',
          0.1
        ),
        {
          name: 'sensor',
          type: 'boolean',
          ui: {
            label: 'Sensor',
            description:
              'Detect overlaps and report body-entered / body-exited without pushing anything (Godot Area2D).',
            group: 'Filtering',
          },
          getValue: (c: unknown) => (c as Collider2DBehavior).config.sensor,
          setValue: (c: unknown, v: unknown) => {
            (c as Collider2DBehavior).config.sensor = Boolean(v);
          },
        },
        {
          name: 'group',
          type: 'string',
          ui: {
            label: 'Group',
            description: 'Tag used to filter physics queries (same convention as Hitbox2D).',
            group: 'Filtering',
          },
          getValue: (c: unknown) => (c as Collider2DBehavior).config.group,
          setValue: (c: unknown, v: unknown) => {
            (c as Collider2DBehavior).config.group = String(v ?? 'default');
          },
        },
      ],
      groups: {
        Shape: { label: 'Shape', expanded: true },
        Material: { label: 'Material', expanded: true },
        Filtering: { label: 'Filtering', expanded: false },
      },
    };
  }

  // --- Collider2DSource ---

  getColliderShape(): Collider2DShape {
    const shape = this.config.shape;
    return shape === 'circle' || shape === 'polygon' || shape === 'capsule' ? shape : 'rect';
  }

  getColliderSize(): { width: number; height: number; radius: number } {
    return {
      width: Number(this.config.width) || 0,
      height: Number(this.config.height) || 0,
      radius: Number(this.config.radius) || 0,
    };
  }

  getColliderOffset(): { x: number; y: number } {
    return { x: Number(this.config.offsetX) || 0, y: Number(this.config.offsetY) || 0 };
  }

  getColliderPolygon(): readonly Point2D[] {
    if (this.config.polygonSource === 'frame') {
      // Duck-typed for the same reason Hitbox2D is: naming AnimatedSprite2D here
      // would pin that module into every export that mentions a collider.
      const provider = this.node as { getFrameCollisionPolygon?: () => Point2D[] } | null;
      return typeof provider?.getFrameCollisionPolygon === 'function'
        ? provider.getFrameCollisionPolygon()
        : [];
    }
    const raw = this.config.points;
    if (raw !== this.polygonCacheInput) {
      this.polygonCacheInput = raw;
      this.polygonCache = normalizePolygonConfig(raw);
    }
    return this.polygonCache;
  }

  getColliderMaterial(): { friction: number; restitution: number; density: number } {
    return {
      friction: Math.max(0, Number(this.config.friction) || 0),
      restitution: Math.min(1, Math.max(0, Number(this.config.restitution) || 0)),
      density: Math.max(0.0001, Number(this.config.density) || 1),
    };
  }

  isSensor(): boolean {
    return Boolean(this.config.sensor);
  }

  getColliderGroup(): string {
    return String(this.config.group ?? 'default');
  }

  /**
   * A cheap digest of everything that changes the baked shape. The service
   * compares it each step and rebakes when it differs, which is what makes an
   * inspector edit during play apply immediately without re-registration.
   *
   * A frame-sourced polygon folds its vertex count and first vertex into the
   * digest, so advancing an animation frame rebakes without stringifying the
   * whole outline every step.
   */
  getColliderRevision(): string {
    const c = this.config;
    if (c.polygonSource === 'frame') {
      const polygon = this.getColliderPolygon();
      const head = polygon[0];
      return `frame|${polygon.length}|${head?.x ?? 0},${head?.y ?? 0}|${c.friction}|${c.restitution}|${c.density}|${c.sensor}|${c.group}`;
    }
    const points = this.getColliderPolygon();
    return [
      c.shape,
      c.width,
      c.height,
      c.radius,
      c.offsetX,
      c.offsetY,
      points.length,
      points.map(p => `${p.x},${p.y}`).join(' '),
      c.friction,
      c.restitution,
      c.density,
      c.sensor,
      c.group,
    ].join('|');
  }

  // --- lifecycle ---

  onStart(): void {
    this.scene?.physics2d.registerCollider(this);
  }

  override onDetach(): void {
    this.scene?.physics2d.unregisterCollider(this);
    super.onDetach();
  }
}
