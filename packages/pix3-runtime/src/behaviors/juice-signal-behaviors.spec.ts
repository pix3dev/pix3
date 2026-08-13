import { describe, expect, it, vi } from 'vitest';

import { BurstOnSignalBehavior } from './BurstOnSignalBehavior';
import { SfxOnSignalBehavior } from './SfxOnSignalBehavior';
import { NodeBase } from '../nodes/NodeBase';
import { SFX_PRESETS } from '../core/SfxSynth';
import type { SceneService } from '../core/SceneService';

function makeNode(): NodeBase {
  return new NodeBase({ id: 'bumper', type: 'Node', name: 'bumper' });
}

describe('core:BurstOnSignal', () => {
  it('bursts at its own node when the configured signal fires, and stops after detach', () => {
    const node = makeNode();
    const burst = vi.fn();
    const behavior = new BurstOnSignalBehavior('burst', 'core:BurstOnSignal');
    behavior.node = node;
    behavior.scene = { juice: { burst } } as unknown as SceneService;
    behavior.config.signal = 'scored';
    behavior.config.color = ' #ffcf33 ';
    behavior.config.count = 20;

    behavior.onStart();
    // Idempotent binding: a second onStart must not double the effect.
    behavior.onStart();
    node.emit('scored');

    expect(burst).toHaveBeenCalledTimes(1);
    expect(burst).toHaveBeenCalledWith(
      node,
      expect.objectContaining({ count: 20, color: '#ffcf33' })
    );

    behavior.onDetach();
    node.emit('scored');
    expect(burst).toHaveBeenCalledTimes(1);
  });

  it('rebinds when the signal is changed through the schema', () => {
    const node = makeNode();
    const burst = vi.fn();
    const behavior = new BurstOnSignalBehavior('burst', 'core:BurstOnSignal');
    behavior.node = node;
    behavior.scene = { juice: { burst } } as unknown as SceneService;
    behavior.onStart();

    const schema = BurstOnSignalBehavior.getPropertySchema();
    const signal = schema.properties.find(p => p.name === 'signal')!;
    signal.setValue(behavior, 'damaged');

    node.emit('hit'); // the old default no longer fires anything
    expect(burst).not.toHaveBeenCalled();
    node.emit('damaged');
    expect(burst).toHaveBeenCalledTimes(1);

    behavior.onDetach();
  });

  it('falls back to the defaults for garbage config and omits an empty colour', () => {
    const behavior = new BurstOnSignalBehavior('burst', 'core:BurstOnSignal');
    behavior.config.count = 'lots';
    behavior.config.speed = null;

    const options = behavior.buildOptions();
    expect(options.count).toBe(14);
    expect(options.speed).toBe(260);
    expect('color' in options).toBe(false);
  });
});

describe('core:SfxOnSignal', () => {
  it('plays its preset through scene.audio and unbinds on detach', () => {
    const node = makeNode();
    const sfx = vi.fn();
    const behavior = new SfxOnSignalBehavior('sfx', 'core:SfxOnSignal');
    behavior.node = node;
    behavior.scene = { audio: { sfx } } as unknown as SceneService;
    behavior.config.signal = 'bounced';
    behavior.config.preset = 'bounce';
    behavior.config.volume = 0.5;

    behavior.onStart();
    node.emit('bounced');

    expect(sfx).toHaveBeenCalledWith('bounce', { volume: 0.5, pitch: 1 });

    behavior.onDetach();
    node.emit('bounced');
    expect(sfx).toHaveBeenCalledTimes(1);
  });

  it('normalizes an unknown preset and out-of-range volume/pitch', () => {
    const node = makeNode();
    const sfx = vi.fn();
    const behavior = new SfxOnSignalBehavior('sfx', 'core:SfxOnSignal');
    behavior.node = node;
    behavior.scene = { audio: { sfx } } as unknown as SceneService;
    behavior.config.preset = 'not-a-preset';
    behavior.config.volume = 12;
    behavior.config.pitch = 0;

    behavior.onStart();
    node.emit('pointerdown');

    expect(sfx).toHaveBeenCalledWith('tap', { volume: 1, pitch: 1 });
    behavior.onDetach();
  });

  it('exposes the preset list to the inspector', () => {
    const schema = SfxOnSignalBehavior.getPropertySchema();
    const preset = schema.properties.find(p => p.name === 'preset')!;
    expect(preset.type).toBe('enum');
    expect(preset.ui?.options).toEqual([...SFX_PRESETS]);
  });
});
