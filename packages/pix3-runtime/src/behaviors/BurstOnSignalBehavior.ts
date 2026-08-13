import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
import type { BurstOptions } from '../core/juice-transients';

/**
 * BurstOnSignal — fires a `scene.juice.burst()` at this node's position whenever a
 * signal fires on it. The inspector-attachable half of the particle burst, so a
 * designer gets hit sparks without a script: drop it on the bumper, point it at
 * the signal the gameplay already emits (`hit`, `damaged`, `pointerdown`, an
 * animation event track), tune the colour.
 *
 * Inert while authoring: it only reacts to a play-driven signal, and the burst it
 * spawns is a runtime-only node (never serialized).
 */
export class BurstOnSignalBehavior extends Script {
  private boundSignal: string | null = null;

  private readonly onSignal = (): void => {
    const node = this.node;
    const scene = this.scene;
    if (!node || !scene) {
      return;
    }
    scene.juice.burst(node, this.buildOptions());
  };

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      signal: 'hit',
      count: 14,
      color: '',
      speed: 260,
      sizePx: 10,
      lifeSec: 0.5,
      gravityY: -600,
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'BurstOnSignalBehavior',
      properties: [
        {
          name: 'signal',
          type: 'string',
          ui: {
            label: 'Signal',
            description: 'Node signal that fires the burst (e.g. hit, damaged, pointerdown)',
            group: 'Burst',
          },
          getValue: c => (c as BurstOnSignalBehavior).getSignal(),
          setValue: (c, v) => {
            (c as BurstOnSignalBehavior).setSignal(v);
          },
        },
        {
          name: 'count',
          type: 'number',
          ui: {
            label: 'Count',
            description: 'Particles per burst',
            group: 'Burst',
            min: 1,
            max: 512,
            step: 1,
            precision: 0,
          },
          getValue: c => (c as BurstOnSignalBehavior).getNumber('count', 14),
          setValue: (c, v) => {
            (c as BurstOnSignalBehavior).config.count = BurstOnSignalBehavior.num(v, 14);
          },
        },
        {
          name: 'color',
          type: 'color',
          ui: {
            label: 'Color',
            description: 'Particle colour; empty = white',
            group: 'Burst',
          },
          getValue: c => (c as BurstOnSignalBehavior).getColor(),
          setValue: (c, v) => {
            (c as BurstOnSignalBehavior).config.color = typeof v === 'string' ? v.trim() : '';
          },
        },
        {
          name: 'speed',
          type: 'number',
          ui: {
            label: 'Speed',
            description: 'Initial particle speed',
            group: 'Burst',
            min: 0,
            step: 10,
            precision: 0,
            unit: 'px/s',
          },
          getValue: c => (c as BurstOnSignalBehavior).getNumber('speed', 260),
          setValue: (c, v) => {
            (c as BurstOnSignalBehavior).config.speed = BurstOnSignalBehavior.num(v, 260);
          },
        },
        {
          name: 'sizePx',
          type: 'number',
          ui: {
            label: 'Size',
            group: 'Burst',
            min: 0.5,
            step: 1,
            precision: 1,
            unit: 'px',
          },
          getValue: c => (c as BurstOnSignalBehavior).getNumber('sizePx', 10),
          setValue: (c, v) => {
            (c as BurstOnSignalBehavior).config.sizePx = BurstOnSignalBehavior.num(v, 10);
          },
        },
        {
          name: 'lifeSec',
          type: 'number',
          ui: {
            label: 'Life',
            group: 'Burst',
            min: 0.05,
            step: 0.05,
            precision: 2,
            unit: 's',
          },
          getValue: c => (c as BurstOnSignalBehavior).getNumber('lifeSec', 0.5),
          setValue: (c, v) => {
            (c as BurstOnSignalBehavior).config.lifeSec = BurstOnSignalBehavior.num(v, 0.5);
          },
        },
        {
          name: 'gravityY',
          type: 'number',
          ui: {
            label: 'Gravity Y',
            description: 'Vertical acceleration; negative falls, 0 = weightless',
            group: 'Burst',
            step: 50,
            precision: 0,
            unit: 'px/s²',
          },
          getValue: c => (c as BurstOnSignalBehavior).getNumber('gravityY', -600),
          setValue: (c, v) => {
            (c as BurstOnSignalBehavior).config.gravityY = BurstOnSignalBehavior.num(v, -600);
          },
        },
      ],
      groups: {
        Burst: {
          label: 'Particle Burst',
          description: 'One-shot particles spawned when the signal fires',
          expanded: true,
        },
      },
    };
  }

  onStart(): void {
    this.bind();
  }

  override onDetach(): void {
    this.unbind();
    super.onDetach();
  }

  /** The burst options this component would pass to the juice API. */
  buildOptions(): BurstOptions {
    const color = this.getColor();
    return {
      count: this.getNumber('count', 14),
      speed: this.getNumber('speed', 260),
      sizePx: this.getNumber('sizePx', 10),
      lifeSec: this.getNumber('lifeSec', 0.5),
      gravityY: this.getNumber('gravityY', -600),
      ...(color ? { color } : {}),
    };
  }

  private bind(): void {
    if (!this.node) {
      return;
    }
    this.boundSignal = this.getSignal();
    this.node.connect(this.boundSignal, this, this.onSignal);
  }

  private unbind(): void {
    if (!this.node || !this.boundSignal) {
      return;
    }
    this.node.disconnect(this.boundSignal, this, this.onSignal);
    this.boundSignal = null;
  }

  private getSignal(): string {
    const value = this.config.signal;
    if (typeof value !== 'string') {
      return 'hit';
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : 'hit';
  }

  private setSignal(value: unknown): void {
    const wasBound = Boolean(this.node);
    if (wasBound) {
      this.unbind();
    }
    this.config.signal =
      typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'hit';
    if (wasBound) {
      this.bind();
    }
  }

  private getColor(): string {
    return typeof this.config.color === 'string' ? this.config.color.trim() : '';
  }

  private getNumber(key: string, fallback: number): number {
    return BurstOnSignalBehavior.num(this.config[key], fallback);
  }

  private static num(value: unknown, fallback: number): number {
    // `Number(null)` and `Number('')` are 0, which would silently turn a missing
    // config value into a zero speed / zero gravity rather than the default.
    if (value === null || value === undefined || value === '') {
      return fallback;
    }
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}
