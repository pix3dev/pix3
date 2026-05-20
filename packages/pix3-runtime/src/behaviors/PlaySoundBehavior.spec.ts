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
});