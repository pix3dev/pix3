import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vector2 } from 'three';
import {
  AssetLoader,
  AudioService,
  ResourceManager,
  SceneLoader,
  SceneManager,
  SceneSaver,
  ScriptRegistry,
  registerBuiltInScripts,
} from '@pix3/runtime';
import type { OperationContext, OperationInvokeResult, Operation } from '@/core/Operation';
import type { OperationEvent } from '@/services/core/OperationService';
import { appState, resetAppState } from '@/state';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { UpdateObjectPropertyOperation } from '@/features/properties/UpdateObjectPropertyOperation';
import { Transform2DCompleteOperation } from '@/features/properties/Transform2DCompleteOperation';
import { ReparentNodeOperation } from '@/features/scene/ReparentNodeOperation';
import { DeleteObjectOperation } from '@/features/scene/DeleteObjectOperation';
import { CreateColorRect2DOperation } from '@/features/scene/CreateColorRect2DOperation';
import { RemoveComponentOperation } from '@/features/scripts/RemoveComponentOperation';
import { UpdateComponentPropertyOperation } from '@/features/scripts/UpdateComponentPropertyOperation';
import { ProtectedSetService } from './ProtectedSetService';
import { entryKey, emptyProtectedSet, recordHumanOperation } from '../external-merge/protected-set';

/**
 * Operation → P, end to end: REAL operations mutate a REAL graph (loaded by the real loader, saved
 * by the real saver), and the recorder turns the commit into protected-set entries at the paths
 * the merge reads in the agent's file.
 */

const SCENE_ID = 'scene-1';
const SCENE_PATH = 'res://scenes/main.pix3scene';

const SCENE = `version: 1.0.0
root:
  - id: root2d
    type: Node2D
    name: Root
    children:
      - id: a
        type: ColorRect2D
        name: A
        properties:
          transform:
            position: [10, 20]
      - id: b
        type: Node2D
        name: B
        components:
          - id: sine1
            type: core:Sine
            enabled: true
            config:
              amplitude: 40
        children:
          - id: b1
            type: Node2D
            name: B1
      - id: c
        type: Node2D
        name: C
`;

