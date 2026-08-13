import { describe, expect, it, vi, type Mock } from 'vitest';

import { AudioApi } from './AudioApi';
import { SFX_PRESETS, SfxSynth, clampSfxPitch, isSfxPreset } from './SfxSynth';
import type { SceneService } from './SceneService';

const SAMPLE_RATE = 24000;

/** The two-method slice of AudioService the synth needs — no Web Audio mock required. */
interface StubHost {
  getSampleRate: () => number | null;
  createBuffer: Mock<(lengthSamples: number, channels?: number) => AudioBuffer | null>;
}

function makeHost(sampleRate: number | null = SAMPLE_RATE): StubHost {
  return {
    getSampleRate: () => sampleRate,
    createBuffer: vi.fn((length: number) => {
      const data = new Float32Array(length);
      return {
        length,
        sampleRate: sampleRate ?? SAMPLE_RATE,
        numberOfChannels: 1,
        duration: length / (sampleRate ?? SAMPLE_RATE),
        getChannelData: () => data,
      } as unknown as AudioBuffer;
    }),
  };
}

function peak(buffer: AudioBuffer): number {
  const samples = buffer.getChannelData(0);
  let max = 0;
  for (const sample of samples) {
    max = Math.max(max, Math.abs(sample));
  }
  return max;
}

/** Zero crossings over a window — an independent read of the rendered pitch. */
function zeroCrossings(buffer: AudioBuffer, seconds: number): number {
  const samples = buffer.getChannelData(0);
  const end = Math.min(samples.length, Math.floor(seconds * buffer.sampleRate));
  let crossings = 0;
  for (let i = 1; i < end; i++) {
    if (samples[i - 1] <= 0 && samples[i] > 0) {
      crossings += 1;
    }
  }
  return crossings;
}

describe('SfxSynth', () => {
  it('renders every preset into an audible, non-clipping buffer', () => {
    const synth = new SfxSynth();
    const host = makeHost();

    for (const preset of SFX_PRESETS) {
      const buffer = synth.getBuffer(host, preset);
      expect(buffer, preset).not.toBeNull();
      expect(buffer!.length, preset).toBeGreaterThan(0);
      const level = peak(buffer!);
      expect(level, `${preset} should be audible`).toBeGreaterThan(0.05);
      expect(level, `${preset} must not clip`).toBeLessThanOrEqual(0.9001);
    }
    expect(host.createBuffer).toHaveBeenCalledTimes(SFX_PRESETS.length);
  });

  it('caches per preset + pitch and reuses the rendered buffer', () => {
    const synth = new SfxSynth();
    const host = makeHost();

    const first = synth.getBuffer(host, 'bounce');
    const second = synth.getBuffer(host, 'bounce');
    expect(second).toBe(first);
    expect(host.createBuffer).toHaveBeenCalledTimes(1);
    expect(synth.size).toBe(1);

    // A different pitch is a different render; the same pitch hits the cache again.
    const pitched = synth.getBuffer(host, 'bounce', 2);
    expect(pitched).not.toBe(first);
    expect(synth.getBuffer(host, 'bounce', 2)).toBe(pitched);
    expect(host.createBuffer).toHaveBeenCalledTimes(2);
    expect(synth.size).toBe(2);

    synth.clear();
    expect(synth.size).toBe(0);
  });

  it('bakes pitch into the frequencies, not into the duration', () => {
    const synth = new SfxSynth();
    const host = makeHost();

    const base = synth.getBuffer(host, 'tap')!;
    const octaveUp = synth.getBuffer(host, 'tap', 2)!;

    expect(octaveUp.length).toBe(base.length);
    const ratio = zeroCrossings(octaveUp, 0.05) / Math.max(1, zeroCrossings(base, 0.05));
    expect(ratio).toBeGreaterThan(1.7);
    expect(ratio).toBeLessThan(2.3);
  });

  it('is a silent no-op when there is no audio context', () => {
    const synth = new SfxSynth();
    const host = makeHost(null);

    expect(synth.getBuffer(host, 'tap')).toBeNull();
    expect(host.createBuffer).not.toHaveBeenCalled();
    expect(synth.size).toBe(0);
  });

  it('validates preset names and clamps pitch', () => {
    expect(isSfxPreset('score')).toBe(true);
    expect(isSfxPreset('nope')).toBe(false);
    expect(clampSfxPitch(0)).toBe(1);
    expect(clampSfxPitch(Number.NaN)).toBe(1);
    expect(clampSfxPitch(99)).toBe(4);
    expect(clampSfxPitch(0.01)).toBe(0.25);
  });
});

describe('AudioApi.sfx', () => {
  function makeApi(audio: unknown): AudioApi {
    return new AudioApi({ getAudioService: () => audio } as unknown as SceneService);
  }

  it('plays the synthesized buffer on the sfx bus with a clamped volume', () => {
    const host = makeHost();
    const play = vi.fn().mockReturnValue({ stop: () => {}, ended: Promise.resolve() });
    const api = makeApi({ ...host, play });

    const playback = api.sfx('score', { volume: 5, pitch: 1.25 });

    expect(playback).not.toBeNull();
    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ bus: 'sfx', volume: 1, label: 'sfx:score' })
    );

    // Second shot reuses the cached render — one createBuffer for two plays.
    api.sfx('score', { pitch: 1.25 });
    expect(host.createBuffer).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('returns null (and never throws) without an audio service or with an unknown preset', () => {
    expect(makeApi(null).sfx('tap')).toBeNull();

    const host = makeHost();
    const play = vi.fn();
    const api = makeApi({ ...host, play });
    expect(api.sfx('kaboom' as never)).toBeNull();
    expect(play).not.toHaveBeenCalled();
  });

  it('stays silent when the context cannot allocate a buffer', () => {
    const play = vi.fn();
    const api = makeApi({ getSampleRate: () => null, createBuffer: () => null, play });

    expect(api.sfx('bounce')).toBeNull();
    expect(play).not.toHaveBeenCalled();
  });
});
