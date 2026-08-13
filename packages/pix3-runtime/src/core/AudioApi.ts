import type { SceneService } from './SceneService';
import type { AudioBusName, AudioPlayback, AudioSnapshot, PlayAudioOptions } from './AudioService';
import { SfxSynth, clampSfxPitch, isSfxPreset, type SfxOptions, type SfxPreset } from './SfxSynth';

/** Options for {@link AudioApi.play} — the path replaces the resource-metadata fields. */
export type ScenePlayOptions = Omit<PlayAudioOptions, 'resourcePath' | 'sizeBytes' | 'label'>;

/**
 * Script-facing audio mixer, reachable as `this.scene.audio`. Wraps the
 * runtime {@link AudioService} — buses, snapshots, and one-shot playback that
 * loads (and caches, via the AssetLoader) a clip by path.
 *
 * Mirrors the `scene.time` / `scene.juice` facade pattern: every method
 * degrades to a null-safe no-op when no scene is running.
 *
 * @example
 * this.scene.audio.play('res://sfx/hit.ogg', { bus: 'sfx', pitchVariation: 0.1 });
 * this.scene.audio.sfx('bounce');            // procedural, no asset needed
 * this.scene.audio.setBusVolume('music', 0.5);
 * this.scene.audio.applySnapshot('muffled');
 */
export class AudioApi {
  /** Lazily created so a session that never plays an SFX preset renders nothing. */
  private sfxSynth: SfxSynth | null = null;

  constructor(private readonly scene: SceneService) {}

  /** Load and play a clip on a bus, with optional per-shot pitch/volume variation. */
  async play(path: string, options: ScenePlayOptions = {}): Promise<AudioPlayback | null> {
    const loader = this.scene.getAssetLoader();
    if (!loader || !this.scene.getAudioService()) {
      return null;
    }
    const buffer = await loader.loadAudio(path);
    // Re-check after the await: the scene may have stopped mid-load.
    const audio = this.scene.getAudioService();
    if (!audio) {
      return null;
    }
    return audio.play(buffer, {
      ...options,
      resourcePath: path,
      sizeBytes: loader.getAudioMetadata(path)?.sizeBytes,
    });
  }

  /**
   * Play a **procedural** sound effect on the `sfx` bus — no project asset, no
   * loading. The preset is synthesized into an AudioBuffer on first use and cached
   * per preset+pitch (see {@link SfxSynth}), so this is a one-liner you can drop
   * next to the mechanic it punctuates:
   *
   * ```ts
   * this.scene.audio.sfx('bounce');
   * this.scene.audio.sfx('score', { pitch: 1.2, volume: 0.8 });
   * ```
   *
   * A silent no-op (returning null, never throwing) when Web Audio is unavailable
   * or the preset name is unknown.
   */
  sfx(preset: SfxPreset, options: SfxOptions = {}): AudioPlayback | null {
    const audio = this.scene.getAudioService();
    if (!audio) {
      return null;
    }
    if (!isSfxPreset(preset)) {
      console.warn(`[AudioApi] sfx: unknown preset "${String(preset)}".`);
      return null;
    }

    const pitch = clampSfxPitch(options.pitch);
    this.sfxSynth ??= new SfxSynth();
    const buffer = this.sfxSynth.getBuffer(audio, preset, pitch);
    if (!buffer) {
      return null;
    }

    const volume = typeof options.volume === 'number' ? options.volume : 1;
    return audio.play(buffer, {
      bus: 'sfx',
      label: `sfx:${preset}`,
      volume: Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1)),
    });
  }

  /** Set a bus's mixer volume, ramping over `fadeSec` (default 0.05) to avoid clicks. */
  setBusVolume(bus: AudioBusName, volume: number, fadeSec?: number): void {
    this.scene.getAudioService()?.setBusVolume(bus, volume, fadeSec);
  }

  /** Authored mixer volume of a bus (1 when no scene is running). */
  getBusVolume(bus: AudioBusName): number {
    return this.scene.getAudioService()?.getBusVolume(bus) ?? 1;
  }

  /** Blend the mixer to a named snapshot (per-bus lowpass + volume scale). */
  applySnapshot(name: string, options?: { timeConstantSec?: number }): void {
    this.scene.getAudioService()?.applySnapshot(name, options);
  }

  /** Blend back to the transparent `'default'` snapshot. */
  resetSnapshot(options?: { timeConstantSec?: number }): void {
    this.scene.getAudioService()?.resetSnapshot(options);
  }

  /** Register (or replace) a named snapshot for later {@link applySnapshot} calls. */
  registerSnapshot(snapshot: AudioSnapshot): void {
    this.scene.getAudioService()?.registerSnapshot(snapshot);
  }

  /** Name of the currently active snapshot (`'default'` initially). */
  getActiveSnapshotName(): string {
    return this.scene.getAudioService()?.getActiveSnapshotName() ?? 'default';
  }

  /** Stop every active playback immediately. */
  stopAll(): void {
    this.scene.getAudioService()?.stopAll();
  }
}
