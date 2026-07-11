import { describe, expect, it, vi } from 'vitest';
import type { SceneService } from '../core/SceneService';
import { NodeBase } from '../nodes/NodeBase';
import { PlaySoundBehavior } from './PlaySoundBehavior';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('PlaySoundBehavior', () => {
  it('ignores duplicate signal connections for the same target and method', () => {
    const node = new NodeBase({ id: 'button', type: 'Button', name: 'Button' });
    const listener = {
      handle: vi.fn(),
    };

    node.connect('click', listener, listener.handle);
    node.connect('click', listener, listener.handle);

    node.emit('click');

    expect(listener.handle).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate playback when started multiple times', async () => {
    const node = new NodeBase({ id: 'button', type: 'Button', name: 'Button' });
    const behavior = new PlaySoundBehavior('play-sound', 'core:PlaySound');
    const play = vi.fn();
    const loadAudio = vi.fn().mockResolvedValue({} as AudioBuffer);
    const getAudioMetadata = vi.fn().mockReturnValue({ sizeBytes: 128 });

    behavior.node = node;
    behavior.scene = {
      getAssetLoader: () => ({
        loadAudio,
        getAudioMetadata,
      }),
      getAudioService: () => ({
        play,
      }),
    } as unknown as SceneService;
    behavior.config.audioTrack = 'res://click.wav';

    behavior.onStart();
    behavior.onStart();

    node.emit('pointerdown');
    await flushMicrotasks();

    expect(loadAudio).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);

    behavior.onDetach();
    node.emit('pointerdown');
    await flushMicrotasks();

    expect(loadAudio).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('forwards bus and variation config to AudioService.play', async () => {
    const node = new NodeBase({ id: 'button', type: 'Button', name: 'Button' });
    const behavior = new PlaySoundBehavior('play-sound', 'core:PlaySound');
    const play = vi.fn();

    behavior.node = node;
    behavior.scene = {
      getAssetLoader: () => ({
        loadAudio: vi.fn().mockResolvedValue({} as AudioBuffer),
        getAudioMetadata: vi.fn().mockReturnValue({ sizeBytes: 128 }),
      }),
      getAudioService: () => ({ play }),
    } as unknown as SceneService;
    behavior.config.audioTrack = 'res://click.wav';
    behavior.config.bus = 'music';
    behavior.config.pitchVariation = 0.3;

    behavior.onStart();
    node.emit('pointerdown');
    await flushMicrotasks();

    expect(play).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ bus: 'music', pitchVariation: 0.3, volumeVariation: 0 })
    );
  });

  it('defaults an unknown bus to sfx', async () => {
    const node = new NodeBase({ id: 'button', type: 'Button', name: 'Button' });
    const behavior = new PlaySoundBehavior('play-sound', 'core:PlaySound');
    const play = vi.fn();

    behavior.node = node;
    behavior.scene = {
      getAssetLoader: () => ({
        loadAudio: vi.fn().mockResolvedValue({} as AudioBuffer),
        getAudioMetadata: vi.fn().mockReturnValue(null),
      }),
      getAudioService: () => ({ play }),
    } as unknown as SceneService;
    behavior.config.audioTrack = 'res://click.wav';
    behavior.config.bus = 'not-a-bus';

    behavior.onStart();
    node.emit('pointerdown');
    await flushMicrotasks();

    expect(play).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ bus: 'sfx' }));
  });
});