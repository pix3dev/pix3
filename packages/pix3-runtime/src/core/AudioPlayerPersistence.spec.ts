import { describe, expect, it } from 'vitest';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { AudioPlayer } from '../nodes/AudioPlayer';
import type { NodeBase } from '../nodes/NodeBase';

function makeLoader(): SceneLoader {
  return new SceneLoader(
    new AssetLoader(new ResourceManager('/'), new AudioService()),
    new ScriptRegistry(),
    new ResourceManager('/')
  );
}

function serialize(node: AudioPlayer): string {
  return new SceneSaver().serializeScene({
    version: '1.0.0',
    metadata: {},
    rootNodes: [node],
    nodeMap: new Map([[node.nodeId, node]]),
  });
}

/** Drive a property through the inspector path (schema setValue), not the field. */
function setProp(node: NodeBase, name: string, value: unknown): void {
  const def = AudioPlayer.getPropertySchema().properties.find(prop => prop.name === name);
  if (!def?.setValue) {
    throw new Error(`No setter for property "${name}"`);
  }
  def.setValue(node, value);
}

describe('AudioPlayer scene persistence', () => {
  it('round-trips bus and variation configuration', async () => {
    const player = new AudioPlayer({
      id: 'audio-1',
      name: 'Music',
      audioTrack: 'res://audio/theme.ogg',
      autoplay: true,
      loop: true,
      volume: 0.4,
      bus: 'music',
      pitchVariation: 0.15,
      volumeVariation: 0.2,
    });

    const yaml = serialize(player);
    expect(yaml).toContain('type: AudioPlayer');
    expect(yaml).toContain('bus: music');

    const graph = await makeLoader().parseScene(yaml, {
      filePath: 'res://scenes/main.pix3scene',
    });
    const loaded = graph.rootNodes[0] as AudioPlayer;

    expect(loaded).toBeInstanceOf(AudioPlayer);
    expect(loaded.audioTrack).toBe('res://audio/theme.ogg');
    expect(loaded.autoplay).toBe(true);
    expect(loaded.loop).toBe(true);
    expect(loaded.volume).toBe(0.4);
    expect(loaded.bus).toBe('music');
    expect(loaded.pitchVariation).toBeCloseTo(0.15, 5);
    expect(loaded.volumeVariation).toBeCloseTo(0.2, 5);

    const config = loaded.serializeConfig();
    expect(config.bus).toBe('music');
    expect(config.pitchVariation).toBeCloseTo(0.15, 5);
    expect(config.volumeVariation).toBeCloseTo(0.2, 5);
  });

  it('applies defaults for a freshly created AudioPlayer', async () => {
    const player = new AudioPlayer({ id: 'audio-default', name: 'SFX' });

    const graph = await makeLoader().parseScene(serialize(player), {
      filePath: 'res://scenes/main.pix3scene',
    });
    const loaded = graph.rootNodes[0] as AudioPlayer;

    expect(loaded.bus).toBe('sfx');
    expect(loaded.pitchVariation).toBe(0);
    expect(loaded.volumeVariation).toBe(0);
  });

  it('persists inspector edits via serializeConfig (latent-bug regression)', async () => {
    // Before serializeConfig() wiring, AudioPlayer schema setters wrote instance
    // fields while the saver read the stale `properties` bag — inspector edits
    // were silently dropped on save. This proves the live values now survive.
    const player = new AudioPlayer({ id: 'audio-edit', name: 'SFX' });

    const firstPass = await makeLoader().parseScene(serialize(player), {
      filePath: 'res://scenes/main.pix3scene',
    });
    const loaded = firstPass.rootNodes[0] as AudioPlayer;

    setProp(loaded, 'volume', 0.2);
    setProp(loaded, 'bus', 'master');
    setProp(loaded, 'pitchVariation', 0.3);

    const secondPass = await makeLoader().parseScene(serialize(loaded), {
      filePath: 'res://scenes/main.pix3scene',
    });
    const reloaded = secondPass.rootNodes[0] as AudioPlayer;

    expect(reloaded.volume).toBe(0.2);
    expect(reloaded.bus).toBe('master');
    expect(reloaded.pitchVariation).toBeCloseTo(0.3, 5);
  });
});
