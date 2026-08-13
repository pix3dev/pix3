import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
import { SFX_PRESETS, clampSfxPitch, isSfxPreset, type SfxPreset } from '../core/SfxSynth';

/**
 * SfxOnSignal — plays a procedural {@link SfxPreset} on the `sfx` bus whenever a
 * signal fires on this node. The asset-free counterpart of `core:PlaySound`: no
 * audio file, no import, no loading — pick the preset that matches the beat
 * (`bounce` on a wall hit, `score` on a bumper, `lose` on a drain).
 *
 * Silent no-op when Web Audio is unavailable (headless runs, tests).
 */
export class SfxOnSignalBehavior extends Script {
  private boundSignal: string | null = null;

  private readonly onSignal = (): void => {
    this.scene?.audio.sfx(this.getPreset(), {
      volume: this.getVolume(),
      pitch: this.getPitch(),
    });
  };

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      signal: 'pointerdown',
      preset: 'tap',
      volume: 1,
      pitch: 1,
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'SfxOnSignalBehavior',
      properties: [
        {
          name: 'signal',
          type: 'string',
          ui: {
            label: 'Signal',
            description: 'Node signal that plays the sound (pointerdown, hit, damaged, …)',
            group: 'Procedural SFX',
          },
          getValue: c => (c as SfxOnSignalBehavior).getSignal(),
          setValue: (c, v) => {
            (c as SfxOnSignalBehavior).setSignal(v);
          },
        },
        {
          name: 'preset',
          type: 'enum',
          ui: {
            label: 'Preset',
            description: 'Built-in synth patch played on the sfx bus',
            group: 'Procedural SFX',
            options: [...SFX_PRESETS],
          },
          getValue: c => (c as SfxOnSignalBehavior).getPreset(),
          setValue: (c, v) => {
            (c as SfxOnSignalBehavior).config.preset = isSfxPreset(v) ? v : 'tap';
          },
        },
        {
          name: 'volume',
          type: 'number',
          ui: {
            label: 'Volume',
            group: 'Procedural SFX',
            min: 0,
            max: 1,
            step: 0.01,
            precision: 2,
          },
          getValue: c => (c as SfxOnSignalBehavior).getVolume(),
          setValue: (c, v) => {
            (c as SfxOnSignalBehavior).config.volume = SfxOnSignalBehavior.clamp01(v);
          },
        },
        {
          name: 'pitch',
          type: 'number',
          ui: {
            label: 'Pitch',
            description: 'Frequency multiplier: 2 = an octave up, 0.5 = an octave down',
            group: 'Procedural SFX',
            min: 0.25,
            max: 4,
            step: 0.05,
            precision: 2,
          },
          getValue: c => (c as SfxOnSignalBehavior).getPitch(),
          setValue: (c, v) => {
            (c as SfxOnSignalBehavior).config.pitch = clampSfxPitch(v);
          },
        },
      ],
      groups: {
        'Procedural SFX': {
          label: 'Procedural SFX',
          description: 'Synthesized one-shot played when the signal fires',
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
      return 'pointerdown';
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : 'pointerdown';
  }

  private setSignal(value: unknown): void {
    const wasBound = Boolean(this.node);
    if (wasBound) {
      this.unbind();
    }
    this.config.signal =
      typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'pointerdown';
    if (wasBound) {
      this.bind();
    }
  }

  private getPreset(): SfxPreset {
    return isSfxPreset(this.config.preset) ? this.config.preset : 'tap';
  }

  private getVolume(): number {
    return SfxOnSignalBehavior.clamp01(this.config.volume);
  }

  private getPitch(): number {
    return clampSfxPitch(this.config.pitch);
  }

  private static clamp01(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      return 1;
    }
    return Math.min(1, Math.max(0, parsed));
  }
}
