import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@/core/Operation';
import { createInitialAppState } from '@/state/AppState';
import { createDefaultProjectManifest } from '@/core/ProjectManifest';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { Group2D, Node3D, NodeBase, SceneManager, Sprite2D } from '@pix3/runtime';
import { Vector2, Vector3 } from 'three';
import { GroupSelectedNodesOperation } from './GroupSelectedNodesOperation';

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

describe('GroupSelectedNodesOperation', () => {
  it('creates the Group2D pre-sized to the selection bounds, keeping children world-exact', async () => {
    // A occupies x[-10..10] y[-10..10]; B occupies x[90..110] y[40..60].
    const spriteA = new Sprite2D({ id: 'sprite-a', name: 'A', width: 20, height: 20 });
    const spriteB = new Sprite2D({
      id: 'sprite-b',
      name: 'B',
      width: 20,
      height: 20,
      position: new Vector2(100, 50),
    });
    const { context, sceneGraph } = createOperationContext([spriteA, spriteB]);
    const worldA = spriteA.getWorldPosition(new Vector3());
    const worldB = spriteB.getWorldPosition(new Vector3());

    const result = await new GroupSelectedNodesOperation({
      nodeIds: [spriteA.nodeId, spriteB.nodeId],
    }).perform(context);

    expect(result.didMutate).toBe(true);
    const group = sceneGraph.rootNodes.find(node => node instanceof Group2D) as Group2D;
    expect(group).toBeDefined();
    // Union x[-10..110] y[-10..60] → 120 × 70 centred at (50, 25).
    expect(group.width).toBeCloseTo(120);
    expect(group.height).toBeCloseTo(70);
    expect(group.position.x).toBeCloseTo(50);
    expect(group.position.y).toBeCloseTo(25);

    // Children were attached, so their local offsets are relative to the new centre…
    expect(spriteA.parentNode).toBe(group);
    expect(spriteA.position.x).toBeCloseTo(-50);
    expect(spriteA.position.y).toBeCloseTo(-25);
    expect(spriteB.position.x).toBeCloseTo(50);
    expect(spriteB.position.y).toBeCloseTo(25);
    // …and their world positions did not move.
    const worldAAfter = spriteA.getWorldPosition(new Vector3());
    const worldBAfter = spriteB.getWorldPosition(new Vector3());
    expect(worldAAfter.x).toBeCloseTo(worldA.x);
    expect(worldAAfter.y).toBeCloseTo(worldA.y);
    expect(worldBAfter.x).toBeCloseTo(worldB.x);
    expect(worldBAfter.y).toBeCloseTo(worldB.y);
  });

  it('measures the bounds in the new group parent frame', async () => {
    const parent = new Group2D({
      id: 'parent-group',
      name: 'Parent',
      width: 400,
      height: 400,
      position: new Vector2(1000, -1000),
    });
    const sprite = new Sprite2D({
      id: 'sprite-child',
      name: 'Child',
      width: 40,
      height: 40,
      position: new Vector2(30, 20),
    });
    parent.add(sprite);
    const { context } = createOperationContext([parent]);

    const result = await new GroupSelectedNodesOperation({ nodeIds: [sprite.nodeId] }).perform(
      context
    );

    expect(result.didMutate).toBe(true);
    const group = parent.children.find(child => child instanceof Group2D) as Group2D;
    expect(group).toBeDefined();
    // Parent-local bounds of the sprite: 40 × 40 centred at (30, 20) — not offset by the parent's own
    // world position.
    expect(group.width).toBeCloseTo(40);
    expect(group.height).toBeCloseTo(40);
    expect(group.position.x).toBeCloseTo(30);
    expect(group.position.y).toBeCloseTo(20);
    expect(sprite.position.x).toBeCloseTo(0);
    expect(sprite.position.y).toBeCloseTo(0);
  });

  it('undo removes the group and restores the previous parents', async () => {
    const sprite = new Sprite2D({
      id: 'sprite-undo',
      name: 'Sprite',
      width: 20,
      height: 20,
      position: new Vector2(40, 0),
    });
    const { context, sceneGraph } = createOperationContext([sprite]);

    const result = await new GroupSelectedNodesOperation({ nodeIds: [sprite.nodeId] }).perform(
      context
    );
    expect(result.didMutate).toBe(true);

    await result.commit!.undo();
    expect(sceneGraph.rootNodes.some(node => node instanceof Group2D)).toBe(false);
    expect(sceneGraph.rootNodes).toContain(sprite);
    expect(sprite.parentNode).toBeNull();
    expect(sprite.position.x).toBeCloseTo(40);
    expect(sprite.position.y).toBeCloseTo(0);
  });

  it('groups 3D nodes under a plain Node3D (no 2D sizing)', async () => {
    const meshA = new Node3D({ id: 'mesh-a', name: 'A' });
    const meshB = new Node3D({ id: 'mesh-b', name: 'B' });
    const { context, sceneGraph } = createOperationContext([meshA, meshB]);

    const result = await new GroupSelectedNodesOperation({
      nodeIds: [meshA.nodeId, meshB.nodeId],
    }).perform(context);

    expect(result.didMutate).toBe(true);
    const group = sceneGraph.rootNodes.find(node => node instanceof Node3D && node !== meshA);
    expect(group).toBeInstanceOf(Node3D);
    expect(group).not.toBeInstanceOf(Group2D);
  });
});
