import type { SceneService } from './SceneService';
import type { AudioBusName, AudioPlayback, AudioSnapshot, PlayAudioOptions } from './AudioService';
import { type SfxOptions, type SfxPreset } from './SfxSynth';
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
export declare class AudioApi {
    private readonly scene;
    /** Lazily created so a session that never plays an SFX preset renders nothing. */
    private sfxSynth;
    constructor(scene: SceneService);
    /** Load and play a clip on a bus, with optional per-shot pitch/volume variation. */
    play(path: string, options?: ScenePlayOptions): Promise<AudioPlayback | null>;
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
    sfx(preset: SfxPreset, options?: SfxOptions): AudioPlayback | null;
    /** Set a bus's mixer volume, ramping over `fadeSec` (default 0.05) to avoid clicks. */
    setBusVolume(bus: AudioBusName, volume: number, fadeSec?: number): void;
    /** Authored mixer volume of a bus (1 when no scene is running). */
    getBusVolume(bus: AudioBusName): number;
    /** Blend the mixer to a named snapshot (per-bus lowpass + volume scale). */
    applySnapshot(name: string, options?: {
        timeConstantSec?: number;
    }): void;
    /** Blend back to the transparent `'default'` snapshot. */
    resetSnapshot(options?: {
        timeConstantSec?: number;
    }): void;
    /** Register (or replace) a named snapshot for later {@link applySnapshot} calls. */
    registerSnapshot(snapshot: AudioSnapshot): void;
    /** Name of the currently active snapshot (`'default'` initially). */
    getActiveSnapshotName(): string;
    /** Stop every active playback immediately. */
    stopAll(): void;
}
