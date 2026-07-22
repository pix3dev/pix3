import { inject } from '@/fw/di';
import { CommandBase, type CommandExecutionResult, type CommandMetadata } from '@/core/command';
import { ProjectLifecycleService } from '@/services/project/ProjectLifecycleService';

export class NewProjectCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'project.new',
    title: 'New Project',
    description: 'Create a new local or cloud project',
    menuPath: 'file',
    addToMenu: true,
    menuOrder: 1,
    keywords: ['new', 'project', 'create'],
  };

  @inject(ProjectLifecycleService)
  private readonly projectLifecycleService!: ProjectLifecycleService;

  async execute(): Promise<CommandExecutionResult<void>> {
    await this.projectLifecycleService.showCreateDialog();
    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
