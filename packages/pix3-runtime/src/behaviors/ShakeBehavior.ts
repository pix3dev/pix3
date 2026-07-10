import { Vector3 } from 'three';
import { Script } from '../core/ScriptComponent';
import { Node3D } from '../nodes/Node3D';
import type { PropertySchema } from '../fw/property-schema';

export interface ShakeOptions {
  /** Peak positional displacement, in the node's local units. */
  amplitude?: number;
  /** Oscillation speed (higher = faster jitter). */
  frequency?: number;
  /** Duration in seconds. `0` shakes until stopped. */
  duration?: number;
  /** Falloff power applied to `(1 - progress)`; `0` = no decay, `1` = linear. */
  decay?: number;
}

/**
 * Smooth-noise positional shake, additive over whatever else drives the node's
 * position (e.g. a FollowBehavior). Because it is ticked through `node.tick`, it
 * automatically respects the global `Time.scale` — a hitstop freezes the shake,
 * slow-mo stretches it. Reusable two ways (P0.3):
 *
 *  - **Preset** (`core:Shake`): attach in the inspector, drive on a node signal
 *    via `triggerEvent`, or auto-start with `playOnStart`.
 *  - **Script API**: `scene.juice.shake(node, { amplitude, frequency, ... })`.
 *
 * The offset is removed and re-applied each frame (never accumulated), so it
 * composes with other position writers and always restores cleanly on stop.
 * When shaking a followed camera, attach this after the follower for the least
 * smoothing coupling.
 */
export class ShakeBehavior extends Script {
  private active = false;
  private elapsed = 0;
  private readonly appliedOffset = new Vector3();

