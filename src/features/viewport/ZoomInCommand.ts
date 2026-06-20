import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { ViewportRendererService } from '@/services/ViewportRenderService';
import { ServiceContainer } from '@/fw/di';

const ZOOM_IN_FACTOR = 1.2;

/**
 * Command to zoom the viewport in by a fixed step.
 */
export class ZoomInCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'view.zoom-in',
    title: 'Zoom In',
    description: 'Zoom the viewport in',
    keywords: ['zoom', 'viewport', 'in', 'closer'],
    menuPath: 'view',
    keybinding: '=',
    when: 'viewportFocused && !isInputFocused',
    addToMenu: true,
    menuOrder: 28,
  };

  preconditions(_context: CommandContext): CommandPreconditionResult {
    return { canExecute: true };
  }

  async execute(_context: CommandContext): Promise<CommandExecutionResult<void>> {
    const container = ServiceContainer.getInstance();
    const viewportRenderer = container.getService<ViewportRendererService>(
      container.getOrCreateToken(ViewportRendererService)
    );

    viewportRenderer.zoomBy(ZOOM_IN_FACTOR);

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
