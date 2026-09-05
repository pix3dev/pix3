import { describe, expect, it } from 'vitest';
import { Texture } from 'three';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import type { NodeBase } from '../nodes/NodeBase';
import { Bar2D } from '../nodes/2D/UI/Bar2D';
import { Button2D } from '../nodes/2D/UI/Button2D';
import { Checkbox2D } from '../nodes/2D/UI/Checkbox2D';
import { Slider2D } from '../nodes/2D/UI/Slider2D';

/**
 * Round-trips for the skin properties the UI-kit forge writes onto the previously
 * colour-only controls, plus the half that keeps existing scenes byte-stable: a
 * control nobody skinned must not grow a single new key on save.
 */

function serialize(node: NodeBase): string {
  return new SceneSaver().serializeScene({
    version: '1.0.0',
    metadata: {},
    rootNodes: [node],
    nodeMap: new Map([[node.nodeId, node]]),
  });
}

async function roundTrip<T extends NodeBase>(node: T, textures: string[] = []): Promise<T> {
  const yaml = serialize(node);
  const assetLoader = new AssetLoader(new ResourceManager('/'), new AudioService());
  // Seed the texture cache so loadTexture() short-circuits before any network
  // fetch — res:// URLs 404 under happy-dom and would leak unhandled rejections.
  const cache = (assetLoader as unknown as { textureCache: Map<string, Texture> }).textureCache;
  for (const url of textures) {
    cache.set(url, new Texture());
  }
  const loader = new SceneLoader(assetLoader, new ScriptRegistry(), new ResourceManager('/'));
  const graph = await loader.parseScene(yaml, { filePath: 'res://scenes/main.pix3scene' });
  return graph.rootNodes[0] as T;
}

describe('Button2D skin persistence', () => {
  it('round-trips the nine-slice border alongside the state sprites', async () => {
    const button = new Button2D({
      id: 'btn',
      name: 'Button',
      width: 220,
      height: 72,
      textureNormal: 'res://ui/btn.png',
      sliceBorder: { left: 12, right: 12, top: 8, bottom: 8 },
    });

    const loaded = await roundTrip(button, ['res://ui/btn.png']);

    expect(loaded.textureNormal?.url).toBe('res://ui/btn.png');
    expect(loaded.sliceBorder).toEqual({ left: 12, right: 12, top: 8, bottom: 8 });
  });

  it('omits the border entirely when it is the default', () => {
    const yaml = serialize(new Button2D({ id: 'btn', name: 'Button' }));

    expect(yaml).not.toContain('sliceBorder');
  });

  it('persists an Inspector-style border edit', async () => {
    const button = new Button2D({ id: 'btn', name: 'Button' });
    button.setSliceBorder({ left: 6, right: 6, top: 6, bottom: 6 });

    const loaded = await roundTrip(button);

    expect(loaded.sliceBorder).toEqual({ left: 6, right: 6, top: 6, bottom: 6 });
  });
});

describe('Checkbox2D skin persistence', () => {
  it('round-trips all three sprite slots', async () => {
    const checkbox = new Checkbox2D({
      id: 'cb',
      name: 'Checkbox',
      textureBox: 'res://ui/box.png',
      textureBoxChecked: 'res://ui/box_on.png',
      textureMark: 'res://ui/tick.png',
    });

    const loaded = await roundTrip(checkbox, [
      'res://ui/box.png',
      'res://ui/box_on.png',
      'res://ui/tick.png',
    ]);

    expect(loaded.textureBox?.url).toBe('res://ui/box.png');
    expect(loaded.textureBoxChecked?.url).toBe('res://ui/box_on.png');
    expect(loaded.textureMark?.url).toBe('res://ui/tick.png');
  });

  it('omits unset slots and drops a cleared one', async () => {
    const checkbox = new Checkbox2D({
      id: 'cb',
      name: 'Checkbox',
      textureBox: 'res://ui/box.png',
    });
    const yaml = serialize(checkbox);
    expect(yaml).toContain('textureBox');
    expect(yaml).not.toContain('textureBoxChecked');
    expect(yaml).not.toContain('textureMark');

    // Clearing must delete the key, not write a null the loader would resurrect.
    checkbox.textureBox = null;
    expect(serialize(checkbox)).not.toContain('textureBox');

    const loaded = await roundTrip(checkbox);
    expect(loaded.textureBox).toBeNull();
  });
});

describe('Slider2D skin persistence', () => {
  it('round-trips the three sprite slots and the border', async () => {
    const slider = new Slider2D({
      id: 'sl',
      name: 'Volume',
      textureTrack: 'res://ui/track.png',
      textureFill: 'res://ui/fill.png',
      textureThumb: 'res://ui/thumb.png',
      sliceBorder: { left: 10, right: 10, top: 0, bottom: 0 },
    });

    const loaded = await roundTrip(slider, [
      'res://ui/track.png',
      'res://ui/fill.png',
      'res://ui/thumb.png',
    ]);

    expect(loaded.textureTrack?.url).toBe('res://ui/track.png');
    expect(loaded.textureFill?.url).toBe('res://ui/fill.png');
    expect(loaded.textureThumb?.url).toBe('res://ui/thumb.png');
    expect(loaded.sliceBorder).toEqual({ left: 10, right: 10, top: 0, bottom: 0 });
  });

  it('adds no keys for an unskinned slider', () => {
    const yaml = serialize(new Slider2D({ id: 'sl', name: 'Volume' }));

    expect(yaml).not.toContain('textureTrack');
    expect(yaml).not.toContain('textureFill');
    expect(yaml).not.toContain('textureThumb');
    expect(yaml).not.toContain('sliceBorder');
  });
});

describe('Bar2D skin persistence', () => {
  it('round-trips the trough/fill sprites and the border', async () => {
    const bar = new Bar2D({
      id: 'bar',
      name: 'HP',
      value: 42,
      textureTrough: 'res://ui/trough.png',
      textureFill: 'res://ui/hp_fill.png',
      sliceBorder: { left: 14, right: 14, top: 4, bottom: 4 },
    });

    const loaded = await roundTrip(bar, ['res://ui/trough.png', 'res://ui/hp_fill.png']);

    expect(loaded.textureTrough?.url).toBe('res://ui/trough.png');
    expect(loaded.textureFill?.url).toBe('res://ui/hp_fill.png');
    expect(loaded.sliceBorder).toEqual({ left: 14, right: 14, top: 4, bottom: 4 });
    expect(loaded.value).toBe(42);
  });

  it('adds no keys for an unskinned bar', () => {
    const yaml = serialize(new Bar2D({ id: 'bar', name: 'HP' }));

    expect(yaml).not.toContain('textureTrough');
    expect(yaml).not.toContain('textureFill');
    expect(yaml).not.toContain('sliceBorder');
  });
});
