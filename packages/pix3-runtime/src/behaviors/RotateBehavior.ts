/**
 * RotateBehavior - A simple component for testing the script system
 *
 * Rotates a node continuously based on a configurable speed parameter.
 */

import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
import { Node3D } from '../nodes/Node3D';

export class RotateBehavior extends Script {
  private rotationSpeed = 1.0; // radians per second

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      rotationSpeed: this.rotationSpeed,
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'RotateBehavior',
      properties: [
        {
          name: 'rotationSpeed',
          type: 'number',
          ui: {
            label: 'Rotation Speed',
            description: 'Speed of rotation in radians per second',
            group: 'Component',
            min: 0,
            max: 10,
            step: 0.1,
          },
          getValue: (component: unknown) => (component as RotateBehavior).getRotationSpeed(),
          setValue: (component: unknown, value: unknown) => {
            const behavior = component as RotateBehavior;
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed < 0) {
              return;
            }
            behavior.setRotationSpeed(parsed);
          },
        },
      ],
      groups: {
        Component: {
          label: 'Component Parameters',
          description: 'Configuration for rotation component',
          expanded: true,
        },
      },
    };
  }

  onAttach(): void {
    this.setRotationSpeed(this.getRotationSpeed());
  }

  onUpdate(dt: number): void {
    if (!this.node || !(this.node instanceof Node3D)) {
      return;
    }

    this.node.rotation.y += this.rotationSpeed * dt;
  }

  private getRotationSpeed(): number {
    const raw = this.config.rotationSpeed;
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1.0;
  }

  private setRotationSpeed(value: number): void {
    this.rotationSpeed = value;
    this.config.rotationSpeed = value;
  }
}
