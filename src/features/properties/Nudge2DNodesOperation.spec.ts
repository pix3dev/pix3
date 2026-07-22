import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@/core/Operation';
import { createInitialAppState } from '@/state/AppState';
import { createDefaultProjectManifest } from '@/core/ProjectManifest';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { Group2D, Node3D, NodeBase, SceneManager, Sprite2D } from '@pix3/runtime';
import { Vector2 } from 'three';
import { Nudge2DNodesOperation } from './Nudge2DNodesOperation';

const createSceneDescriptor = () => ({
  id: 'scene-1',
  filePath: 'res://scene.pix3scene',
  name: 'Scene',
  version: '1.0.0',
  isDirty: false,
  lastSavedAt: null,
  fileHandle: null,
  lastModifiedTime: null,
});

const collectNodeMap = (nodes: readonly NodeBase[]): Map<string, NodeBase> => {
  const nodeMap = new Map<string, NodeBase>();
  const visit = (current: readonly NodeBase[]) => {
    for (const node of current) {
      nodeMap.set(node.nodeId, node);
      if (node.children.length > 0) {
        visit(node.children);
      }
    }
  };
  visit(nodes);
  return nodeMap;
};

const createOperationContext = (rootNodes: NodeBase[]) => {
  const state = createInitialAppState();
  state.scenes.activeSceneId = 'scene-1';
  state.scenes.descriptors['scene-1'] = createSceneDescriptor();
  state.project.manifest = createDefaultProjectManifest();

  const sceneGraph = {
    version: '1.0.0',
    description: 'Scene',
    metadata: {},
    rootNodes,
    nodeMap: collectNodeMap(rootNodes),
  };

  const viewportRenderer = new ViewportRendererService();
  const sceneManagerMock: Pick<SceneManager, 'getSceneGraph' | 'getActiveSceneGraph'> = {
    getSceneGraph: sceneId => (sceneId === 'scene-1' ? sceneGraph : null),
    getActiveSceneGraph: () => sceneGraph,
  };

  const container = {
    getOrCreateToken: <T>(token: T): T => token,
    getService: <T>(token: unknown): T => {
      if (token === SceneManager) {
        return sceneManagerMock as T;
      }
      if (token === ViewportRendererService) {
        return viewportRenderer as T;
      }
      throw new Error(`Unexpected token: ${String(token)}`);
    },
  };

  const context = {
    state,
    snapshot: structuredClone(state),
    container: container as OperationContext['container'],
    requestedAt: Date.now(),
  } as OperationContext;

  return { context, state, sceneGraph };
};

describe('Nudge2DNodesOperation', () => {
  it('moves a root sprite right and up by the given delta', async () => {
    const sprite = new Sprite2D({
      id: 'sprite-1',
      name: 'Sprite',
      width: 20,
      height: 20,
      position: new Vector2(10, 5),
    });
    const { context } = createOperationContext([sprite]);

    const result = await new Nudge2DNodesOperation({
      dx: 3,
      dy: 7,
      nodeIds: [sprite.nodeId],
    }).perform(context);

    expect(result.didMutate).toBe(true);
    expect(sprite.position.x).toBeCloseTo(13);
    expect(sprite.position.y).toBeCloseTo(12);
  });

  it('restores the original position on undo', async () => {
    const sprite = new Sprite2D({
      id: 'sprite-undo',
      name: 'Sprite',
      width: 20,
      height: 20,
      position: new Vector2(0, 0),
    });
    const { context } = createOperationContext([sprite]);

    const result = await new Nudge2DNodesOperation({
      dx: -5,
      dy: 0,
      nodeIds: [sprite.nodeId],
    }).perform(context);

    expect(sprite.position.x).toBeCloseTo(-5);
    await result.commit?.undo();
    expect(sprite.position.x).toBeCloseTo(0);
    await result.commit?.redo();
    expect(sprite.position.x).toBeCloseTo(-5);
  });

  it('moves an entire multi-node selection as one commit', async () => {
    const a = new Sprite2D({
      id: 'sprite-a',
      name: 'A',
      width: 20,
      height: 20,
      position: new Vector2(0, 0),
    });
    const b = new Sprite2D({
      id: 'sprite-b',
      name: 'B',
      width: 20,
      height: 20,
      position: new Vector2(100, 0),
    });
    const { context } = createOperationContext([a, b]);

    const result = await new Nudge2DNodesOperation({
      dx: 0,
      dy: -4,
      nodeIds: [a.nodeId, b.nodeId],
    }).perform(context);

    expect(result.didMutate).toBe(true);
    expect(a.position.y).toBeCloseTo(-4);
    expect(b.position.y).toBeCloseTo(-4);

    await result.commit?.undo();
    expect(a.position.y).toBeCloseTo(0);
    expect(b.position.y).toBeCloseTo(0);
  });

  it('applies the delta in world space through a scaled parent', async () => {
    const group = new Group2D({
      id: 'group-scaled',
      name: 'Group',
      width: 200,
      height: 200,
      position: new Vector2(0, 0),
    });
    group.scale.set(2, 2, 1);
    const child = new Sprite2D({
      id: 'child-scaled',
      name: 'Child',
      width: 20,
      height: 20,
      position: new Vector2(-30, 0),
    });
    group.add(child);

    const { context } = createOperationContext([group]);

    const result = await new Nudge2DNodesOperation({
      dx: 10,
      dy: 0,
      nodeIds: [child.nodeId],
    }).perform(context);

    expect(result.didMutate).toBe(true);
    // 10 world units / parent scale 2 = 5 local units.
    expect(child.position.x).toBeCloseTo(-25);
  });

  it('ignores non-2D nodes and reports no mutation for a pure 3D selection', async () => {
    const mesh = new Node3D({ id: 'mesh-1', name: 'Mesh' });
    const { context } = createOperationContext([mesh]);

    const result = await new Nudge2DNodesOperation({
      dx: 5,
      dy: 5,
      nodeIds: [mesh.nodeId],
    }).perform(context);

    expect(result.didMutate).toBe(false);
  });

  it('reports no mutation for a zero delta', async () => {
    const sprite = new Sprite2D({
      id: 'sprite-zero',
      name: 'Sprite',
      width: 20,
      height: 20,
      position: new Vector2(0, 0),
    });
    const { context } = createOperationContext([sprite]);

    const result = await new Nudge2DNodesOperation({
      dx: 0,
      dy: 0,
      nodeIds: [sprite.nodeId],
    }).perform(context);

    expect(result.didMutate).toBe(false);
  });
});
