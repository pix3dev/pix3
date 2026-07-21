import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';

/**
 * FreeOnSignal — frees the host node (`queueFree`) once a given signal fires on
 * it, after an optional delay. The generic lifecycle half that pairs with any
 * "finished" signal: `animation-finished` from AnimatedSprite2D/3D (one-shot
 * VFX), a fade/sound completion, a gameplay `damaged`/`died` event, etc.
 *
 * Defaults are the one-shot-VFX case (fire on `animation-finished`, free
 * immediately), so a self-destroying flipbook prefab is zero-config:
 *   type: AnimatedSprite2D (loop:false)  +  core:FreeOnSignal
 *
 * Inert in edit mode by construction — it only acts on a play-driven signal and
 * a running `onUpdate`, so nodes never disappear while authoring.
 */
export class FreeOnSignalBehavior extends Script {
  private armed = false;
  private remaining = 0;
  private boundSignal: string | null = null;

  private readonly onSignal = (): void => {
    if (this.armed) {
      return;
    }
    this.armed = true;
    this.remaining = this.getDelay();
  };

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      signal: 'animation-finished',
      delay: 0,
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'FreeOnSignalBehavior',
      properties: [
        {
          name: 'signal',
          type: 'string',
          ui: {
            label: 'Signal',
            description: 'Node signal that triggers the free (e.g. animation-finished)',
            group: 'Lifecycle',
          },
          getValue: component => (component as FreeOnSignalBehavior).getSignal(),
          setValue: (component, value) => {
            (component as FreeOnSignalBehavior).setSignal(value);
          },
        },
        {
          name: 'delay',
          type: 'number',
          ui: {
            label: 'Delay',
            description: 'Seconds to wait after the signal before freeing',
            group: 'Lifecycle',
            min: 0,
            step: 0.01,
            precision: 2,
            unit: 's',
          },
          getValue: component => (component as FreeOnSignalBehavior).getDelay(),
          setValue: (component, value) => {
            (component as FreeOnSignalBehavior).setDelay(value);
          },
        },
      ],
      groups: {
        Lifecycle: {
          label: 'Lifecycle',
          description: 'Free this node when a signal fires',
          expanded: true,
        },
      },
    };
  }

  onStart(): void {
    this.bind();
  }

  onUpdate(dt: number): void {
    if (!this.armed || !this.node) {
      return;
    }
    this.remaining -= dt;
    if (this.remaining <= 0) {
      this.armed = false;
      this.node.queueFree();
    }
  }

  override onDetach(): void {
    this.unbind();
    this.armed = false;
    super.onDetach();
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
      return 'animation-finished';
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : 'animation-finished';
  }

  private setSignal(value: unknown): void {
    const wasBound = Boolean(this.node);
    if (wasBound) {
      this.unbind();
    }
    this.config.signal =
      typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'animation-finished';
    if (wasBound) {
      this.bind();
    }
  }

  private getDelay(): number {
    const parsed = typeof this.config.delay === 'number' ? this.config.delay : Number(this.config.delay);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }

  private setDelay(value: unknown): void {
    const parsed = typeof value === 'number' ? value : Number(value);
    this.config.delay = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }
}
