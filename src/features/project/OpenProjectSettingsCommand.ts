import { inject } from '@/fw/di';
import { ProjectSettingsService } from '@/services/project/ProjectSettingsService';
import {
  CommandBase,
  type CommandContext,
  type CommandPreconditionResult,
  type CommandMetadata,
  type CommandExecutionResult,
} from '@/core/command';

export class OpenProjectSettingsCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'project.open-settings',
    title: 'Project Settings',
    description: 'Open the project settings modal',
    menuPath: 'file',
    addToMenu: true,
    menuOrder: 100, // Should be towards the bottom of the File menu
    keywords: ['project', 'settings', 'config'],
  };

  @inject(ProjectSettingsService)
  private readonly projectSettingsService!: ProjectSettingsService;

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (context.state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'Project must be opened to access settings',
        scope: 'project',
      };
    }
    return { canExecute: true };
  }

  async execute(): Promise<CommandExecutionResult<void>> {
    await this.projectSettingsService.showSettings();
    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
