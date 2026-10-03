import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@/core/Operation';
import { createInitialAppState } from '@/state/AppState';
import { Node3D, SceneManager, type SceneGraph } from '@pix3/runtime';
import { Vector3 } from 'three';
import { ReparentNodeOperation } from './ReparentNodeOperation';

function createHarness() {
  const originalParent = new Node3D({ id: 'original-parent', name: 'Original parent' });
  const newParent = new Node3D({ id: 'new-parent', name: 'New parent' });
  const before = new Node3D({ id: 'before' });
  const moved = new Node3D({ id: 'moved', name: 'Moved' });
  const after = new Node3D({ id: 'after' });
  originalParent.position.set(10, 20, 30);
  newParent.position.set(-15, 10, 5);
  moved.position.set(1, 2, 3);
  originalParent.add(before, moved, after);
  const sceneGraph: SceneGraph = {
    version: '1.0.0',
    rootNodes: [originalParent, newParent],
    nodeMap: new Map(
      [originalParent, newParent, before, moved, after].map(node => [node.nodeId, node])
    ),
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
    ...sceneGraph,
    description: 'Scene',
    rootNodes: [...sceneGraph.rootNodes],
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
  return { context, state, sceneGraph, originalParent, newParent, before, moved, after };
}

describe('ReparentNodeOperation', () => {
  it.each(['parent', 'root'] as const)(
    'marks undo and redo dirty after autosave when moving to %s',
    async target => {
      const h = createHarness();
      const worldPosition = h.moved.getWorldPosition(new Vector3());
      const result = await new ReparentNodeOperation({
        nodeId: h.moved.nodeId,
        newParentId: target === 'parent' ? h.newParent.nodeId : null,
        newIndex: 0,
      }).perform(h.context);
      expect(result.didMutate).toBe(true);
      expect(h.moved.parentNode).toBe(target === 'parent' ? h.newParent : null);
      expect(h.moved.getWorldPosition(new Vector3()).toArray()).toEqual(worldPosition.toArray());
      const descriptor = h.state.scenes.descriptors['scene-1'];
      expect(descriptor.isDirty).toBe(true);

      // Autosave is not in undo history; undoing the move is a fresh unsaved edit.
      descriptor.isDirty = false;
      descriptor.lastSavedAt = 123;
      const hierarchyAfterMove = h.state.scenes.hierarchies['scene-1'];
      await result.commit!.undo();
      expect(h.originalParent.children).toEqual([h.before, h.moved, h.after]);
      expect(h.moved.parentNode).toBe(h.originalParent);
      expect(h.moved.getWorldPosition(new Vector3()).toArray()).toEqual(worldPosition.toArray());
      expect(h.state.scenes.hierarchies['scene-1']).not.toBe(hierarchyAfterMove);
      expect(h.state.scenes.hierarchies['scene-1'].rootNodes).toEqual(h.sceneGraph.rootNodes);
      expect(descriptor.isDirty).toBe(true);
      expect(descriptor.lastSavedAt).toBe(123);

      descriptor.isDirty = false;
      await result.commit!.redo();
      expect(descriptor.isDirty).toBe(true);
      expect(h.moved.parentNode).toBe(target === 'parent' ? h.newParent : null);
      expect(h.moved.getWorldPosition(new Vector3()).toArray()).toEqual(worldPosition.toArray());
      expect(h.sceneGraph.nodeMap.get(h.moved.nodeId)).toBe(h.moved);
    }
  );
});
