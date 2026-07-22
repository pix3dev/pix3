import { inject } from '@/fw/di';
import { DialogService } from '@/services/editor/DialogService';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { OpenProjectSettingsCommand } from './OpenProjectSettingsCommand';
import {
  CommandBase,
  type CommandContext,
  type CommandPreconditionResult,
  type CommandMetadata,
  type CommandExecutionResult,
} from '@/core/command';

export class OpenProjectInIdeCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'project.open-in-ide',
    title: 'Open in VS Code',
    description: 'Open the project folder in VS Code using the absolute path from settings',
    menuPath: 'project',
    addToMenu: true,
    keywords: ['project', 'ide', 'vscode'],
  };

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (context.state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'Project must be opened',
        scope: 'project',
      };
    }
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const localPath = context.state.project.localAbsolutePath;

    if (!localPath) {
      const confirm = await this.dialogService.showConfirmation({
        title: 'Project Path Required',
        message:
          'A local absolute path is required to open the project in VS Code.\n\nWould you like to set it now in project settings?',
        confirmLabel: 'Open Settings',
        cancelLabel: 'Cancel',
      });

      if (confirm) {
        await this.commandDispatcher.execute(new OpenProjectSettingsCommand());
      }
      return {
        didMutate: false,
        payload: undefined,
      };
    }

    // Open in VS Code using vscode:// protocol
    // For folders, vscode://file/[path] works
    const vscodeUrl = `vscode://file/${localPath}`;
    window.open(vscodeUrl, '_blank');

    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
