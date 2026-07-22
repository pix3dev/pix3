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

  private readonly editorTabService: EditorTabService;
  private readonly gamePlaySessionService: GamePlaySessionService;

  constructor(editorTabService: EditorTabService, gamePlaySessionService: GamePlaySessionService) {
    super();
    this.editorTabService = editorTabService;
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
      const gameTabResourceId = 'game-view-instance';
      await this.editorTabService.openResourceTab('game', gameTabResourceId, {}, true);
    }

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
