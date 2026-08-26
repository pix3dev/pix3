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
import {
  ensureSceneActive,
  openGameSurface,
  resolveGameplayScenePath,
} from '@/features/scripts/play-workspace';

/**
 * Play the scene the user is looking at — the prototyping default, and what both the Studio toolbar
 * and the Flow stage dispatch. It deliberately never moves the active scene when there already is
 * one: `appState.scenes.activeSceneId` is simultaneously what runs, what the viewport shows and what
 * the agent edits, so a play command that reassigns it moves the user's work out from under them
 * (which is exactly what `game.start-main` does, and why it is no longer the prototyping path).
 */
export class StartGameCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'game.start',
    title: 'Play Scene',
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
    // The command can now open a scene, which needs a project — same precondition `game.start-main`
    // has carried all along.
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
    // "The active scene" can be nothing at all: a fresh Flow project never had a startup scene
    // opened for it (`PrototypeBootstrapService` skips `openStartupScene`), and a failed reload of an
    // externally rewritten scene closes the only tab. Opening the gameplay scene here is what lets
    // the Flow stage launch on gameplay instead of routing through `game.start-main` (the menu).
    if (!context.state.scenes.activeSceneId) {
      await ensureSceneActive(context.container, resolveGameplayScenePath(context.state));
    }

    // Play mode without an active scene starts nothing while the Game tab, the Flow stage,
    // `play_start` and every agent verification believe it did — the same guard `game.start-main`
    // carries, and until now the hole this command had.
    if (!context.state.scenes.activeSceneId) {
      throw new Error('Cannot start the game: no scene could be opened.');
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
}
