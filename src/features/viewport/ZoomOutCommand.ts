import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { ViewportRendererService } from '@/services/ViewportRenderService';
import { ServiceContainer } from '@/fw/di';

const ZOOM_OUT_FACTOR = 1 / 1.2;

/**
 * Command to zoom the viewport out by a fixed step.
 */
export class ZoomOutCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'view.zoom-out',
    title: 'Zoom Out',
    description: 'Zoom the viewport out',
    keywords: ['zoom', 'viewport', 'out', 'farther'],
    menuPath: 'view',
    keybinding: '-',
    when: 'viewportFocused && !isInputFocused',
    addToMenu: true,
    menuOrder: 29,
  };

  preconditions(_context: CommandContext): CommandPreconditionResult {
    return { canExecute: true };
  }

  async execute(_context: CommandContext): Promise<CommandExecutionResult<void>> {
    const container = ServiceContainer.getInstance();
    const viewportRenderer = container.getService<ViewportRendererService>(
      container.getOrCreateToken(ViewportRendererService)
    );

    viewportRenderer.zoomBy(ZOOM_OUT_FACTOR);

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
