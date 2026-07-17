import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { ViewportRendererService } from '@/services/ViewportRenderService';
import { ServiceContainer } from '@/fw/di';

/**
 * Command to zoom viewport to fit all objects.
 */
export class ZoomAllCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'view.zoom-all',
    title: 'Frame All',
    description: 'Zoom viewport to fit all objects',
    keywords: ['zoom', 'viewport', 'fit', 'all', 'frame'],
    menuPath: 'view',
    keybinding: 'Shift+F',
    when: 'viewportFocused && !isInputFocused',
    addToMenu: true,
    menuOrder: 31,
  };

  preconditions(_context: CommandContext): CommandPreconditionResult {
    return { canExecute: true };
  }

  async execute(_context: CommandContext): Promise<CommandExecutionResult<void>> {
    const container = ServiceContainer.getInstance();
    const viewportRenderer = container.getService<ViewportRendererService>(
      container.getOrCreateToken(ViewportRendererService)
    );

    viewportRenderer.zoomAll();

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
