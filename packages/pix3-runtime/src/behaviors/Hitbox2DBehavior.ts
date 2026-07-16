import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineLoop } from 'three';
import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
import type { Hitbox2DShape, Hitbox2DSource } from '../core/Collision2DService';
import { OVERLAY_2D_FLAG } from '../core/render-order-2d';

/**
 * Hitbox2D (`core:Hitbox2D`) — attaches a queryable 2D collision shape to a
 * node (Unity Collider2D / Cocos Collider component style, filtered by
 * Godot-style string groups). Registers with `scene.collision2d`; gameplay
 * scripts hit-test via `scene.collision2d.overlapCircle(...)` / `raycast(...)`.
 *
 * Shapes are axis-aligned (rotation ignored, scale honored) — see
 * Collision2DService for the contract. `debugDraw` renders the shape outline
 * in play mode (Godot's "Visible Collision Shapes").
 */
export class Hitbox2DBehavior extends Script implements Hitbox2DSource {
  private debugLine: LineLoop | null = null;
  private debugKey = '';

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      shape: 'rect',
      width: 64,
      height: 64,
      radius: 32,
      offsetX: 0,
      offsetY: 0,
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
            description: 'Axis-aligned rect or circle (rotation is ignored, scale honored)',
            group: 'Shape',
            options: ['rect', 'circle'],
          },
          getValue: (c: unknown) => (c as Hitbox2DBehavior).config.shape,
          setValue: (c: unknown, v: unknown) => {
            (c as Hitbox2DBehavior).config.shape = v === 'circle' ? 'circle' : 'rect';
          },
        },
        numberProp('width', 'Width', 'Shape'),
        numberProp('height', 'Height', 'Shape'),
        numberProp('radius', 'Radius', 'Shape'),
        numberProp('offsetX', 'Offset X', 'Shape'),
        numberProp('offsetY', 'Offset Y', 'Shape'),
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
    return this.config.shape === 'circle' ? 'circle' : 'rect';
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
    const key = `${shape}|${size.width}|${size.height}|${size.radius}|${offset.x}|${offset.y}`;
    if (this.debugLine && key === this.debugKey) {
      return;
    }

    this.removeDebugLine();
    this.debugKey = key;

    const points: number[] = [];
    if (shape === 'circle') {
      const segments = 32;
      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        points.push(offset.x + Math.cos(a) * size.radius, offset.y + Math.sin(a) * size.radius, 0);
      }
    } else {
      const hw = size.width / 2;
      const hh = size.height / 2;
      points.push(
        offset.x - hw, offset.y - hh, 0,
        offset.x + hw, offset.y - hh, 0,
        offset.x + hw, offset.y + hh, 0,
        offset.x - hw, offset.y + hh, 0
      );
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
    const material = new LineBasicMaterial({ color: 0x7df9ff, depthTest: false, transparent: true, opacity: 0.9 });
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
