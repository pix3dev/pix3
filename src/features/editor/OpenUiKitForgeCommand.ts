import { inject } from '@/fw/di';
import { CommandBase, type CommandMetadata, type CommandExecutionResult } from '@/core/command';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { UIKIT_FORGE_HASH } from '@/core/tool-routes';
import { appState } from '@/state';

/**
 * Opens UI Kit Forge, the game-UI sprite generator.
 *
 * Two destinations, chosen by whether a project is open, because the tool has two hosts over one
 * core (plan §4):
 *
 * - **A project is open** → the editor tab (`pix3-uikit-forge-panel`). Only there can the kit be
 *   baked into `sprites/ui/`, skins applied to selected nodes and templates written as prefabs —
 *   all of which need a project on disk.
 * - **No project** → the standalone page on `#uikit`. That route is documented as cold-loadable
 *   and linkable, and the tool being useful with no project at all is the point of the standalone
 *   host — so navigating stays the right answer, not an error message.
 *
 * Opening either is not an undoable state change, so this reports `didMutate: false` and creates
 * no Operation.
 */
export class OpenUiKitForgeCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'editor.open-uikit-forge',
    title: 'UI Kit',
    description: 'Generate game UI sprites (buttons, panels, bars) from a theme',
    menuPath: 'tools',
    addToMenu: true,
    menuOrder: 12,
    keywords: [
      'uikit',
      'ui kit',
      'forge',
      'ui',
      'button',
      'panel',
      'progress bar',
      'toggle',
      'atlas',
      'svg',
      'skin',
      'prefab',
      'generate',
    ],
  };

  @inject(EditorTabService)
  private readonly editorTabService!: EditorTabService;

  async execute(): Promise<CommandExecutionResult<void>> {
    if (appState.project.status === 'ready') {
      await this.editorTabService.focusOrOpenUiKitForge();
    } else {
      window.location.hash = UIKIT_FORGE_HASH;
    }

    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
