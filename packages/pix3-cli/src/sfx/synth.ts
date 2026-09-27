/**
 * A small, dependency-free sound-effect synthesiser for `pix3 sfx` — jsfxr's idea (one voice, a
 * handful of numbers, a seed) without jsfxr's code.
 *
 * Why not `@txt2sfx/core`, which the editor's `generate_sfx` uses: its only renderer drives an
 * `OfflineAudioContext` the caller must supply (`render/offline.d.ts`: "offline rendering takes an
 * OfflineAudioContext factory you provide … `node-web-audio-api` in Node"), i.e. a native Web Audio
 * implementation. The CLI will not pull a prebuilt native module in for a sound effect, so this
 * renders plain sample math instead: one oscillator (square / saw / sine / triangle / noise) with an
 * exponential pitch slide, an optional pitch jump (arpeggio), vibrato, an ADSR envelope, a resonant
 * low-pass, a DC blocker and peak normalisation, written as 44.1 kHz 16-bit mono PCM WAV — the one
 * audio format every browser's `decodeAudioData` accepts.
 *
 * Deterministic: the same preset, text and seed produce the same bytes.
 */

export type SfxWave = 'square' | 'saw' | 'sine' | 'triangle' | 'noise';

export interface SfxParams {
  readonly wave: SfxWave;
  /** Start frequency, Hz. For `noise` it is the sample-and-hold rate / 16 (higher = hissier). */
  readonly freq: number;
  /** Frequency at the end of the slide (exponential); equal to `freq` = no slide. */
  readonly freqEnd: number;
  /** Slide length in seconds; 0 = the whole sound. */
  readonly slide: number;
  /** Pitch jump: multiply the frequency by `arpMul` from `arpAt` seconds on (0 = off). */
  readonly arpAt: number;
  readonly arpMul: number;
  /** Vibrato depth (fraction of the frequency) and rate (Hz). */
  readonly vibratoDepth: number;
  readonly vibratoHz: number;
  /** Square duty cycle, 0.05..0.95. */
  readonly duty: number;
  /** ADSR, seconds; `sustainLevel` 0..1 is held for `sustain` seconds after the decay. */
  readonly attack: number;
  readonly decay: number;
  readonly sustainLevel: number;
  readonly sustain: number;
  readonly release: number;
  /** Low-pass cutoff (Hz, 0 = off) and resonance (Q, 0.5..8). */
  readonly lowpassHz: number;
  readonly lowpassQ: number;
  /** Output peak after normalisation, 0..1. */
  readonly volume: number;
}

export const SFX_PRESET_NAMES = ['coin', 'jump', 'hit', 'explosion', 'powerup', 'click'] as const;
export type SfxPresetName = (typeof SFX_PRESET_NAMES)[number];

const BASE: SfxParams = {
  wave: 'square',
  freq: 440,
  freqEnd: 440,
  slide: 0,
  arpAt: 0,
  arpMul: 1,
  vibratoDepth: 0,
  vibratoHz: 0,
  duty: 0.5,
  attack: 0.002,
  decay: 0.05,
  sustainLevel: 0.6,
  sustain: 0.05,
  release: 0.1,
  lowpassHz: 0,
  lowpassQ: 0.707,
  volume: 0.8,
};

