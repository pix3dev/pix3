import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@/core/Operation';
import { createInitialAppState } from '@/state/AppState';
import { createDefaultProjectManifest } from '@/core/ProjectManifest';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { Group2D, Node2D, NodeBase, SceneManager } from '@pix3/runtime';
import { Vector2, Vector3 } from 'three';
import { FitGroup2DToContentsOperation } from './FitGroup2DToContentsOperation';

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
    // Mirrors the tokens `getService` below answers for; an optional-dependency lookup
    // (`syncViewportTransform`) asks this rather than probing with a try/catch.
    hasService: (token: unknown): boolean =>
      token === SceneManager || token === ViewportRendererService,
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

/**
 * World positions of every Node2D *below* `root`, keyed by nodeId. The root group itself is excluded
 * on purpose: fitting moves its origin onto the contents' centre — it's the children that must not
 * budge.
 */
const worldPositions = (root: Node2D): Map<string, Vector3> => {
  const positions = new Map<string, Vector3>();
  const visit = (node: Node2D) => {
    for (const child of node.children) {
      if (!(child instanceof Node2D)) continue;
      positions.set(child.nodeId, child.getWorldPosition(new Vector3()));
      visit(child);
    }
  };
  visit(root);
  return positions;
};

const expectSameWorldPositions = (root: Node2D, expected: Map<string, Vector3>): void => {
  for (const [nodeId, position] of worldPositions(root)) {
    const before = expected.get(nodeId);
    expect(before, `missing baseline for ${nodeId}`).toBeDefined();
    expect(position.x).toBeCloseTo(before!.x, 6);
    expect(position.y).toBeCloseTo(before!.y, 6);
  }
};

