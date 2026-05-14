import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@/core/Operation';
import { createInitialAppState } from '@/state/AppState';
import { createDefaultProjectManifest } from '@/core/ProjectManifest';
import { ViewportRendererService } from '@/services/ViewportRenderService';
import { Group2D, Node3D, NodeBase, SceneManager, Sprite2D } from '@pix3/runtime';
import { Vector2 } from 'three';
import { Align2DNodesOperation } from './Align2DNodesOperation';

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
  state.project.manifest.viewportBaseSize.width = 400;
  state.project.manifest.viewportBaseSize.height = 300;

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

describe('Align2DNodesOperation', () => {
  it('aligns a root-level sprite to the viewport left edge', async () => {
    const sprite = new Sprite2D({
      id: 'sprite-root-left',
      name: 'Sprite Root',
      width: 20,
      height: 40,
      position: new Vector2(50, 10),
    });
    const { context } = createOperationContext([sprite]);

    const result = await new Align2DNodesOperation({
      action: 'container-left',
      nodeIds: [sprite.nodeId],
    }).perform(context);

    expect(result.didMutate).toBe(true);
    expect(sprite.position.x).toBeCloseTo(-190);
    expect(sprite.position.y).toBeCloseTo(10);

    await result.commit?.undo();
    expect(sprite.position.x).toBeCloseTo(50);
  });

  it('aligns grouped sprites against their shared parent bounds', async () => {
    const group = new Group2D({
      id: 'group-parent',
      name: 'Group Parent',
      width: 200,
      height: 120,
      position: new Vector2(0, 0),
    });
    const sprite = new Sprite2D({
      id: 'sprite-child-right',
      name: 'Child',
      width: 20,
      height: 20,
      position: new Vector2(-30, 0),
    });
    group.add(sprite);

    const { context } = createOperationContext([group]);

    const result = await new Align2DNodesOperation({
      action: 'container-right',
      nodeIds: [sprite.nodeId],
    }).perform(context);

    expect(result.didMutate).toBe(true);
    expect(sprite.position.x).toBeCloseTo(90);
  });

  it('aligns sprites to the current selection bounds', async () => {
    const leftSprite = new Sprite2D({
      id: 'sprite-selection-a',
      name: 'Left Sprite',
      width: 20,
      height: 20,
      position: new Vector2(-60, 0),
    });
    const rightSprite = new Sprite2D({
      id: 'sprite-selection-b',
      name: 'Right Sprite',
      width: 20,
      height: 20,
      position: new Vector2(40, 0),
    });
    const { context } = createOperationContext([leftSprite, rightSprite]);

    const result = await new Align2DNodesOperation({
      action: 'selection-left',
      nodeIds: [leftSprite.nodeId, rightSprite.nodeId],
    }).perform(context);

    expect(result.didMutate).toBe(true);
    expect(leftSprite.position.x).toBeCloseTo(-60);
    expect(rightSprite.position.x).toBeCloseTo(-60);
  });

  it('distributes horizontal gaps across a root-level selection', async () => {
    const leftSprite = new Sprite2D({
      id: 'sprite-gap-a',
      name: 'Gap A',
      width: 20,
      height: 20,
      position: new Vector2(-60, 0),
    });
    const middleSprite = new Sprite2D({
      id: 'sprite-gap-b',
      name: 'Gap B',
      width: 20,
      height: 20,
      position: new Vector2(0, 0),
    });
    const rightSprite = new Sprite2D({
      id: 'sprite-gap-c',
      name: 'Gap C',
      width: 20,
      height: 20,
      position: new Vector2(120, 0),
    });
    const { context } = createOperationContext([leftSprite, middleSprite, rightSprite]);

    const result = await new Align2DNodesOperation({
      action: 'distribute-gap-x',
      nodeIds: [leftSprite.nodeId, middleSprite.nodeId, rightSprite.nodeId],
    }).perform(context);

    expect(result.didMutate).toBe(true);
    expect(leftSprite.position.x).toBeCloseTo(-60);
    expect(middleSprite.position.x).toBeCloseTo(30);
    expect(rightSprite.position.x).toBeCloseTo(120);
  });

  it('distributes vertical centers across a selection', async () => {
    const topSprite = new Sprite2D({
      id: 'sprite-center-y-a',
      name: 'Top',
      width: 20,
      height: 20,
      position: new Vector2(0, 100),
    });
    const middleSprite = new Sprite2D({
      id: 'sprite-center-y-b',
      name: 'Middle',
      width: 20,
      height: 20,
      position: new Vector2(0, 40),
    });
    const bottomSprite = new Sprite2D({
      id: 'sprite-center-y-c',
      name: 'Bottom',
      width: 20,
      height: 20,
      position: new Vector2(0, -80),
    });
    const { context } = createOperationContext([topSprite, middleSprite, bottomSprite]);

    const result = await new Align2DNodesOperation({
      action: 'distribute-center-y',
      nodeIds: [topSprite.nodeId, middleSprite.nodeId, bottomSprite.nodeId],
    }).perform(context);

    expect(result.didMutate).toBe(true);
    expect(topSprite.position.y).toBeCloseTo(100);
    expect(middleSprite.position.y).toBeCloseTo(10);
    expect(bottomSprite.position.y).toBeCloseTo(-80);
  });

  it('does not align to a container when selection spans different parents', async () => {
    const groupA = new Group2D({
      id: 'group-a',
      name: 'Group A',
      width: 120,
      height: 120,
      position: new Vector2(-80, 0),
    });
    const groupB = new Group2D({
      id: 'group-b',
      name: 'Group B',
      width: 120,
      height: 120,
      position: new Vector2(80, 0),
    });
    const childA = new Sprite2D({
      id: 'child-a',
      name: 'Child A',
      width: 20,
      height: 20,
      position: new Vector2(-20, 0),
    });
    const childB = new Sprite2D({
      id: 'child-b',
      name: 'Child B',
      width: 20,
      height: 20,
      position: new Vector2(20, 0),
    });
    groupA.add(childA);
    groupB.add(childB);

    const { context } = createOperationContext([groupA, groupB]);

    const result = await new Align2DNodesOperation({
      action: 'container-left',
      nodeIds: [childA.nodeId, childB.nodeId],
    }).perform(context);

    expect(result.didMutate).toBe(false);
    expect(childA.position.x).toBeCloseTo(-20);
    expect(childB.position.x).toBeCloseTo(20);
  });

  it('aligns the 2D subset of a mixed selection', async () => {
    const sprite = new Sprite2D({
      id: 'mixed-selection-sprite',
      name: 'Mixed Sprite',
      width: 20,
      height: 20,
      position: new Vector2(50, 0),
    });
    const meshNode = new Node3D({
      id: 'mixed-selection-mesh',
      name: 'Mesh Node',
    });
    const { context } = createOperationContext([sprite, meshNode]);

    const result = await new Align2DNodesOperation({
      action: 'container-left',
      nodeIds: [sprite.nodeId, meshNode.nodeId],
    }).perform(context);

    expect(result.didMutate).toBe(true);
    expect(sprite.position.x).toBeCloseTo(-190);
  });
});
