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
export type SfxPreset =
  | 'tap'
  | 'score'
  | 'bounce'
  | 'explosion'
  | 'powerup'
  | 'win'
  | 'lose'
  | 'laser'
  | 'tick';

export const SFX_PRESETS: readonly SfxPreset[] = [
  'tap',
  'score',
  'bounce',
  'explosion',
  'powerup',
  'win',
  'lose',
  'laser',
  'tick',
];

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

type SfxWave = 'sine' | 'square' | 'saw' | 'triangle' | 'noise';

interface SfxLayer {
  wave: SfxWave;
  /** Start frequency in Hz (ignored by `noise`). */
  freq?: number;
  /** End frequency of an exponential sweep; defaults to {@link freq} (no sweep). */
  freqEnd?: number;
  /** Layer amplitude before the final normalization pass (default 0.7). */
  gain?: number;
  /** Offset from the buffer start in seconds (default 0) — this is how arpeggios are built. */
  start?: number;
  /** Layer length in seconds. */
  duration: number;
  /** Attack ramp in seconds (default 0.004) — long enough to avoid a click. */
  attack?: number;
  /** Decay shape exponent: 1 = linear, higher = snappier (default 2). */
  decay?: number;
  /** One-pole lowpass cutoff in Hz, mostly to turn white noise into a boom. */
  lowpassHz?: number;
}

const PRESET_PATCHES: Record<SfxPreset, readonly SfxLayer[]> = {
  tap: [
    { wave: 'sine', freq: 880, freqEnd: 620, duration: 0.09, decay: 3, gain: 0.7 },
    { wave: 'square', freq: 1320, duration: 0.035, decay: 4, gain: 0.15 },
  ],
  tick: [{ wave: 'square', freq: 2200, freqEnd: 1700, duration: 0.035, decay: 5, gain: 0.35 }],
  bounce: [
    { wave: 'sine', freq: 420, freqEnd: 140, duration: 0.18, decay: 2.5, gain: 0.9 },
    { wave: 'triangle', freq: 840, freqEnd: 280, duration: 0.1, decay: 3, gain: 0.3 },
  ],
  score: [
    { wave: 'square', freq: 880, duration: 0.08, decay: 2.5, gain: 0.35 },
    { wave: 'square', freq: 1174, start: 0.06, duration: 0.08, decay: 2.5, gain: 0.35 },
    { wave: 'triangle', freq: 1568, start: 0.12, duration: 0.18, decay: 2, gain: 0.45 },
  ],
  powerup: [
    { wave: 'square', freq: 440, freqEnd: 1760, duration: 0.3, decay: 1.2, gain: 0.35 },
    { wave: 'sine', freq: 880, freqEnd: 3520, duration: 0.3, decay: 1.6, gain: 0.25 },
  ],
  laser: [
    { wave: 'saw', freq: 1800, freqEnd: 180, duration: 0.22, decay: 2, gain: 0.45 },
    { wave: 'square', freq: 900, freqEnd: 90, duration: 0.22, decay: 2.5, gain: 0.18 },
  ],
  explosion: [
    { wave: 'noise', duration: 0.55, decay: 1.6, gain: 0.9, lowpassHz: 900, attack: 0.002 },
    { wave: 'noise', duration: 0.12, decay: 3, gain: 0.45, lowpassHz: 3500, attack: 0.001 },
    { wave: 'sine', freq: 120, freqEnd: 40, duration: 0.45, decay: 2, gain: 0.6 },
  ],
  win: [
    { wave: 'triangle', freq: 523, duration: 0.22, decay: 2, gain: 0.4 },
    { wave: 'triangle', freq: 659, start: 0.1, duration: 0.22, decay: 2, gain: 0.4 },
    { wave: 'triangle', freq: 784, start: 0.2, duration: 0.24, decay: 2, gain: 0.4 },
    { wave: 'square', freq: 1046, start: 0.3, duration: 0.34, decay: 1.6, gain: 0.3 },
  ],
  lose: [
    { wave: 'square', freq: 392, duration: 0.22, decay: 2, gain: 0.3 },
    { wave: 'square', freq: 311, start: 0.12, duration: 0.22, decay: 2, gain: 0.3 },
    { wave: 'square', freq: 233, start: 0.24, duration: 0.3, decay: 1.8, gain: 0.3 },
    { wave: 'sine', freq: 160, freqEnd: 60, start: 0.24, duration: 0.4, decay: 1.6, gain: 0.5 },
  ],
};

/** Silence appended after the last layer so a decay tail is never cut mid-swing. */
const TAIL_SEC = 0.02;
/** Cache ceiling — a caller randomizing `pitch` every shot must not grow it forever. */
const MAX_CACHE_ENTRIES = 64;
const PEAK_TARGET = 0.9;

/** Whether `value` is one of the built-in presets. */
export function isSfxPreset(value: unknown): value is SfxPreset {
  return typeof value === 'string' && (SFX_PRESETS as readonly string[]).includes(value);
}

/** Clamp a pitch multiplier to the synth's supported range. */
export function clampSfxPitch(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 1;
  }
  return Math.min(4, Math.max(0.25, parsed));
}

/**
 * Lazily renders and caches one {@link AudioBuffer} per preset+pitch+sample-rate.
 * One instance lives on the `AudioApi` facade, so the cache is shared by every
 * script in a session and survives `changeScene`.
 */
