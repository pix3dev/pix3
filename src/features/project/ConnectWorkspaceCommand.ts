import { inject } from '@/fw/di';
import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { WorkspaceConnectDialogService } from '@/services/project/workspace/WorkspaceConnectDialogService';

/**
 * File → Connect to Workspace…: open a project served by `pix3 serve` (a folder on another
 * machine, e.g. over VS Code Remote SSH) instead of picking a local folder. Opens the dialog that
 * asks for the address and token; opening a project is session state, not an undoable edit.
 */
export class ConnectWorkspaceCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'project.connect-workspace',
    title: 'Connect to Workspace…',
    description: 'Open a project served by `pix3 serve` (address + token), without a local folder',
    menuPath: 'file',
    addToMenu: true,
    menuOrder: 120,
    keywords: ['workspace', 'remote', 'ssh', 'serve', 'connect', 'server', 'project'],
  };

  @inject(WorkspaceConnectDialogService)
  private readonly dialogService!: WorkspaceConnectDialogService;

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (context.state.ui.isPlaying) {
      return {
        canExecute: false,
        reason: 'Stop the game before switching to another project.',
        scope: 'project',
        recoverable: true,
      };
    }
    if (context.state.project.workspace.status === 'connecting') {
      return {
        canExecute: false,
        reason: 'A workspace connection is already in progress.',
        scope: 'service',
        recoverable: true,
      };
    }
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const workspace = context.state.project.workspace;
    this.dialogService.open({
      endpoint: context.state.project.backend === 'workspace' ? workspace.endpoint : null,
    });
    return { didMutate: false, payload: undefined };
  }
}
