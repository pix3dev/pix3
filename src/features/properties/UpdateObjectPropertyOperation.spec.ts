import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '@/core/Operation';
import { createInitialAppState } from '@/state/AppState';
import { NodeBase, SceneManager, Sprite2D } from '@pix3/runtime';
import { ViewportRendererService } from '@/services/ViewportRenderService';
import { UpdateObjectPropertyOperation } from './UpdateObjectPropertyOperation';

const createOperationContext = (node: NodeBase) => {
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

  const sceneGraph = {
    version: '1.0.0',
    description: 'Scene',
    metadata: {},
    rootNodes: [node],
    nodeMap: new Map([[node.nodeId, node]]),
  };

  const sceneManagerMock: Pick<SceneManager, 'getActiveSceneGraph'> = {
    getActiveSceneGraph: () => sceneGraph,
  };
  const viewportRendererMock: Pick<
    ViewportRendererService,
    'updateNodeTransform' | 'updateNodeVisibility' | 'updateSelection'
  > = {
    updateNodeTransform: vi.fn(),
    updateNodeVisibility: vi.fn(),
    updateSelection: vi.fn(),
  };

  const container = {
    getOrCreateToken: <T>(token: T): T => token,
    getService: <T>(token: unknown): T => {
      if (token === SceneManager) {
        return sceneManagerMock as T;
      }
      if (token === ViewportRendererService) {
        return viewportRendererMock as T;
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

  return { context, node, state, viewportRendererMock };
};

describe('UpdateObjectPropertyOperation', () => {
  it('preserves initial visibility when editor visibility is toggled', async () => {
    const node = new NodeBase({
      id: 'node-1',
      type: 'Node3D',
      name: 'Node 1',
      properties: { visible: true },
    });
    const { context } = createOperationContext(node);
    const operation = new UpdateObjectPropertyOperation({
      nodeId: 'node-1',
      propertyPath: 'visible',
      value: false,
    });

    const result = await operation.perform(context);

    expect(result.didMutate).toBe(true);
    expect(node.visible).toBe(false);
    expect(node.properties.visible).toBe(false);
    expect(node.properties.initiallyVisible).toBe(true);

    await result.commit?.undo();
    expect(node.visible).toBe(true);
    expect(node.properties.visible).toBe(true);
    expect(node.properties.initiallyVisible).toBeUndefined();

    await result.commit?.redo();
    expect(node.visible).toBe(false);
    expect(node.properties.visible).toBe(false);
    expect(node.properties.initiallyVisible).toBe(true);
  });

  it('routes Sprite2D opacity changes through the viewport transform update path', async () => {
    const sprite = new Sprite2D({
      id: 'sprite-opacity-node',
      name: 'Sprite',
      width: 64,
      height: 64,
      opacity: 1,
    });
    const { context, viewportRendererMock } = createOperationContext(sprite);
    const operation = new UpdateObjectPropertyOperation({
      nodeId: sprite.nodeId,
      propertyPath: 'opacity',
      value: 0.35,
    });

    const result = await operation.perform(context);

    expect(result.didMutate).toBe(true);
    expect(sprite.opacity).toBe(0.35);
    expect(viewportRendererMock.updateNodeTransform).toHaveBeenCalledWith(sprite);
    expect(viewportRendererMock.updateSelection).not.toHaveBeenCalled();
  });

  it('keeps explicit initial visibility unchanged', async () => {
    const node = new NodeBase({
      id: 'node-1',
      type: 'Node3D',
      name: 'Node 1',
      properties: { visible: true, initiallyVisible: false },
    });
    const { context } = createOperationContext(node);
    const operation = new UpdateObjectPropertyOperation({
      nodeId: 'node-1',
      propertyPath: 'visible',
      value: false,
    });

    const result = await operation.perform(context);

    expect(result.didMutate).toBe(true);
    expect(node.properties.initiallyVisible).toBe(false);

    await result.commit?.undo();
    expect(node.properties.initiallyVisible).toBe(false);
  });
});
