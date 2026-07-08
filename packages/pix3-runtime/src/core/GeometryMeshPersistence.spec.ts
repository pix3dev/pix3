import { describe, expect, it } from 'vitest';
import { Texture } from 'three';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { GeometryMesh } from '../nodes/3D/GeometryMesh';

function makeLoader(preloadTextures: string[] = []): SceneLoader {
  const assetLoader = new AssetLoader(new ResourceManager('/'), new AudioService());
  const cache = (assetLoader as unknown as { textureCache: Map<string, Texture> }).textureCache;
  for (const url of preloadTextures) {
    cache.set(url, new Texture());
  }
  return new SceneLoader(assetLoader, new ScriptRegistry(), new ResourceManager('/'));
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

  it('round-trips a baked AO map + intensity and loads the texture', async () => {
    const aoSrc = 'res://lightmaps/demo/box.png';
    const mesh = new GeometryMesh({
      id: 'ao-box',
      name: 'AO Box',
      geometry: 'box',
      size: [1, 1, 1],
      material: { color: '#ffffff', aoMap: aoSrc, aoMapIntensity: 0.8 },
    });
    expect(mesh.aoMapSrc).toBe(aoSrc);
    expect(mesh.aoMapIntensity).toBeCloseTo(0.8);

    const yaml = serialize(mesh);
    expect(yaml).toContain(`aoMap: ${aoSrc}`);
    expect(yaml).toContain('aoMapIntensity: 0.8');

    const graph = await makeLoader([aoSrc]).parseScene(yaml, {
      filePath: 'res://scenes/main.pix3scene',
    });
    const loaded = graph.rootNodes[0] as GeometryMesh;
    expect(loaded.aoMapSrc).toBe(aoSrc);
    expect(loaded.aoMapIntensity).toBeCloseTo(0.8);
    // The AO texture was assigned and a dedicated lightmap UV set generated.
    const loadedMesh = loaded.children.find(c => (c as { isMesh?: boolean }).isMesh) as unknown as {
      material: { aoMap: Texture | null };
      geometry: { getAttribute(name: string): unknown };
    };
    expect(loadedMesh.material.aoMap).toBeInstanceOf(Texture);
    expect(loadedMesh.geometry.getAttribute('uv1')).toBeTruthy();
  });

  it('packs a box lightmap UV into six non-overlapping atlas cells', () => {
    const mesh = new GeometryMesh({
      id: 'ao-box2',
      geometry: 'box',
      size: [1, 1, 1],
      material: { color: '#ffffff' },
    });
    mesh.setAOMap(new Texture());
    const meshObj = mesh.children.find(c => (c as { isMesh?: boolean }).isMesh) as unknown as {
      geometry: { getAttribute(name: string): { getX(i: number): number; getY(i: number): number } };
    };
    const uv1 = meshObj.geometry.getAttribute('uv1');
    // Each face's 4 verts should land in one of the 3x2 atlas cells; collect the
    // distinct cell indices across all 24 verts — must be exactly 6.
    const cells = new Set<number>();
    for (let i = 0; i < 24; i += 1) {
      const col = Math.min(2, Math.floor(uv1.getX(i) * 3));
      const row = Math.min(1, Math.floor(uv1.getY(i) * 2));
      cells.add(row * 3 + col);
    }
    expect(cells.size).toBe(6);
  });
});
