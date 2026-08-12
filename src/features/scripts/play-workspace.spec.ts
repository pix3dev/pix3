import { beforeEach, describe, expect, it, vi } from 'vitest';

import { appState } from '@/state';
import type { ServiceContainer } from '@/fw/di';

import { ensureSceneActive } from './play-workspace';

/**
 * A container that hands out whatever stub is registered for a class, keyed by the class itself
 * (`getOrCreateToken` is identity here, exactly as the other command specs do it).
 */
const createContainer = (services: Map<unknown, unknown>): ServiceContainer =>
  ({
    getOrCreateToken: <T>(token: T): T => token,
    getService: <T>(token: unknown): T => {
      if (!services.has(token)) {
        throw new Error('Unexpected getService call in this test');
      }
      return services.get(token) as T;
    },
  }) as unknown as ServiceContainer;

const setActiveScene = vi.fn();
const ensureReady = vi.fn(async () => {});
const execute = vi.fn(async () => true);

const buildContainer = async (): Promise<ServiceContainer> => {
  const { SceneManager } = await import('@pix3/runtime');
  const { ProjectScriptLoaderService } = await import(
    '@/services/scripting/ProjectScriptLoaderService'
  );
  const { CommandDispatcher } = await import('@/services/core/CommandDispatcher');
  return createContainer(
    new Map<unknown, unknown>([
      [SceneManager, { setActiveScene }],
      [ProjectScriptLoaderService, { ensureReady }],
      [CommandDispatcher, { execute }],
    ])
  );
};

describe('ensureSceneActive (Flow)', () => {
  beforeEach(() => {
    setActiveScene.mockClear();
    ensureReady.mockClear();
    execute.mockClear();
    appState.ui.workspaceMode = 'flow';
    appState.scenes.descriptors = {};
    appState.scenes.activeSceneId = null;
  });

  it('activates an already-loaded scene without dispatching a load', async () => {
    appState.scenes.descriptors = {
      'scenes-main': {
        id: 'scenes-main',
        filePath: 'res://scenes/main.pix3scene',
        name: 'Main',
        version: '1.0.0',
        isDirty: false,
        lastSavedAt: null,
        fileHandle: null,
        lastModifiedTime: null,
      },
    } as unknown as typeof appState.scenes.descriptors;

    await ensureSceneActive(await buildContainer(), 'res://scenes/main.pix3scene');

    expect(appState.scenes.activeSceneId).toBe('scenes-main');
    expect(setActiveScene).toHaveBeenCalledWith('scenes-main');
    expect(execute).not.toHaveBeenCalled();
  });

  it('throws when the load command is blocked rather than reporting success', async () => {
    // A blocked command returns false (preconditions), it does not throw. Swallowing that is what
    // let play mode flip on with no scene — the caller must see a failure.
    execute.mockResolvedValueOnce(false);

    await expect(
      ensureSceneActive(await buildContainer(), 'res://scenes/main.pix3scene')
    ).rejects.toThrow(/Could not open the scene/);
    expect(appState.scenes.activeSceneId).toBeNull();
  });

  it('throws when the load reports success but no scene became active', async () => {
    execute.mockResolvedValueOnce(true);

    await expect(
      ensureSceneActive(await buildContainer(), 'res://scenes/main.pix3scene')
    ).rejects.toThrow(/Could not open the scene/);
  });

  it('loads the scene when it is not open yet, scripts first', async () => {
    execute.mockImplementationOnce(async () => {
      appState.scenes.activeSceneId = 'scenes-main';
      return true;
    });

    await ensureSceneActive(await buildContainer(), 'res://scenes/main.pix3scene');

    expect(ensureReady).toHaveBeenCalled();
    expect(appState.scenes.activeSceneId).toBe('scenes-main');
  });
});
