import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appState, resetAppState } from '@/state';
import type { Operation } from '@/core/Operation';
import { OperationService } from '@/services/core/OperationService';

/** Minimal undoable history entry. */
function entry(commandId = 'edit', coalesceKey?: string) {
  return { metadata: { commandId, coalesceKey }, undo: vi.fn(), redo: vi.fn() };
}

function openScene(id: string): void {
  appState.scenes.descriptors[id] = {
    id,
    name: id,
    filePath: `res://${id}.pix3scene`,
    version: '1.0.0',
    isDirty: false,
    lastSavedAt: null,
    fileHandle: null,
    lastModifiedTime: null,
  };
}

function deferredOperation() {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => {
    finish = resolve;
  });
  const commit = { undo: vi.fn(), redo: vi.fn() };
  const operation: Operation = {
    metadata: { id: 'edit.async', title: 'Async edit' },
    async perform() {
      await pending;
      return { didMutate: true, commit };
    },
  };
  return { operation, commit, finish };
}

describe('OperationService per-scene history', () => {
  const services: OperationService[] = [];
  const createService = () => {
    const service = new OperationService();
    services.push(service);
    return service;
  };

  beforeEach(() => {
    resetAppState();
    openScene('scene-A');
    openScene('scene-B');
  });

  afterEach(() => {
    for (const service of services.splice(0)) service.dispose();
    resetAppState();
  });

  it('keeps a separate undo stack per active scene', () => {
    appState.scenes.activeSceneId = 'scene-A';
    const service = createService();

    const historyA = service.history;
    historyA.push(entry());
    expect(service.history.canUndo).toBe(true);

    // Switching scenes resolves to a different, empty stack.
    appState.scenes.activeSceneId = 'scene-B';
    expect(service.history).not.toBe(historyA);
    expect(service.history.canUndo).toBe(false);

    // Switching back restores scene A's stack.
    appState.scenes.activeSceneId = 'scene-A';
    expect(service.history).toBe(historyA);
    expect(service.history.canUndo).toBe(true);
  });

  it('clearHistory only clears the active scene stack', () => {
    appState.scenes.activeSceneId = 'scene-A';
    const service = createService();
    service.history.push(entry());

    appState.scenes.activeSceneId = 'scene-B';
    service.history.push(entry());
    service.clearHistory();
    expect(service.history.canUndo).toBe(false);

    appState.scenes.activeSceneId = 'scene-A';
    expect(service.history.canUndo).toBe(true);
  });

  it('clears an inactive scene without clearing the active stack or undo metadata', () => {
    appState.scenes.activeSceneId = 'scene-A';
    const service = createService();
    const historyA = service.history;
    historyA.push(entry('edit-A'));

    appState.scenes.activeSceneId = 'scene-B';
    const historyB = service.history;
    historyB.push(entry('edit-B'));

    expect(service.clearHistory('scene-A')).toBe(true);
    expect(historyA.canUndo).toBe(false);
    expect(historyB.canUndo).toBe(true);
    expect(appState.operations.lastUndoableCommandId).toBe('edit-B');
    expect(service.clearHistory('scene-A')).toBe(false);
  });

  it('pushes an async commit into the original scene after a tab switch', async () => {
    appState.scenes.activeSceneId = 'scene-A';
    const service = createService();
    const historyA = service.history;
    const deferred = deferredOperation();
    const listener = vi.fn();
    service.addListener(listener);
    const result = service.invokeAndPush(deferred.operation);

    appState.scenes.activeSceneId = 'scene-B';
    const historyB = service.history;
    historyB.push(entry('edit-B'));
    deferred.finish();

    expect(await result).toBe(true);
    expect(historyA.snapshot().undoEntries.map(e => e.metadata.commandId)).toEqual(['edit.async']);
    expect(historyB.snapshot().undoEntries.map(e => e.metadata.commandId)).toEqual(['edit-B']);
    expect(appState.operations.lastUndoableCommandId).toBe('edit-B');
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'operation:completed',
        pushedToHistory: true,
        sceneId: 'scene-A',
      })
    );

    appState.scenes.activeSceneId = 'scene-A';
    expect(await service.undo()).toBe(true);
    expect(deferred.commit.undo).toHaveBeenCalledOnce();
    expect(historyB.canUndo).toBe(true);
  });

  it('coalesces async edits only against their original scene history', async () => {
    appState.scenes.activeSceneId = 'scene-A';
    const service = createService();
    const historyA = service.history;
    historyA.push(entry('previous-A', 'drag'));
    const deferred = deferredOperation();
    const result = service.invokeAndPush(deferred.operation, { coalesceKey: 'drag' });

    appState.scenes.activeSceneId = 'scene-B';
    const historyB = service.history;
    historyB.push(entry('previous-B', 'drag'));
    deferred.finish();

    expect(await result).toBe(true);
    expect(historyA.snapshot().undoEntries.map(e => e.metadata.commandId)).toEqual(['edit.async']);
    expect(historyB.snapshot().undoEntries.map(e => e.metadata.commandId)).toEqual(['previous-B']);
  });

  it('does not revive pending history after an inactive scene is cleared for reload', async () => {
    appState.scenes.activeSceneId = 'scene-A';
    const service = createService();
    const historyA = service.history;
    const deferred = deferredOperation();
    const result = service.invokeAndPush(deferred.operation);

    appState.scenes.activeSceneId = 'scene-B';
    const historyB = service.history;
    historyB.push(entry('edit-B'));
    // Even an empty history must invalidate a pending operation on the old graph.
    expect(service.clearHistory('scene-A')).toBe(false);
    deferred.finish();

    expect(await result).toBe(false);
    expect(historyA.canUndo).toBe(false);
    expect(historyB.canUndo).toBe(true);
    expect(appState.operations.lastUndoableCommandId).toBe('edit-B');
  });

  it('drops an async commit when its scene closes before it finishes', async () => {
    appState.scenes.activeSceneId = 'scene-A';
    const service = createService();
    const historyA = service.history;
    historyA.push(entry('previous-A'));
    const deferred = deferredOperation();
    const result = service.invokeAndPush(deferred.operation);

    appState.scenes.activeSceneId = 'scene-B';
    delete appState.scenes.descriptors['scene-A'];
    deferred.finish();

    expect(await result).toBe(false);
    expect(historyA.canUndo).toBe(false);
    expect(service.history.canUndo).toBe(false);
    openScene('scene-A');
    appState.scenes.activeSceneId = 'scene-A';
    expect(service.history).not.toBe(historyA);
    expect(service.history.canUndo).toBe(false);
  });
});
