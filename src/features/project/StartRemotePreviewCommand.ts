import { inject } from '@/fw/di';
import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { LayoutManagerService } from '@/core/LayoutManager';
import { EditorTabService } from '@/services/EditorTabService';
import { LoggingService } from '@/services/LoggingService';
import { PreviewHostService } from '@/services/PreviewHostService';

/**
 * Starts (or re-opens) a live remote preview session: creates the relay
 * session on the collab server, connects this editor as host and shows the
 * QR/join-link card inside the Game tab. Players opening the link stream the
 * active scene and its assets straight out of this editor's project folder;
 * their logs and metrics land in the Logs and Profiler panels.
 */
export class StartRemotePreviewCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'project.start-remote-preview',
    title: 'Start Remote Preview',
    description:
      'Share a live preview link (QR) that streams the active scene to phones and browsers',
    menuPath: 'project',
    addToMenu: true,
    menuOrder: 215,
    keywords: ['remote', 'preview', 'qr', 'phone', 'mobile', 'share', 'relay', 'play'],
  };

  @inject(PreviewHostService)
  private readonly previewHostService!: PreviewHostService;

  @inject(EditorTabService)
  private readonly editorTabService!: EditorTabService;

  @inject(LayoutManagerService)
  private readonly layoutManager!: LayoutManagerService;

  @inject(LoggingService)
  private readonly loggingService!: LoggingService;

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (context.state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'Project must be opened',
        scope: 'project',
      };
    }

    const hasScenes = Object.keys(context.state.scenes.descriptors).length > 0;
    if (!hasScenes) {
      return {
        canExecute: false,
        reason: 'At least one loaded scene is required',
        scope: 'scene',
      };
    }

    return { canExecute: true };
  }

  async execute(): Promise<CommandExecutionResult<void>> {
    // Show the Game tab immediately so session/connection progress is visible
    // in place of the idle placeholder, and surface the runtime-facing panels
    // the way play mode does.
    await this.editorTabService.openResourceTab('game', 'game-view-instance', {}, true);
    this.layoutManager.focusPanel('profiler');
    this.layoutManager.focusPanel('logs');

    try {
      const session = await this.previewHostService.start();
      this.loggingService.info(
        `[Remote Preview] Session ${session.sessionId} ready — join at ${session.joinUrl}`
      );
    } catch (error) {
      this.loggingService.error('[Remote Preview] Failed to start preview session', error);
      // The Game tab card stays visible and shows the error state.
    }

    return { didMutate: false, payload: undefined };
  }
}
