import { inject } from '@/fw/di';
import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { LoggingService } from '@/services/LoggingService';
import { PreviewHostService } from '@/services/PreviewHostService';
import { RemotePreviewDialogService } from '@/services/RemotePreviewDialogService';

/**
 * Starts (or re-opens) a live remote preview session: creates the relay
 * session on the collab server, connects this editor as host and shows the
 * QR/join-link dialog. Players opening the link stream the active scene and
 * its assets straight out of this editor's project folder.
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

  @inject(RemotePreviewDialogService)
  private readonly remotePreviewDialogService!: RemotePreviewDialogService;

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
    // Show the dialog immediately so session/connection progress is visible.
    this.remotePreviewDialogService.show();

    try {
      const session = await this.previewHostService.start();
      this.loggingService.info(
        `[Remote Preview] Session ${session.sessionId} ready — join at ${session.joinUrl}`
      );
    } catch (error) {
      this.loggingService.error('[Remote Preview] Failed to start preview session', error);
      // The dialog stays open and shows the error state.
    }

    return { didMutate: false, payload: undefined };
  }
}
