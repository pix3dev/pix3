import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOperationContext, type OperationInvokeResult } from '@/core/Operation';
import type { CommandContext } from '@/core/command';
import { appState, resetAppState } from '@/state';
import { OperationService } from '@/services/core/OperationService';
import { ReloadSceneCommand } from '@/features/scene/ReloadSceneCommand';
import { ReloadSceneOperation } from '@/features/scene/ReloadSceneOperation';

describe('ReloadSceneCommand history', () => {
  let operations: OperationService;
  let context: CommandContext;

  beforeEach(() => {
    resetAppState();
    for (const id of ['scene-A', 'scene-B']) {
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
    appState.scenes.activeSceneId = 'scene-A';
    operations = new OperationService();
    context = {
      ...createOperationContext(),
      container: {
        getOrCreateToken: <T>(token: T): T => token,
        getService: <T>(token: unknown): T => {
          if (token === OperationService) return operations as T;
          throw new Error(`Unexpected token: ${String(token)}`);
        },
      } as CommandContext['container'],
    };
  });

  afterEach(() => {
    operations.dispose();
    vi.restoreAllMocks();
    resetAppState();
  });

  it.each(['scene-A', 'scene-B'])(
    'clears only the reloaded scene after awaiting a reload started from %s',
    async initialActiveScene => {
      const historyA = operations.history;
      historyA.push({ metadata: { commandId: 'edit-A' }, undo: vi.fn(), redo: vi.fn() });
      appState.scenes.activeSceneId = 'scene-B';
      const historyB = operations.history;
      historyB.push({ metadata: { commandId: 'edit-B' }, undo: vi.fn(), redo: vi.fn() });

      let finish!: (result: OperationInvokeResult) => void;
      const pendingReload = new Promise<OperationInvokeResult>(resolve => {
        finish = resolve;
      });
      vi.spyOn(ReloadSceneOperation.prototype, 'perform').mockReturnValue(pendingReload);
      appState.scenes.activeSceneId = initialActiveScene;
      const command = new ReloadSceneCommand({
        sceneId: 'scene-A',
        filePath: 'res://scene-A.pix3scene',
      });
      const result = command.execute(context);
      appState.scenes.activeSceneId = 'scene-B';
      finish({ didMutate: true });

      expect((await result).didMutate).toBe(true);
      expect(historyA.canUndo).toBe(false);
      expect(historyB.canUndo).toBe(true);
      expect(appState.operations.lastUndoableCommandId).toBe('edit-B');
    }
  );

  it('keeps history when the reload did not replace the graph', async () => {
    operations.history.push({ metadata: {}, undo: vi.fn(), redo: vi.fn() });
    vi.spyOn(ReloadSceneOperation.prototype, 'perform').mockResolvedValue({ didMutate: false });
    const command = new ReloadSceneCommand({
      sceneId: 'scene-A',
      filePath: 'res://scene-A.pix3scene',
    });

    expect((await command.execute(context)).didMutate).toBe(false);
    expect(operations.history.canUndo).toBe(true);
  });

  it('keeps history when the reload fails', async () => {
    operations.history.push({ metadata: {}, undo: vi.fn(), redo: vi.fn() });
    vi.spyOn(ReloadSceneOperation.prototype, 'perform').mockRejectedValue(
      new Error('Invalid scene')
    );
    const command = new ReloadSceneCommand({
      sceneId: 'scene-A',
      filePath: 'res://scene-A.pix3scene',
    });

    await expect(command.execute(context)).rejects.toThrow('Invalid scene');
    expect(operations.history.canUndo).toBe(true);
  });
});
