import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineLoop } from 'three';
import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
import type { Hitbox2DShape, Hitbox2DSource } from '../core/Collision2DService';
import type { Point2D } from '../core/collision-shapes-2d';
import { normalizePolygonConfig } from '../core/collision-polygon-config';
import { OVERLAY_2D_FLAG } from '../core/render-order-2d';

/**
 * Hitbox2D (`core:Hitbox2D`) — attaches a queryable 2D collision shape to a
 * node (Unity Collider2D / Cocos Collider component style, filtered by
 * Godot-style string groups). Registers with `scene.collision2d`; gameplay
 * scripts hit-test via `scene.collision2d.overlapCircle(...)` / `raycast(...)`.
 *
 * Shapes: `rect` and `circle` are axis-aligned (rotation ignored, scale honored)
 * — see Collision2DService for that contract. `polygon` is rotation-aware and may
 * be concave, and takes its vertices either from `points` (authored in the
 * viewport's polygon tool) or, with `polygonSource: 'frame'`, from the animation
 * frame currently showing on an `AnimatedSprite2D` — the outline the Sprite
 * Editor traces from the frame's alpha.
 *
 * `debugDraw` renders the shape outline in play mode (Godot's "Visible Collision
 * Shapes").
 */
export class Hitbox2DBehavior extends Script implements Hitbox2DSource {
  private debugLine: LineLoop | null = null;
  private debugKey = '';
  /** Last `points` array seen, with its normalized form — avoids re-parsing per query. */
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
      group: 'default',
      debugDraw: false,
    };
  }

  static getPropertySchema(): PropertySchema {
    const numberProp = (name: string, label: string, group: string) => ({
      name,
      type: 'number' as const,
      ui: { label, group, step: 1 },
      getValue: (c: unknown) => (c as Hitbox2DBehavior).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as Hitbox2DBehavior).config[name] = Number(v);
      },
    });
    return {
      nodeType: 'Hitbox2D',
      properties: [
        {
          name: 'shape',
          type: 'select',
          ui: {
            label: 'Shape',
            description:
              'Rect and circle are axis-aligned (rotation ignored, scale honored); polygon is rotation-aware and may be concave',
            group: 'Shape',
            options: ['rect', 'circle', 'polygon'],
          },
          getValue: (c: unknown) => (c as Hitbox2DBehavior).config.shape,
          setValue: (c: unknown, v: unknown) => {
            (c as Hitbox2DBehavior).config.shape =
              v === 'circle' ? 'circle' : v === 'polygon' ? 'polygon' : 'rect';
          },
        },
        numberProp('width', 'Width', 'Shape'),
        numberProp('height', 'Height', 'Shape'),
        numberProp('radius', 'Radius', 'Shape'),
        numberProp('offsetX', 'Offset X', 'Shape'),
        numberProp('offsetY', 'Offset Y', 'Shape'),
        {
          name: 'polygonSource',
          type: 'select',
          ui: {
            label: 'Polygon Source',
            description:
              'manual: the vertices below. frame: the collision polygon of the animation frame currently showing on this AnimatedSprite2D.',
            group: 'Shape',
            options: ['manual', 'frame'],
          },
          getValue: (c: unknown) => (c as Hitbox2DBehavior).config.polygonSource ?? 'manual',
          setValue: (c: unknown, v: unknown) => {
            (c as Hitbox2DBehavior).config.polygonSource = v === 'frame' ? 'frame' : 'manual';
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
          getValue: (c: unknown) => (c as Hitbox2DBehavior).config.points ?? [],
          setValue: (c: unknown, v: unknown) => {
            (c as Hitbox2DBehavior).config.points = normalizePolygonConfig(v);
          },
        },
        {
          name: 'group',
          type: 'string',
          ui: {
            label: 'Group',
            description: 'Collision group tag used to filter queries (Godot-style group)',
            group: 'Filtering',
          },
          getValue: (c: unknown) => (c as Hitbox2DBehavior).config.group,
          setValue: (c: unknown, v: unknown) => {
            (c as Hitbox2DBehavior).config.group = String(v ?? 'default');
          },
        },
        {
          name: 'debugDraw',
          type: 'boolean',
          ui: {
            label: 'Debug Draw',
            description: 'Render the shape outline in play mode',
            group: 'Debug',
          },
          getValue: (c: unknown) => (c as Hitbox2DBehavior).config.debugDraw,
          setValue: (c: unknown, v: unknown) => {
            (c as Hitbox2DBehavior).config.debugDraw = Boolean(v);
          },
        },
      ],
      groups: {
        Shape: { label: 'Shape', expanded: true },
        Filtering: { label: 'Filtering', expanded: true },
        Debug: { label: 'Debug', expanded: false },
      },
    };
  }

  // --- Hitbox2DSource ---

  getHitboxShape(): Hitbox2DShape {
    const shape = this.config.shape;
    return shape === 'circle' ? 'circle' : shape === 'polygon' ? 'polygon' : 'rect';
  }

  getHitboxSize(): { width: number; height: number; radius: number } {
    return {
      width: Number(this.config.width) || 0,
      height: Number(this.config.height) || 0,
      radius: Number(this.config.radius) || 0,
    };
  }

  getHitboxOffset(): { x: number; y: number } {
    return { x: Number(this.config.offsetX) || 0, y: Number(this.config.offsetY) || 0 };
  }

  getHitboxGroup(): string {
    return String(this.config.group ?? 'default');
  }

  /**
   * Node-local vertices. With `polygonSource: 'frame'` this changes every time
   * the sprite advances a frame — deliberately re-read per query rather than
   * cached, because the whole point is that the collider tracks the animation.
   */
  getHitboxPolygon(): readonly Point2D[] {
    if (this.config.polygonSource === 'frame') {
      // Duck-typed on purpose: an `instanceof AnimatedSprite2D` here would make
      // every project that says `Hitbox2D` ship the AnimatedSprite2D module,
      // which the export's strippable table exists to avoid. Same reasoning as
      // the host-injected Spine module.
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

  // --- lifecycle ---

  onStart(): void {
    this.scene?.collision2d.register(this);
  }

  onUpdate(): void {
    this.syncDebugDraw();
  }

  override onDetach(): void {
    this.scene?.collision2d.unregister(this);
    this.removeDebugLine();
    super.onDetach();
  }

  // --- debug outline ---

  private syncDebugDraw(): void {
    const node = this.node;
    if (!node) {
      return;
    }
    if (!this.config.debugDraw) {
      this.removeDebugLine();
      return;
    }

    const size = this.getHitboxSize();
    const offset = this.getHitboxOffset();
    const shape = this.getHitboxShape();
    const polygon = shape === 'polygon' ? this.getHitboxPolygon() : null;
    const key =
      shape === 'polygon'
        ? `polygon|${offset.x}|${offset.y}|${polygon?.map(p => `${p.x},${p.y}`).join(' ')}`
        : `${shape}|${size.width}|${size.height}|${size.radius}|${offset.x}|${offset.y}`;
    if (this.debugLine && key === this.debugKey) {
      return;
    }

    this.removeDebugLine();
    this.debugKey = key;

    const points: number[] = [];
    if (shape === 'polygon') {
      if (!polygon || polygon.length < 3) {
        return;
      }
      for (const p of polygon) {
        points.push(offset.x + p.x, offset.y + p.y, 0);
      }
    } else if (shape === 'circle') {
      const segments = 32;
      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        points.push(offset.x + Math.cos(a) * size.radius, offset.y + Math.sin(a) * size.radius, 0);
      }
    } else {
      const hw = size.width / 2;
      const hh = size.height / 2;
      points.push(
        offset.x - hw,
        offset.y - hh,
        0,
        offset.x + hw,
        offset.y - hh,
        0,
        offset.x + hw,
        offset.y + hh,
        0,
        offset.x - hw,
        offset.y + hh,
        0
      );
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
    const material = new LineBasicMaterial({
      color: 0x7df9ff,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    });
    const line = new LineLoop(geometry, material);
    line.renderOrder = 5000;
    line.userData[OVERLAY_2D_FLAG] = true;
    node.add(line);
    this.debugLine = line;
  }

  private removeDebugLine(): void {
    if (!this.debugLine) {
      return;
    }
    this.debugLine.removeFromParent();
    this.debugLine.geometry.dispose();
    (this.debugLine.material as LineBasicMaterial).dispose();
    this.debugLine = null;
    this.debugKey = '';
  }
}
