import { describe, expect, it, beforeEach } from 'vitest';
import type { OperationContext } from '@/core/Operation';
import { createInitialAppState } from '@/state/AppState';
import {
  EDITOR_SETTINGS_STORAGE_KEY,
  UpdateEditorSettingsOperation,
  loadEditorSettings,
} from './UpdateEditorSettingsOperation';

const createStorageStub = (): Storage => {
  const data = new Map<string, string>();

  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
};

const operationWith = (
  context: OperationContext,
  params: ConstructorParameters<typeof UpdateEditorSettingsOperation>[0]
) => new UpdateEditorSettingsOperation(params).perform(context);

describe('UpdateEditorSettingsOperation', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorageStub(),
      configurable: true,
      writable: true,
    });
  });

  it('persists gameAspectRatio changes and supports undo/redo', async () => {
    const state = createInitialAppState();
    const context = {
      state,
      snapshot: structuredClone(state),
      container: {} as OperationContext['container'],
      requestedAt: Date.now(),
    } as OperationContext;

    const operation = new UpdateEditorSettingsOperation({
      gameAspectRatio: '16:9-landscape',
    });

    const result = await operation.perform(context);

    expect(result.didMutate).toBe(true);
    expect(state.ui.gameAspectRatio).toBe('16:9-landscape');

    const stored = JSON.parse(localStorage.getItem(EDITOR_SETTINGS_STORAGE_KEY) ?? '{}') as {
      gameAspectRatio?: string;
    };
    expect(stored.gameAspectRatio).toBe('16:9-landscape');

    await result.commit?.undo();
    expect(state.ui.gameAspectRatio).toBe('free');

    await result.commit?.redo();
    expect(state.ui.gameAspectRatio).toBe('16:9-landscape');
  });

  it('persists flowStageAspect independently of gameAspectRatio', async () => {
    const state = createInitialAppState();
    const context = {
      state,
      snapshot: structuredClone(state),
      container: {} as OperationContext['container'],
      requestedAt: Date.now(),
    } as OperationContext;

    const result = await operationWith(context, { flowStageAspect: '16:9-portrait' });

    expect(result.didMutate).toBe(true);
    expect(state.ui.flowStageAspect).toBe('16:9-portrait');
    // The two settings are separate on purpose: Vibe's pick must not retune the Game tab.
    expect(state.ui.gameAspectRatio).toBe('free');

    const stored = JSON.parse(localStorage.getItem(EDITOR_SETTINGS_STORAGE_KEY) ?? '{}') as {
      flowStageAspect?: string;
    };
    expect(stored.flowStageAspect).toBe('16:9-portrait');

    await result.commit?.undo();
    expect(state.ui.flowStageAspect).toBe('project');

    await result.commit?.redo();
    expect(state.ui.flowStageAspect).toBe('16:9-portrait');
  });

  it('loads a persisted flowStageAspect, and ignores a value that is not one', () => {
    localStorage.setItem(
      EDITOR_SETTINGS_STORAGE_KEY,
      JSON.stringify({ flowStageAspect: 'project' })
    );
    expect(loadEditorSettings()?.flowStageAspect).toBe('project');

    localStorage.setItem(EDITOR_SETTINGS_STORAGE_KEY, JSON.stringify({ flowStageAspect: '21:9' }));
    expect(loadEditorSettings()?.flowStageAspect).toBeUndefined();
  });

  it('loads persisted gameAspectRatio from storage', () => {
    localStorage.setItem(
      EDITOR_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        warnOnUnsavedUnload: false,
        pauseRenderingOnUnfocus: true,
        navigation2D: {
          panSensitivity: 1,
          zoomSensitivity: 1,
        },
        gameAspectRatio: '4:3',
      })
    );

    const settings = loadEditorSettings();

    expect(settings?.gameAspectRatio).toBe('4:3');
  });
});
