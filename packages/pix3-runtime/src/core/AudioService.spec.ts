import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AudioService } from './AudioService';

class MockGainNode {
  gain = {
    value: 1,
    setTargetAtTime: vi.fn(),
  };

  connect = vi.fn();
  disconnect = vi.fn();
}

class MockBiquadFilterNode {
  type: BiquadFilterType = 'lowpass';
  frequency = {
    value: 20000,
    setTargetAtTime: vi.fn(),
  };
  Q = { value: 1 };

  connect = vi.fn();
  disconnect = vi.fn();
}

class MockStereoPannerNode {
  pan = {
    value: 0,
  };

  connect = vi.fn();
  disconnect = vi.fn();
}

class MockAudioBufferSourceNode {
  buffer: AudioBuffer | null = null;
  loop = false;
  playbackRate = {
    value: 1,
  };
  onended: (() => void) | null = null;

  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn(() => {
    this.onended?.();
  });
}

/** Latest-constructed context, so tests can inspect the buses the service built. */
let lastContext: MockAudioContextBase | null = null;

class MockAudioContextBase {
  currentTime = 0;
  destination = {} as AudioDestinationNode;
  state: AudioContextState = 'running';

  readonly createdGains: MockGainNode[] = [];
  readonly createdFilters: MockBiquadFilterNode[] = [];

  constructor() {
    lastContext = this;
  }

  createGain(): GainNode {
    const gain = new MockGainNode();
    this.createdGains.push(gain);
    return gain as unknown as GainNode;
  }

  createBufferSource(): AudioBufferSourceNode {
    return new MockAudioBufferSourceNode() as unknown as AudioBufferSourceNode;
  }

  createStereoPanner(): StereoPannerNode {
    return new MockStereoPannerNode() as unknown as StereoPannerNode;
  }

  resume = vi.fn(async () => {
    this.state = 'running';
  });

  suspend = vi.fn(async () => {
    this.state = 'suspended';
  });

  close = vi.fn(async () => {
    this.state = 'closed';
  });

  decodeAudioData = vi.fn(async () => ({}) as AudioBuffer);
}

/** Default mock — full Web-Audio surface including createBiquadFilter. */
class MockAudioContext extends MockAudioContextBase {
  createBiquadFilter(): BiquadFilterNode {
    const filter = new MockBiquadFilterNode();
    this.createdFilters.push(filter);
    return filter as unknown as BiquadFilterNode;
  }
}

function context(): MockAudioContextBase {
  if (!lastContext) {
    throw new Error('No mock AudioContext constructed');
  }
  return lastContext;
}

