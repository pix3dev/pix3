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

/**
 * Starts the game from the project's main scene (Project Settings →
 * Default Export Scene Path), opening that scene first when needed. Falls
 * back to the active scene when no main scene is configured.
 */
export class StartMainSceneGameCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'game.start-main',
    title: 'Start Game',
    description: 'Start the game from the project main scene',
    keywords: ['play', 'game', 'start', 'main', 'run'],
    menuPath: 'project',
    addToMenu: true,
    menuOrder: 101,
  };

  private readonly editorTabService: EditorTabService;
  private readonly gamePlaySessionService: GamePlaySessionService;

  constructor(editorTabService: EditorTabService, gamePlaySessionService: GamePlaySessionService) {
    super();
    this.editorTabService = editorTabService;
    this.gamePlaySessionService = gamePlaySessionService;
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (context.state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'Project must be opened',
        scope: 'project',
      };
    }

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
    const mainScenePath = this.resolveMainScenePath(context);
    if (mainScenePath) {
      await this.editorTabService.focusOrOpenScene(`res://${mainScenePath}`);
    } else if (!context.state.scenes.activeSceneId) {
      const firstDescriptor = Object.values(context.state.scenes.descriptors)[0];
      if (!firstDescriptor) {
        console.warn('[StartMainSceneGameCommand] No scenes available to play.');
        return { didMutate: false, payload: undefined };
      }
      await this.editorTabService.focusOrOpenScene(firstDescriptor.filePath);
    } else {
      console.warn(
        '[StartMainSceneGameCommand] No main scene configured (Project Settings → Default Export Scene Path); playing the active scene.'
      );
    }

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

  private resolveMainScenePath(context: CommandContext): string | null {
    const configured = context.state.project.manifest?.defaultExportScenePath?.trim() ?? '';
    if (!configured) {
      return null;
    }

    return configured.replace(/^res:\/\//i, '');
  }
}
