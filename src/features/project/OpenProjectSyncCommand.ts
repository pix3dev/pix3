import { inject } from '@/fw/di';
import { ProjectSyncService } from '@/services/project/ProjectSyncService';
import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';

export class OpenProjectSyncCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'project.open-sync-dialog',
    title: 'Sync to Local Folder',
    description: 'Open the project sync dialog',
    menuPath: 'project',
    addToMenu: true,
    menuOrder: 120,
    keywords: ['sync', 'local', 'folder', 'cloud', 'project'],
  };

  @inject(ProjectSyncService)
  private readonly projectSyncService!: ProjectSyncService;

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (context.state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'Project must be opened to synchronize it',
        scope: 'project',
      };
    }

    return { canExecute: true };
  }

  async execute(): Promise<CommandExecutionResult<void>> {
    await this.projectSyncService.showDialog();
    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
