import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { parse, stringify } from 'yaml';
import type { SceneGraph } from '@pix3/runtime';
import { appState, resetAppState } from '@/state';
import { SceneCRDTBinding } from '@/services/collab/SceneCRDTBinding';
import type { CollaborationService } from '@/services/collab/CollaborationService';
import type { OperationEvent, OperationService } from '@/services/core/OperationService';
import type { MergeDoc } from '@/services/project/external-merge/scene-doc';

const initial: MergeDoc = {
  version: '1.0.0',
  root: [
    { id: 'a', name: 'A', properties: { value: 1, other: 10 } },
    { id: 'b', name: 'B', properties: { value: 2 } },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function peer(ydoc = new Y.Doc()) {
  let listener: ((event: OperationEvent) => void) | undefined;
  const snapshots = new WeakMap<SceneGraph, string>();
  const graphFor = (text: string): SceneGraph => {
    const graph = { version: '1.0.0', rootNodes: [], nodeMap: new Map(), metadata: {} };
    snapshots.set(graph, text);
    return graph;
  };
  let graph = graphFor(stringify(initial));
  const service = { isRemoteUpdate: false, getYDoc: () => ydoc, getLocalOrigin: () => 'local' };
  const manager = {
    getSceneGraph: () => graph,
    serializeScene: (current: SceneGraph) => snapshots.get(current)!,
    parseScene: vi.fn(async (text: string) => graphFor(text)),
    setActiveSceneGraph: vi.fn((_id: string, next: SceneGraph) => {
      graph = next;
    }),
    setActiveScene: vi.fn(),
  };
  const binding = new SceneCRDTBinding();
  Object.defineProperty(binding, 'getSceneManager', { value: () => manager });
  binding.bindToOperationService(
    {
      addListener: (next: typeof listener) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    } as unknown as OperationService,
    service as unknown as CollaborationService
  );
  const bind = () => binding.bindToYDoc(ydoc, 'scene-1');
  const emit = (sceneId = 'scene-1') =>
    listener?.({
      type: 'operation:completed',
      metadata: { id: 'test', title: 'Test' },
      didMutate: true,
      pushedToHistory: true,
      origin: 'user',
      timestamp: 0,
      sceneId,
    });
  return {
    binding,
    ydoc,
    manager,
    service,
    graphFor,
    bind,
    emit,
    fail: () =>
      listener?.({
        type: 'operation:failed',
        metadata: { id: 'test', title: 'Test' },
        error: new Error('failed'),
        timestamp: 0,
      }),
    initialize: () =>
      binding.initializeYDocFromScene(ydoc, 'scene-1', graph, 'res://test.pix3scene'),
    change: (change: (doc: MergeDoc) => void, sceneId?: string) => {
      const doc = parse(snapshots.get(graph)!) as MergeDoc;
      change(doc);
      snapshots.set(graph, stringify(doc));
      emit(sceneId);
    },
    document: () => parse(snapshots.get(graph)!) as MergeDoc,
    readShared: async () =>
      parse(snapshots.get(await binding.buildSceneFromYDoc(ydoc, 'scene-1'))!) as MergeDoc,
  };
}

function pair(legacy = false) {
  const a = peer();
  if (legacy) {
    const scene = new Y.Map<unknown>();
    a.ydoc.getMap('scenes').set('scene-1', scene);
    scene.set('snapshot', stringify(initial));
  } else a.initialize();
  const b = peer();
  Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
  a.bind();
  b.bind();
  return { a, b };
}

function exchange(a: ReturnType<typeof peer>, b: ReturnType<typeof peer>) {
  const aUpdate = Y.encodeStateAsUpdate(a.ydoc);
  const bUpdate = Y.encodeStateAsUpdate(b.ydoc);
  Y.applyUpdate(a.ydoc, bUpdate);
  Y.applyUpdate(b.ydoc, aUpdate);
}

beforeEach(() => {
  resetAppState();
  appState.scenes.activeSceneId = 'scene-1';
  appState.scenes.descriptors['scene-1'] = {
    id: 'scene-1',
    filePath: 'res://test.pix3scene',
    name: 'Test',
    version: '1.0.0',
    isDirty: false,
    lastSavedAt: null,
    fileHandle: null,
    lastModifiedTime: null,
  };
});

describe('SceneCRDTBinding concurrent replicas', () => {
  it.each([false, true])(
    'keeps independent edits, including concurrent legacy upgrades (%s)',
    async legacy => {
      const { a, b } = pair(legacy);
      a.change(doc => {
        doc.root[0].name = 'A from first peer';
      });
      b.change(doc => {
        doc.root[1].name = 'B from second peer';
      });
      exchange(a, b);
      await vi.waitFor(() => {
        expect(a.document().root.map(node => node.name)).toEqual([
          'A from first peer',
          'B from second peer',
        ]);
        expect(b.document()).toEqual(a.document());
      });
      expect(await a.readShared()).toEqual(await b.readShared());
    }
  );

  it('merges different properties on the same node, including a newly-created object', async () => {
    const { a, b } = pair();
    a.change(doc => {
      doc.root[0].metadata = { first: 1 };
    });
    b.change(doc => {
      doc.root[0].metadata = { second: 2 };
    });
    exchange(a, b);
    await vi.waitFor(() => {
      expect(a.document().root[0].metadata).toEqual({ first: 1, second: 2 });
      expect(b.document()).toEqual(a.document());
    });
  });

  it('keeps concurrent sibling creations and gives them the same deterministic order', async () => {
    const { a, b } = pair();
    a.change(doc => {
      doc.root.splice(1, 0, { id: 'c', name: 'C' });
    });
    b.change(doc => {
      doc.root.splice(1, 0, { id: 'd', name: 'D' });
    });
    exchange(a, b);
    await vi.waitFor(() => {
      expect(a.document().root.map(node => node.id)).toEqual(['a', 'c', 'd', 'b']);
      expect(b.document()).toEqual(a.document());
    });
  });

  it('does not resurrect a deleted node when another peer edits its properties', async () => {
    const { a, b } = pair();
    a.change(doc => {
      doc.root.splice(0, 1);
    });
    b.change(doc => {
      doc.root[0].name = 'edited during deletion';
      doc.root[1].name = 'kept';
    });
    exchange(a, b);
    await vi.waitFor(() => {
      expect(a.document().root.map(node => node.id)).toEqual(['b']);
      expect(a.document().root[0].name).toBe('kept');
      expect(b.document()).toEqual(a.document());
    });
  });

  it('does not resurrect a deletion when a concurrent insertion shifts sibling indices', async () => {
    const { a, b } = pair();
    a.ydoc.clientID = 1;
    b.ydoc.clientID = 2;
    a.change(doc => {
      doc.root.splice(1, 1);
    });
    b.change(doc => {
      doc.root.unshift({ id: 'new', name: 'New' });
    });
    exchange(a, b);
    await vi.waitFor(() => {
      expect(a.document().root.map(node => node.id)).toEqual(['new', 'a']);
      expect(b.document()).toEqual(a.document());
    });
  });

  it('ignores operations completed for another scene', () => {
    const { a } = pair();
    const before = Y.encodeStateAsUpdate(a.ydoc);
    a.change(doc => {
      doc.root[0].name = 'uncommitted';
    }, 'scene-2');
    expect(Y.encodeStateAsUpdate(a.ydoc)).toEqual(before);
  });
});

describe('SceneCRDTBinding asynchronous application', () => {
  it('discards a slow older parse and disposes its graph after the newer state is installed', async () => {
    const { a, b } = pair();
    const old = deferred<SceneGraph>();
    const latest = deferred<SceneGraph>();
    b.manager.parseScene
      .mockImplementationOnce(() => old.promise)
      .mockImplementationOnce(() => latest.promise);
    a.change(doc => {
      doc.root[0].name = 'old';
    });
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    a.change(doc => {
      doc.root[0].name = 'latest';
    });
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    latest.resolve(b.graphFor(b.manager.parseScene.mock.calls[1][0]));
    await vi.waitFor(() => expect(b.document().root[0].name).toBe('latest'));
    const stale = b.graphFor(b.manager.parseScene.mock.calls[0][0]);
    const dispose = vi.fn();
    stale.rootNodes = [{ dispose } as unknown as SceneGraph['rootNodes'][number]];
    old.resolve(stale);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(b.document().root[0].name).toBe('latest');
    expect(b.manager.setActiveSceneGraph).toHaveBeenCalledOnce();
    expect(b.service.isRemoteUpdate).toBe(false);
    expect(appState.scenes.descriptors['scene-1'].isDirty).toBe(true);
  });

  it('preserves a local edit while a remote parse is waiting and applies the merged state', async () => {
    const { a, b } = pair();
    const old = deferred<SceneGraph>();
    b.manager.parseScene.mockImplementationOnce(() => old.promise);
    a.change(doc => {
      doc.root[0].name = 'remote';
    });
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    expect(b.service.isRemoteUpdate).toBe(false);
    b.change(doc => {
      doc.root[1].name = 'local';
    });
    await vi.waitFor(() =>
      expect(b.document().root.map(node => node.name)).toEqual(['remote', 'local'])
    );
    old.resolve(b.graphFor(b.manager.parseScene.mock.calls[0][0]));
    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc));
    await vi.waitFor(() => expect(a.document()).toEqual(b.document()));
    expect(b.document().root.map(node => node.name)).toEqual(['remote', 'local']);
  });

  it('baselines the actual disk graph when binding an existing room', async () => {
    const a = peer();
    a.initialize();
    a.bind();
    a.change(doc => {
      doc.root[0].name = 'already in room';
    });
    const b = peer();
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    const pending = deferred<SceneGraph>();
    b.manager.parseScene.mockImplementationOnce(() => pending.promise);
    b.bind();
    b.change(doc => {
      doc.root[1].name = 'new local edit';
    });
    await vi.waitFor(() =>
      expect(b.document().root.map(node => node.name)).toEqual([
        'already in room',
        'new local edit',
      ])
    );
    pending.resolve(b.graphFor(b.manager.parseScene.mock.calls[0][0]));
    exchange(a, b);
    await vi.waitFor(() => expect(a.document()).toEqual(b.document()));
  });

  it('catches room updates arriving during initial scene loading', async () => {
    const a = peer();
    a.initialize();
    a.bind();
    const b = peer();
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    const pending = deferred<SceneGraph>();
    b.manager.parseScene.mockImplementationOnce(() => pending.promise);
    const loading = b.binding.buildSceneFromYDoc(b.ydoc, 'scene-1');
    a.change(doc => {
      doc.root[0].name = 'arrived during join';
    });
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    pending.resolve(b.graphFor(b.manager.parseScene.mock.calls[0][0]));
    b.manager.setActiveSceneGraph('scene-1', await loading);
    b.bind();
    await vi.waitFor(() => expect(b.document().root[0].name).toBe('arrived during join'));
  });

  it.each(['before-parse', 'during-parse'] as const)(
    'waits for a local asynchronous operation (%s) before replacing its graph',
    async timing => {
      const { a, b } = pair();
      const pending = deferred<SceneGraph>();
      if (timing === 'before-parse') appState.operations.isExecuting = true;
      else b.manager.parseScene.mockImplementationOnce(() => pending.promise);
      a.change(doc => {
        doc.root[0].name = 'remote';
      });
      Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
      appState.operations.isExecuting = true;
      if (timing === 'during-parse') {
        pending.resolve(b.graphFor(b.manager.parseScene.mock.calls[0][0]));
        await pending.promise;
        await Promise.resolve();
      }
      expect(b.manager.setActiveSceneGraph).not.toHaveBeenCalled();
      appState.operations.isExecuting = false;
      b.change(doc => {
        doc.root[1].name = 'async local result';
      });
      await vi.waitFor(() =>
        expect(b.document().root.map(node => node.name)).toEqual(['remote', 'async local result'])
      );
    }
  );

  it('resumes a deferred remote update after a local operation fails', async () => {
    const { a, b } = pair();
    appState.operations.isExecuting = true;
    a.change(doc => {
      doc.root[0].name = 'remote';
    });
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    expect(b.manager.parseScene).not.toHaveBeenCalled();
    appState.operations.isExecuting = false;
    b.fail();
    await vi.waitFor(() => expect(b.document().root[0].name).toBe('remote'));
  });

  it.each(['dispose', 'rebind'] as const)(
    'does not install a pending graph after %s',
    async action => {
      const { a, b } = pair();
      const pending = deferred<SceneGraph>();
      b.manager.parseScene.mockImplementationOnce(() => pending.promise);
      a.change(doc => {
        doc.root[0].name = 'old room';
      });
      Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
      if (action === 'dispose') b.binding.dispose();
      else b.binding.bindToYDoc(new Y.Doc(), 'scene-2');
      pending.resolve(b.graphFor(b.manager.parseScene.mock.calls[0][0]));
      await pending.promise;
      await Promise.resolve();
      expect(b.manager.setActiveSceneGraph).not.toHaveBeenCalled();
      expect(b.service.isRemoteUpdate).toBe(false);
    }
  );
});
