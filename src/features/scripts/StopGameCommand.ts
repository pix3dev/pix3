import {
  CommandBase,
  type CommandExecutionResult,
  type CommandContext,
  type CommandPreconditionResult,
  type CommandMetadata,
} from '@/core/command';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { GamePlaySessionService } from '@/services/play/GamePlaySessionService';
import { OperationService } from '@/services/core/OperationService';
import { SetPlayModeOperation } from '@/features/scripts/SetPlayModeOperation';
import { closeGameSurface } from '@/features/scripts/play-workspace';

export class StopGameCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'game.stop',
    title: 'Stop Game',
    description: 'Stop the game and close the tab',
    keywords: ['stop', 'game', 'close'],
    menuPath: 'project',
    keybinding: 'Mod+Ctrl+Shift+Enter',
    addToMenu: true,
    menuOrder: 103,
  };

  private readonly gamePlaySessionService: GamePlaySessionService;

  /**
   * `editorTabService` is accepted for call-site compatibility but no longer used: which surface
   * the game appears on is decided per workspace in `play-workspace` (Studio = a Golden-Layout
   * tab, Flow = the permanently mounted stage).
   */
  constructor(_editorTabService: EditorTabService, gamePlaySessionService: GamePlaySessionService) {
    super();
    this.gamePlaySessionService = gamePlaySessionService;
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

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );

    await operationService.invoke(
      new SetPlayModeOperation({
        isPlaying: false,
        status: 'stopped',
      })
    );

    if (!this.gamePlaySessionService.isPopoutOpen()) {
      await closeGameSurface(context.container);
    }

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
