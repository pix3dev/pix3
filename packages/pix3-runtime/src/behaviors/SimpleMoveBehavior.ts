/**
 * SimpleMoveBehavior - Joystick-driven movement behavior.
 */

import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';

type MovementPlane = 'xz' | 'xy';

interface SimpleMoveConfig {
  speed: number;
  axisHorizontal: string;
  axisVertical: string;
  movementPlane: MovementPlane;
  invertVertical: boolean;
}

export class SimpleMoveBehavior extends Script {
  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      speed: 5,
      axisHorizontal: 'Horizontal',
      axisVertical: 'Vertical',
      movementPlane: 'xz',
      invertVertical: true,
    } satisfies SimpleMoveConfig;
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'SimpleMoveBehavior',
      properties: [
        {
          name: 'speed',
          type: 'number',
          ui: {
            label: 'Speed',
            description: 'Movement speed units per second',
            group: 'Movement',
            min: 0,
            max: 50,
            step: 0.1,
          },
          getValue: (script: unknown) => (script as SimpleMoveBehavior).getSpeed(),
          setValue: (script: unknown, value: unknown) => {
            const behavior = script as SimpleMoveBehavior;
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed < 0) {
              return;
            }
            behavior.config.speed = parsed;
          },
        },
        {
          name: 'axisHorizontal',
          type: 'string',
          ui: {
            label: 'Horizontal Axis',
            description: 'Input axis name for horizontal movement',
            group: 'Input',
          },
          getValue: (script: unknown) => (script as SimpleMoveBehavior).getHorizontalAxis(),
          setValue: (script: unknown, value: unknown) => {
            if (typeof value !== 'string' || value.trim().length === 0) {
              return;
            }
            (script as SimpleMoveBehavior).config.axisHorizontal = value;
          },
        },
        {
          name: 'axisVertical',
          type: 'string',
          ui: {
            label: 'Vertical Axis',
            description: 'Input axis name for vertical movement',
            group: 'Input',
          },
          getValue: (script: unknown) => (script as SimpleMoveBehavior).getVerticalAxis(),
          setValue: (script: unknown, value: unknown) => {
            if (typeof value !== 'string' || value.trim().length === 0) {
              return;
            }
            (script as SimpleMoveBehavior).config.axisVertical = value;
          },
        },
        {
          name: 'movementPlane',
          type: 'select',
          ui: {
            label: 'Movement Plane',
            description: 'Select whether vertical input moves on XY or XZ plane',
            group: 'Movement',
            options: ['xz', 'xy'],
          },
          getValue: (script: unknown) => (script as SimpleMoveBehavior).getMovementPlane(),
          setValue: (script: unknown, value: unknown) => {
            if (value === 'xz' || value === 'xy') {
              (script as SimpleMoveBehavior).config.movementPlane = value;
            }
          },
        },
        {
          name: 'invertVertical',
          type: 'boolean',
          ui: {
            label: 'Invert Vertical',
            description: 'Invert sign for vertical input axis',
            group: 'Movement',
          },
          getValue: (script: unknown) => (script as SimpleMoveBehavior).isVerticalInverted(),
          setValue: (script: unknown, value: unknown) => {
            if (typeof value === 'boolean') {
              (script as SimpleMoveBehavior).config.invertVertical = value;
            }
          },
        },
      ],
      groups: {
        Movement: {
          label: 'Movement',
          description: 'Movement settings',
          expanded: true,
        },
        Input: {
          label: 'Input',
          description: 'Input axis mapping',
          expanded: true,
        },
      },
    };
  }

  onUpdate(dt: number): void {
    if (!this.input || !this.node) return;

    const horizontal = this.input.getAxis(this.getHorizontalAxis());
    const vertical = this.input.getAxis(this.getVerticalAxis());

    if (horizontal === 0 && vertical === 0) {
      return;
    }

    const signedVertical = this.isVerticalInverted() ? -vertical : vertical;
    const deltaHorizontal = horizontal * this.getSpeed() * dt;
    const deltaVertical = signedVertical * this.getSpeed() * dt;

    this.node.position.x += deltaHorizontal;

    if (this.getMovementPlane() === 'xy') {
      this.node.position.y += deltaVertical;
    } else {
      this.node.position.z += deltaVertical;
    }
  }

  private getSpeed(): number {
    const raw = this.config.speed;
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5;
  }

  private getHorizontalAxis(): string {
    const raw = this.config.axisHorizontal;
    return typeof raw === 'string' && raw.length > 0 ? raw : 'Horizontal';
  }

  private getVerticalAxis(): string {
    const raw = this.config.axisVertical;
    return typeof raw === 'string' && raw.length > 0 ? raw : 'Vertical';
  }

  private getMovementPlane(): MovementPlane {
    const raw = this.config.movementPlane;
    return raw === 'xy' || raw === 'xz' ? raw : 'xz';
  }

  private isVerticalInverted(): boolean {
    const raw = this.config.invertVertical;
    return typeof raw === 'boolean' ? raw : true;
  }
}
