import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
import type { NodeBase } from '../nodes/NodeBase';
import type { RevoluteJoint2DConfig, RevoluteJoint2DSource } from '../core/Physics2DService';

/**
 * RevoluteJoint2D (`core:RevoluteJoint2D`) — a hinge.
 *
 * Pins this node's body to a point, letting it rotate about it and nothing else.
 * With `connectedNode` empty the hinge is nailed to the world, which is the
 * pinball flipper case: a body on a fixed pivot, an angle range it may swing
 * through, and a motor strong enough to slam it against the upper limit when the
 * player presses the button.
 *
 * A flipper is then a script that flips `motorSpeed` between `+speed` and
 * `-speed`, which is exactly how the same machine is built in Box2D and Godot:
 *
 * ```ts
 * const hinge = this.node.getComponent(RevoluteJoint2DBehavior);
 * hinge.config.motorSpeed = this.input.getButton('flip') ? 20 : -20;
 * ```
 *
 * Config is read live every step, so an inspector edit during play applies
 * immediately and a script needs no handle API.
 *
 * Angles are **degrees** on the authored surface (the whole inspector is), and
 * radians inside the solver.
 */
export class RevoluteJoint2DBehavior extends Script implements RevoluteJoint2DSource {
  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      anchorX: 0,
      anchorY: 0,
      connectedNode: '',
      limitEnabled: false,
      lowerAngle: -45,
      upperAngle: 45,
      motorEnabled: false,
      motorSpeed: 0,
      maxMotorTorque: 100000,
      collideConnected: false,
    };
  }

  static getPropertySchema(): PropertySchema {
    const numberProp = (name: string, label: string, group: string, description: string) => ({
      name,
      type: 'number' as const,
      ui: { label, group, step: 1, description },
      getValue: (c: unknown) => (c as RevoluteJoint2DBehavior).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as RevoluteJoint2DBehavior).config[name] = Number(v);
      },
    });
    const boolProp = (name: string, label: string, group: string, description: string) => ({
      name,
      type: 'boolean' as const,
      ui: { label, group, description },
      getValue: (c: unknown) => (c as RevoluteJoint2DBehavior).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as RevoluteJoint2DBehavior).config[name] = Boolean(v);
      },
    });

    return {
      nodeType: 'RevoluteJoint2D',
      properties: [
        numberProp(
          'anchorX',
          'Anchor X',
          'Hinge',
          'Pivot point in this node’s local pixels. (0, 0) hinges on the node origin.'
        ),
        numberProp('anchorY', 'Anchor Y', 'Hinge', 'Pivot point in this node’s local pixels.'),
        {
          name: 'connectedNode',
          type: 'string',
          ui: {
            label: 'Connected Node',
            description:
              'Name, id or path of the body to hinge to. Empty pins the hinge to the world, which is what a flipper or a swinging door wants.',
            group: 'Hinge',
          },
          getValue: (c: unknown) => (c as RevoluteJoint2DBehavior).config.connectedNode ?? '',
          setValue: (c: unknown, v: unknown) => {
            (c as RevoluteJoint2DBehavior).config.connectedNode = String(v ?? '');
          },
        },
        boolProp('limitEnabled', 'Limit', 'Limits', 'Restrict the swing to an angle range.'),
        numberProp('lowerAngle', 'Lower Angle', 'Limits', 'Degrees, relative to the rest pose.'),
        numberProp('upperAngle', 'Upper Angle', 'Limits', 'Degrees, relative to the rest pose.'),
        boolProp('motorEnabled', 'Motor', 'Motor', 'Drive the hinge towards a target spin.'),
        numberProp(
          'motorSpeed',
          'Motor Speed',
          'Motor',
          'Target spin in degrees per second. Flip its sign to swing the other way.'
        ),
        numberProp(
          'maxMotorTorque',
          'Max Motor Torque',
          'Motor',
          'Torque ceiling. Too low and the motor cannot lift the arm; too high and it ignores everything it hits.'
        ),
        boolProp(
          'collideConnected',
          'Collide Connected',
          'Hinge',
          'Let the two hinged bodies collide. Off by default: they overlap at the pivot, and a contact there fights the joint.'
        ),
      ],
      groups: {
        Hinge: { label: 'Hinge', expanded: true },
        Limits: { label: 'Limits', expanded: true },
        Motor: { label: 'Motor', expanded: true },
      },
    };
  }

  // --- RevoluteJoint2DSource ---

  getJointAnchor(): { x: number; y: number } {
    return { x: Number(this.config.anchorX) || 0, y: Number(this.config.anchorY) || 0 };
  }

  getConnectedNode(): NodeBase | null {
    const query = String(this.config.connectedNode ?? '').trim();
    if (!query) {
      return null;
    }
    return this.findNode(query);
  }

  getJointConfig(): RevoluteJoint2DConfig {
    const toRadians = (value: unknown): number => ((Number(value) || 0) * Math.PI) / 180;
    return {
      limitEnabled: Boolean(this.config.limitEnabled),
      lowerAngle: toRadians(this.config.lowerAngle),
      upperAngle: toRadians(this.config.upperAngle),
      motorEnabled: Boolean(this.config.motorEnabled),
      motorSpeed: toRadians(this.config.motorSpeed),
      maxMotorTorque: Math.max(0, Number(this.config.maxMotorTorque) || 0),
      collideConnected: Boolean(this.config.collideConnected),
    };
  }

  // --- lifecycle ---

  onStart(): void {
    this.scene?.physics2d.registerJoint(this);
  }

  override onDetach(): void {
    this.scene?.physics2d.unregisterJoint(this);
    super.onDetach();
  }
}
