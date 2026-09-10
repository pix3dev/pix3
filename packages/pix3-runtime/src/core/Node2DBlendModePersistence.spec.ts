import {
  AdditiveBlending,
  Mesh,
  MeshBasicMaterial,
  MultiplyBlending,
  NormalBlending,
  Scene,
} from 'three';
import { describe, expect, it } from 'vitest';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { Batch2DSystem, type OrderedMesh2D } from './batch-2d';
import { Group2D } from '../nodes/2D/Group2D';
import { Sprite2D } from '../nodes/2D/Sprite2D';
import { Node2D } from '../nodes/Node2D';

function findSetter(name: string): (node: unknown, value: unknown) => void {
  const def = Node2D.getPropertySchema().properties.find(p => p.name === name);
  if (!def) {
    throw new Error(`Node2D schema is missing "${name}"`);
  }
  return def.setValue;
}

function spriteMaterial(sprite: Sprite2D): MeshBasicMaterial {
  const mesh = sprite.children.find(child => child instanceof Mesh) as Mesh | undefined;
  if (!mesh || !(mesh.material instanceof MeshBasicMaterial)) {
    throw new Error('Sprite2D has no MeshBasicMaterial');
  }
  return mesh.material;
}

async function roundTrip(root: Node2D): Promise<{ yaml: string; loaded: Node2D }> {
  const nodeMap = new Map<string, Node2D>();
  root.traverse(obj => {
    if (obj instanceof Node2D) {
      nodeMap.set(obj.nodeId, obj);
    }
  });

  const yaml = new SceneSaver().serializeScene({
    version: '1.0.0',
    metadata: {},
    rootNodes: [root],
    nodeMap,
  });

  const loader = new SceneLoader(
    new AssetLoader(new ResourceManager('/'), new AudioService()),
    new ScriptRegistry(),
    new ResourceManager('/')
  );
  const graph = await loader.parseScene(yaml, { filePath: 'res://scenes/main.pix3scene' });
  return { yaml, loaded: graph.rootNodes[0] as Node2D };
}

describe('Node2D blend mode', () => {
  it('applies the mode to the node’s own materials', () => {
    const sprite = new Sprite2D({ id: 'glow', name: 'Glow' });
    expect(spriteMaterial(sprite).blending).toBe(NormalBlending);

    findSetter('blendMode')(sprite, 'additive');
    expect(spriteMaterial(sprite).blending).toBe(AdditiveBlending);
    // three.js falls back to NoBlending for an opaque material, so a blended
    // node must stay transparent whatever its opacity is.
    expect(spriteMaterial(sprite).transparent).toBe(true);

    findSetter('blendMode')(sprite, 'multiply');
    expect(spriteMaterial(sprite).blending).toBe(MultiplyBlending);

    findSetter('blendMode')(sprite, 'normal');
    expect(spriteMaterial(sprite).blending).toBe(NormalBlending);
  });

  it('does not inherit the parent’s mode', () => {
    const group = new Group2D({ id: 'fx', name: 'FX' });
    const child = new Sprite2D({ id: 'child', name: 'Child' });
    group.add(child);

    group.blendMode = 'additive';

    expect(child.blendMode).toBe('normal');
    expect(spriteMaterial(child).blending).toBe(NormalBlending);
  });

  it('survives an opacity change (both own material.transparent)', () => {
    const sprite = new Sprite2D({ id: 'glow', name: 'Glow' });
    sprite.blendMode = 'additive';

    sprite.opacity = 0.5;
    expect(spriteMaterial(sprite).blending).toBe(AdditiveBlending);
    expect(spriteMaterial(sprite).opacity).toBeCloseTo(0.5);

    sprite.opacity = 1;
    expect(spriteMaterial(sprite).blending).toBe(AdditiveBlending);
    expect(spriteMaterial(sprite).transparent).toBe(true);
  });

  it('ignores an unknown authored value', () => {
    const sprite = new Sprite2D({ id: 'glow', name: 'Glow', properties: { blendMode: 'screen' } });
    expect(sprite.blendMode).toBe('normal');
  });

  it('opts a blended sprite out of the 2D quad batcher', () => {
    const a = new Sprite2D({ id: 'a', name: 'A' });
    const b = new Sprite2D({ id: 'b', name: 'B' });
    const entries = (): OrderedMesh2D[] =>
      [a, b].map((sprite, index) => {
        const mesh = sprite.children.find(child => child instanceof Mesh) as Mesh;
        mesh.updateMatrixWorld(true);
        return { mesh, order: index, overlay: false, visible: true };
      });

    // Same (absent) texture source: the default blend merges them into one draw.
    const system = new Batch2DSystem(new Scene());
    system.update(entries());
    expect(system.stats.batches).toBe(1);

    a.blendMode = 'additive';
    b.blendMode = 'additive';
    system.update(entries());
    expect(system.stats.batches).toBe(0);
    expect(system.stats.passthrough).toBe(2);
  });

  it('round-trips through the scene file and keeps the default out of YAML', async () => {
    const group = new Group2D({ id: 'fx', name: 'FX' });
    const glow = new Sprite2D({ id: 'glow', name: 'Glow' });
    const plain = new Sprite2D({ id: 'plain', name: 'Plain' });
    group.add(glow);
    group.add(plain);

    findSetter('blendMode')(glow, 'additive');

    const { yaml, loaded } = await roundTrip(group);
    const children = loaded.children.filter(child => child instanceof Sprite2D) as Sprite2D[];
    const loadedGlow = children.find(child => child.name === 'Glow');
    const loadedPlain = children.find(child => child.name === 'Plain');

    expect(loadedGlow?.blendMode).toBe('additive');
    expect(loadedGlow ? spriteMaterial(loadedGlow).blending : null).toBe(AdditiveBlending);
    expect(loadedPlain?.blendMode).toBe('normal');
    expect(yaml.match(/blendMode/g)).toHaveLength(1);
  });
});
