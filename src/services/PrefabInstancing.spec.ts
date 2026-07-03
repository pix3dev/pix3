import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  AssetLoader,
  AudioService,
  NodeBase,
  ResourceManager,
  SceneLoader,
  SceneSaver,
  SceneValidationError,
  ScriptRegistry,
  registerBuiltInScripts,
} from '@pix3/runtime';

function collectSubtree(root: NodeBase): NodeBase[] {
  const out: NodeBase[] = [root];
  for (const child of root.children) {
    if (child instanceof NodeBase) {
      out.push(...collectSubtree(child));
    }
  }
  return out;
}

class InMemoryResourceManager extends ResourceManager {
  private readonly files: Record<string, string>;

  constructor(files: Record<string, string>) {
    super('/');
    this.files = files;
  }

  override async readText(resource: string): Promise<string> {
    const normalized = resource.replace(/\\/g, '/');
    const value = this.files[normalized];
    if (typeof value !== 'string') {
      throw new Error(`Missing in-memory resource: ${resource}`);
    }
    return value;
  }

  override normalize(resource: string): string {
    return resource.replace(/\\/g, '/');
  }
}

function createLoader(files: Record<string, string>): SceneLoader {
  const resources = new InMemoryResourceManager(files);
  const scriptRegistry = new ScriptRegistry();
  registerBuiltInScripts(scriptRegistry);
  const audioService = new AudioService();
  const assetLoader = new AssetLoader(resources, audioService);
  return new SceneLoader(assetLoader, scriptRegistry, resources);
}

