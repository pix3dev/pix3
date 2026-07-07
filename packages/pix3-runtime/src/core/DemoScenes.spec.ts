import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { Texture } from 'three';

import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { ScriptRegistry } from './ScriptRegistry';
import { registerBuiltInScripts } from '../behaviors/register-behaviors';

/**
 * Parse-check for the HelloWorld demo scenes. These are hand-authored YAML, so
 * this guards against schema drift breaking them: every demo must load through
 * the real SceneLoader with the built-in scripts registered.
 */
function demoPath(file: string): string {
  // Vitest runs from the repo root; samples/HelloWorld lives under it.
  return resolve(process.cwd(), 'samples/HelloWorld', file);
}

function createLoader(preloadTextures: string[] = []): SceneLoader {
  const assetLoader = new AssetLoader(new ResourceManager('/'), new AudioService());
  const cache = (assetLoader as unknown as { textureCache: Map<string, Texture> }).textureCache;
  for (const url of preloadTextures) {
    cache.set(url, new Texture());
  }
  const registry = new ScriptRegistry();
  registerBuiltInScripts(registry);
  return new SceneLoader(assetLoader, registry, new ResourceManager('/'));
}

async function loadDemo(file: string, textures: string[] = []) {
  const yaml = readFileSync(demoPath(file), 'utf8');
  return createLoader(textures).parseScene(yaml, { filePath: `res://scenes/${file}` });
}

function typesInTree(nodes: readonly { type: string; children?: unknown[] }[]): Set<string> {
  const found = new Set<string>();
  const walk = (list: readonly { type: string; children?: unknown[] }[]) => {
    for (const n of list) {
      found.add(n.type);
      if (Array.isArray(n.children)) {
        walk(n.children as { type: string; children?: unknown[] }[]);
      }
    }
  };
  walk(nodes);
  return found;
}

describe('HelloWorld demo scenes', () => {
  it('demo 01 — primitives, materials & lights', async () => {
    const graph = await loadDemo('demo-01-primitives-materials.pix3scene');
    const types = typesInTree(graph.rootNodes);
    expect(types).toContain('GeometryMesh');
    // Light nodes report the runtime type string (no "Node" suffix).
    expect(types).toContain('DirectionalLight');
    expect(types).toContain('PointLight');
    expect(types).toContain('SpotLight');
    expect(types).toContain('HemisphereLight');
    expect(types).toContain('AmbientLight');
  });

  it('demo 02 — cinematic camera (vcam + brain)', async () => {
    const graph = await loadDemo('demo-02-cinematic-camera.pix3scene');
    const types = typesInTree(graph.rootNodes);
    expect(types).toContain('VirtualCamera3D');
    expect(types).toContain('Camera3D');
    // The render camera must carry the CameraBrain component.
    const brainHost = graph.nodeMap.get('render-camera');
    expect(brainHost?.components.some(c => c.type === 'core:CameraBrain')).toBe(true);
  });

  it('demo 03 — animation timeline', async () => {
    const graph = await loadDemo('demo-03-animation-timeline.pix3scene');
    const root = graph.nodeMap.get('anim-root');
    expect(root?.components.some(c => c.type === 'core:AnimationPlayer')).toBe(true);
  });

  it('demo 04 — post-processing', async () => {
    const graph = await loadDemo('demo-04-post-processing.pix3scene');
    expect(typesInTree(graph.rootNodes)).toContain('PostProcess');
  });

  it('demo 05 — juice', async () => {
    const graph = await loadDemo('demo-05-juice.pix3scene');
    const hero = graph.nodeMap.get('juice-hero');
    expect(hero?.components.some(c => c.type === 'core:PunchScale')).toBe(true);
    expect(hero?.components.some(c => c.type === 'core:AnimationPlayer')).toBe(true);
  });

  it('demo 06 — 2D UI (structure)', () => {
    // The label/button controls build canvas-backed text textures on
    // construction, which happy-dom can't provide ("no 2D context"). That's an
    // env limitation, not a scene bug — so validate the authored structure by
    // parsing the YAML rather than constructing the nodes.
    const doc = parseYaml(readFileSync(demoPath('demo-06-2d-ui.pix3scene'), 'utf8')) as {
      root: { type: string; children?: unknown[] }[];
    };
    const types = typesInTree(doc.root);
    expect(types).toContain('Group2D');
    expect(types).toContain('Button2D');
    expect(types).toContain('Slider2D');
    expect(types).toContain('Bar2D');
    expect(types).toContain('Checkbox2D');
    expect(types).toContain('Label2D');
    expect(types).toContain('Sprite2D');
    expect(types).toContain('ColorRect2D');
  });
});
