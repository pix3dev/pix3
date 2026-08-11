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
import { ensureSceneActive, openGameSurface } from '@/features/scripts/play-workspace';

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
      await ensureSceneActive(context.container, `res://${mainScenePath}`);
    } else if (!context.state.scenes.activeSceneId) {
      const firstDescriptor = Object.values(context.state.scenes.descriptors)[0];
      if (!firstDescriptor) {
        console.warn('[StartMainSceneGameCommand] No scenes available to play.');
        return { didMutate: false, payload: undefined };
      }
      await ensureSceneActive(context.container, firstDescriptor.filePath);
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
      await openGameSurface(context.container);
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
