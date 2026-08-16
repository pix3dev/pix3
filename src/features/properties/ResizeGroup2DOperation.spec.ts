import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@/core/Operation';
import { createInitialAppState } from '@/state/AppState';
import { createDefaultProjectManifest } from '@/core/ProjectManifest';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { Group2D, Node2D, NodeBase, SceneManager, Sprite2D } from '@pix3/runtime';
import { Vector2 } from 'three';
import { ResizeGroup2DOperation } from './ResizeGroup2DOperation';

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

describe('ResizeGroup2DOperation', () => {
  it('scales child positions and sizes by the resize factors', async () => {
    const group = new Group2D({ id: 'group', name: 'Group', width: 100, height: 100 });
    const child = new Sprite2D({
      id: 'child',
      name: 'Child',
      width: 40,
      height: 20,
      position: new Vector2(30, 10),
    });
    group.add(child);

    const { context } = createOperationContext([group]);
    const result = await new ResizeGroup2DOperation({
      nodeId: group.nodeId,
      width: 200,
      height: 50,
    }).perform(context);

    expect(result.didMutate).toBe(true);
    expect(group.width).toBeCloseTo(200);
    expect(group.height).toBeCloseTo(50);
    // fx = 2, fy = 0.5
    expect(child.position.x).toBeCloseTo(60);
    expect(child.position.y).toBeCloseTo(5);
    expect(child.width).toBeCloseTo(80);
    expect(child.height).toBeCloseTo(10);
    // Sizes are authored on width/height; the transform scale stays put.
    expect(child.scale.x).toBeCloseTo(1);
    expect(child.scale.y).toBeCloseTo(1);
  });

  it('recurses into a nested group and scales its contents too', async () => {
    const group = new Group2D({ id: 'group', name: 'Group', width: 100, height: 100 });
    const nested = new Group2D({
      id: 'nested',
      name: 'Nested',
      width: 50,
      height: 50,
      position: new Vector2(20, 0),
    });
    const leaf = new Sprite2D({
      id: 'leaf',
      name: 'Leaf',
      width: 10,
      height: 10,
      position: new Vector2(5, 5),
    });
    nested.add(leaf);
    group.add(nested);

    const { context } = createOperationContext([group]);
    const result = await new ResizeGroup2DOperation({
      nodeId: group.nodeId,
      width: 300,
      height: 100,
    }).perform(context);

    expect(result.didMutate).toBe(true);
    // fx = 3, fy = 1 — the nested group's own frame does not scale, so its contents scale explicitly.
    expect(nested.position.x).toBeCloseTo(60);
    expect(nested.width).toBeCloseTo(150);
    expect(nested.height).toBeCloseTo(50);
    expect(leaf.position.x).toBeCloseTo(15);
    expect(leaf.position.y).toBeCloseTo(5);
    expect(leaf.width).toBeCloseTo(30);
    expect(leaf.height).toBeCloseTo(10);
  });

  it('scales a size-less child through its transform scale and stops there', async () => {
    const group = new Group2D({ id: 'group', name: 'Group', width: 100, height: 100 });
    const plain = new Node2D({ id: 'plain', name: 'Plain', position: new Vector2(10, 20) });
    const buried = new Sprite2D({
      id: 'buried',
      name: 'Buried',
      width: 10,
      height: 10,
      position: new Vector2(4, 4),
    });
    plain.add(buried);
    group.add(plain);

    const { context } = createOperationContext([group]);
    const result = await new ResizeGroup2DOperation({
      nodeId: group.nodeId,
      width: 200,
      height: 200,
    }).perform(context);

    expect(result.didMutate).toBe(true);
    expect(plain.position.x).toBeCloseTo(20);
    expect(plain.position.y).toBeCloseTo(40);
    expect(plain.scale.x).toBeCloseTo(2);
    expect(plain.scale.y).toBeCloseTo(2);
    // Descendants of a scale-handled node inherit through the transform — never touched directly.
    expect(buried.position.x).toBeCloseTo(4);
    expect(buried.width).toBeCloseTo(10);
    expect(buried.scale.x).toBeCloseTo(1);
  });

  it('leaves an anchored child to the anchor reflow', async () => {
    const group = new Group2D({ id: 'group', name: 'Group', width: 100, height: 100 });
    const anchored = new Sprite2D({
      id: 'anchored',
      name: 'Anchored',
      width: 40,
      height: 40,
      position: new Vector2(30, 10),
    });
    group.add(anchored);
    anchored.layoutEnabled = true;

    const { context } = createOperationContext([group]);
    const result = await new ResizeGroup2DOperation({
      nodeId: group.nodeId,
      width: 200,
      height: 100,
    }).perform(context);

    expect(result.didMutate).toBe(true);
    expect(group.width).toBeCloseTo(200);
    // Centre-aligned anchor layout keeps the authored rect — no proportional scaling applied.
    expect(anchored.position.x).toBeCloseTo(30);
    expect(anchored.position.y).toBeCloseTo(10);
    expect(anchored.width).toBeCloseTo(40);
    expect(anchored.height).toBeCloseTo(40);
  });

  it('restores the group and its children in one undo step, then redoes', async () => {
    const group = new Group2D({ id: 'group', name: 'Group', width: 100, height: 100 });
    const child = new Sprite2D({
      id: 'child',
      name: 'Child',
      width: 40,
      height: 20,
      position: new Vector2(30, 10),
    });
    group.add(child);

    const { context } = createOperationContext([group]);
    const result = await new ResizeGroup2DOperation({
      nodeId: group.nodeId,
      width: 250,
      height: 400,
    }).perform(context);

    expect(result.commit).toBeDefined();
    await result.commit!.undo();
    expect(group.width).toBeCloseTo(100);
    expect(group.height).toBeCloseTo(100);
    expect(child.position.x).toBeCloseTo(30);
    expect(child.position.y).toBeCloseTo(10);
    expect(child.width).toBeCloseTo(40);
    expect(child.height).toBeCloseTo(20);

    await result.commit!.redo();
    expect(group.width).toBeCloseTo(250);
    expect(group.height).toBeCloseTo(400);
    expect(child.position.x).toBeCloseTo(75);
    expect(child.position.y).toBeCloseTo(40);
    expect(child.width).toBeCloseTo(100);
    expect(child.height).toBeCloseTo(80);
  });

  it('does nothing for an unchanged or invalid size', async () => {
    const group = new Group2D({ id: 'group', name: 'Group', width: 100, height: 100 });
    group.add(new Sprite2D({ id: 'child', name: 'Child', width: 10, height: 10 }));
    const { context } = createOperationContext([group]);

    const unchanged = await new ResizeGroup2DOperation({
      nodeId: group.nodeId,
      width: 100,
      height: 100,
    }).perform(context);
    expect(unchanged.didMutate).toBe(false);

    const invalid = await new ResizeGroup2DOperation({
      nodeId: group.nodeId,
      width: 0,
      height: 100,
    }).perform(context);
    expect(invalid.didMutate).toBe(false);
    expect(group.width).toBe(100);
  });
});
