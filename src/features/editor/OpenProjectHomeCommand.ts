import { inject } from '@/fw/di';
import { LayoutManagerService } from '@/core/LayoutManager';
import { CommandBase, type CommandMetadata, type CommandExecutionResult } from '@/core/command';

/**
 * Activate the pinned Project Home tab (the onboarding dashboard, always first
 * in the editor document area). Switching tabs is not an undoable state change,
 * so this returns `didMutate: false` and never creates an Operation.
 */
export class OpenProjectHomeCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'editor.open-project-home',
    title: 'Project Home',
    description: 'Switch to the pinned Project Home dashboard tab',
    menuPath: 'view',
    addToMenu: true,
    menuOrder: 1,
    keybinding: 'Mod+1',
    when: '!isInputFocused',
    keywords: ['home', 'dashboard', 'project', 'start', 'overview'],
  };

  @inject(LayoutManagerService)
  private readonly layoutManager!: LayoutManagerService;

  async execute(): Promise<CommandExecutionResult<void>> {
    this.layoutManager.focusHomeTab();
    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
