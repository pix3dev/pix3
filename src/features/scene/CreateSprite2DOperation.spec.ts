import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@/core/Operation';
import { createInitialAppState } from '@/state/AppState';
import { SceneManager, Group2D, AssetLoader, type NodeBase } from '@pix3/runtime';
import { Texture, Vector2 } from 'three';
import { CreateSprite2DOperation } from './CreateSprite2DOperation';

describe('CreateSprite2DOperation', () => {
  it('adds sprite to root nodes when created via async flow', async () => {
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

    const parentA = new Group2D({
      id: 'group-a',
      name: 'Group A',
      position: new Vector2(0, 0),
      width: 100,
      height: 100,
    });
    const parentB = new Group2D({
      id: 'group-b',
      name: 'Group B',
      position: new Vector2(0, 0),
      width: 100,
      height: 100,
    });

    const rootNodes: NodeBase[] = [parentA, parentB];
    const nodeMap = new Map<string, NodeBase>([
      [parentA.nodeId, parentA],
      [parentB.nodeId, parentB],
    ]);
    const sceneGraph = {
      version: '1.0.0',
      description: 'Scene',
      metadata: {},
      rootNodes,
      nodeMap,
    };

    const sceneManagerMock = {
      getSceneGraph: (sceneId: string) => (sceneId === 'scene-1' ? sceneGraph : null),
    } satisfies Pick<SceneManager, 'getSceneGraph'>;

    let resolveTexture!: () => void;
    const textureLoaded = new Promise<void>(resolve => {
      resolveTexture = resolve;
    });
    const assetLoaderMock = {
      loadTexture: async () => {
        await textureLoaded;
        const texture = new Texture();
        (texture as Texture & { image: { naturalWidth: number; naturalHeight: number } }).image = {
          naturalWidth: 64,
          naturalHeight: 32,
        };
        return texture;
      },
    } satisfies Pick<AssetLoader, 'loadTexture'>;

    const container = {
      getOrCreateToken: <T>(token: T): T => token,
      getService: <T>(token: unknown): T => {
        if (token === SceneManager) {
          return sceneManagerMock as T;
        }
        if (token === AssetLoader) {
          return assetLoaderMock as T;
        }
        throw new Error(`Unexpected token: ${String(token)}`);
      },
    };

    state.selection.primaryNodeId = parentB.nodeId;

    const context = {
      state,
      snapshot: {
        selection: {
          primaryNodeId: parentA.nodeId,
        },
      },
      container: container as OperationContext['container'],
      requestedAt: Date.now(),
    } as unknown as OperationContext;

    const operation = new CreateSprite2DOperation({
      texturePath: 'res://assets/sprite.png',
    });

    const performPromise = operation.perform(context);

    state.selection.primaryNodeId = parentB.nodeId;
    resolveTexture();

    const result = await performPromise;
    expect(result.didMutate).toBe(true);
    expect(sceneGraph.rootNodes).toHaveLength(3);
    expect(parentA.children).toHaveLength(0);
  });

  it('inserts sprite into the requested 2D parent and preserves placement through undo/redo', async () => {
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

    const parent = new Group2D({
      id: 'group-parent',
      name: 'Parent',
      position: new Vector2(0, 0),
      width: 200,
      height: 200,
    });
    const existingChild = new Group2D({
      id: 'existing-child',
      name: 'Existing Child',
      position: new Vector2(0, 0),
      width: 64,
      height: 64,
    });
    parent.add(existingChild);

    const rootNodes: NodeBase[] = [parent];
    const nodeMap = new Map<string, NodeBase>([
      [parent.nodeId, parent],
      [existingChild.nodeId, existingChild],
    ]);
    const sceneGraph = {
      version: '1.0.0',
      description: 'Scene',
      metadata: {},
      rootNodes,
      nodeMap,
    };

    const sceneManagerMock = {
      getSceneGraph: (sceneId: string) => (sceneId === 'scene-1' ? sceneGraph : null),
    } satisfies Pick<SceneManager, 'getSceneGraph'>;

    const assetLoaderMock = {
      loadTexture: async () => {
        const texture = new Texture();
        (texture as Texture & { image: { naturalWidth: number; naturalHeight: number } }).image = {
          naturalWidth: 128,
          naturalHeight: 64,
        };
        return texture;
      },
    } satisfies Pick<AssetLoader, 'loadTexture'>;

    const container = {
      getOrCreateToken: <T>(token: T): T => token,
      getService: <T>(token: unknown): T => {
        if (token === SceneManager) {
          return sceneManagerMock as T;
        }
        if (token === AssetLoader) {
          return assetLoaderMock as T;
        }
        throw new Error(`Unexpected token: ${String(token)}`);
      },
    };

    const context = {
      state,
      snapshot: { selection: { primaryNodeId: null } },
      container: container as OperationContext['container'],
      requestedAt: Date.now(),
    } as unknown as OperationContext;

    const operation = new CreateSprite2DOperation({
      texturePath: 'res://assets/sprite.png',
      parentNodeId: parent.nodeId,
      insertIndex: 0,
    });

    const result = await operation.perform(context);
    expect(result.didMutate).toBe(true);
    expect(parent.children).toHaveLength(2);

    const createdNodeId = state.selection.primaryNodeId;
    expect(createdNodeId).toBeTruthy();
    expect(parent.children[0]?.nodeId).toBe(createdNodeId);
    expect(parent.children[1]?.nodeId).toBe(existingChild.nodeId);

    result.commit?.undo();
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]?.nodeId).toBe(existingChild.nodeId);

    result.commit?.redo();
    expect(parent.children).toHaveLength(2);
    expect(parent.children[0]?.nodeId).toBe(createdNodeId);
    expect(parent.children[1]?.nodeId).toBe(existingChild.nodeId);
  });
});
