import { describe, expect, it } from 'vitest';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { SpineSkeleton2D } from '../nodes/2D/SpineSkeleton2D';

function findSetter(name: string): (node: unknown, value: unknown) => void {
  const def = SpineSkeleton2D.getPropertySchema().properties.find(p => p.name === name);
  if (!def) {
    throw new Error(`SpineSkeleton2D schema is missing "${name}"`);
  }
  return def.setValue;
}

async function roundTrip(node: SpineSkeleton2D): Promise<SpineSkeleton2D> {
  const yaml = new SceneSaver().serializeScene({
    version: '1.0.0',
    metadata: {},
    rootNodes: [node],
    nodeMap: new Map([[node.nodeId, node]]),
  });

  const loader = new SceneLoader(
    new AssetLoader(new ResourceManager('/'), new AudioService()),
    new ScriptRegistry(),
    new ResourceManager('/')
  );
  const graph = await loader.parseScene(yaml, { filePath: 'res://scenes/main.pix3scene' });
  return graph.rootNodes[0] as SpineSkeleton2D;
}

describe('SpineSkeleton2D scene persistence', () => {
  it('round-trips the authored asset paths and playback state', async () => {
    const node = new SpineSkeleton2D({
      id: 'hero',
      name: 'Hero',
      skeletonPath: 'res://spine/hero.json',
      atlasPath: 'res://spine/hero.atlas',
      animation: 'run',
      loop: false,
      isPlaying: false,
      skin: 'blue',
      timeScale: 1.5,
      defaultMix: 0.2,
      color: '#ff8800',
      twoColorTint: true,
      freeOnFinish: true,
      previewInEditor: true,
    });

    const loaded = await roundTrip(node);

    expect(loaded.skeletonPath).toBe('res://spine/hero.json');
    expect(loaded.atlasPath).toBe('res://spine/hero.atlas');
    expect(loaded.animation).toBe('run');
    expect(loaded.loop).toBe(false);
    expect(loaded.isPlaying).toBe(false);
    expect(loaded.skin).toBe('blue');
    expect(loaded.timeScale).toBeCloseTo(1.5);
    expect(loaded.defaultMix).toBeCloseTo(0.2);
    expect(loaded.color).toBe('#ff8800');
    expect(loaded.twoColorTint).toBe(true);
    expect(loaded.freeOnFinish).toBe(true);
    expect(loaded.previewInEditor).toBe(true);
  });

  it('persists inspector edits made through the property schema', async () => {
    // Entering play mode serializes the live graph and re-parses it, so a setter
    // that only mutates instance fields would silently lose the edit unless the
    // SceneSaver branch reads the instance (not the construction-time props).
    const node = new SpineSkeleton2D({ id: 'hero', name: 'Hero' });

    findSetter('skeletonPath')(node, 'res://spine/boss.skel');
    findSetter('atlasPath')(node, 'res://spine/boss.atlas');
    findSetter('animation')(node, 'attack');
    findSetter('loop')(node, false);
    findSetter('timeScale')(node, 0.5);
    findSetter('texture')(node, 'res://spine/boss.png');

    const loaded = await roundTrip(node);

    expect(loaded.skeletonPath).toBe('res://spine/boss.skel');
    expect(loaded.atlasPath).toBe('res://spine/boss.atlas');
    expect(loaded.animation).toBe('attack');
    expect(loaded.loop).toBe(false);
    expect(loaded.timeScale).toBeCloseTo(0.5);
    expect(loaded.texturePath).toBe('res://spine/boss.png');
  });

  it('omits defaults and cleared paths from the serialized properties', async () => {
    const node = new SpineSkeleton2D({ id: 'hero', name: 'Hero' });

    const loaded = await roundTrip(node);

    expect(loaded.skeletonPath).toBeNull();
    expect(loaded.atlasPath).toBeNull();
    expect(loaded.texturePath).toBeNull();
    expect(loaded.animation).toBe('');
    expect(loaded.properties.freeOnFinish).toBeUndefined();
    expect(loaded.properties.twoColorTint).toBeUndefined();
    expect(loaded.properties.previewInEditor).toBeUndefined();
    // Defaults that DO round-trip, so a prefab override diff sees a stable shape.
    expect(loaded.loop).toBe(true);
    expect(loaded.isPlaying).toBe(true);
    expect(loaded.timeScale).toBe(1);
  });

  it('keeps the asset request null until both required paths are set', () => {
    const node = new SpineSkeleton2D({ id: 'hero', name: 'Hero' });
    expect(node.getAssetRequest()).toBeNull();

    node.skeletonPath = 'res://spine/hero.json';
    expect(node.getAssetRequest()).toBeNull();

    node.atlasPath = 'res://spine/hero.atlas';
    expect(node.getAssetRequest()).toEqual({
      skeletonPath: 'res://spine/hero.json',
      atlasPath: 'res://spine/hero.atlas',
      texturePath: null,
    });
  });
});
