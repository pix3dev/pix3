import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '@/core/command';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { WorkspaceModeService } from '@/services/editor/WorkspaceModeService';
import { createInitialAppState } from '@/state/AppState';
import type { WorkspaceMode } from '@/state/AppState';
import { SwitchWorkspaceModeCommand } from './SwitchWorkspaceModeCommand';

/**
 * A container that answers only the two services this command resolves, keyed by the same tokens
 * the real one hands out — enough to observe what the command does without booting the editor.
 */
const makeContext = (
  workspaceMode: WorkspaceMode,
  isPlaying: boolean
): {
  context: CommandContext;
  set: ReturnType<typeof vi.fn>;
  executeById: ReturnType<typeof vi.fn>;
  order: string[];
} => {
  const order: string[] = [];
  const set = vi.fn((mode: WorkspaceMode) => {
    order.push(`set:${mode}`);
  });
  const executeById = vi.fn(async (id: string) => {
    order.push(`command:${id}`);
    return true;
  });

  const snapshot = createInitialAppState();
  snapshot.ui.workspaceMode = workspaceMode;
  snapshot.ui.isPlaying = isPlaying;

  const container = {
    getOrCreateToken: (service: unknown) => service,
    getService: (token: unknown) => {
      if (token === WorkspaceModeService) return { set };
      if (token === CommandDispatcher) return { executeById };
      throw new Error('unexpected service');
    },
  };

  return {
    context: { container, snapshot } as unknown as CommandContext,
    set,
    executeById,
    order,
  };
};

describe('SwitchWorkspaceModeCommand', () => {
  it('stops a running game before leaving Flow, and stops it through the command', async () => {
    const { context, set, executeById, order } = makeContext('flow', true);

    await new SwitchWorkspaceModeCommand({ mode: 'studio' }).execute(context);

    // Through `game.stop`, not by writing state: the Stop button, the game surface and the
    // "a game is already running" precondition all hang off that one path.
    expect(executeById).toHaveBeenCalledWith('game.stop');
    expect(set).toHaveBeenCalledWith('studio');
    // Stop first — the shell that owns the game canvas is about to be unmounted.
    expect(order).toEqual(['command:game.stop', 'set:studio']);
  });

  it('leaves Flow untouched when nothing is playing', async () => {
    const { context, set, executeById } = makeContext('flow', false);

    await new SwitchWorkspaceModeCommand({ mode: 'studio' }).execute(context);

    expect(executeById).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith('studio');
  });

  it('keeps the game running on the way INTO Flow', async () => {
    // Measured asymmetry: the Studio branch is only hidden when Flow takes over, so the running
    // clone and its canvas survive. Stopping here would be a regression, not a symmetry fix.
    const { context, set, executeById } = makeContext('studio', true);

    await new SwitchWorkspaceModeCommand({ mode: 'flow' }).execute(context);

    expect(executeById).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith('flow');
  });

  it('does nothing when the requested mode is already on screen', async () => {
    const { context, set, executeById } = makeContext('flow', true);

    const result = await new SwitchWorkspaceModeCommand({ mode: 'flow' }).execute(context);

    expect(result.didMutate).toBe(false);
    expect(executeById).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});
