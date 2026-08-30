import { CommandBase, type CommandContext, type CommandExecutionResult } from '@/core/command';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { WorkspaceModeService } from '@/services/editor/WorkspaceModeService';
import type { WorkspaceMode } from '@/state/AppState';

export interface SwitchWorkspaceModeParams {
  /** Target shell. Omit to toggle between Flow and Studio. */
  mode?: WorkspaceMode;
}

/**
 * Swap the shell between Flow (prompt + live stage) and Studio (the full docked editor). Same
 * project, same services, same undo stack — Golden Layout is simply mounted (or left unmounted)
 * behind the scenes, so this is a component swap and never a page reload.
 */
export class SwitchWorkspaceModeCommand extends CommandBase<void, void> {
  readonly metadata = {
    id: 'editor.switch-workspace-mode',
    title: 'Toggle Flow / Studio',
    description: 'Switch between the prompt-first Flow workspace and the full Studio editor',
    keywords: ['flow', 'studio', 'workspace', 'mode', 'prompt'],
    menuPath: 'view',
    addToMenu: true,
    menuOrder: 5,
  } as const;

  private readonly params: SwitchWorkspaceModeParams;

  constructor(params: SwitchWorkspaceModeParams = {}) {
    super();
    this.params = params;
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const { container, snapshot } = context;
    const workspaceMode = container.getService<WorkspaceModeService>(
      container.getOrCreateToken(WorkspaceModeService)
    );
    const current = snapshot.ui.workspaceMode;
    const next = this.params.mode ?? (current === 'flow' ? 'studio' : 'flow');
    if (current === next) {
      return { didMutate: false, payload: undefined };
    }

    // Leaving Flow ends the game, and it has to end through `game.stop` so the whole editor hears
    // about it. The asymmetry is real and measured: Studio -> Flow keeps the running clone alive
    // (the Studio branch merely gets hidden), but Flow -> Studio unmounts `pix3-flow-shell` and
    // with it the stage that owns the game canvas. Nothing was resetting play state afterwards, so
    // the editor sat there with `isPlaying: true`, a Stop button offering to stop nothing, and no
    // game window anywhere — and `game.start` refuses while the editor believes a game is running.
    if (current === 'flow' && snapshot.ui.isPlaying) {
      const dispatcher = container.getService<CommandDispatcher>(
        container.getOrCreateToken(CommandDispatcher)
      );
      await dispatcher.executeById('game.stop');
    }

    workspaceMode.set(next);
    return { didMutate: true, payload: undefined };
  }
}

export const openInStudio = () => new SwitchWorkspaceModeCommand({ mode: 'studio' });
export const openInFlow = () => new SwitchWorkspaceModeCommand({ mode: 'flow' });
