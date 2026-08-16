import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';

type SineAxis = 'x' | 'y' | 'z';

interface SineConfig {
  amplitude: number;
  frequency: number;
  axis: SineAxis;
}

/**
 * SineBehavior - Custom behavior script for oscillating a node.
 *
 * Demonstrates basic animation by modifying the node's position over time
 * according to a sine wave.
 */
export class SineBehavior extends Script {
  private elapsedTime = 0;
  private initialPositionX = 0;
  private initialPositionY = 0;
  private initialPositionZ = 0;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      amplitude: 1.0,
      frequency: 1.0,
      axis: 'y',
    } satisfies SineConfig;
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'SineBehavior',
      properties: [
        {
          name: 'amplitude',
          type: 'number',
          ui: {
            label: 'Amplitude',
            description: 'Maximum displacement from the center',
            group: 'Oscillation',
            min: 0,
            step: 0.1,
          },
          getValue: (component: unknown) => (component as SineBehavior).getAmplitude(),
          setValue: (component: unknown, value: unknown) => {
            const behavior = component as SineBehavior;
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed < 0) {
              return;
            }
            behavior.config.amplitude = parsed;
          },
        },
        {
          name: 'frequency',
          type: 'number',
          ui: {
            label: 'Frequency (Hz)',
            description: 'Oscillations per second',
            group: 'Oscillation',
            min: 0,
            step: 0.1,
          },
          getValue: (component: unknown) => (component as SineBehavior).getFrequency(),
          setValue: (component: unknown, value: unknown) => {
            const behavior = component as SineBehavior;
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed < 0) {
              return;
            }
            behavior.config.frequency = parsed;
          },
        },
        {
          name: 'axis',
          type: 'select',
          ui: {
            label: 'Axis',
            description: 'The axis to oscillate along',
            group: 'Oscillation',
            options: ['x', 'y', 'z'],
          },
          getValue: (component: unknown) => (component as SineBehavior).getAxis(),
          setValue: (component: unknown, value: unknown) => {
            const behavior = component as SineBehavior;
            if (value === 'x' || value === 'y' || value === 'z') {
              behavior.config.axis = value;
            }
          },
        },
      ],
      groups: {
        Oscillation: {
          label: 'Oscillation Settings',
          expanded: true,
        },
      },
    };
  }

  onStart(): void {
    if (this.node) {
      this.initialPositionX = this.node.position.x;
      this.initialPositionY = this.node.position.y;
      this.initialPositionZ = this.node.position.z;
    }
  }

  onUpdate(dt: number): void {
    if (!this.node) return;

    this.elapsedTime += dt;

    const offset =
      Math.sin(this.elapsedTime * this.getFrequency() * Math.PI * 2) * this.getAmplitude();

    this.node.position.set(this.initialPositionX, this.initialPositionY, this.initialPositionZ);

    const axis = this.getAxis();
    if (axis === 'x') {
      this.node.position.x += offset;
    } else if (axis === 'y') {
      this.node.position.y += offset;
    } else {
      this.node.position.z += offset;
    }
  }

  private getAmplitude(): number {
    const raw = this.config.amplitude;
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1.0;
  }

  private getFrequency(): number {
    const raw = this.config.frequency;
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1.0;
  }

  private getAxis(): SineAxis {
    const axis = this.config.axis;
    return axis === 'x' || axis === 'y' || axis === 'z' ? axis : 'y';
  }
}
