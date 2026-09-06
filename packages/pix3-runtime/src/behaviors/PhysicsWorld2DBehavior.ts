import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';

/**
 * PhysicsWorld2D (`core:PhysicsWorld2D`) — designer-facing gravity, attached to
 * the scene root.
 *
 * `scene.physics2d.setGravity(...)` covers the scripting case; this covers the
 * case with no script at all, which is the whole point of an engine-level
 * physics system. It writes on start and on every update so an inspector edit
 * during play takes effect immediately (~40 lines, and it strips out of exports
 * that never mention it).
 *
 * Units are design pixels per second squared with **y up**, so earth-ish gravity
 * is a negative y — the default, 1960, is the value a 100 px sprite reads as
 * "roughly a metre-tall object falling" at Pix3's usual scale.
 */
export class PhysicsWorld2DBehavior extends Script {
  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      gravityX: 0,
      gravityY: -1960,
    };
  }

  static getPropertySchema(): PropertySchema {
    const numberProp = (name: string, label: string, description: string) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Gravity', step: 10, description },
      getValue: (c: unknown) => (c as PhysicsWorld2DBehavior).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as PhysicsWorld2DBehavior).config[name] = Number(v);
      },
    });

    return {
      nodeType: 'PhysicsWorld2D',
      properties: [
        numberProp('gravityX', 'Gravity X', 'Sideways gravity in px/s^2. 0 for most games.'),
        numberProp(
          'gravityY',
          'Gravity Y',
          'Vertical gravity in px/s^2. Y is up, so falling is NEGATIVE.'
        ),
      ],
      groups: {
        Gravity: { label: 'Gravity', expanded: true },
      },
    };
  }

  onStart(): void {
    this.applyGravity();
  }

  onUpdate(): void {
    this.applyGravity();
  }

  private applyGravity(): void {
    this.scene?.physics2d.setGravity(
      Number(this.config.gravityX) || 0,
      Number(this.config.gravityY) || 0
    );
  }
}