export class SfxSynth {
  private readonly cache = new Map<string, AudioBuffer>();

  /** Cached buffers (diagnostics/tests). */
  get size(): number {
    return this.cache.size;
  }

  /**
   * The rendered buffer for a preset, from cache when possible. Returns null —
   * never throws — when the host has no audio context or the render fails.
   */
  getBuffer(host: SfxAudioHost, preset: SfxPreset, pitch = 1): AudioBuffer | null {
    const sampleRate = host.getSampleRate();
    if (!sampleRate || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      return null;
    }
    const normalizedPitch = clampSfxPitch(pitch);
    // Quantized so a randomized pitch reuses neighbouring renders instead of
    // minting a buffer per shot.
    const key = `${preset}|${normalizedPitch.toFixed(2)}|${Math.round(sampleRate)}`;
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    let buffer: AudioBuffer | null = null;
    try {
      buffer = this.render(host, preset, normalizedPitch, sampleRate);
    } catch (error) {
      console.warn(`[SfxSynth] Failed to render preset "${preset}":`, error);
      return null;
    }
    if (!buffer) {
      return null;
    }

    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      // Map iterates in insertion order, so this drops the oldest entry.
      const oldest = this.cache.keys().next();
      if (!oldest.done) {
        this.cache.delete(oldest.value);
      }
    }
    this.cache.set(key, buffer);
    return buffer;
  }

  /** Drop every cached buffer (e.g. when the audio context was replaced). */
  clear(): void {
    this.cache.clear();
  }

  private render(
    host: SfxAudioHost,
    preset: SfxPreset,
    pitch: number,
    sampleRate: number
  ): AudioBuffer | null {
    const layers = PRESET_PATCHES[preset];
    let totalSec = 0;
    for (const layer of layers) {
      totalSec = Math.max(totalSec, (layer.start ?? 0) + layer.duration);
    }
    const length = Math.max(1, Math.ceil((totalSec + TAIL_SEC) * sampleRate));
    const buffer = host.createBuffer(length, 1);
    if (!buffer) {
      return null;
    }

    const samples = buffer.getChannelData(0);
    samples.fill(0);
    for (const layer of layers) {
      renderLayer(samples, layer, pitch, sampleRate);
    }

    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const magnitude = Math.abs(samples[i]);
      if (magnitude > peak) {
        peak = magnitude;
      }
    }
    if (peak > PEAK_TARGET) {
      const scale = PEAK_TARGET / peak;
      for (let i = 0; i < samples.length; i++) {
        samples[i] *= scale;
      }
    }

    return buffer;
  }
}

function renderLayer(
  samples: Float32Array,
  layer: SfxLayer,
  pitch: number,
  sampleRate: number
): void {
  const startSample = Math.max(0, Math.floor((layer.start ?? 0) * sampleRate));
  const lengthSamples = Math.max(1, Math.floor(layer.duration * sampleRate));
  const gain = layer.gain ?? 0.7;
  const attack = Math.max(1 / sampleRate, layer.attack ?? 0.004);
  const decay = layer.decay ?? 2;
  const startFreq = Math.max(1, (layer.freq ?? 440) * pitch);
  const endFreq = Math.max(1, (layer.freqEnd ?? layer.freq ?? 440) * pitch);
  const sweep = endFreq / startFreq;

  // One-pole lowpass coefficient (noise → boom). `lowpassHz` scales with pitch so
  // a pitched-up explosion stays proportionally bright.
  const cutoff = layer.lowpassHz ? layer.lowpassHz * pitch : 0;
  const lowpassAlpha = cutoff > 0 ? 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate) : 1;
  let lowpassState = 0;
  let phase = 0;

  for (let i = 0; i < lengthSamples; i++) {
    const target = startSample + i;
    if (target >= samples.length) {
      break;
    }
    const time = i / sampleRate;
    const progress = i / lengthSamples;

    let value: number;
    if (layer.wave === 'noise') {
      const white = Math.random() * 2 - 1;
      lowpassState += lowpassAlpha * (white - lowpassState);
      value = lowpassState;
    } else {
      // Exponential sweep integrated per sample so the pitch glide is smooth.
      const frequency = startFreq * Math.pow(sweep, progress);
      phase += (2 * Math.PI * frequency) / sampleRate;
      value = waveform(layer.wave, phase);
    }

    const envelope =
      Math.min(1, time / attack) * Math.pow(Math.max(0, 1 - progress), Math.max(0.1, decay));
    samples[target] += value * envelope * gain;
  }
}

function waveform(wave: Exclude<SfxWave, 'noise'>, phase: number): number {
  switch (wave) {
    case 'sine':
      return Math.sin(phase);
    case 'square':
      return Math.sin(phase) >= 0 ? 1 : -1;
    case 'saw': {
      const cycle = (phase / (Math.PI * 2)) % 1;
      return 2 * (cycle < 0 ? cycle + 1 : cycle) - 1;
    }
    case 'triangle': {
      const cycle = (phase / (Math.PI * 2)) % 1;
      const normalized = cycle < 0 ? cycle + 1 : cycle;
      return 2 * Math.abs(2 * normalized - 1) - 1;
    }
  }
}
