import {
  CommandBase,
  type CommandExecutionResult,
  type CommandContext,
  type CommandPreconditionResult,
  type CommandMetadata,
} from '@/core/command';
import { GamePlaySessionService } from '@/services/play/GamePlaySessionService';

export class RestartGameCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'game.restart',
    title: 'Restart Game',
    description: 'Restart the running game without closing its host view',
    keywords: ['restart', 'game', 'replay'],
    menuPath: 'project',
    keybinding: 'Mod+Ctrl+R',
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
    await this.gamePlaySessionService.restart();

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
