import { describe, expect, it } from 'vitest';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { PostProcess } from '../nodes/PostProcess';

function makeLoader(): SceneLoader {
  return new SceneLoader(
    new AssetLoader(new ResourceManager('/'), new AudioService()),
    new ScriptRegistry(),
    new ResourceManager('/')
  );
}

describe('PostProcess scene persistence', () => {
  it('round-trips all authored configuration', async () => {
    const pp = new PostProcess({
      id: 'pp-1',
      name: 'Cinematic FX',
      affect2D: false,
      bloomEnabled: true,
      bloomIntensity: 1.75,
      bloomThreshold: 0.65,
      bloomSmoothing: 0.05,
      bloomRadius: 0.7,
      vignetteEnabled: true,
      vignetteOffset: 0.45,
      vignetteDarkness: 0.8,
      chromaticAberrationEnabled: true,
      chromaticAberrationOffset: 0.0035,
      lutEnabled: true,
      lutSrc: 'res://luts/warm.cube',
      lutIntensity: 0.6,
    });

    const saver = new SceneSaver();
    const yaml = saver.serializeScene({
      version: '1.0.0',
      metadata: {},
      rootNodes: [pp],
      nodeMap: new Map([[pp.nodeId, pp]]),
    });

    expect(yaml).toContain('type: PostProcess');
    expect(yaml).toContain('bloomIntensity: 1.75');
    expect(yaml).toContain('lutSrc: res://luts/warm.cube');

    const graph = await makeLoader().parseScene(yaml, {
      filePath: 'res://scenes/main.pix3scene',
    });
    const loaded = graph.rootNodes[0] as PostProcess;

    expect(loaded).toBeInstanceOf(PostProcess);
    const config = loaded.serializeConfig();
    expect(config).toEqual({
      affect2D: false,
      bloomEnabled: true,
      bloomIntensity: 1.75,
      bloomThreshold: 0.65,
      bloomSmoothing: 0.05,
      bloomRadius: 0.7,
      vignetteEnabled: true,
      vignetteOffset: 0.45,
      vignetteDarkness: 0.8,
      chromaticAberrationEnabled: true,
      chromaticAberrationOffset: 0.0035,
      lutEnabled: true,
      lutSrc: 'res://luts/warm.cube',
      lutIntensity: 0.6,
    });
    expect(loaded.isActive()).toBe(true);
  });

  it('applies defaults for a freshly created node', async () => {
    const pp = new PostProcess({ id: 'pp-default', name: 'PostFX' });

    const saver = new SceneSaver();
    const yaml = saver.serializeScene({
      version: '1.0.0',
      metadata: {},
      rootNodes: [pp],
      nodeMap: new Map([[pp.nodeId, pp]]),
    });

    const graph = await makeLoader().parseScene(yaml, {
      filePath: 'res://scenes/main.pix3scene',
    });
    const loaded = graph.rootNodes[0] as PostProcess;

    expect(loaded.affect2D).toBe(true);
    expect(loaded.bloomEnabled).toBe(true);
    expect(loaded.bloomIntensity).toBe(1);
    expect(loaded.vignetteEnabled).toBe(false);
  });
});
