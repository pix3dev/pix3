import { describe, expect, it } from 'vitest';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { VirtualCamera3D } from '../nodes/3D/VirtualCamera3D';

describe('VirtualCamera3D scene persistence', () => {
  it('round-trips all authored configuration', async () => {
    const vcam = new VirtualCamera3D({
      id: 'vcam-1',
      name: 'Intro Cam',
      priority: 42,
      fov: 55,
      followTargetId: 'hero',
      followDamping: 5,
      followOffset: { x: 0, y: 3, z: -8 },
      deadzone: { x: 1, y: 0.5, z: 0 },
      lookAtTargetId: 'hero',
      lookAtWeight: 0.75,
      rotationDamping: 6,
      confinerEnabled: true,
      confinerCenter: { x: 1, y: 2, z: 3 },
      confinerSize: { x: 20, y: 15, z: 30 },
      blendDuration: 2.5,
      blendEasing: 'expoOut',
    });

    const saver = new SceneSaver();
    const yaml = saver.serializeScene({
      version: '1.0.0',
      metadata: {},
      rootNodes: [vcam],
      nodeMap: new Map([[vcam.nodeId, vcam]]),
    });

    expect(yaml).toContain('type: VirtualCamera3D');
    expect(yaml).toContain('priority: 42');
    expect(yaml).toContain('blendEasing: expoOut');

    const loader = new SceneLoader(
      new AssetLoader(new ResourceManager('/'), new AudioService()),
      new ScriptRegistry(),
      new ResourceManager('/')
    );
    const graph = await loader.parseScene(yaml, { filePath: 'res://scenes/main.pix3scene' });
    const loaded = graph.rootNodes[0] as VirtualCamera3D;

    expect(loaded).toBeInstanceOf(VirtualCamera3D);
    const config = loaded.serializeConfig();
    expect(config.priority).toBe(42);
    expect(config.fov).toBe(55);
    expect(config.followTargetId).toBe('hero');
    expect(config.followDamping).toBe(5);
    expect(config.followOffset).toEqual([0, 3, -8]);
    expect(config.deadzone).toEqual([1, 0.5, 0]);
    expect(config.lookAtTargetId).toBe('hero');
    expect(config.lookAtWeight).toBe(0.75);
    expect(config.rotationDamping).toBe(6);
    expect(config.confinerEnabled).toBe(true);
    expect(config.confinerCenter).toEqual([1, 2, 3]);
    expect(config.confinerSize).toEqual([20, 15, 30]);
    expect(config.blendDuration).toBe(2.5);
    expect(config.blendEasing).toBe('expoOut');
  });

  it('applies defaults for a freshly created virtual camera', async () => {
    const vcam = new VirtualCamera3D({ id: 'vcam-default', name: 'VCam' });

    const saver = new SceneSaver();
    const yaml = saver.serializeScene({
      version: '1.0.0',
      metadata: {},
      rootNodes: [vcam],
      nodeMap: new Map([[vcam.nodeId, vcam]]),
    });

    const loader = new SceneLoader(
      new AssetLoader(new ResourceManager('/'), new AudioService()),
      new ScriptRegistry(),
      new ResourceManager('/')
    );
    const graph = await loader.parseScene(yaml, { filePath: 'res://scenes/main.pix3scene' });
    const loaded = graph.rootNodes[0] as VirtualCamera3D;

    expect(loaded.priority).toBe(10);
    expect(loaded.fov).toBe(60);
    expect(loaded.blendEasing).toBe('cubicInOut');
  });
});
