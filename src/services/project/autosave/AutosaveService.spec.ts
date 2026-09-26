import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appState, resetAppState } from '@/state';
import type { OperationEvent } from '@/services/core/OperationService';
import { SceneDiskStateService } from '@/services/project/coauthoring/SceneDiskStateService';
import { MemoryStorage, wire } from '@/services/project/coauthoring/memory-storage.spec-helper';
import { SaveSceneOperation } from '@/features/scene/SaveSceneOperation';
import { AUTOSAVE_DEBOUNCE_MS, AutosaveService } from './AutosaveService';

const committed: OperationEvent = {
  type: 'operation:completed',
  metadata: { id: 'scene.update-object-property', title: 'Update' },
  didMutate: true,
  pushedToHistory: true,
  origin: 'user',
  timestamp: 0,
};

function createHarness(options: { backend?: 'local' | 'workspace' | 'cloud' } = {}) {
  appState.project.status = 'ready';
  appState.project.id = 'p1';
  appState.project.backend = options.backend ?? 'workspace';
  appState.scenes.descriptors['s1'] = {
    id: 's1',
    filePath: 'res://scenes/main.pix3scene',
    name: 'Main',
    version: '1.0.0',
    isDirty: false,
    lastSavedAt: null,
    fileHandle: null,
    lastModifiedTime: null,
  };

  const storage = new MemoryStorage();
  const diskState = new SceneDiskStateService();
  let owner = true;
  let gesture = false;
  let outcome: 'saved' | 'external-change' = 'saved';
  const invoke = vi.fn(async () => {
    if (outcome === 'saved') appState.scenes.descriptors['s1'].isDirty = false;
    return { didMutate: outcome === 'saved', outcome };
  });
  const service = wire(new AutosaveService(), {
    operations: { invoke, addListener: () => () => undefined },
    storage,
    diskState,
    ownership: { isOwner: () => owner, subscribe: () => () => undefined },
    gestures: { isGestureActive: () => gesture },
  });

  const edit = () => {
    appState.scenes.descriptors['s1'].isDirty = true;
    service.handleOperationEvent(committed);
  };
  return {
    service,
    storage,
    diskState,
    invoke,
    edit,
    setOwner: (value: boolean) => {
      owner = value;
    },
    setGesture: (value: boolean) => {
      gesture = value;
    },
    setOutcome: (value: 'saved' | 'external-change') => {
      outcome = value;
    },
  };
}

beforeEach(() => {
  resetAppState();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AutosaveService', () => {
  it('saves a dirty scene ~1 s after the last committed operation (debounced)', async () => {
    const h = createHarness();
    h.service.initialize();
    expect(appState.project.coauthoring.autosaveEnabled).toBe(true);

    h.edit();
    await vi.advanceTimersByTimeAsync(600);
    h.edit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS - 100);
    expect(h.invoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    const [operation, options] = h.invoke.mock.calls[0] as unknown as [SaveSceneOperation, unknown];
    expect(operation).toBeInstanceOf(SaveSceneOperation);
    expect(options).toEqual({ origin: 'system' });
    expect(appState.project.coauthoring.autosaveStatus).toBe('saved');
    h.service.dispose();
  });

  it('is off for a local folder without an agent kit, on with the setting or a kit', async () => {
    const h = createHarness({ backend: 'local' });
    h.service.initialize();
    expect(appState.project.coauthoring.autosaveEnabled).toBe(false);
    expect(appState.project.coauthoring.autosaveStatus).toBe('off');
    h.edit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(h.invoke).not.toHaveBeenCalled();

    appState.ui.autosaveLocalProjects = true;
    await vi.advanceTimersByTimeAsync(0);
    expect(appState.project.coauthoring.autosaveEnabled).toBe(true);

    appState.ui.autosaveLocalProjects = false;
    await vi.advanceTimersByTimeAsync(0);
    expect(appState.project.coauthoring.autosaveEnabled).toBe(false);

    h.storage.files.set('AGENTS.md', '# kit');
    await h.service.detectAgentKit('p1');
    await vi.advanceTimersByTimeAsync(0);
    expect(appState.project.coauthoring.hasAgentKit).toBe(true);
    expect(appState.project.coauthoring.autosaveEnabled).toBe(true);
    h.service.dispose();
  });

  it('detects a .pix3/ directory as an agent kit', async () => {
    const h = createHarness({ backend: 'local' });
    h.storage.files.set('.pix3/protected.json', '{}');
    h.service.initialize();
    await vi.advanceTimersByTimeAsync(0);
    expect(appState.project.coauthoring.hasAgentKit).toBe(true);
    h.service.dispose();
  });

  it('never autosaves a cloud project', () => {
    const h = createHarness({ backend: 'cloud' });
    h.service.initialize();
    expect(appState.project.coauthoring.autosaveEnabled).toBe(false);
    h.service.dispose();
  });

  it('only the owner window saves', async () => {
    const h = createHarness();
    h.setOwner(false);
    h.service.initialize();
    h.edit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(appState.project.coauthoring.autosaveStatus).toBe('not-owner');
    h.service.dispose();
  });

  it('holds a scene with a pending external version, saves once it is applied', async () => {
    const h = createHarness();
    h.service.initialize();
    h.diskState.markPendingExternal('scenes/main.pix3scene');
    h.edit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(appState.project.coauthoring.autosaveStatus).toBe('held');

    h.diskState.clearPendingExternal('scenes/main.pix3scene');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 10);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(appState.project.coauthoring.autosaveStatus).toBe('saved');
    h.service.dispose();
  });

  it('waits for a gesture to end', async () => {
    const h = createHarness();
    h.service.initialize();
    h.setGesture(true);
    h.edit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 3);
    expect(h.invoke).not.toHaveBeenCalled();

    h.setGesture(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    h.service.dispose();
  });

  it('a refused pre-write check leaves the scene dirty and the status held', async () => {
    const h = createHarness();
    h.setOutcome('external-change');
    h.service.initialize();
    h.edit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 10);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(appState.scenes.descriptors['s1'].isDirty).toBe(true);
    expect(appState.project.coauthoring.autosaveStatus).toBe('held');
    h.service.dispose();
  });

  it('ignores its own save completions and non-mutating operations', async () => {
    const h = createHarness();
    h.service.initialize();
    appState.scenes.descriptors['s1'].isDirty = true;
    h.service.handleOperationEvent({ ...committed, metadata: { id: 'scene.save', title: 'Save' } });
    h.service.handleOperationEvent({ ...committed, didMutate: false });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(h.invoke).not.toHaveBeenCalled();
    h.service.dispose();
  });
});