export const SFX_PRESETS: Readonly<Record<SfxPresetName, SfxParams>> = {
  // Two-note square "bling": short blip, then a fourth up.
  coin: {
    ...BASE,
    freq: 988,
    freqEnd: 988,
    arpAt: 0.07,
    arpMul: 4 / 3,
    duty: 0.5,
    decay: 0.02,
    sustainLevel: 0.7,
    sustain: 0.1,
    release: 0.18,
    volume: 0.7,
  },
  // Rising square chirp.
  jump: {
    ...BASE,
    freq: 260,
    freqEnd: 720,
    slide: 0.16,
    duty: 0.35,
    decay: 0.04,
    sustainLevel: 0.6,
    sustain: 0.06,
    release: 0.1,
    lowpassHz: 5000,
    volume: 0.7,
  },
  // Crunchy noise burst falling fast.
  hit: {
    ...BASE,
    wave: 'noise',
    freq: 1400,
    freqEnd: 180,
    slide: 0.12,
    attack: 0.001,
    decay: 0.05,
    sustainLevel: 0.3,
    sustain: 0.02,
    release: 0.08,
    lowpassHz: 3200,
    lowpassQ: 1.2,
    volume: 0.85,
  },
  // Long low rumble.
  explosion: {
    ...BASE,
    wave: 'noise',
    freq: 520,
    freqEnd: 40,
    slide: 0.7,
    attack: 0.002,
    decay: 0.12,
    sustainLevel: 0.55,
    sustain: 0.15,
    release: 0.5,
    lowpassHz: 1400,
    lowpassQ: 1,
    volume: 0.9,
  },
  // Rising saw sweep with vibrato.
  powerup: {
    ...BASE,
    wave: 'saw',
    freq: 330,
    freqEnd: 1320,
    slide: 0.38,
    vibratoDepth: 0.04,
    vibratoHz: 14,
    attack: 0.005,
    decay: 0.05,
    sustainLevel: 0.7,
    sustain: 0.25,
    release: 0.15,
    lowpassHz: 6000,
    volume: 0.65,
  },
  // A UI tick.
  click: {
    ...BASE,
    wave: 'square',
    freq: 1800,
    freqEnd: 1200,
    slide: 0.02,
    duty: 0.25,
    attack: 0.0005,
    decay: 0.012,
    sustainLevel: 0,
    sustain: 0,
    release: 0.012,
    lowpassHz: 8000,
    volume: 0.6,
  },
};

/** Words that pick a preset out of a free-text description. */
const KEYWORDS: Readonly<Record<SfxPresetName, readonly string[]>> = {
  coin: [
    'coin',
    'pickup',
    'pick up',
    'collect',
    'gem',
    'ding',
    'bling',
    'money',
    'score',
    'reward',
  ],
  jump: ['jump', 'hop', 'leap', 'spring', 'bounce', 'boing'],
  hit: ['hit', 'hurt', 'damage', 'punch', 'impact', 'thud', 'smack', 'crash', 'kick', 'slap'],
  explosion: ['explosion', 'explode', 'boom', 'blast', 'bomb', 'kaboom', 'explod', 'detonat'],
  powerup: ['powerup', 'power-up', 'power up', 'level up', 'upgrade', 'bonus', 'charge', 'magic'],
  click: ['click', 'tap', 'button', 'ui', 'menu', 'select', 'tick', 'toggle', 'blip'],
};

export interface SfxResolution {
  readonly preset: SfxPresetName;
  readonly params: SfxParams;
  /** Modifier words that changed the preset (`high`, `short`, …). */
  readonly modifiers: readonly string[];
}

const scaleFreq = (params: SfxParams, factor: number): SfxParams => ({
  ...params,
  freq: params.freq * factor,
  freqEnd: params.freqEnd * factor,
});

const scaleTime = (params: SfxParams, factor: number): SfxParams => ({
  ...params,
  slide: params.slide * factor,
  arpAt: params.arpAt * factor,
  decay: params.decay * factor,
  sustain: params.sustain * factor,
  release: params.release * factor,
});

const MODIFIERS: readonly {
  readonly words: readonly string[];
  readonly apply: (params: SfxParams) => SfxParams;
}[] = [
  { words: ['high', 'bright', 'tiny', 'small', 'light'], apply: p => scaleFreq(p, 1.4) },
  { words: ['low', 'deep', 'big', 'heavy', 'huge'], apply: p => scaleFreq(p, 0.7) },
  { words: ['short', 'quick', 'snappy', 'fast'], apply: p => scaleTime(p, 0.65) },
  { words: ['long', 'slow'], apply: p => scaleTime(p, 1.6) },
  { words: ['soft', 'quiet'], apply: p => ({ ...p, volume: p.volume * 0.6 }) },
];

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z-]+/)
    .filter(Boolean);

