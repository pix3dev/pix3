import { inject } from '@/fw/di';
import { LayoutManagerService } from '@/core/LayoutManager';
import { DialogService } from '@/services/editor/DialogService';
import { CommandBase, type CommandExecutionResult, type CommandMetadata } from '@/core/command';

/**
 * `Window ▸ Reset Layout…` — put every dock back where the default layout has it.
 *
 * This is the escape hatch behind the rest of the Window menu: a row per panel gets a closed panel
 * back, but a layout the user has dragged into a corner needs the whole tree rebuilt.
 * `LayoutManager` already owns the default config (`resetLayout()` reloads it), so this command is
 * only the confirmation in front of it.
 *
 * It asks first — the user's arrangement is not on the undo stack (Golden Layout owns it, not
 * `HistoryManager`), so a mis-click would be unrecoverable. That is also why the title ends in an
 * ellipsis: per the naming rules, "…" marks a command that asks before it acts.
 */
export class ResetLayoutCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'window.reset-layout',
    title: 'Reset Layout…',
    description: 'Restore the default arrangement of panels and docks',
    keywords: ['reset', 'layout', 'panels', 'docks', 'default', 'window', 'restore'],
    menuPath: 'window',
    addToMenu: true,
    menuOrder: 900,
  };

  @inject(LayoutManagerService)
  private readonly layoutManager!: LayoutManagerService;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  async execute(): Promise<CommandExecutionResult<void>> {
    const confirmed = await this.dialogService.showConfirmation({
      title: 'Reset Layout',
      message:
        'Restore the default panel arrangement? Your current layout — panel positions, sizes and ' +
        'which panels are open — will be discarded. This cannot be undone.',
      confirmLabel: 'Reset Layout',
      cancelLabel: 'Cancel',
      isDangerous: true,
    });

    if (!confirmed) {
      return {
        didMutate: false,
        payload: undefined,
      };
    }

    await this.layoutManager.resetLayout();

    // Not undoable: the layout lives in Golden Layout, not in `appState`, so there is nothing for
    // an Operation to restore.
    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
