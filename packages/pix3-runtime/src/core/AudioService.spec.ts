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

class MockAudioContext {
  currentTime = 0;
  destination = {} as AudioDestinationNode;
  state: AudioContextState = 'running';

  createGain(): GainNode {
    return new MockGainNode() as unknown as GainNode;
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

describe('AudioService', () => {
  beforeEach(() => {
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
      durationSeconds: null,
      channelCount: null,
      sampleRate: null,
      bitrateKbps: null,
    });

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