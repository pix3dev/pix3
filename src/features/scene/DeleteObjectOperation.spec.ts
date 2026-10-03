import { describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import type { OperationContext } from '@/core/Operation';
import { createInitialAppState } from '@/state/AppState';
import {
  Node3D,
  NodeBase,
  SceneManager,
  SceneSaver,
  type SceneGraph,
  type ScriptComponent,
} from '@pix3/runtime';
import { DeleteObjectOperation } from './DeleteObjectOperation';

function createHarness(rootNodes: NodeBase[]) {
  const nodeMap = new Map<string, NodeBase>();
  const register = (node: NodeBase) => {
    nodeMap.set(node.nodeId, node);
    for (const child of node.children) {
      if (child instanceof NodeBase) register(child);
    }
  };
  rootNodes.forEach(register);
  const sceneGraph: SceneGraph = {
    version: '1.0.0',
    rootNodes,
    nodeMap,
    metadata: {},
  };
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
  state.scenes.hierarchies['scene-1'] = {
    version: '1.0.0',
    description: 'Scene',
    rootNodes: [...rootNodes],
    metadata: {},
  };
  const sceneManager = { getSceneGraph: () => sceneGraph };
  const container = {
    getOrCreateToken: <T>(token: T): T => token,
    getService: <T>(token: unknown): T => {
      if (token === SceneManager) return sceneManager as T;
      throw new Error(`Unexpected token ${String(token)}`);
    },
  };
  const context: OperationContext = {
    state,
    snapshot: {} as OperationContext['snapshot'],
    container: container as unknown as OperationContext['container'],
    requestedAt: Date.now(),
  };
  return { context, state, sceneGraph };
}

const node = (id: string) => new Node3D({ id, name: id });

describe('DeleteObjectOperation', () => {
  it('removes every descendant from the index and selection and restores the exact subtree', async () => {
    const before = node('before');
    const removed = node('removed');
    const after = node('after');
    const children = ['a', 'b', 'c', 'd'].map(node);
    const grandchildren = ['a1', 'a2', 'a3'].map(node);
    const visualBefore = new Object3D();
    const visualMiddle = new Object3D();
    const visualAfter = new Object3D();
    removed.add(
      visualBefore,
      children[0],
      children[1],
      visualMiddle,
      children[2],
      children[3],
      visualAfter
    );
    children[0].add(...grandchildren);
    const originalChildren = [...removed.children];
    const component: ScriptComponent = {
      id: 'component',
      type: 'user:Test',
      node: null,
      enabled: true,
      config: { amount: 3 },
      _started: false,
      onAttach: vi.fn(),
      onDetach: vi.fn(),
    };
    grandchildren[1].addComponent(component);
    const h = createHarness([before, removed, after]);
    h.state.selection.nodeIds = [
      before.nodeId,
      removed.nodeId,
      ...children.map(child => child.nodeId),
      ...grandchildren.map(child => child.nodeId),
    ];
    h.state.selection.primaryNodeId = grandchildren[1].nodeId;
    const saver = new SceneSaver();
    const originalYaml = saver.serializeScene(h.sceneGraph);
    const originalNodes = new Map(h.sceneGraph.nodeMap);

    const result = await new DeleteObjectOperation({ nodeIds: [removed.nodeId] }).perform(
      h.context
    );
    expect(result.didMutate).toBe(true);
    expect(h.sceneGraph.rootNodes).toEqual([before, after]);
    expect([...h.sceneGraph.nodeMap.keys()]).toEqual([before.nodeId, after.nodeId]);
    expect(h.state.selection.nodeIds).toEqual([before.nodeId]);
    expect(h.state.selection.primaryNodeId).toBeNull();
    expect(removed.children).toEqual([visualBefore, visualMiddle, visualAfter]);
    expect(component.node).toBe(grandchildren[1]);
    expect(component.onDetach).not.toHaveBeenCalled();
    for (const original of originalNodes.values()) expect(original.isDisposed).toBe(false);

    h.state.scenes.descriptors['scene-1'].isDirty = false;
    await result.commit!.undo();
    expect(h.sceneGraph.rootNodes).toEqual([before, removed, after]);
    expect(removed.children).toEqual(originalChildren);
    expect(children[0].children).toEqual(grandchildren);
    expect(saver.serializeScene(h.sceneGraph)).toBe(originalYaml);
    expect(h.sceneGraph.nodeMap.size).toBe(originalNodes.size);
    for (const [id, original] of originalNodes) expect(h.sceneGraph.nodeMap.get(id)).toBe(original);
    expect(h.state.scenes.hierarchies['scene-1'].rootNodes).toEqual(h.sceneGraph.rootNodes);
    expect(h.state.scenes.descriptors['scene-1'].isDirty).toBe(true);
    expect(grandchildren[1].components).toEqual([component]);
    expect(component.onAttach).toHaveBeenCalledOnce();
    expect(component.onDetach).not.toHaveBeenCalled();

    await result.commit!.redo();
    expect([...h.sceneGraph.nodeMap.keys()]).toEqual([before.nodeId, after.nodeId]);
    await result.commit!.undo();
    expect(saver.serializeScene(h.sceneGraph)).toBe(originalYaml);
    expect(removed.children).toEqual(originalChildren);
  });

  it.each([
    ['a', 'b', 'c'],
    ['b', 'a', 'c'],
    ['c', 'a', 'b'],
  ])(
    'restores selected siblings in their original order after deleting %s, %s, %s',
    async (...ids) => {
      const parent = node('parent');
      const children = ['before', 'a', 'b', 'between', 'c', 'after'].map(node);
      parent.add(...children);
      const h = createHarness([parent]);
      const result = await new DeleteObjectOperation({ nodeIds: ids }).perform(h.context);
      expect(parent.children.map(child => child.nodeId)).toEqual(['before', 'between', 'after']);
      await result.commit!.undo();
      expect(parent.children).toEqual(children);
      await result.commit!.redo();
      await result.commit!.undo();
      expect(parent.children).toEqual(children);
    }
  );

  it.each([
    ['a', 'b', 'c'],
    ['b', 'a', 'c'],
    ['c', 'a', 'b'],
  ])(
    'restores selected roots in their original order after deleting %s, %s, %s',
    async (...ids) => {
      const roots = ['before', 'a', 'b', 'between', 'c', 'after'].map(node);
      const h = createHarness([...roots]);
      const result = await new DeleteObjectOperation({ nodeIds: ids }).perform(h.context);
      expect(h.sceneGraph.rootNodes.map(root => root.nodeId)).toEqual([
        'before',
        'between',
        'after',
      ]);
      await result.commit!.undo();
      expect(h.sceneGraph.rootNodes).toEqual(roots);
    }
  );

  it.each([
    ['child', 'parent'],
    ['parent', 'child'],
  ])('handles overlapping parent/child selection in %s, %s order', async (...ids) => {
    const parent = node('parent');
    const children = ['before', 'child', 'after'].map(node);
    parent.add(...children);
    const h = createHarness([parent]);
    const result = await new DeleteObjectOperation({ nodeIds: [...ids, ids[0]] }).perform(
      h.context
    );
    expect(h.sceneGraph.rootNodes).toEqual([]);
    expect(h.sceneGraph.nodeMap.size).toBe(0);
    await result.commit!.undo();
    expect(h.sceneGraph.rootNodes).toEqual([parent]);
    expect(parent.children).toEqual(children);
    expect(h.sceneGraph.nodeMap.size).toBe(4);
  });

  it('leaves locked prefab children intact when selected on their own', async () => {
    const parent = node('parent');
    const child = new Node3D({
      id: 'child',
      metadata: {
        __pix3Prefab: {
          localId: 'child',
          effectiveLocalId: 'child',
          instanceRootId: parent.nodeId,
          sourcePath: 'res://prefabs/test.pix3scene',
        },
      },
    });
    parent.add(child);
    const h = createHarness([parent]);
    const result = await new DeleteObjectOperation({ nodeIds: [child.nodeId] }).perform(h.context);
    expect(result.didMutate).toBe(false);
    expect(parent.children).toEqual([child]);
    expect(h.sceneGraph.nodeMap.get(child.nodeId)).toBe(child);
    expect(h.state.scenes.descriptors['scene-1'].isDirty).toBe(false);
  });
});
