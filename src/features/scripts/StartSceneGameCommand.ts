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

export interface StartSceneGameParams {
  /** Scene to play — `res://` path or project-relative (`src/assets/scenes/x.pix3scene`). */
  scenePath: string;
}

/**
 * Starts the game from an explicitly named scene: focuses (or opens) that
 * scene first, then enters play mode. Unlike `game.start` (active scene) and
 * `game.start-main` (project main scene) the caller picks the scene, which is
 * what tooling flows need — e.g. an agent verifying one scene of a multi-scene
 * flow without caring which tab happens to be active.
 *
 * Parametrized: dispatched as an instance (`new StartSceneGameCommand({...})`),
 * not registered in the menu/command registry.
 */
export class StartSceneGameCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'game.start-scene',
    title: 'Start Scene',
    description: 'Start the game from an explicitly named scene',
    keywords: ['play', 'game', 'start', 'scene'],
  };

  private readonly params: StartSceneGameParams;

  constructor(params: StartSceneGameParams) {
    super();
    this.params = params;
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

    const path = (this.params.scenePath ?? '').trim();
    if (!path.toLowerCase().endsWith('.pix3scene')) {
      return {
        canExecute: false,
        reason: `Not a scene path: "${path}" (expected a .pix3scene file)`,
        scope: 'scene',
        recoverable: false,
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const container = context.container;
    const editorTabService = container.getService<EditorTabService>(
      container.getOrCreateToken(EditorTabService)
    );
    const gamePlaySessionService = container.getService<GamePlaySessionService>(
      container.getOrCreateToken(GamePlaySessionService)
    );
    const operationService = container.getService<OperationService>(
      container.getOrCreateToken(OperationService)
    );

    const raw = this.params.scenePath.trim().replace(/\\/g, '/');
    const resourcePath = /^res:\/\//i.test(raw) ? raw : `res://${raw.replace(/^\/+/, '')}`;

    // Focusing/opening the scene makes it the active scene the runner clones.
    await editorTabService.focusOrOpenScene(resourcePath);

    await operationService.invoke(
      new SetPlayModeOperation({
        isPlaying: true,
        status: 'playing',
      })
    );

    if (gamePlaySessionService.isPopoutOpen()) {
      await gamePlaySessionService.openOrFocusPopoutWindow();
    } else {
      const gameTabResourceId = 'game-view-instance';
      await editorTabService.openResourceTab('game', gameTabResourceId, {}, true);
    }

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
