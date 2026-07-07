import { Vector3 } from 'three';
import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';

export interface PunchScaleOptions {
  /** Peak scale delta (0.3 = +30% at the first bounce). */
  amount?: number;
  /** Duration in seconds. */
  duration?: number;
  /** Number of oscillations before settling. */
  vibrato?: number;
}

/**
 * Squash-and-stretch "punch" on the node's scale — an instant pop that
 * oscillates back to the authored scale. Ticked through `node.tick`, so it
 * respects the global `Time.scale`. Reusable as the `core:PunchScale` preset
 * (trigger on a signal / play on start) or via `scene.juice.punchScale(node)`.
 *
 * The resting scale is captured on trigger (not construction), so it plays
 * correctly regardless of the node's authored scale and never drifts.
 */
export class PunchScaleBehavior extends Script {
  private active = false;
  private elapsed = 0;
  private readonly baseScale = new Vector3(1, 1, 1);

  private readonly onTriggerSignal = (): void => {
    this.trigger();
  };

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      amount: 0.3,
      duration: 0.35,
      vibrato: 3,
      triggerEvent: '',
      playOnStart: false,
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'PunchScaleBehavior',
      properties: [
        {
          name: 'amount',
          type: 'number',
          ui: {
            label: 'Amount',
            description: 'Peak scale delta (0.3 = +30%)',
            group: 'Punch Scale',
            min: 0,
            step: 0.05,
            precision: 2,
          },
          getValue: c => (c as PunchScaleBehavior).getAmount(),
          setValue: (c, v) => {
            (c as PunchScaleBehavior).config.amount = PunchScaleBehavior.num(v, 0.3, 0);
          },
        },
        {
          name: 'duration',
          type: 'number',
          ui: {
            label: 'Duration',
            group: 'Punch Scale',
            min: 0,
            step: 0.05,
            precision: 2,
            unit: 's',
          },
          getValue: c => (c as PunchScaleBehavior).getDuration(),
          setValue: (c, v) => {
            (c as PunchScaleBehavior).config.duration = PunchScaleBehavior.num(v, 0.35, 0);
          },
        },
        {
          name: 'vibrato',
          type: 'number',
          ui: {
            label: 'Vibrato',
            description: 'Oscillations before settling',
            group: 'Punch Scale',
            min: 0,
            step: 1,
          },
          getValue: c => (c as PunchScaleBehavior).getVibrato(),
          setValue: (c, v) => {
            (c as PunchScaleBehavior).config.vibrato = PunchScaleBehavior.num(v, 3, 0);
          },
        },
        {
          name: 'triggerEvent',
          type: 'string',
          ui: {
            label: 'Trigger Event',
            description: 'Node signal that triggers the punch (empty = manual/API only)',
            group: 'Punch Scale',
          },
          getValue: c => (c as PunchScaleBehavior).getTriggerEvent(),
          setValue: (c, v) => {
            (c as PunchScaleBehavior).setTriggerEvent(v);
          },
        },
        {
          name: 'playOnStart',
          type: 'boolean',
          ui: { label: 'Play On Start', group: 'Punch Scale' },
          getValue: c => !!(c as PunchScaleBehavior).config.playOnStart,
          setValue: (c, v) => {
            (c as PunchScaleBehavior).config.playOnStart = !!v;
          },
        },
      ],
      groups: { 'Punch Scale': { label: 'Punch Scale', expanded: true } },
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

  /** Configure (partial) and (re)start the punch. Used by the juice API. */
  play(options: PunchScaleOptions = {}): void {
    if (options.amount != null) this.config.amount = PunchScaleBehavior.num(options.amount, 0.3, 0);
    if (options.duration != null)
      this.config.duration = PunchScaleBehavior.num(options.duration, 0.35, 0);
    if (options.vibrato != null)
      this.config.vibrato = PunchScaleBehavior.num(options.vibrato, 3, 0);
    this.trigger();
  }

  /** (Re)start the punch from the beginning. */
  trigger(): void {
    if (!this.node) {
      return;
    }
    // Capture the resting scale only when idle so a re-trigger mid-punch does
    // not latch onto an already-scaled value.
    if (!this.active) {
      this.baseScale.copy(this.node.scale);
    }
    this.elapsed = 0;
    this.active = true;
  }

  onUpdate(dt: number): void {
    if (!this.active || !this.node) {
      return;
    }

    this.elapsed += dt;
    const duration = this.getDuration();
    if (duration <= 0 || this.elapsed >= duration) {
      this.node.scale.copy(this.baseScale);
      this.active = false;
      return;
    }

    const progress = this.elapsed / duration;
    // Instant pop at t=0 that decays (1-t)^2 while oscillating `vibrato` times.
    const envelope = Math.pow(1 - progress, 2);
    const wave = Math.cos(progress * this.getVibrato() * Math.PI * 2);
    const factor = 1 + this.getAmount() * envelope * wave;
    this.node.scale.set(
      this.baseScale.x * factor,
      this.baseScale.y * factor,
      this.baseScale.z * factor
    );
  }

  private restore(): void {
    if (this.node && this.active) {
      this.node.scale.copy(this.baseScale);
    }
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

  private getAmount(): number {
    return PunchScaleBehavior.num(this.config.amount, 0.3, 0);
  }

  private getDuration(): number {
    return PunchScaleBehavior.num(this.config.duration, 0.35, 0);
  }

  private getVibrato(): number {
    return PunchScaleBehavior.num(this.config.vibrato, 3, 0);
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
