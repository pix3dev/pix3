import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  AssetLoader,
  AudioService,
  NodeBase,
  ResourceManager,
  SceneLoader,
  SceneManager,
  SceneSaver,
  ScriptRegistry,
  registerBuiltInScripts,
} from '@pix3/runtime';
import type { OperationContext } from '@/core/Operation';
import { createInitialAppState } from '@/state/AppState';
import { isPrefabInstanceRoot, getPrefabMetadata } from '@/features/scene/prefab-utils';
import { UnlinkPrefabInstanceOperation } from './UnlinkPrefabInstanceOperation';

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

function createSceneManager(files: Record<string, string>): SceneManager {
  const resources = new InMemoryResourceManager(files);
  const scriptRegistry = new ScriptRegistry();
  registerBuiltInScripts(scriptRegistry);
  const audioService = new AudioService();
  const assetLoader = new AssetLoader(resources, audioService);
  const loader = new SceneLoader(assetLoader, scriptRegistry, resources);
  return new SceneManager(loader, new SceneSaver());
}

const SCENE_ID = 'scene-1';

async function createHarness(files: Record<string, string>, sceneText: string) {
  const sceneManager = createSceneManager(files);
  const graph = await sceneManager.parseScene(sceneText, {
    filePath: 'res://scenes/main.pix3scene',
  });
  sceneManager.setActiveSceneGraph(SCENE_ID, graph);

  const state = createInitialAppState();
  state.scenes.activeSceneId = SCENE_ID;
  state.scenes.descriptors[SCENE_ID] = {
    id: SCENE_ID,
    filePath: 'res://scenes/main.pix3scene',
    name: 'Scene',
    version: '1.0.0',
    isDirty: false,
    lastSavedAt: null,
    fileHandle: null,
    lastModifiedTime: null,
  };

  const container = {
    getOrCreateToken: <T>(token: T): T => token,
    getService: <T>(token: unknown): T => {
      if (token === SceneManager) return sceneManager as T;
      throw new Error(`Unexpected token: ${String(token)}`);
    },
  };

  const context = {
    state,
    snapshot: {} as OperationContext['snapshot'],
    container: container as OperationContext['container'],
    requestedAt: Date.now(),
  } as OperationContext;

  return { sceneManager, graph, context };
}

function collectSubtree(root: NodeBase): NodeBase[] {
  const out: NodeBase[] = [root];
  for (const child of root.children) {
    if (child instanceof NodeBase) {
      out.push(...collectSubtree(child));
    }
  }
  return out;
}

const PLAYER_PREFAB = `
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

const SCENE_WITH_INSTANCE = `
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

describe('UnlinkPrefabInstanceOperation', () => {
  it('strips prefab markers so the instance serializes as plain nodes', async () => {
    const { sceneManager, graph, context } = await createHarness(
      { 'res://prefabs/player.pix3scene': PLAYER_PREFAB },
      SCENE_WITH_INSTANCE
    );

    const root = graph.rootNodes[0];
    expect(isPrefabInstanceRoot(root)).toBe(true);

    const result = await new UnlinkPrefabInstanceOperation({ nodeId: root.nodeId }).perform(
      context
    );
    expect(result.didMutate).toBe(true);

    // Every node in the subtree lost its prefab marker; the root lost instancePath.
    expect(root.instancePath).toBeNull();
    for (const node of collectSubtree(root)) {
      expect(getPrefabMetadata(node)).toBeNull();
    }

    const savedDoc = parseYaml(sceneManager.serializeScene(graph)) as {
      root: Array<{
        instance?: string;
        overrides?: unknown;
        children?: Array<{ properties?: Record<string, unknown> }>;
      }>;
    };
    const savedRoot = savedDoc.root[0];
    expect(savedRoot.instance).toBeUndefined();
    expect(savedRoot.overrides).toBeUndefined();
    // The former override value survives as a real property on the expanded child.
    expect(savedRoot.children).toHaveLength(1);
    expect(savedRoot.children?.[0]?.properties?.visible).toBe(false);
  });

  it('round-trips exactly on undo', async () => {
    const { sceneManager, graph, context } = await createHarness(
      { 'res://prefabs/player.pix3scene': PLAYER_PREFAB },
      SCENE_WITH_INSTANCE
    );

    const before = sceneManager.serializeScene(graph);
    const root = graph.rootNodes[0];

    const result = await new UnlinkPrefabInstanceOperation({ nodeId: root.nodeId }).perform(
      context
    );
    expect(result.commit).toBeDefined();

    await result.commit!.undo();
    expect(isPrefabInstanceRoot(root)).toBe(true);
    expect(root.instancePath).toBe('res://prefabs/player.pix3scene');
    expect(sceneManager.serializeScene(graph)).toBe(before);
  });

  it('is idempotent across redo', async () => {
    const { sceneManager, graph, context } = await createHarness(
      { 'res://prefabs/player.pix3scene': PLAYER_PREFAB },
      SCENE_WITH_INSTANCE
    );

    const root = graph.rootNodes[0];
    const result = await new UnlinkPrefabInstanceOperation({ nodeId: root.nodeId }).perform(
      context
    );
    const afterUnlink = sceneManager.serializeScene(graph);

    await result.commit!.undo();
    await result.commit!.redo();
    expect(root.instancePath).toBeNull();
    expect(sceneManager.serializeScene(graph)).toBe(afterUnlink);
  });

  it('does nothing for a node that is not a prefab instance root', async () => {
    const { graph, context } = await createHarness(
      { 'res://prefabs/player.pix3scene': PLAYER_PREFAB },
      SCENE_WITH_INSTANCE
    );

    const child = graph.rootNodes[0].children.find(
      (node): node is NodeBase => node instanceof NodeBase
    );
    expect(child).toBeDefined();

    const result = await new UnlinkPrefabInstanceOperation({ nodeId: child!.nodeId }).perform(
      context
    );
    expect(result.didMutate).toBe(false);
  });

  it('keeps nested instances linked when unpacking the outer instance', async () => {
    const innerPrefab = `
version: 1.0.0
root:
  - id: inner-root
    type: Node3D
    children:
      - id: inner-child
        type: Node3D
        properties:
          visible: true
`;
    const outerPrefab = `
version: 1.0.0
root:
  - id: outer-root
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

    const { sceneManager, graph, context } = await createHarness(
      {
        'res://prefabs/inner.pix3scene': innerPrefab,
        'res://prefabs/outer.pix3scene': outerPrefab,
      },
      sceneText
    );

    const outerRoot = graph.rootNodes[0];
    const nested = outerRoot.children.find(
      (node): node is NodeBase => node instanceof NodeBase && node.instancePath !== null
    );
    expect(nested).toBeDefined();

    const result = await new UnlinkPrefabInstanceOperation({ nodeId: outerRoot.nodeId }).perform(
      context
    );
    expect(result.didMutate).toBe(true);

    // Outer instance is unpacked; the nested instance stays linked and re-rooted.
    expect(outerRoot.instancePath).toBeNull();
    expect(getPrefabMetadata(outerRoot)).toBeNull();
    expect(nested!.instancePath).toBe('res://prefabs/inner.pix3scene');
    expect(isPrefabInstanceRoot(nested!)).toBe(true);

    const savedDoc = parseYaml(sceneManager.serializeScene(graph)) as {
      root: Array<{ instance?: string; children?: Array<{ instance?: string }> }>;
    };
    const savedRoot = savedDoc.root[0];
    expect(savedRoot.instance).toBeUndefined();
    expect(savedRoot.children?.[0]?.instance).toBe('res://prefabs/inner.pix3scene');
  });
});
