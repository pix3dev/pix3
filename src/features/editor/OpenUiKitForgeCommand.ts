import { CommandBase, type CommandMetadata, type CommandExecutionResult } from '@/core/command';
import { UIKIT_FORGE_HASH } from '@/core/tool-routes';

/**
 * Opens UI Kit Forge, the game-UI sprite generator, on its own full-window route.
 *
 * Navigating rather than opening a panel is the point: the tool needs no project, so `#uikit` has
 * to work from a cold load and stay linkable. Opening a route is not an undoable state change, so
 * this reports `didMutate: false` and creates no Operation.
 */
export class OpenUiKitForgeCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'editor.open-uikit-forge',
    title: 'UI Kit Forge',
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
      'generate',
    ],
  };

  async execute(): Promise<CommandExecutionResult<void>> {
    window.location.hash = UIKIT_FORGE_HASH;
    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
