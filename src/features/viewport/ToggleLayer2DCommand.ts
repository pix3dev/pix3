import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { SceneManager } from '@pix3/runtime';
import { ToggleUIFlagOperation } from './ToggleUIFlagOperation';
import { deriveSceneLayerCapabilities, isMixedScene } from './scene-layer-capabilities';

export class ToggleLayer2DCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'view.toggle-layer-2d',
    title: 'Toggle 2D Layer',
    description: 'Show or hide the 2D layer in the viewport',
    keywords: ['2d', 'layer', 'viewport', 'toggle'],
    menuPath: 'view',
    keybinding: '2',
    when: 'viewportFocused && !isInputFocused',
    addToMenu: true,
    menuOrder: 21,
  };

  preconditions(context: CommandContext): CommandPreconditionResult {
    const sceneManager = context.container.getService<SceneManager>(
      context.container.getOrCreateToken(SceneManager)
    );
    const capabilities = deriveSceneLayerCapabilities(sceneManager.getActiveSceneGraph());
    // Layer visibility is only meaningful in a mixed scene — hiding the sole
    // layer would just blank the viewport, so the toggle is locked otherwise.
    return { canExecute: isMixedScene(capabilities) };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    await operations.invoke(new ToggleUIFlagOperation('showLayer2D', 'Toggle 2D Layer'));

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
