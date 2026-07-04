import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '@/core/Operation';
import { SceneManager } from '@pix3/runtime';
import { ProjectStorageService } from '@/services/ProjectStorageService';
import { PrefabRefreshTracker } from '@/services/PrefabRefreshTracker';
import { OperationService } from '@/services/OperationService';
import { createInitialAppState } from '@/state/AppState';
import { RefreshPrefabInstancesOperation } from './RefreshPrefabInstancesOperation';

interface FakeNode {
  nodeId: string;
  instancePath: string | null;
}

function makeGraph(nodes: FakeNode[]) {
  return {
    version: '1.0.0',
    description: 'Scene',
    metadata: {},
    rootNodes: nodes,
    nodeMap: new Map(nodes.map(n => [n.nodeId, n])),
  };
}

interface Harness {
  context: OperationContext;
  parseScene: ReturnType<typeof vi.fn>;
  setActiveSceneGraph: ReturnType<typeof vi.fn>;
  serializeScene: ReturnType<typeof vi.fn>;
  getLastModified: ReturnType<typeof vi.fn>;
  historyClear: ReturnType<typeof vi.fn>;
  tracker: PrefabRefreshTracker;
}

function createHarness(options: {
  nodes: FakeNode[];
  mtimes?: Record<string, number | null>;
}): Harness {
  const state = createInitialAppState();
  state.scenes.activeSceneId = 'scene-1';
  state.scenes.descriptors['scene-1'] = {
    id: 'scene-1',
    filePath: 'res://scene.pix3scene',
    name: 'Scene',
    version: '1.0.0',
    isDirty: false,
    lastSavedAt: null,
    fileHandle: null,
    lastModifiedTime: null,
  };

  const currentGraph = makeGraph(options.nodes);
  const serializeScene = vi.fn(() => 'serialized');
  const setActiveSceneGraph = vi.fn();
  // parseScene returns a distinct graph object each call (simulating a rebuild).
  const parseScene = vi.fn(async () => makeGraph(options.nodes.map(n => ({ ...n }))));

  const sceneManager: Pick<
    SceneManager,
    'getSceneGraph' | 'serializeScene' | 'parseScene' | 'setActiveSceneGraph'
  > = {
    getSceneGraph: () => currentGraph as never,
    serializeScene: serializeScene as never,
    parseScene: parseScene as never,
    setActiveSceneGraph: setActiveSceneGraph as never,
  };

  const mtimes = options.mtimes ?? {};
  const getLastModified = vi.fn(async (path: string) => mtimes[path] ?? 0);
  const storage: Pick<ProjectStorageService, 'getLastModified'> = {
    getLastModified: getLastModified as never,
  };

  const tracker = new PrefabRefreshTracker();
  const historyClear = vi.fn();
  const operationService = { history: { clear: historyClear } };

  const container = {
    getOrCreateToken: <T>(token: T): T => token,
    getService: <T>(token: unknown): T => {
      if (token === SceneManager) return sceneManager as T;
      if (token === ProjectStorageService) return storage as T;
      if (token === PrefabRefreshTracker) return tracker as T;
      if (token === OperationService) return operationService as T;
      throw new Error(`Unexpected token: ${String(token)}`);
    },
  };

  const context = {
    state,
    snapshot: {} as OperationContext['snapshot'],
    container: container as OperationContext['container'],
    requestedAt: Date.now(),
  } as OperationContext;

  return {
    context,
    parseScene,
    setActiveSceneGraph,
    serializeScene,
    getLastModified,
    historyClear,
    tracker,
  };
}

const PREFAB = 'res://prefabs/shop.pix3scene';

describe('RefreshPrefabInstancesOperation', () => {
  it('does nothing when the scene has no prefab instances', async () => {
    const h = createHarness({ nodes: [{ nodeId: 'a', instancePath: null }] });
    const result = await new RefreshPrefabInstancesOperation({ sceneId: 'scene-1' }).perform(
      h.context
    );

    expect(result.didMutate).toBe(false);
    expect(h.getLastModified).not.toHaveBeenCalled();
    expect(h.parseScene).not.toHaveBeenCalled();
  });

  it('establishes a baseline on first refresh without rebuilding', async () => {
    const h = createHarness({
      nodes: [{ nodeId: 'inst', instancePath: PREFAB }],
      mtimes: { [PREFAB]: 1000 },
    });
    const result = await new RefreshPrefabInstancesOperation({ sceneId: 'scene-1' }).perform(
      h.context
    );

    expect(result.didMutate).toBe(false);
    expect(h.parseScene).not.toHaveBeenCalled();
    expect(h.setActiveSceneGraph).not.toHaveBeenCalled();
    expect(h.historyClear).not.toHaveBeenCalled();
    expect(h.tracker.get('scene-1')).toBe(`${PREFAB}@1000`);
  });

  it('skips the rebuild when the prefab mtime is unchanged (preserves history)', async () => {
    const h = createHarness({
      nodes: [{ nodeId: 'inst', instancePath: PREFAB }],
      mtimes: { [PREFAB]: 1000 },
    });
    const op = () => new RefreshPrefabInstancesOperation({ sceneId: 'scene-1' }).perform(h.context);

    await op(); // baseline
    const result = await op(); // unchanged

    expect(result.didMutate).toBe(false);
    expect(h.parseScene).not.toHaveBeenCalled();
    expect(h.historyClear).not.toHaveBeenCalled();
  });

  it('rebuilds and clears history when a prefab mtime changes', async () => {
    const mtimes: Record<string, number> = { [PREFAB]: 1000 };
    const h = createHarness({ nodes: [{ nodeId: 'inst', instancePath: PREFAB }], mtimes });

    await new RefreshPrefabInstancesOperation({ sceneId: 'scene-1' }).perform(h.context); // baseline

    mtimes[PREFAB] = 2000; // external edit
    const result = await new RefreshPrefabInstancesOperation({ sceneId: 'scene-1' }).perform(
      h.context
    );

    expect(result.didMutate).toBe(true);
    expect(h.parseScene).toHaveBeenCalledTimes(1);
    expect(h.setActiveSceneGraph).toHaveBeenCalledTimes(1);
    expect(h.historyClear).toHaveBeenCalledTimes(1);
    expect(h.tracker.get('scene-1')).toBe(`${PREFAB}@2000`);
  });

  it('forces a rebuild when an explicit changedPrefabPath is provided', async () => {
    const h = createHarness({
      nodes: [{ nodeId: 'inst', instancePath: PREFAB }],
      mtimes: { [PREFAB]: 1000 },
    });

    await new RefreshPrefabInstancesOperation({ sceneId: 'scene-1' }).perform(h.context); // baseline

    const result = await new RefreshPrefabInstancesOperation({
      sceneId: 'scene-1',
      changedPrefabPath: PREFAB,
    }).perform(h.context);

    expect(result.didMutate).toBe(true);
    expect(h.parseScene).toHaveBeenCalledTimes(1);
    expect(h.historyClear).toHaveBeenCalledTimes(1);
  });

  it('ignores a changedPrefabPath the scene does not reference', async () => {
    const h = createHarness({
      nodes: [{ nodeId: 'inst', instancePath: PREFAB }],
      mtimes: { [PREFAB]: 1000 },
    });

    const result = await new RefreshPrefabInstancesOperation({
      sceneId: 'scene-1',
      changedPrefabPath: 'res://prefabs/other.pix3scene',
    }).perform(h.context);

    expect(result.didMutate).toBe(false);
    expect(h.parseScene).not.toHaveBeenCalled();
  });
});