describe('Prefab scene instancing', () => {
  it('applies root properties and child overrides on instance load', async () => {
    const prefabText = `
version: 1.0.0
root:
  - id: player-root
    type: Node3D
    properties:
      position: { x: 1, y: 2, z: 3 }
    children:
      - id: weapon
        type: Node3D
        properties:
          visible: true
`;

    const sceneText = `
version: 1.0.0
root:
  - id: player-instance
    instance: res://prefabs/player.pix3scene
    properties:
      position: { x: 10, y: 0, z: 0 }
    overrides:
      byLocalId:
        weapon:
          properties:
            visible: false
`;

    const loader = createLoader({
      'res://prefabs/player.pix3scene': prefabText,
    });

    const graph = await loader.parseScene(sceneText, { filePath: 'res://scenes/main.pix3scene' });
    const instanceRoot = graph.rootNodes[0];
    expect(instanceRoot.instancePath).toBe('res://prefabs/player.pix3scene');
    expect(instanceRoot.position.x).toBe(10);

    const weapon = instanceRoot.children.find(child => child.nodeId.startsWith('weapon'));
    expect(weapon).toBeDefined();
    expect(weapon?.visible).toBe(false);
  });

  it('remaps component node references to runtime node ids', async () => {
    const prefabText = `
version: 1.0.0
root:
  - id: player-root
    type: Node3D
    components:
      - type: core:PinToNode
        config:
          targetNodeId: weapon
    children:
      - id: weapon
        type: Node3D
`;

    const sceneText = `
version: 1.0.0
root:
  - id: player-instance
    instance: res://prefabs/player.pix3scene
`;

    const loader = createLoader({
      'res://prefabs/player.pix3scene': prefabText,
    });

    const graph = await loader.parseScene(sceneText, { filePath: 'res://scenes/main.pix3scene' });
    const root = graph.rootNodes[0];
    const weapon = root.children.find(child => child.nodeId.startsWith('weapon'));
    expect(weapon).toBeDefined();

    const component = root.components[0] as { targetNodeId?: string };
    expect(component.targetNodeId).toBeDefined();
    expect(component.targetNodeId).toBe(weapon?.nodeId);
  });

  it('serializes instance overrides as root properties + byLocalId child diff', async () => {
    const prefabText = `
version: 1.0.0
root:
  - id: player-root
    type: Node3D
    properties:
      position: { x: 0, y: 0, z: 0 }
    children:
      - id: weapon
        type: Node3D
        properties:
          visible: true
`;

    const sceneText = `
version: 1.0.0
root:
  - id: player-instance
    instance: res://prefabs/player.pix3scene
    properties:
      position: { x: 3, y: 4, z: 5 }
    overrides:
      byLocalId:
        weapon:
          properties:
            visible: false
`;

    const loader = createLoader({
      'res://prefabs/player.pix3scene': prefabText,
    });
    const graph = await loader.parseScene(sceneText, { filePath: 'res://scenes/main.pix3scene' });
    const saver = new SceneSaver();
    const savedText = saver.serializeScene(graph);
    const savedDoc = parseYaml(savedText) as {
      root: Array<{
        properties?: Record<string, unknown>;
        overrides?: { byLocalId: Record<string, { properties?: Record<string, unknown> }> };
        children?: unknown[];
      }>;
    };

    const root = savedDoc.root[0];
    expect(root.children).toBeUndefined();
    expect(root.properties?.position).toEqual({ x: 3, y: 4, z: 5 });
    expect(root.overrides?.byLocalId?.weapon?.properties?.visible).toBe(false);
  });

  it('throws SceneValidationError on cyclical instance dependencies', async () => {
    const loader = createLoader({
      'res://prefabs/a.pix3scene': `
version: 1.0.0
root:
  - id: a-root
    instance: res://prefabs/b.pix3scene
`,
      'res://prefabs/b.pix3scene': `
version: 1.0.0
root:
  - id: b-root
    instance: res://prefabs/a.pix3scene
`,
    });

    const sceneText = `
version: 1.0.0
root:
  - id: top
    instance: res://prefabs/a.pix3scene
`;

    await expect(
      loader.parseScene(sceneText, { filePath: 'res://scenes/main.pix3scene' })
    ).rejects.toBeInstanceOf(SceneValidationError);
  });

  it('re-applies root + child overrides after a serialize -> parse round-trip (Refresh path)', async () => {
    const prefabText = `
version: 1.0.0
root:
  - id: player-root
    type: Node3D
    properties:
      position: { x: 0, y: 0, z: 0 }
    children:
      - id: weapon
        type: Node3D
        properties:
          visible: true
`;

    const sceneText = `
version: 1.0.0
root:
  - id: player-instance
    instance: res://prefabs/player.pix3scene
    properties:
      position: { x: 3, y: 4, z: 5 }
    overrides:
      byLocalId:
        weapon:
          properties:
            visible: false
`;

    const loader = createLoader({ 'res://prefabs/player.pix3scene': prefabText });
    const graph = await loader.parseScene(sceneText, { filePath: 'res://scenes/main.pix3scene' });

    // Mimic RefreshPrefabInstancesOperation: serialize the live graph then
    // re-parse it. Overrides must survive this trip or Refresh silently reverts.
    const saver = new SceneSaver();
    const reloaded = await loader.parseScene(saver.serializeScene(graph), {
      filePath: 'res://scenes/main.pix3scene',
    });

    const reloadedRoot = reloaded.rootNodes[0];
    expect(reloadedRoot.position.x).toBe(3);
    const reloadedWeapon = reloadedRoot.children.find(child => child.nodeId.startsWith('weapon'));
    expect(reloadedWeapon?.visible).toBe(false);
  });

  it('preserves deep child overrides for nested prefabs that reuse the root id', async () => {
    // Both prefabs use the generic root id "root"; this is the case where the
    // saver's prefix strip and the loader's prefix re-add previously disagreed.
    const innerPrefab = `
version: 1.0.0
root:
  - id: root
    type: Node3D
    children:
      - id: child
        type: Node3D
        properties:
          visible: true
`;
    const outerPrefab = `
version: 1.0.0
root:
  - id: root
    type: Node3D
    children:
      - id: nested
        instance: res://prefabs/inner.pix3scene
`;
    const sceneText = `
version: 1.0.0
root:
  - id: inst
    instance: res://prefabs/outer.pix3scene
`;

    const loader = createLoader({
      'res://prefabs/inner.pix3scene': innerPrefab,
      'res://prefabs/outer.pix3scene': outerPrefab,
    });

    const graph = await loader.parseScene(sceneText, { filePath: 'res://scenes/main.pix3scene' });

    // The single leaf is the deepest grandchild ("child"). Override it, then
    // round-trip through the saver.
    const leaf = collectSubtree(graph.rootNodes[0]).find(node => node.children.length === 0);
    expect(leaf).toBeDefined();
    expect(leaf?.visible).toBe(true);
    leaf!.visible = false;

    const saver = new SceneSaver();
    const reloaded = await loader.parseScene(saver.serializeScene(graph), {
      filePath: 'res://scenes/main.pix3scene',
    });

    const reloadedLeaf = collectSubtree(reloaded.rootNodes[0]).find(
      node => node.children.length === 0
    );
    expect(reloadedLeaf?.visible).toBe(false);
  });

  it('mints unique runtime ids for prefab children whose ids collide after normalization', async () => {
    // "Weapon" and "weapon" are distinct (case-sensitive) prefab ids, but both
    // normalize to "weapon" during cloning; without id reservation the second
    // clone reused the id and the whole load threw a duplicate-id error.
    const prefabText = `
version: 1.0.0
root:
  - id: root
    type: Node3D
    children:
      - id: Weapon
        type: Node3D
      - id: weapon
        type: Node3D
`;
    const sceneText = `
version: 1.0.0
root:
  - id: inst
    instance: res://prefabs/p.pix3scene
`;

    const loader = createLoader({ 'res://prefabs/p.pix3scene': prefabText });
    const graph = await loader.parseScene(sceneText, { filePath: 'res://scenes/main.pix3scene' });

    const childIds = graph.rootNodes[0].children.map(child => child.nodeId);
    expect(childIds).toHaveLength(2);
    expect(new Set(childIds).size).toBe(2);
  });
});
