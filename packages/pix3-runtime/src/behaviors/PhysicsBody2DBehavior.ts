import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
import type { PhysicsBody2DSource, PhysicsBody2DType } from '../core/Physics2DService';

/**
 * PhysicsBody2D (`core:PhysicsBody2D`) — makes a node a rigid body in
 * `scene.physics2d`.
 *
 * Unity's arrangement rather than Godot's: the body is a *component* on the
 * sprite, and shape lives on sibling/descendant `core:Collider2D` components, so
 * a compound body (a flipper with two colliders) needs no new node types. A
 * collider with no body on its node or any ancestor is static world geometry —
 * the designer's "wall" case, one component and no script.
 *
 * Units are design pixels with y up, so gravity is negative-y and an impulse of
 * `(0, 600)` throws a 1-mass body upwards at 600 px/s.
 */
export class PhysicsBody2DBehavior extends Script implements PhysicsBody2DSource {
  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      bodyType: 'dynamic',
      gravityScale: 1,
      mass: 0,
      linearDamping: 0,
      angularDamping: 0.05,
      fixedRotation: false,
      bullet: false,
      canSleep: true,
      emitContacts: false,
    };
  }

  static getPropertySchema(): PropertySchema {
    const numberProp = (
      name: string,
      label: string,
      group: string,
      description: string,
      step = 0.05
    ) => ({
      name,
      type: 'number' as const,
      ui: { label, group, step, description },
      getValue: (c: unknown) => (c as PhysicsBody2DBehavior).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as PhysicsBody2DBehavior).config[name] = Number(v);
      },
    });
    const boolProp = (name: string, label: string, group: string, description: string) => ({
      name,
      type: 'boolean' as const,
      ui: { label, group, description },
      getValue: (c: unknown) => (c as PhysicsBody2DBehavior).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as PhysicsBody2DBehavior).config[name] = Boolean(v);
      },
    });

    return {
      nodeType: 'PhysicsBody2D',
      properties: [
        {
          name: 'bodyType',
          type: 'select',
          ui: {
            label: 'Body Type',
            description:
              'static: never moves. kinematic: moved by scripts/animation, pushes others, is not pushed. dynamic: simulated.',
            group: 'Body',
            options: ['static', 'kinematic', 'dynamic'],
          },
          getValue: (c: unknown) => (c as PhysicsBody2DBehavior).config.bodyType,
          setValue: (c: unknown, v: unknown) => {
            (c as PhysicsBody2DBehavior).config.bodyType =
              v === 'static' ? 'static' : v === 'kinematic' ? 'kinematic' : 'dynamic';
          },
        },
        numberProp(
          'gravityScale',
          'Gravity Scale',
          'Body',
          'Multiplier on world gravity. 0 makes the body float; negative makes it rise.'
        ),
        numberProp(
          'mass',
          'Mass',
          'Body',
          'Explicit mass. 0 derives it from the collider area times its density.',
          0.1
        ),
        numberProp('linearDamping', 'Linear Damping', 'Damping', 'Per-second velocity decay.'),
        numberProp('angularDamping', 'Angular Damping', 'Damping', 'Per-second spin decay.'),
        boolProp(
          'fixedRotation',
          'Fixed Rotation',
          'Body',
          'Lock the rotation — the usual choice for a character or a UI prop.'
        ),
        boolProp(
          'bullet',
          'Bullet (CCD)',
          'Body',
          'Sweep this body against static geometry so a fast circle cannot tunnel through a wall.'
        ),
        boolProp(
          'canSleep',
          'Can Sleep',
          'Body',
          'Let the body stop simulating once it has been at rest for half a second.'
        ),
        boolProp(
          'emitContacts',
          'Emit Contacts',
          'Signals',
          'Fire contact-started / contact-ended on this node. Off by default: most games never read them.'
        ),
      ],
      groups: {
        Body: { label: 'Body', expanded: true },
        Damping: { label: 'Damping', expanded: false },
        Signals: { label: 'Signals', expanded: false },
      },
    };
  }

  // --- PhysicsBody2DSource ---

  getBodyType(): PhysicsBody2DType {
    const value = this.config.bodyType;
    return value === 'static' ? 'static' : value === 'kinematic' ? 'kinematic' : 'dynamic';
  }

  getBodyConfig(): {
    gravityScale: number;
    mass: number;
    linearDamping: number;
    angularDamping: number;
    fixedRotation: boolean;
    bullet: boolean;
    canSleep: boolean;
    emitContacts: boolean;
  } {
    return {
      gravityScale: finite(this.config.gravityScale, 1),
      mass: Math.max(0, finite(this.config.mass, 0)),
      linearDamping: Math.max(0, finite(this.config.linearDamping, 0)),
      angularDamping: Math.max(0, finite(this.config.angularDamping, 0)),
      fixedRotation: Boolean(this.config.fixedRotation),
      bullet: Boolean(this.config.bullet),
      canSleep: this.config.canSleep !== false,
      emitContacts: Boolean(this.config.emitContacts),
    };
  }

  // --- lifecycle ---

  onStart(): void {
    this.scene?.physics2d.registerBody(this);
  }

  override onDetach(): void {
    this.scene?.physics2d.unregisterBody(this);
    super.onDetach();
  }
}

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
