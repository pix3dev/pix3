import { describe, expect, it, vi } from 'vitest';

import type { OperationContext } from '@/core/Operation';
import { createInitialAppState } from '@/state/AppState';
import { AnimatedSprite2D, SceneManager } from '@pix3/runtime';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { CreateAndBindAnimationAssetOperation } from './CreateAndBindAnimationAssetOperation';

const PLAYER_ANIMATION_PATH = 'res://animations/player/player.pix3anim';
const PLAYER_ANIMATION_DIRECTORY = 'animations/player';

const createOperationContext = (sprite: AnimatedSprite2D) => {
  const state = createInitialAppState();
  state.project.status = 'ready';
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
    rootNodes: [sprite],
    nodeMap: new Map([[sprite.nodeId, sprite]]),
  };

  const files = new Map<string, string>();
  const storageMock: Pick<
    ProjectStorageService,
    'readTextFile' | 'writeTextFile' | 'deleteEntry' | 'createDirectory'
  > = {
    readTextFile: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (typeof value !== 'string') {
        throw new Error(`Missing file: ${path}`);
      }
      return value;
    }),
    writeTextFile: vi.fn(async (path: string, contents: string) => {
      files.set(path, contents);
    }),
    deleteEntry: vi.fn(async (path: string) => {
      const normalizedPath = path
        .replace(/^res:\/\//, '')
        .replace(/\\/g, '/')
        .replace(/\/+$/, '');
      for (const existingPath of Array.from(files.keys())) {
        const normalizedExistingPath = existingPath
          .replace(/^res:\/\//, '')
          .replace(/\\/g, '/')
          .replace(/\/+$/, '');
        if (
          normalizedExistingPath === normalizedPath ||
          normalizedExistingPath.startsWith(`${normalizedPath}/`)
        ) {
          files.delete(existingPath);
        }
      }
    }),
    createDirectory: vi.fn(async () => {}),
  };

  const sceneManagerMock: Pick<SceneManager, 'getActiveSceneGraph'> = {
    getActiveSceneGraph: () => sceneGraph,
  };

  const viewportRendererMock: Pick<ViewportRendererService, 'updateSelection'> = {
    updateSelection: vi.fn(),
  };

  const container = {
    getOrCreateToken: <T>(token: T): T => token,
    getService: <T>(token: unknown): T => {
      if (token === ProjectStorageService) {
        return storageMock as T;
      }
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

  return { context, files, storageMock };
};

describe('CreateAndBindAnimationAssetOperation', () => {
  it('creates and binds an animation asset in one operation', async () => {
    const sprite = new AnimatedSprite2D({
      id: 'sprite-1',
      name: 'Player',
    });
    const { context, files, storageMock } = createOperationContext(sprite);
    const operation = new CreateAndBindAnimationAssetOperation({
      nodeId: sprite.nodeId,
      assetPath: 'res://animations/player',
      texturePath: '',
      initialClipName: 'idle',
    });

    const result = await operation.perform(context);

    expect(result.didMutate).toBe(true);
    expect(sprite.animationResourcePath).toBe(PLAYER_ANIMATION_PATH);
    expect(files.has(PLAYER_ANIMATION_PATH)).toBe(true);
    expect(storageMock.createDirectory).toHaveBeenCalledWith(PLAYER_ANIMATION_DIRECTORY);

    await result.commit?.undo();
    expect(sprite.animationResourcePath).toBeNull();
    expect(files.has(PLAYER_ANIMATION_PATH)).toBe(false);
    expect(storageMock.deleteEntry).toHaveBeenCalledWith(PLAYER_ANIMATION_DIRECTORY);

    await result.commit?.redo();
    expect(sprite.animationResourcePath).toBe(PLAYER_ANIMATION_PATH);
    expect(files.has(PLAYER_ANIMATION_PATH)).toBe(true);
  });

  it('rolls back the created asset when binding fails', async () => {
    const sprite = new AnimatedSprite2D({
      id: 'sprite-1',
      name: 'Player',
    });
    const { context, files } = createOperationContext(sprite);
    const operation = new CreateAndBindAnimationAssetOperation({
      nodeId: 'missing-node',
      assetPath: 'res://animations/player',
      texturePath: '',
      initialClipName: 'idle',
    });

    const result = await operation.perform(context);

    expect(result.didMutate).toBe(false);
    expect(sprite.animationResourcePath).toBeNull();
    expect(files.has(PLAYER_ANIMATION_PATH)).toBe(false);
  });
});
