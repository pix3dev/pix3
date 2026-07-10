import { describe, expect, it } from 'vitest';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { Camera2D } from '../nodes/2D/Camera2D';

function makeLoader(): SceneLoader {
  return new SceneLoader(
    new AssetLoader(new ResourceManager('/'), new AudioService()),
    new ScriptRegistry(),
    new ResourceManager('/')
  );
}

describe('Camera2D scene persistence', () => {
  it('round-trips all authored configuration', async () => {
    const cam = new Camera2D({
      id: 'cam-1',
      name: 'Game Cam',
      priority: 42,
      zoom: 1.5,
      offset: { x: 4, y: -3 },
      followTargetId: 'hero',
      followDamping: 5,
      followOffset: { x: 0, y: 20 },
      deadzone: { x: 10, y: 6 },
      limitsEnabled: true,
      limitsCenter: { x: 100, y: 50 },
      limitsSize: { x: 2000, y: 1500 },
      shakeAmplitude: 12,
      shakeFrequency: 30,
      shakeDuration: 0.5,
      shakeDecay: 2,
    });

    const saver = new SceneSaver();
    const yaml = saver.serializeScene({
      version: '1.0.0',
      metadata: {},
      rootNodes: [cam],
      nodeMap: new Map([[cam.nodeId, cam]]),
    });

    expect(yaml).toContain('type: Camera2D');
    expect(yaml).toContain('priority: 42');

    const graph = await makeLoader().parseScene(yaml, {
      filePath: 'res://scenes/main.pix3scene',
    });
    const loaded = graph.rootNodes[0] as Camera2D;

    expect(loaded).toBeInstanceOf(Camera2D);
    const config = loaded.serializeConfig();
    expect(config.priority).toBe(42);
    expect(config.zoom).toBe(1.5);
    expect(config.offset).toEqual([4, -3]);
    expect(config.followTargetId).toBe('hero');
    expect(config.followDamping).toBe(5);
    expect(config.followOffset).toEqual([0, 20]);
    expect(config.deadzone).toEqual([10, 6]);
    expect(config.limitsEnabled).toBe(true);
    expect(config.limitsCenter).toEqual([100, 50]);
    expect(config.limitsSize).toEqual([2000, 1500]);
    expect(config.shakeAmplitude).toBe(12);
    expect(config.shakeFrequency).toBe(30);
    expect(config.shakeDuration).toBe(0.5);
    expect(config.shakeDecay).toBe(2);
  });

  it('applies defaults for a freshly created 2D camera', async () => {
    const cam = new Camera2D({ id: 'cam-default', name: 'Cam' });

    const saver = new SceneSaver();
    const yaml = saver.serializeScene({
      version: '1.0.0',
      metadata: {},
      rootNodes: [cam],
      nodeMap: new Map([[cam.nodeId, cam]]),
    });

    const graph = await makeLoader().parseScene(yaml, {
      filePath: 'res://scenes/main.pix3scene',
    });
    const loaded = graph.rootNodes[0] as Camera2D;

    expect(loaded.priority).toBe(10);
    expect(loaded.zoom).toBe(1);
    const config = loaded.serializeConfig();
    expect(config.limitsEnabled).toBe(false);
    expect(config.limitsSize).toEqual([1000, 1000]);
  });
});
