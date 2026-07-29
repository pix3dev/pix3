import { inject } from '@/fw/di';
import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { LoggingService } from '@/services/core/LoggingService';
import { OperationService } from '@/services/core/OperationService';
import { OnlineSessionService } from '@/services/play/OnlineSessionService';
import { SetPlayModeOperation } from '@/features/scripts/SetPlayModeOperation';

/**
 * "Play Online" — start the active scene as a multiplayer host (plan step 1.5).
 *
 * Creates a room through pix3-cloud, joins it, and *then* enters play mode: the room must exist
 * before the first frame so a script's `onStart` can spawn its avatar immediately. The Game tab's
 * session card carries the join link — a second player opens it, streams the project's assets from
 * this editor over the preview relay, and joins the same room.
 */
export class StartOnlineGameCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'game.start-online',
    title: 'Play Online',
    description: 'Create a multiplayer room for the active scene and share a join link',
    keywords: ['multiplayer', 'online', 'room', 'coop', 'play', 'network', 'share'],
    menuPath: 'project',
    addToMenu: true,
    menuOrder: 103,
  };

  @inject(OnlineSessionService)
  private readonly onlineSession!: OnlineSessionService;

  @inject(EditorTabService)
  private readonly editorTabService!: EditorTabService;

  @inject(LoggingService)
  private readonly logger!: LoggingService;

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (context.state.project.status !== 'ready') {
      return { canExecute: false, reason: 'Project must be opened', scope: 'project' };
    }

    if (!context.state.scenes.activeSceneId) {
      return { canExecute: false, reason: 'No active scene is open', scope: 'scene' };
    }

    if (this.onlineSession.isActive()) {
      return {
        canExecute: false,
        reason: 'An online session is already running',
        scope: 'scene',
        recoverable: false,
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    // Show the tab first so the card renders the "starting" state instead of the idle placeholder.
    await this.editorTabService.openResourceTab('game', 'game-view-instance', {}, true);

    try {
      await this.onlineSession.start();
    } catch {
      // The card shows the failure; play mode must not start into a room that does not exist.
      return { didMutate: false, payload: undefined };
    }

    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );

    if (!context.state.ui.isPlaying) {
      await operationService.invoke(
        new SetPlayModeOperation({ isPlaying: true, status: 'playing' })
      );
    }

    this.logger.info('[Play Online] Session ready — share the join link from the Game tab.');
    return { didMutate: true, payload: undefined };
  }
}
