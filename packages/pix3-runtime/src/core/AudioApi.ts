import type { SceneService } from './SceneService';
import type { AudioBusName, AudioPlayback, AudioSnapshot, PlayAudioOptions } from './AudioService';

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
 * this.scene.audio.setBusVolume('music', 0.5);
 * this.scene.audio.applySnapshot('muffled');
 */
export class AudioApi {
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