/** Position of the first word matching `keyword` (a phrase matches as a run of words; a keyword of
 * five letters or more also matches as a prefix, so `explod` finds "exploding"), or -1. */
const findKeyword = (tokens: readonly string[], keyword: string): number => {
  const parts = keyword.split(' ');
  for (let i = 0; i + parts.length <= tokens.length; i++) {
    const hit = parts.every((part, k) => {
      const token = tokens[i + k];
      return token === part || (part.length >= 5 && token.startsWith(part));
    });
    if (hit) return i;
  }
  return -1;
};

/**
 * A preset name, or a description (`"short high coin pickup"`) mapped to one by keyword — the
 * earliest keyword in the text wins — with modifier words applied. Null when nothing names a preset.
 */
export const resolveSfx = (input: string): SfxResolution | null => {
  const tokens = words(input);
  const exact = SFX_PRESET_NAMES.find(name => input.trim().toLowerCase() === name);
  let preset: SfxPresetName | undefined = exact;
  if (!preset) {
    let best = -1;
    for (const name of SFX_PRESET_NAMES) {
      for (const keyword of [name, ...KEYWORDS[name]]) {
        const at = findKeyword(tokens, keyword);
        if (at >= 0 && (best < 0 || at < best)) {
          best = at;
          preset = name;
        }
      }
    }
  }
  if (!preset) return null;
  let params = SFX_PRESETS[preset];
  const modifiers: string[] = [];
  if (!exact) {
    for (const modifier of MODIFIERS) {
      const word = modifier.words.find(w => tokens.includes(w));
      if (word) {
        params = modifier.apply(params);
        modifiers.push(word);
      }
    }
  }
  return { preset, params, modifiers };
};