describe('AudioService', () => {
  beforeEach(() => {
    lastContext = null;
    vi.stubGlobal('AudioContext', MockAudioContext as unknown as typeof AudioContext);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('tracks active playback diagnostics for current audio instances', () => {
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(1000);

    const service = new AudioService();
    const playback = service.play(createAudioBufferMock({ duration: 2, channels: 2, sampleRate: 48000 }), {
      resourcePath: 'res://audio/hitStone.ogg',
      sizeBytes: 64000,
      volume: 0.35,
      loop: true,
      playbackRate: 1.15,
      pan: 0.2,
    });

    expect(service.getActivePlaybackSnapshot(1450)).toEqual([
      {
        id: 'playback-1',
        label: 'hitStone.ogg',
        resourcePath: 'res://audio/hitStone.ogg',
        startedAtMs: 1000,
        elapsedMs: 450,
        loop: true,
        volume: 0.35,
        playbackRate: 1.15,
        pan: 0.2,
        bus: 'sfx',
        durationSeconds: 2,
        channelCount: 2,
        sampleRate: 48000,
        bitrateKbps: 256,
      },
    ]);

    playback.stop();

    expect(service.getActivePlaybackSnapshot(1500)).toEqual([]);
    service.dispose();
  });

  it('falls back to an unknown label when callers omit debug metadata', () => {
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(250);

    const service = new AudioService();
    service.play(createAudioBufferMock({ duration: null, channels: null, sampleRate: null }));

    expect(service.getActivePlaybackSnapshot(300)[0]).toMatchObject({
      label: 'Unknown',
      resourcePath: null,
      elapsedMs: 50,
      loop: false,
      volume: 1,
      playbackRate: 1,
      pan: null,
      bus: 'sfx',
      durationSeconds: null,
      channelCount: null,
      sampleRate: null,
      bitrateKbps: null,
    });

    service.dispose();
  });

  it('builds a master/music/sfx bus graph with transparent lowpass filters', () => {
    const service = new AudioService();
    const ctx = context();

    // 3 bus input gains + 3 bus filters, deterministic creation order:
    // [0] master, [1] music, [2] sfx.
    expect(ctx.createdGains).toHaveLength(3);
    expect(ctx.createdFilters).toHaveLength(3);

    for (const filter of ctx.createdFilters) {
      expect(filter.type).toBe('lowpass');
      expect(filter.frequency.value).toBe(20000);
      expect(filter.Q.value).toBeCloseTo(0.7071, 4);
    }

    // master input → master filter → destination
    expect(ctx.createdGains[0]?.connect).toHaveBeenCalledWith(ctx.createdFilters[0]);
    expect(ctx.createdFilters[0]?.connect).toHaveBeenCalledWith(ctx.destination);
    // music/sfx filters feed master's input
    expect(ctx.createdFilters[1]?.connect).toHaveBeenCalledWith(ctx.createdGains[0]);
    expect(ctx.createdFilters[2]?.connect).toHaveBeenCalledWith(ctx.createdGains[0]);

    service.dispose();
  });

  it('routes playback to the requested bus (default sfx)', () => {
    const service = new AudioService();
    const ctx = context();
    const musicInput = ctx.createdGains[1];
    const sfxInput = ctx.createdGains[2];

    service.play(createAudioBufferMock({ duration: 1, channels: 1, sampleRate: 44100 }), { bus: 'music' });
    const musicPlaybackGain = ctx.createdGains[3];
    expect(musicPlaybackGain?.connect).toHaveBeenCalledWith(musicInput);

    service.play(createAudioBufferMock({ duration: 1, channels: 1, sampleRate: 44100 }));
    const sfxPlaybackGain = ctx.createdGains[4];
    expect(sfxPlaybackGain?.connect).toHaveBeenCalledWith(sfxInput);

    const snapshot = service.getActivePlaybackSnapshot();
    expect(snapshot.map(entry => entry.bus).sort()).toEqual(['music', 'sfx']);

    service.dispose();
  });

  it('sets and reads bus volume through the authoritative userVolume', () => {
    const service = new AudioService();
    const ctx = context();
    const musicInput = ctx.createdGains[1];

    service.setBusVolume('music', 0.5);

    expect(musicInput?.gain.setTargetAtTime).toHaveBeenCalledWith(0.5, 0, expect.any(Number));
    expect(service.getBusVolume('music')).toBe(0.5);

    service.dispose();
  });

  it('applies and clears the muffled snapshot, composing with user volume', () => {
    const service = new AudioService();
    const ctx = context();
    const masterInput = ctx.createdGains[0];
    const masterFilter = ctx.createdFilters[0];

    service.setBusVolume('master', 0.5);
    masterInput?.gain.setTargetAtTime.mockClear();

    service.applySnapshot('muffled');
    expect(service.getActiveSnapshotName()).toBe('muffled');
    expect(masterFilter?.frequency.setTargetAtTime).toHaveBeenCalledWith(700, 0, 0.08);
    // master gain composes user volume (0.5) with snapshot scale (0.85).
    expect(masterInput?.gain.setTargetAtTime).toHaveBeenCalledWith(0.5 * 0.85, 0, 0.08);
    // music/sfx filters ramp back to the open cutoff.
    expect(ctx.createdFilters[1]?.frequency.setTargetAtTime).toHaveBeenCalledWith(20000, 0, 0.08);

    masterFilter?.frequency.setTargetAtTime.mockClear();
    service.applySnapshot('default');
    expect(service.getActiveSnapshotName()).toBe('default');
    expect(masterFilter?.frequency.setTargetAtTime).toHaveBeenCalledWith(20000, 0, 0.08);

    service.dispose();
  });

  it('warns and keeps state unchanged for an unknown snapshot', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new AudioService();

    service.applySnapshot('does-not-exist');

    expect(service.getActiveSnapshotName()).toBe('default');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown snapshot'));

    service.dispose();
  });

  it('applies per-shot pitch and volume variation deterministically', () => {
    const service = new AudioService();
    const buffer = createAudioBufferMock({ duration: 1, channels: 1, sampleRate: 44100 });

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    service.play(buffer, { playbackRate: 1, volume: 1, pitchVariation: 0.2, volumeVariation: 0.1 });
    let entry = service.getActivePlaybackSnapshot()[0];
    expect(entry?.playbackRate).toBeCloseTo(1.2, 5);
    expect(entry?.volume).toBeCloseTo(1.1, 5);
    service.stopAll();

    randomSpy.mockReturnValue(0);
    service.play(buffer, { playbackRate: 1, volume: 1, pitchVariation: 0.2, volumeVariation: 0.1 });
    entry = service.getActivePlaybackSnapshot()[0];
    expect(entry?.playbackRate).toBeCloseTo(0.8, 5);
    expect(entry?.volume).toBeCloseTo(0.9, 5);
    service.stopAll();

    // Extreme spread with random()=0 clamps the rate to the audible floor.
    randomSpy.mockReturnValue(0);
    service.play(buffer, { playbackRate: 1, pitchVariation: 1 });
    entry = service.getActivePlaybackSnapshot()[0];
    expect(entry?.playbackRate).toBe(0.01);

    service.dispose();
  });

  it('resets buses to volume 1 and the default snapshot', () => {
    const service = new AudioService();

    service.setBusVolume('music', 0.25);
    service.applySnapshot('muffled');

    service.resetBuses();

    expect(service.getBusVolume('master')).toBe(1);
    expect(service.getBusVolume('music')).toBe(1);
    expect(service.getBusVolume('sfx')).toBe(1);
    expect(service.getActiveSnapshotName()).toBe('default');

    service.dispose();
  });

  it('degrades gracefully when createBiquadFilter is unavailable', () => {
    vi.stubGlobal('AudioContext', MockAudioContextBase as unknown as typeof AudioContext);
    const service = new AudioService();
    const ctx = context();

    // No filters created; bus inputs connect straight through.
    expect(ctx.createdFilters).toHaveLength(0);
    expect(ctx.createdGains).toHaveLength(3);

    // Snapshot/volume still apply (gain only) without throwing.
    expect(() => service.applySnapshot('muffled')).not.toThrow();
    expect(service.getActiveSnapshotName()).toBe('muffled');
    expect(() => service.play(createAudioBufferMock({ duration: 1, channels: 1, sampleRate: 44100 }))).not.toThrow();

    service.dispose();
  });
});

function createAudioBufferMock(options: {
  duration: number | null;
  channels: number | null;
  sampleRate: number | null;
}): AudioBuffer {
  return {
    duration: options.duration ?? 0,
    numberOfChannels: options.channels ?? 0,
    sampleRate: options.sampleRate ?? 0,
  } as AudioBuffer;
}