class NoFilesResourceManager extends ResourceManager {
  constructor() {
    super('/');
  }
  override async readText(resource: string): Promise<string> {
    throw new Error(`no resource ${resource}`);
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

async function createHarness() {
  const resources = new NoFilesResourceManager();
  const registry = new ScriptRegistry();
  registerBuiltInScripts(registry);
  const loader = new SceneLoader(
    new AssetLoader(resources, new AudioService()),
    registry,
    resources
  );
  const sceneManager = new SceneManager(loader, new SceneSaver());
  const graph = await sceneManager.parseScene(SCENE, { filePath: SCENE_PATH });
  sceneManager.setActiveSceneGraph(SCENE_ID, graph);

  appState.scenes.activeSceneId = SCENE_ID;
  appState.scenes.descriptors[SCENE_ID] = {
    id: SCENE_ID,
    filePath: SCENE_PATH,
    name: 'Main',
    version: '1.0.0',
    isDirty: false,
    lastSavedAt: null,
    fileHandle: null,
    lastModifiedTime: null,
  };

  const viewport = new Proxy({}, { get: () => vi.fn() });
  const container = {
    getOrCreateToken: <T>(token: T): T => token,
    hasService: (token: unknown): boolean =>
      token === SceneManager || token === ScriptRegistry || token === ViewportRendererService,
    getService: <T>(token: unknown): T => {
      if (token === SceneManager) return sceneManager as T;
      if (token === ScriptRegistry) return registry as T;
      if (token === ViewportRendererService) return viewport as T;
      throw new Error(`Unexpected token: ${String(token)}`);
    },
  };
  const context = (): OperationContext =>
    ({
      state: appState,
      snapshot: structuredClone({
        selection: { nodeIds: [], primaryNodeId: null },
        scenes: { activeSceneId: SCENE_ID },
      }),
      container: container as unknown as OperationContext['container'],
      requestedAt: Date.now(),
    }) as unknown as OperationContext;

  const recorder = new ProtectedSetService();
  recorder.setSceneSource(sceneManager);

  const emit = (event: OperationEvent) => recorder.handleOperationEvent(event);

  /** Invoke → perform → completed(pushed, user), exactly like `invokeAndPush` reports it. */
  const runHuman = async (op: Operation): Promise<OperationInvokeResult> => {
    emit({ type: 'operation:invoked', metadata: op.metadata, timestamp: 0 });
    const result = await op.perform(context());
    emit({
      type: 'operation:completed',
      metadata: op.metadata,
      didMutate: result.didMutate,
      pushedToHistory: result.didMutate && result.commit !== undefined,
      origin: 'user',
      timestamp: 0,
    });
    await settle();
    return result;
  };

  const entries = () => recorder.get(SCENE_PATH).entries;
  const entry = (nodeId: string, ...path: string[]) =>
    entries().find(e => entryKey(e.nodeId, e.path) === entryKey(nodeId, path));

  return { sceneManager, graph, recorder, runHuman, emit, entries, entry };
}

beforeEach(() => {
  resetAppState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProtectedSetService — Operation → P', () => {
  it('UpdateObjectPropertyOperation: Node2D position → properties.transform.position', async () => {
    const h = await createHarness();
    await h.runHuman(
      new UpdateObjectPropertyOperation({
        nodeId: 'a',
        propertyPath: 'position',
        value: { x: 100, y: 20 },
      })
    );

    const position = h.entry('a', 'properties', 'transform', 'position');
    expect(position?.value).toEqual([100, 20]);
    expect(position?.gen).toBe(1);
    expect(h.entries()).toHaveLength(1);
  });

  it('create node: whole snapshot + tree position with prevSibling', async () => {
    const h = await createHarness();
    await h.runHuman(
      new CreateColorRect2DOperation({
        nodeName: 'Fresh',
        position: new Vector2(5, 6),
        parentNodeId: 'root2d',
      })
    );

    const created = h.entries().filter(e => e.path.length === 0 && !e.deleted);
    expect(created).toHaveLength(1);
    const id = created[0].nodeId;
    expect((created[0].value as { type?: string }).type).toBe('ColorRect2D');
    expect(h.entry(id, '$tree')?.value).toEqual({ parent: 'root2d', prevSibling: 'c' });
    // No other node reads as moved by the insertion.
    expect(h.entries().filter(e => e.path[0] === '$tree')).toHaveLength(1);
  });

  it('delete node: tombstones for the node and its whole subtree', async () => {
    const h = await createHarness();
    await h.runHuman(new DeleteObjectOperation({ nodeIds: ['b'] }));

    expect(h.entry('b')?.deleted).toBe(true);
    expect(h.entry('b1')?.deleted).toBe(true);
    // Deleting B changes C's prevSibling but is not a move of C.
    expect(h.entry('c', '$tree')).toBeUndefined();
  });

  it('reparent: move-node with the new parent and prevSibling', async () => {
    const h = await createHarness();
    await h.runHuman(new ReparentNodeOperation({ nodeId: 'c', newParentId: 'b', newIndex: -1 }));

    expect(h.entry('c', '$tree')?.value).toEqual({ parent: 'b', prevSibling: 'b1' });
    expect(h.entries().filter(e => e.path[0] === '$tree')).toHaveLength(1);
  });

  it('component property → components/@id/config/<key>; remove component → tombstone', async () => {
    const h = await createHarness();
    await h.runHuman(
      new UpdateComponentPropertyOperation({
        nodeId: 'b',
        componentId: 'sine1',
        propertyName: 'amplitude',
        value: 75,
      })
    );
    expect(h.entry('b', 'components', '@sine1', 'config', 'amplitude')?.value).toBe(75);

    await h.runHuman(new RemoveComponentOperation({ nodeId: 'b', componentId: 'sine1' }));
    const tombstone = h.entry('b', 'components', '@sine1');
    expect(tombstone?.deleted).toBe(true);
    expect(tombstone?.gen).toBe(2);
    // The component tombstone folds the earlier config entry.
    expect(h.entry('b', 'components', '@sine1', 'config', 'amplitude')).toBeUndefined();
  });

  it('undo of a human operation is a human operation (the resulting value is recorded)', async () => {
    const h = await createHarness();
    const result = await h.runHuman(
      new UpdateObjectPropertyOperation({
        nodeId: 'a',
        propertyPath: 'position',
        value: { x: 100, y: 20 },
      })
    );
    await result.commit!.undo();
    h.emit({ type: 'operation:undone', entry: {} as never, timestamp: 0 });
    await settle();

    const position = h.entry('a', 'properties', 'transform', 'position');
    expect(position?.value).toEqual([10, 20]);
    expect(position?.gen).toBe(2);
  });

  it('a live gesture is recorded once, by the committing operation', async () => {
    const h = await createHarness();
    // The recorder baselines the graph on the first operation it sees (and on scene load).
    h.emit({
      type: 'operation:invoked',
      metadata: { id: 'scene.select-object', title: 'Select' },
      timestamp: 0,
    });
    // The drag mutates the node directly, frame by frame — nothing is recorded meanwhile.
    const node = h.graph.nodeMap.get('a')!;
    node.position.x = 50;
    await settle();
    expect(h.entries()).toHaveLength(0);
    node.position.x = 70;

    // Pointer-up commits one operation (start → end state); its diff carries the whole drag.
    await h.runHuman(
      new Transform2DCompleteOperation({
        nodeId: 'a',
        previousState: { position: { x: 10, y: 20 } },
        currentState: { position: { x: 70, y: 20 } },
      })
    );
    expect(h.entry('a', 'properties', 'transform', 'position')?.value).toEqual([70, 20]);
    expect(h.recorder.getGen(SCENE_PATH)).toBe(1);
  });

  it('does not record a reload, an external/system origin, or an operation outside history', async () => {
    const h = await createHarness();
    const metadata = { id: 'scene.reload', title: 'Reload' };
    for (const variant of [
      { pushedToHistory: true, origin: 'external' as const },
      { pushedToHistory: true, origin: 'system' as const },
      { pushedToHistory: false, origin: 'user' as const },
    ]) {
      h.emit({ type: 'operation:invoked', metadata, timestamp: 0 });
      h.graph.nodeMap.get('a')!.position.x += 5;
      h.emit({
        type: 'operation:completed',
        metadata,
        didMutate: true,
        ...variant,
        timestamp: 0,
      });
    }
    await settle();
    expect(h.entries()).toHaveLength(0);

    // ...and the baseline moved with them: the next human edit records only its own change.
    await h.runHuman(
      new UpdateObjectPropertyOperation({ nodeId: 'c', propertyPath: 'name', value: 'Renamed' })
    );
    expect(h.entries().map(e => entryKey(e.nodeId, e.path))).toEqual([entryKey('c', ['name'])]);
  });
});

describe('ProtectedSetService — .pix3/protected.json', () => {
  it('round-trips every scene set through serialize/parse', () => {
    const service = new ProtectedSetService();
    let set = recordHumanOperation(emptyProtectedSet(), {
      kind: 'set-property',
      nodeId: 'a',
      path: ['properties', 'transform', 'position'],
      value: [1, 2],
    });
    set = recordHumanOperation(set, { kind: 'delete-node', nodeIds: ['b', 'b1'] });
    service.set('res://scenes/main.pix3scene', set);
    service.recordEditorWrite('scenes/main.pix3scene', 'abc123', 1);
    service.set(
      'scenes/other.pix3scene',
      recordHumanOperation(emptyProtectedSet(), {
        kind: 'move-node',
        nodeId: 'x',
        parentId: null,
        prevSiblingId: 'y',
      })
    );

    const parsed = ProtectedSetService.parse(service.serialize());
    expect([...parsed.keys()]).toEqual(['scenes/main.pix3scene', 'scenes/other.pix3scene']);
    expect(parsed.get('scenes/main.pix3scene')).toEqual(service.get('scenes/main.pix3scene'));
    expect(parsed.get('scenes/main.pix3scene')?.versions).toEqual([
      { hash: 'abc123', genAtWrite: 1 },
    ]);
    expect(parsed.get('scenes/other.pix3scene')).toEqual(service.get('scenes/other.pix3scene'));
    service.dispose();
  });

  it('refuses a malformed file instead of silently dropping protection', () => {
    expect(() => ProtectedSetService.parse('{"format":1,"scenes":{"a":{"format":1}}}')).toThrow();
    expect(() => ProtectedSetService.parse('{"format":2,"scenes":{}}')).toThrow();
  });

  it('loads the file of the open project and writes it back only as the owner', async () => {
    const files = new Map<string, string>();
    const storage = {
      fileExists: vi.fn(async (path: string) => files.has(path)),
      readTextFile: vi.fn(async (path: string) => files.get(path) ?? ''),
      writeTextFile: vi.fn(async (path: string, text: string) => {
        files.set(path, text);
      }),
    };
    let owner = false;
    const service = new ProtectedSetService();
    Object.defineProperty(service, 'storage', { value: storage });
    Object.defineProperty(service, 'ownership', { value: { isOwner: () => owner } });

    const seed = new ProtectedSetService();
    seed.set(
      'scenes/main.pix3scene',
      recordHumanOperation(emptyProtectedSet(), {
        kind: 'set-property',
        nodeId: 'a',
        path: ['name'],
        value: 'Kept',
      })
    );
    files.set('.pix3/protected.json', seed.serialize());
    seed.dispose();

    appState.project.status = 'ready';
    appState.project.id = 'p1';
    await service.load();
    expect(service.get('scenes/main.pix3scene').entries[0].value).toBe('Kept');

    service.recordHuman('scenes/main.pix3scene', [
      { kind: 'set-property', nodeId: 'a', path: ['name'], value: 'Edited' },
    ]);
    await service.flush();
    expect(storage.writeTextFile).not.toHaveBeenCalled();

    owner = true;
    await service.flush();
    expect(storage.writeTextFile).toHaveBeenCalledWith('.pix3/protected.json', expect.any(String), {
      unconditional: true,
    });
    const reloaded = ProtectedSetService.parse(files.get('.pix3/protected.json')!);
    expect(reloaded.get('scenes/main.pix3scene')?.entries[0].value).toBe('Edited');
    expect(reloaded.get('scenes/main.pix3scene')?.gen).toBe(2);
    service.dispose();
  });
});
