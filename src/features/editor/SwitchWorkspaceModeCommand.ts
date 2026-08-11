import { CommandBase, type CommandContext, type CommandExecutionResult } from '@/core/command';
import { WorkspaceModeService } from '@/services/editor/WorkspaceModeService';
import type { WorkspaceMode } from '@/state/AppState';

export interface SwitchWorkspaceModeParams {
  /** Target shell. Omit to toggle between Flow and Studio. */
  mode?: WorkspaceMode;
}

/**
 * Swap the shell between Flow (prompt + live stage) and Studio (the full docked editor). Same
 * project, same services, same undo stack — Golden Layout is simply mounted (or left unmounted)
 * behind the scenes, so this is a component swap and never a page reload.
 */
export class SwitchWorkspaceModeCommand extends CommandBase<void, void> {
  readonly metadata = {
    id: 'editor.switch-workspace-mode',
    title: 'Toggle Flow / Studio',
    description: 'Switch between the prompt-first Flow workspace and the full Studio editor',
    keywords: ['flow', 'studio', 'workspace', 'mode', 'prompt'],
    menuPath: 'view',
    addToMenu: true,
    menuOrder: 5,
  } as const;

  private readonly params: SwitchWorkspaceModeParams;

  constructor(params: SwitchWorkspaceModeParams = {}) {
    super();
    this.params = params;
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const { container, snapshot } = context;
    const workspaceMode = container.getService<WorkspaceModeService>(
      container.getOrCreateToken(WorkspaceModeService)
    );
    const current = snapshot.ui.workspaceMode;
    const next = this.params.mode ?? (current === 'flow' ? 'studio' : 'flow');
    if (current === next) {
      return { didMutate: false, payload: undefined };
    }
    workspaceMode.set(next);
    return { didMutate: true, payload: undefined };
  }
}

export const openInStudio = () => new SwitchWorkspaceModeCommand({ mode: 'studio' });
export const openInFlow = () => new SwitchWorkspaceModeCommand({ mode: 'flow' });
