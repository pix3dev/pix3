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
 * Starts the game from the project's entry scene (Project Settings →
 * Default Export Scene Path), opening that scene first when needed. Falls
 * back to the active scene when no entry scene is configured.
 *
 * This is the **full-flow** run: on a recipe project the entry scene is the menu, so it also
 * switches the editor's active scene there — `appState.scenes.activeSceneId` is what play mode binds
 * to (`GamePlaySessionService.startScene`), so running one scene while the editor shows another is
 * not expressible. That is why the prototyping surfaces (the Studio toolbar button, the Flow stage)
 * dispatch `game.start` instead: a menu becoming the active scene mid-session also silently
 * redirects every agent edit into it.
 */
export class StartMainSceneGameCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'game.start-main',
    title: 'Play Game (Entry Scene)',
    description: 'Start the game from the project entry scene',
    keywords: ['play', 'game', 'start', 'main', 'run', 'entry'],
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

    // Play mode is flipped by the operation below, and `GamePlaySessionService` starts the runtime
    // off that flag — so flipping it without a scene puts the app in a state where nothing runs but
    // everything (Game tab, Flow stage, `play_start`, every agent verification) believes it does.
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

  private resolveMainScenePath(context: CommandContext): string | null {
    const configured = context.state.project.manifest?.defaultExportScenePath?.trim() ?? '';
    if (!configured) {
      return null;
    }

    return configured.replace(/^res:\/\//i, '');
  }
}