describe('FitGroup2DToContentsOperation', () => {
  it('wraps the subtree of a rotated, scaled group without moving anything in world space', async () => {
    // G is rotated 30° and non-uniformly scaled, so the origin shift has to go through the group's
    // linear part (p' = p + L·c) for the children to stay put.
    const group = new Group2D({
      id: 'group-fit',
      name: 'Group',
      width: 100,
      height: 100,
      position: new Vector2(10, 20),
    });
    group.rotation.set(0, 0, Math.PI / 6);
    group.scale.set(2, 3, 1);

    // Local rects: A → x[0..40] y[-20..20], B → x[-60..-40] y[20..40].
    const childA = new Group2D({
      id: 'child-a',
      name: 'A',
      width: 40,
      height: 40,
      position: new Vector2(20, 0),
    });
    const childB = new Group2D({
      id: 'child-b',
      name: 'B',
      width: 20,
      height: 20,
      position: new Vector2(-50, 30),
    });
    // Inside A's box, so it does not widen the union — but it must still not move.
    const grandchild = new Group2D({ id: 'grandchild', name: 'A.1', width: 10, height: 10 });
    childA.add(grandchild);
    group.add(childA);
    group.add(childB);

    const { context } = createOperationContext([group]);
    const before = worldPositions(group);

    const result = await new FitGroup2DToContentsOperation({ nodeId: group.nodeId }).perform(
      context
    );

    expect(result.didMutate).toBe(true);
    // Union is x[-60..40] y[-20..40] → 100 × 60, centered at c = (-10, 10) in group-local.
    expect(group.width).toBeCloseTo(100);
    expect(group.height).toBeCloseTo(60);
    const cos = Math.cos(Math.PI / 6);
    const sin = Math.sin(Math.PI / 6);
    expect(group.position.x).toBeCloseTo(10 + 2 * -10 * cos - 3 * 10 * sin);
    expect(group.position.y).toBeCloseTo(20 + 2 * -10 * sin + 3 * 10 * cos);
    // Direct children counter-shift by -c; deeper descendants are untouched.
    expect(childA.position.x).toBeCloseTo(30);
    expect(childA.position.y).toBeCloseTo(-10);
    expect(childB.position.x).toBeCloseTo(-40);
    expect(childB.position.y).toBeCloseTo(20);
    expect(grandchild.position.x).toBeCloseTo(0);
    expect(grandchild.position.y).toBeCloseTo(0);
    expectSameWorldPositions(group, before);
    // Rotation and scale are never touched by a fit.
    expect(group.rotation.z).toBeCloseTo(Math.PI / 6);
    expect(group.scale.x).toBeCloseTo(2);
    expect(group.scale.y).toBeCloseTo(3);
  });

  it('restores the group and every child in a single undo step, then redoes', async () => {
    const group = new Group2D({
      id: 'group-undo',
      name: 'Group',
      width: 300,
      height: 300,
      position: new Vector2(5, -5),
    });
    const child = new Group2D({
      id: 'child-undo',
      name: 'Child',
      width: 40,
      height: 20,
      position: new Vector2(60, -30),
    });
    group.add(child);

    const { context } = createOperationContext([group]);
    const result = await new FitGroup2DToContentsOperation({ nodeId: group.nodeId }).perform(
      context
    );

    expect(result.didMutate).toBe(true);
    expect(result.commit).toBeDefined();
    expect(group.width).toBeCloseTo(40);
    expect(group.height).toBeCloseTo(20);

    await result.commit!.undo();
    expect(group.width).toBeCloseTo(300);
    expect(group.height).toBeCloseTo(300);
    expect(group.position.x).toBeCloseTo(5);
    expect(group.position.y).toBeCloseTo(-5);
    expect(child.position.x).toBeCloseTo(60);
    expect(child.position.y).toBeCloseTo(-30);

    await result.commit!.redo();
    expect(group.width).toBeCloseTo(40);
    expect(group.height).toBeCloseTo(20);
    expect(group.position.x).toBeCloseTo(65);
    expect(group.position.y).toBeCloseTo(-35);
    expect(child.position.x).toBeCloseTo(0);
    expect(child.position.y).toBeCloseTo(0);
  });

  it('grows the box when a nested descendant sticks out', async () => {
    const group = new Group2D({ id: 'group-nested', name: 'Group', width: 100, height: 100 });
    const child = new Group2D({
      id: 'child-nested',
      name: 'Child',
      width: 20,
      height: 20,
      position: new Vector2(0, 0),
    });
    // Grandchild at child-local (100, 0) → group-local x[90..110]: far outside the child's own box.
    const grandchild = new Group2D({
      id: 'grandchild-nested',
      name: 'Child.1',
      width: 20,
      height: 20,
      position: new Vector2(100, 0),
    });
    child.add(grandchild);
    group.add(child);

    const { context } = createOperationContext([group]);
    const before = worldPositions(group);

    const result = await new FitGroup2DToContentsOperation({ nodeId: group.nodeId }).perform(
      context
    );

    expect(result.didMutate).toBe(true);
    // Union of x[-10..10] (child) and x[90..110] (grandchild) → 120 wide, centered at x = 50.
    expect(group.width).toBeCloseTo(120);
    expect(group.height).toBeCloseTo(20);
    expect(group.position.x).toBeCloseTo(50);
    expectSameWorldPositions(group, before);
  });

  it('leaves an anchored child world-exact and keeps its size', async () => {
    const group = new Group2D({ id: 'group-anchored', name: 'Group', width: 200, height: 200 });
    const anchored = new Group2D({
      id: 'anchored-child',
      name: 'Anchored',
      width: 40,
      height: 40,
      position: new Vector2(20, 10),
    });
    group.add(anchored);
    anchored.layoutEnabled = true;

    const { context } = createOperationContext([group]);
    const before = worldPositions(group);

    const result = await new FitGroup2DToContentsOperation({ nodeId: group.nodeId }).perform(
      context
    );

    expect(result.didMutate).toBe(true);
    expect(group.width).toBeCloseTo(40);
    expect(group.height).toBeCloseTo(40);
    expect(anchored.width).toBeCloseTo(40);
    expectSameWorldPositions(group, before);
  });

  it('does nothing for a group without Node2D descendants', async () => {
    const group = new Group2D({ id: 'group-empty', name: 'Group', width: 100, height: 100 });
    const { context } = createOperationContext([group]);

    const result = await new FitGroup2DToContentsOperation({ nodeId: group.nodeId }).perform(
      context
    );

    expect(result.didMutate).toBe(false);
    expect(group.width).toBe(100);
    expect(group.height).toBe(100);
  });

  it('does nothing when the target is not a Group2D', async () => {
    const group = new Group2D({ id: 'group-target', name: 'Group', width: 100, height: 100 });
    const { context } = createOperationContext([group]);

    const result = await new FitGroup2DToContentsOperation({ nodeId: 'missing-node' }).perform(
      context
    );

    expect(result.didMutate).toBe(false);
  });
});
