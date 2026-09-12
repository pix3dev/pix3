import {
  CommandBase,
  type CommandExecutionResult,
  type CommandContext,
  type CommandPreconditionResult,
  type CommandMetadata,
} from '@/core/command';
import { GamePlaySessionService } from '@/services/play/GamePlaySessionService';

/**
 * Freeze the running game in place — and let it go again. A toggle rather than two commands so the
 * one key (and the one toolbar button) does what the user means without them having to know which
 * state the game is in.
 *
 * The pause is held by the host, not by the runner: it survives focus and visibility changes, which
 * is what separates it from the automatic `pauseRenderingOnUnfocus` freeze. It ends with the run —
 * a stop or a restart always resumes.
 */
export class PauseGameCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'game.pause',
    title: 'Pause / Resume Game',
    description: 'Freeze the running game, or let it continue',
    keywords: ['pause', 'resume', 'freeze', 'game', 'play'],
    menuPath: 'project',
    keybinding: 'F7',
    addToMenu: true,
    menuOrder: 104,
  };

  constructor(private readonly gamePlaySessionService: GamePlaySessionService) {
    super();
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (!context.snapshot.ui.isPlaying) {
      return {
        canExecute: false,
        reason: 'Game is not running',
        scope: 'scene',
        recoverable: false,
      };
    }

    return { canExecute: true };
  }

  async execute(): Promise<CommandExecutionResult<void>> {
    await this.gamePlaySessionService.togglePaused();

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
