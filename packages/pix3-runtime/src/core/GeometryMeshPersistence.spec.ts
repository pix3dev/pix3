import { describe, expect, it } from 'vitest';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { GeometryMesh } from '../nodes/3D/GeometryMesh';

function makeLoader(): SceneLoader {
  return new SceneLoader(
    new AssetLoader(new ResourceManager('/'), new AudioService()),
    new ScriptRegistry(),
    new ResourceManager('/')
  );
}

function serialize(node: GeometryMesh): string {
  return new SceneSaver().serializeScene({
    version: '1.0.0',
    metadata: {},
    rootNodes: [node],
    nodeMap: new Map([[node.nodeId, node]]),
  });
}

/** Read a schema property the way the inspector does. */
function getProp(node: GeometryMesh, name: string): unknown {
  const def = GeometryMesh.getPropertySchema().properties.find(p => p.name === name);
  if (!def) throw new Error(`no such property: ${name}`);
  return def.getValue(node);
}

function setProp(node: GeometryMesh, name: string, value: unknown): void {
  const def = GeometryMesh.getPropertySchema().properties.find(p => p.name === name);
  if (!def) throw new Error(`no such property: ${name}`);
  def.setValue(node, value);
}

describe('GeometryMesh material persistence', () => {
  it('persists an inspector color edit through save + reload (regression: play-mode color)', async () => {
    // Authored with magenta, like the startup scene.
    const mesh = new GeometryMesh({
      id: 'demo-box',
      name: 'Demo Box',
      geometry: 'box',
      size: [1, 1, 1],
      material: { color: '#ff00ff' },
    });

    // The inspector mutates the LIVE three.js material in place — it does NOT
    // touch node.properties. Before the fix, the saver read the stale
    // node.properties and this edit was lost in the serialize->parse play clone.
    setProp(mesh, 'color', '#00ff00');
    expect(getProp(mesh, 'color')).toBe('#00ff00');

    const yaml = serialize(mesh);
    expect(yaml).toContain('type: GeometryMesh');
    expect(yaml).toContain('#00ff00');
    expect(yaml).not.toContain('#ff00ff');

    const graph = await makeLoader().parseScene(yaml, {
      filePath: 'res://scenes/main.pix3scene',
    });
    const loaded = graph.rootNodes[0] as GeometryMesh;
    expect(loaded).toBeInstanceOf(GeometryMesh);
    expect(getProp(loaded, 'color')).toBe('#00ff00');
  });

  it('round-trips roughness and metalness (regression: dropped on load)', async () => {
    const mesh = new GeometryMesh({
      id: 'demo-box',
      name: 'Demo Box',
      geometry: 'box',
      size: [2, 3, 4],
      material: { color: '#3366cc', roughness: 0.9, metalness: 0.1 },
    });

    expect(getProp(mesh, 'roughness')).toBeCloseTo(0.9);
    expect(getProp(mesh, 'metalness')).toBeCloseTo(0.1);

    const yaml = serialize(mesh);
    const graph = await makeLoader().parseScene(yaml, {
      filePath: 'res://scenes/main.pix3scene',
    });
    const loaded = graph.rootNodes[0] as GeometryMesh;

    expect(getProp(loaded, 'roughness')).toBeCloseTo(0.9);
    expect(getProp(loaded, 'metalness')).toBeCloseTo(0.1);
    expect(getProp(loaded, 'color')).toBe('#3366cc');
    expect(loaded.serializeConfig().size).toEqual([2, 3, 4]);
  });

  it('round-trips a non-box primitive shape and inspector shape switch', async () => {
    const mesh = new GeometryMesh({
      id: 'demo-sphere',
      name: 'Ball',
      geometry: 'sphere',
      size: [2, 2, 2],
      material: { color: '#ffffff' },
    });
    expect(getProp(mesh, 'geometry')).toBe('sphere');

    // Inspector switches the shape live.
    setProp(mesh, 'geometry', 'torus');
    expect(getProp(mesh, 'geometry')).toBe('torus');
    expect(mesh.geometryKind).toBe('torus');

    const yaml = serialize(mesh);
    expect(yaml).toContain('geometry: torus');

    const graph = await makeLoader().parseScene(yaml, {
      filePath: 'res://scenes/main.pix3scene',
    });
    const loaded = graph.rootNodes[0] as GeometryMesh;
    expect(getProp(loaded, 'geometry')).toBe('torus');
  });

  it('falls back to box for an unknown shape', () => {
    const mesh = new GeometryMesh({ id: 'x', geometry: 'teapot', size: [1, 1, 1] });
    expect(mesh.geometryKind).toBe('box');
  });
});
