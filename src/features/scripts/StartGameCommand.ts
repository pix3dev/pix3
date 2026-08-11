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
import { openGameSurface } from '@/features/scripts/play-workspace';

export class StartGameCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'game.start',
    title: 'Start Current Scene',
    description: 'Start the game from the active scene',
    keywords: ['play', 'game', 'start', 'scene', 'current'],
    menuPath: 'project',
    keybinding: 'Mod+Ctrl+Enter',
    addToMenu: true,
    menuOrder: 102,
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
    if (context.snapshot.ui.isPlaying) {
      return {
        canExecute: false,
        reason: 'Game is already running',
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
        isPlaying: true,
        status: 'playing',
      })
    );

    if (this.gamePlaySessionService.isPopoutOpen()) {
      await this.gamePlaySessionService.openOrFocusPopoutWindow();
    } else {
      await openGameSurface(context.container);
    }

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
