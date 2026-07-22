import { inject } from '@/fw/di';
import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { DialogService } from '@/services/editor/DialogService';
import { LoggingService } from '@/services/core/LoggingService';
import { ProjectLifecycleService } from '@/services/project/ProjectLifecycleService';

/**
 * Promotes an in-browser (OPFS) project to a real folder on disk, so a quick
 * "instant start" draft can be turned into a normal local project the user
 * owns as files. Only available while a browser-storage project is open.
 */
export class MoveProjectToFolderCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'project.moveToFolder',
    title: 'Move Project to Folder…',
    description: 'Copy this in-browser project to a folder on disk',
    menuPath: 'file',
    addToMenu: true,
    menuOrder: 2,
    keywords: ['move', 'save', 'folder', 'browser', 'local', 'export', 'disk'],
  };

  @inject(ProjectLifecycleService)
  private readonly projectLifecycleService!: ProjectLifecycleService;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  @inject(LoggingService)
  private readonly loggingService!: LoggingService;

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (context.state.project.status !== 'ready' || context.state.project.backend !== 'browser') {
      return {
        canExecute: false,
        reason: 'Only available for in-browser projects.',
        scope: 'project',
      };
    }

    return { canExecute: true };
  }

  async execute(): Promise<CommandExecutionResult<void>> {
    try {
      await this.projectLifecycleService.moveBrowserProjectToFolder();
    } catch (error) {
      this.loggingService.error('[Move Project to Folder] Failed', error);
      await this.dialogService.showConfirmation({
        title: 'Move Project Failed',
        message:
          `An error occurred while moving the project to a folder. The in-browser copy is unchanged.\n\n` +
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        confirmLabel: 'OK',
        cancelLabel: 'Close',
      });
      throw error;
    }

    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
