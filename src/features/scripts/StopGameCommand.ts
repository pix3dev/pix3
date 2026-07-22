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

  private readonly editorTabService: EditorTabService;
  private readonly gamePlaySessionService: GamePlaySessionService;

  constructor(editorTabService: EditorTabService, gamePlaySessionService: GamePlaySessionService) {
    super();
    this.editorTabService = editorTabService;
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
      const gameTabResourceId = 'game-view-instance';
      const tabId = `game:${gameTabResourceId}`;
      await this.editorTabService.closeTab(tabId);
    }

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