  private readonly onTriggerSignal = (): void => {
    this.trigger();
  };

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      amplitude: 8,
      frequency: 24,
      duration: 0.35,
      decay: 1.5,
      triggerEvent: '',
      playOnStart: false,
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'ShakeBehavior',
      properties: [
        {
          name: 'amplitude',
          type: 'number',
          ui: { label: 'Amplitude', group: 'Shake', min: 0, step: 0.5 },
          getValue: c => (c as ShakeBehavior).getAmplitude(),
          setValue: (c, v) => {
            (c as ShakeBehavior).config.amplitude = ShakeBehavior.num(v, 8, 0);
          },
        },
        {
          name: 'frequency',
          type: 'number',
          ui: { label: 'Frequency', group: 'Shake', min: 0, step: 1 },
          getValue: c => (c as ShakeBehavior).getFrequency(),
          setValue: (c, v) => {
            (c as ShakeBehavior).config.frequency = ShakeBehavior.num(v, 24, 0);
          },
        },
        {
          name: 'duration',
          type: 'number',
          ui: { label: 'Duration', group: 'Shake', min: 0, step: 0.05, precision: 2, unit: 's' },
          getValue: c => (c as ShakeBehavior).getDuration(),
          setValue: (c, v) => {
            (c as ShakeBehavior).config.duration = ShakeBehavior.num(v, 0.35, 0);
          },
        },
        {
          name: 'decay',
          type: 'number',
          ui: {
            label: 'Decay',
            description: 'Falloff power (0 = steady, 1 = linear, >1 = punchy tail)',
            group: 'Shake',
            min: 0,
            step: 0.1,
            precision: 2,
          },
          getValue: c => (c as ShakeBehavior).getDecay(),
          setValue: (c, v) => {
            (c as ShakeBehavior).config.decay = ShakeBehavior.num(v, 1.5, 0);
          },
        },
        {
          name: 'triggerEvent',
          type: 'string',
          ui: {
            label: 'Trigger Event',
            description: 'Node signal that starts the shake (empty = manual/API only)',
            group: 'Shake',
          },
          getValue: c => (c as ShakeBehavior).getTriggerEvent(),
          setValue: (c, v) => {
            (c as ShakeBehavior).setTriggerEvent(v);
          },
        },
        {
          name: 'playOnStart',
          type: 'boolean',
          ui: { label: 'Play On Start', group: 'Shake' },
          getValue: c => !!(c as ShakeBehavior).config.playOnStart,
          setValue: (c, v) => {
            (c as ShakeBehavior).config.playOnStart = !!v;
          },
        },
      ],
      groups: { Shake: { label: 'Shake', expanded: true } },
    };
  }

  onStart(): void {
    this.bindTrigger();
    if (this.config.playOnStart) {
      this.trigger();
    }
  }

  override onDetach(): void {
    this.unbindTrigger();
    this.restore();
    this.active = false;
    super.onDetach();
  }

  /** Configure (partial) and (re)start the shake. Used by the juice API. */
  play(options: ShakeOptions = {}): void {
    if (options.amplitude != null)
      this.config.amplitude = ShakeBehavior.num(options.amplitude, 8, 0);
    if (options.frequency != null)
      this.config.frequency = ShakeBehavior.num(options.frequency, 24, 0);
    if (options.duration != null)
      this.config.duration = ShakeBehavior.num(options.duration, 0.35, 0);
    if (options.decay != null) this.config.decay = ShakeBehavior.num(options.decay, 1.5, 0);
    this.trigger();
  }

  /** (Re)start the shake from the beginning. */
  trigger(): void {
    this.elapsed = 0;
    this.active = true;
  }

  /** Stop shaking and restore the node's position. */
  stop(): void {
    this.active = false;
    this.restore();
  }

  onUpdate(dt: number): void {
    if (!this.node) {
      return;
    }

    // Remove last frame's offset so we read/leave the node's "clean" position.
    this.restore();

    if (!this.active) {
      return;
    }

    this.elapsed += dt;
    const duration = this.getDuration();
    if (duration > 0 && this.elapsed >= duration) {
      this.active = false;
      return;
    }

    const progress = duration > 0 ? this.elapsed / duration : 0;
    const damp = Math.pow(Math.max(0, 1 - progress), this.getDecay());
    const amp = this.getAmplitude() * damp;
    const phase = this.elapsed * this.getFrequency();
    const is3D = this.node instanceof Node3D;

    this.appliedOffset.set(
      shakeNoise(phase, 0) * amp,
      shakeNoise(phase, 100) * amp,
      is3D ? shakeNoise(phase, 200) * amp * 0.5 : 0
    );
    this.node.position.add(this.appliedOffset);
  }

  private restore(): void {
    if (this.node && (this.appliedOffset.x || this.appliedOffset.y || this.appliedOffset.z)) {
      this.node.position.sub(this.appliedOffset);
    }
    this.appliedOffset.set(0, 0, 0);
  }

  private bindTrigger(): void {
    const trigger = this.getTriggerEvent();
    if (this.node && trigger) {
      this.node.connect(trigger, this, this.onTriggerSignal);
    }
  }

  private unbindTrigger(): void {
    const trigger = this.getTriggerEvent();
    if (this.node && trigger) {
      this.node.disconnect(trigger, this, this.onTriggerSignal);
    }
  }

  private getAmplitude(): number {
    return ShakeBehavior.num(this.config.amplitude, 8, 0);
  }

  private getFrequency(): number {
    return ShakeBehavior.num(this.config.frequency, 24, 0);
  }

  private getDuration(): number {
    return ShakeBehavior.num(this.config.duration, 0.35, 0);
  }

  private getDecay(): number {
    return ShakeBehavior.num(this.config.decay, 1.5, 0);
  }

  private getTriggerEvent(): string {
    return typeof this.config.triggerEvent === 'string' ? this.config.triggerEvent.trim() : '';
  }

  private setTriggerEvent(value: unknown): void {
    const wasBound = Boolean(this.node);
    if (wasBound) {
      this.unbindTrigger();
    }
    this.config.triggerEvent = typeof value === 'string' ? value.trim() : '';
    if (wasBound) {
      this.bindTrigger();
    }
  }

  private static num(value: unknown, fallback: number, min: number): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(min, parsed);
  }
}

/**
 * Smooth pseudo-random value in ~[-1, 1] from a sum of incommensurate sines.
 * Deterministic (no Math.random), continuous over time, and decorrelated per
 * axis via the `seed` offset — so shakes look organic and replay identically.
 * Exported so other shake-driven nodes (e.g. {@link ../nodes/2D/Camera2D})
 * reuse the exact same deterministic noise.
 */
export function shakeNoise(t: number, seed: number): number {
  return (
    Math.sin(t * 1.373 + seed * 12.9898) * 0.5 +
    Math.sin(t * 2.917 + seed * 7.233) * 0.3 +
    Math.sin(t * 5.109 + seed * 19.19) * 0.2
  );
}