/** mulberry32 — tiny, seedable, good enough for noise and jitter. */
export const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * A variation of `params` for `seed` (jsfxr's "mutate"): pitch ±15%, times ±20%, duty/vibrato/
 * cutoff nudged. Same seed, same variation.
 */
export const mutateSfx = (params: SfxParams, seed: number): SfxParams => {
  const random = seededRandom(seed ^ 0x9e3779b9);
  const jitter = (amount: number): number => 1 + (random() * 2 - 1) * amount;
  const pitch = jitter(0.15);
  const time = jitter(0.2);
  return {
    ...scaleTime(scaleFreq(params, pitch), time),
    freqEnd: params.freqEnd * pitch * jitter(0.08),
    duty: Math.min(0.9, Math.max(0.1, params.duty * jitter(0.25))),
    vibratoDepth: params.vibratoDepth * jitter(0.3),
    vibratoHz: params.vibratoHz * jitter(0.2),
    lowpassHz: params.lowpassHz > 0 ? params.lowpassHz * jitter(0.25) : 0,
  };
};

export const SAMPLE_RATE = 44100;

export const durationOf = (p: SfxParams): number => p.attack + p.decay + p.sustain + p.release;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

/** Envelope amplitude at time `t` (seconds). */
const envelopeAt = (p: SfxParams, t: number): number => {
  if (t < p.attack) return t / p.attack;
  let rest = t - p.attack;
  if (rest < p.decay) return 1 - (1 - p.sustainLevel) * (rest / p.decay);
  rest -= p.decay;
  if (rest < p.sustain) return p.sustainLevel;
  rest -= p.sustain;
  if (rest < p.release) return p.sustainLevel * (1 - rest / p.release) ** 2;
  return 0;
};

/** Render to mono float samples in -1..1. `seed` drives the noise. */
export const renderSfx = (input: SfxParams, seed = 1): Float32Array => {
  const p: SfxParams = {
    ...input,
    freq: clamp(input.freq, 10, 20000),
    freqEnd: clamp(input.freqEnd, 10, 20000),
    attack: clamp(input.attack, 0.0005, 5),
    decay: clamp(input.decay, 0, 5),
    sustain: clamp(input.sustain, 0, 5),
    release: clamp(input.release, 0.002, 5),
    sustainLevel: clamp(input.sustainLevel, 0, 1),
    duty: clamp(input.duty, 0.05, 0.95),
    volume: clamp(input.volume, 0, 1),
    lowpassQ: clamp(input.lowpassQ, 0.5, 8),
  };
  const duration = durationOf(p);
  const length = Math.max(1, Math.round(duration * SAMPLE_RATE));
  const out = new Float32Array(length);
  const random = seededRandom(seed);
  const slide = p.slide > 0 ? p.slide : duration;
  const ratio = p.freqEnd / p.freq;

  // RBJ biquad low-pass; coefficients recomputed only when the cutoff is set (it is static).
  const lowpass = p.lowpassHz > 0 && p.lowpassHz < SAMPLE_RATE / 2;
  let b0 = 1;
  let b1 = 0;
  let b2 = 0;
  let a1 = 0;
  let a2 = 0;
  if (lowpass) {
    const w0 = (2 * Math.PI * p.lowpassHz) / SAMPLE_RATE;
    const alpha = Math.sin(w0) / (2 * p.lowpassQ);
    const cos = Math.cos(w0);
    const a0 = 1 + alpha;
    b0 = (1 - cos) / 2 / a0;
    b1 = (1 - cos) / a0;
    b2 = b0;
    a1 = (-2 * cos) / a0;
    a2 = (1 - alpha) / a0;
  }
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  // DC blocker (a non-50% square and held noise carry an offset).
  let dcIn = 0;
  let dcOut = 0;

  let phase = 0;
  let noiseValue = random() * 2 - 1;
  let noiseStep = 0;
  for (let i = 0; i < length; i++) {
    const t = i / SAMPLE_RATE;
    let freq = p.freq * ratio ** Math.min(1, t / slide);
    if (p.arpAt > 0 && t >= p.arpAt) freq *= p.arpMul;
    if (p.vibratoDepth > 0) freq *= 1 + p.vibratoDepth * Math.sin(2 * Math.PI * p.vibratoHz * t);
    phase += freq / SAMPLE_RATE;
    let sample: number;
    switch (p.wave) {
      case 'square':
        sample = phase % 1 < p.duty ? 1 : -1;
        break;
      case 'saw':
        sample = 2 * (phase % 1) - 1;
        break;
      case 'sine':
        sample = Math.sin(2 * Math.PI * phase);
        break;
      case 'triangle':
        sample = 1 - 4 * Math.abs((phase % 1) - 0.5);
        break;
      case 'noise': {
        const step = Math.floor(phase * 16);
        if (step !== noiseStep) {
          noiseStep = step;
          noiseValue = random() * 2 - 1;
        }
        sample = noiseValue;
        break;
      }
    }
    sample *= envelopeAt(p, t);
    if (lowpass) {
      const y = b0 * sample + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = sample;
      y2 = y1;
      y1 = y;
      sample = y;
    }
    dcOut = sample - dcIn + 0.995 * dcOut;
    dcIn = sample;
    out[i] = dcOut;
  }

  // Short fade-out so the last sample is 0 (no click), then normalise to `volume`.
  const fade = Math.min(length, Math.round(0.003 * SAMPLE_RATE));
  for (let i = 0; i < fade; i++) out[length - 1 - i] *= i / fade;
  let peak = 0;
  for (const value of out) peak = Math.max(peak, Math.abs(value));
  if (peak > 0) {
    const gain = p.volume / peak;
    for (let i = 0; i < length; i++) out[i] *= gain;
  }
  return out;
};

/** 16-bit PCM mono WAV. */
export const encodeWav16 = (samples: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array => {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return new Uint8Array(buffer);
};
