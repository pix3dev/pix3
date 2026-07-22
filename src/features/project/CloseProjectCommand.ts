import { inject } from '@/fw/di';
import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { ProjectLifecycleService } from '@/services/project/ProjectLifecycleService';

export class CloseProjectCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'project.close',
    title: 'Close Project',
    description: 'Close the current project and return to the welcome screen',
    menuPath: 'file',
    addToMenu: true,
    menuOrder: 90,
    keywords: ['close', 'project', 'welcome'],
  };

  @inject(ProjectLifecycleService)
  private readonly projectLifecycleService!: ProjectLifecycleService;

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (context.state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'Project must be open to close it.',
        scope: 'project',
      };
    }

    return { canExecute: true };
  }

  async execute(): Promise<CommandExecutionResult<void>> {
    const closed = await this.projectLifecycleService.closeCurrentProject();
    if (closed && typeof window !== 'undefined') {
      window.location.hash = '#welcome';
    }
    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
