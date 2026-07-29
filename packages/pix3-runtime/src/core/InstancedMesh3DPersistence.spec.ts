import { describe, expect, it } from 'vitest';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { InstancedMesh3D } from '../nodes/3D/InstancedMesh3D';

describe('InstancedMesh3D scene persistence', () => {
  it('serializes and parses stable instancing configuration', async () => {
    const node = new InstancedMesh3D({
      id: 'crowd',
      name: 'Crowd',
      maxInstances: 256,
      castShadow: true,
      receiveShadow: true,
      enablePerInstanceColor: true,
    });
    node.position.set(1, 2, 3);

    const saver = new SceneSaver();
    const yaml = saver.serializeScene({
      version: '1.0.0',
      metadata: {},
      rootNodes: [node],
      nodeMap: new Map([[node.nodeId, node]]),
    });

    expect(yaml).toContain('type: InstancedMesh3D');
    expect(yaml).toContain('maxInstances: 256');
    expect(yaml).not.toContain('visibleInstanceCount');

    const loader = new SceneLoader(
      new AssetLoader(new ResourceManager('/'), new AudioService()),
      new ScriptRegistry(),
      new ResourceManager('/')
    );
    const graph = await loader.parseScene(yaml, { filePath: 'res://scenes/main.pix3scene' });
    const loaded = graph.rootNodes[0];

    expect(loaded).toBeInstanceOf(InstancedMesh3D);

    const instanced = loaded as InstancedMesh3D;
    expect(instanced.maxInstances).toBe(256);
    expect(instanced.mesh.castShadow).toBe(true);
    expect(instanced.mesh.receiveShadow).toBe(true);
    expect(instanced.enablePerInstanceColor).toBe(true);
    expect(instanced.position.toArray()).toEqual([1, 2, 3]);
  });
});
