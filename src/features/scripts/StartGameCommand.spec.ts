import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '@/core/command';
import { appState } from '@/state';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { OperationService } from '@/services/core/OperationService';
import { ProjectScriptLoaderService } from '@/services/scripting/ProjectScriptLoaderService';
import { SceneManager } from '@pix3/runtime';

import { StartGameCommand } from './StartGameCommand';
import { SetPlayModeOperation } from './SetPlayModeOperation';
import { resolveGameplayScenePath } from './play-workspace';

/**
 * `game.start` is the prototyping play path (Studio toolbar, Flow stage), so two promises are pinned
 * here: it never moves the active scene when there is one — that field is simultaneously what runs,
 * what the viewport shows and what the agent edits — and it never flips play mode on without one,
 * which used to be possible because its preconditions only checked `isPlaying`.
 *
 * Flow is the workspace under test because it is the one that reaches the fallback: a Flow project
 * is created without ever opening a startup scene (`PrototypeBootstrapService` goes straight to
 * `createNewProjectWithOptions`), so the stage's first launch finds no active scene.
 */
const invoke = vi.fn(async () => ({ didMutate: true }));
const setActiveScene = vi.fn();
const ensureReady = vi.fn(async () => {});
const dispatch = vi.fn(async (_command: { payload?: unknown }) => true);

const createContext = (): CommandContext => {
  const services = new Map<unknown, unknown>([
    [OperationService, { invoke }],
    [SceneManager, { setActiveScene }],
    [ProjectScriptLoaderService, { ensureReady }],
    [CommandDispatcher, { execute: dispatch }],
  ]);
  const container = {
    getOrCreateToken: <T>(token: T): T => token,
    getService: <T>(token: unknown): T => {
      if (!services.has(token)) {
        throw new Error(`Unexpected token: ${String(token)}`);
      }
      return services.get(token) as T;
    },
  };
  return {
    state: appState,
    snapshot: { ui: { isPlaying: false } } as unknown as CommandContext['snapshot'],
    container: container as unknown as CommandContext['container'],
    requestedAt: 0,
  };
};

const descriptor = (id: string, filePath: string) =>
  ({
    id,
    filePath,
    name: id,
    version: '1.0.0',
    isDirty: false,
    lastSavedAt: null,
  }) as unknown as (typeof appState.scenes.descriptors)[string];

const createCommand = (): StartGameCommand =>
  new StartGameCommand(
    // Accepted for call-site compatibility and unused (see the command's constructor doc).
    undefined as unknown as ConstructorParameters<typeof StartGameCommand>[0],
    { isPopoutOpen: () => false } as unknown as ConstructorParameters<typeof StartGameCommand>[1]
  );

describe('resolveGameplayScenePath', () => {
  it('prefers the gameplay scene over any other open scene', () => {
    const path = resolveGameplayScenePath({
      scenes: {
        descriptors: {
          'scenes-menu': { filePath: 'res://scenes/menu.pix3scene' },
          'scenes-main': { filePath: 'res://scenes/main.pix3scene' },
        },
      },
    });
    expect(path).toBe('res://scenes/main.pix3scene');
  });

  it('falls back to the first open scene when the project has no gameplay scene', () => {
    const path = resolveGameplayScenePath({
      scenes: { descriptors: { intro: { filePath: 'res://levels/intro.pix3scene' } } },
    });
    expect(path).toBe('res://levels/intro.pix3scene');
  });

  it('names the gameplay scene when nothing is open at all', () => {
    const path = resolveGameplayScenePath({ scenes: { descriptors: {} } });
    expect(path).toBe('res://scenes/main.pix3scene');
  });
});

describe('StartGameCommand', () => {
  beforeEach(() => {
    invoke.mockClear();
    setActiveScene.mockClear();
    ensureReady.mockClear();
    dispatch.mockClear();
    dispatch.mockImplementation(async () => true);
    appState.ui.workspaceMode = 'flow';
    appState.ui.isPlaying = false;
    appState.project.status = 'ready';
    appState.scenes.descriptors = {};
    appState.scenes.activeSceneId = null;
  });

  it('opens the gameplay scene when nothing is active, not the configured entry scene', async () => {
    // The entry scene is the menu on every recipe project; picking it here is what used to point the
    // whole prototyping session (stage AND agent edits) at the menu.
    appState.project.manifest = {
      defaultExportScenePath: 'scenes/menu.pix3scene',
    } as unknown as typeof appState.project.manifest;
    dispatch.mockImplementation(async () => {
      appState.scenes.activeSceneId = 'scenes-main';
      return true;
    });

    await createCommand().execute(createContext());

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      payload: { filePath: 'res://scenes/main.pix3scene' },
    });
    expect(invoke).toHaveBeenCalledWith(expect.any(SetPlayModeOperation));
  });

  it('leaves the active scene alone when there already is one', async () => {
    appState.scenes.descriptors = {
      'scenes-menu': descriptor('scenes-menu', 'res://scenes/menu.pix3scene'),
    };
    appState.scenes.activeSceneId = 'scenes-menu';

    await createCommand().execute(createContext());

    // No load, no setActiveScene: whatever the user is looking at is what plays.
    expect(dispatch).not.toHaveBeenCalled();
    expect(setActiveScene).not.toHaveBeenCalled();
    expect(appState.scenes.activeSceneId).toBe('scenes-menu');
    expect(invoke).toHaveBeenCalledWith(expect.any(SetPlayModeOperation));
  });

  it('throws instead of flipping play mode on when no scene could be opened', async () => {
    dispatch.mockImplementation(async () => false);

    await expect(createCommand().execute(createContext())).rejects.toThrow(
      /Could not open the scene|no scene could be opened/
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(appState.ui.isPlaying).toBe(false);
  });

  it('refuses to run without an open project', () => {
    appState.project.status = 'idle';

    const result = createCommand().preconditions(createContext());

    expect(result.canExecute).toBe(false);
  });
});
