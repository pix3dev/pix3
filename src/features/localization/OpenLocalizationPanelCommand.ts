import { inject } from '@/fw/di';
import { LayoutManagerService } from '@/core/LayoutManager';
import { CommandBase, type CommandExecutionResult, type CommandMetadata } from '@/core/command';

/**
 * Reveal the Localization panel (locale tables, missing-translation view, preview
 * locale switch). Revealing a panel is not an undoable state change, so this
 * returns `didMutate: false` and never creates an Operation.
 */
export class OpenLocalizationPanelCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'localization.open-panel',
    title: 'Localization',
    description: 'Open the localization panel to author locale tables and translations',
    menuPath: 'view',
    addToMenu: true,
    menuOrder: 50,
    keywords: ['localization', 'locale', 'translation', 'i18n', 'l10n', 'language', 'panel'],
  };

  @inject(LayoutManagerService)
  private readonly layoutManager!: LayoutManagerService;

  async execute(): Promise<CommandExecutionResult<void>> {
    this.layoutManager.revealLocalizationPanel();
    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
