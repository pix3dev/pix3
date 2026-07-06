import { afterEach, describe, expect, it } from 'vitest';
import { appState } from '@/state';
import { OperationService } from './OperationService';

/** Minimal undoable history entry. */
function entry() {
  return { metadata: {}, undo: () => {}, redo: () => {} };
}

describe('OperationService per-scene history', () => {
  afterEach(() => {
    appState.scenes.activeSceneId = null;
  });

  it('keeps a separate undo stack per active scene', () => {
    appState.scenes.activeSceneId = 'scene-A';
    const service = new OperationService();

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

    service.dispose();
  });

  it('clearHistory only clears the active scene stack', () => {
    appState.scenes.activeSceneId = 'scene-A';
    const service = new OperationService();
    service.history.push(entry());

    appState.scenes.activeSceneId = 'scene-B';
    service.history.push(entry());
    service.clearHistory();
    expect(service.history.canUndo).toBe(false);

    appState.scenes.activeSceneId = 'scene-A';
    expect(service.history.canUndo).toBe(true);

    service.dispose();
  });
});
