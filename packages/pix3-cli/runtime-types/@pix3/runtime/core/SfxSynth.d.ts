/**
 * Procedural sound effects — the "no assets needed" half of game feel.
 *
 * A preset is a tiny additive synth patch (oscillator + exponential envelope,
 * the same recipe the one-shot WebAudio games use), rendered ONCE into an
 * {@link AudioBuffer} and cached, then played through the existing
 * {@link AudioService} on the `sfx` bus. So `scene.audio.sfx('bounce')` costs a
 * cache lookup after the first call and needs no project asset at all.
 *
 * Rendering is deliberately synchronous sample math rather than an
 * `OfflineAudioContext.startRendering()` promise: the first shot of a preset
 * usually coincides with the gameplay event that asked for it (the first bounce,
 * the first score), and an async render would make that first one silent or late.
 * The trade-off is that filters/curves are hand-rolled here instead of borrowed
 * from the browser's audio graph.
 *
 * Everything degrades to a silent no-op when Web Audio is unavailable
 * (headless/tests): the host returns no sample rate, so no buffer is produced and
 * nothing throws.
 */
/** The built-in synth presets. */
export type SfxPreset = 'tap' | 'score' | 'bounce' | 'explosion' | 'powerup' | 'win' | 'lose' | 'laser' | 'tick';
export declare const SFX_PRESETS: readonly SfxPreset[];
/** Per-shot options for `scene.audio.sfx()`. */
export interface SfxOptions {
    /** Linear volume 0..1 (default 1). */
    volume?: number;
    /**
     * Frequency multiplier baked into the render — 1 = as authored, 2 = an octave
     * up, 0.5 = an octave down (clamped 0.25..4). Duration is unaffected, and each
     * distinct pitch gets its own cached buffer.
     */
    pitch?: number;
}
/**
 * The slice of {@link AudioService} the synth needs. Declared structurally so
 * tests can pass a two-method stub instead of a whole Web Audio mock.
 */
export interface SfxAudioHost {
    /** Output sample rate, or null when Web Audio is unavailable. */
    getSampleRate(): number | null;
    /** Allocate an empty buffer on the live context, or null when unavailable. */
    createBuffer(lengthSamples: number, channels?: number): AudioBuffer | null;
}
/** Whether `value` is one of the built-in presets. */
export declare function isSfxPreset(value: unknown): value is SfxPreset;
/** Clamp a pitch multiplier to the synth's supported range. */
export declare function clampSfxPitch(value: unknown): number;
/**
 * Lazily renders and caches one {@link AudioBuffer} per preset+pitch+sample-rate.
 * One instance lives on the `AudioApi` facade, so the cache is shared by every
 * script in a session and survives `changeScene`.
 */
export declare class SfxSynth {
    private readonly cache;
    /** Cached buffers (diagnostics/tests). */
    get size(): number;
    /**
     * The rendered buffer for a preset, from cache when possible. Returns null —
     * never throws — when the host has no audio context or the render fails.
     */
    getBuffer(host: SfxAudioHost, preset: SfxPreset, pitch?: number): AudioBuffer | null;
    /** Drop every cached buffer (e.g. when the audio context was replaced). */
    clear(): void;
    private render;
}
