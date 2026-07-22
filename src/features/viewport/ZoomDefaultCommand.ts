import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { ServiceContainer } from '@/fw/di';

/**
 * Command to reset viewport zoom to default (1:1).
 */
export class ZoomDefaultCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'view.zoom-default',
    title: 'Zoom Default',
    description: 'Reset viewport zoom to default (1:1)',
    keywords: ['zoom', 'viewport', 'reset'],
    menuPath: 'view',
    keybinding: 'Home',
    when: 'viewportFocused && !isInputFocused',
    addToMenu: true,
    menuOrder: 30,
  };

  preconditions(_context: CommandContext): CommandPreconditionResult {
    return { canExecute: true };
  }

  async execute(_context: CommandContext): Promise<CommandExecutionResult<void>> {
    const container = ServiceContainer.getInstance();
    const viewportRenderer = container.getService<ViewportRendererService>(
      container.getOrCreateToken(ViewportRendererService)
    );

    viewportRenderer.zoomDefault();

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
