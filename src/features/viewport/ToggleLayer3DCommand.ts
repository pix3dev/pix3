import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/OperationService';
import { SceneManager } from '@pix3/runtime';
import { ToggleUIFlagOperation } from './ToggleUIFlagOperation';
import { deriveSceneLayerCapabilities, isMixedScene } from './scene-layer-capabilities';

export class ToggleLayer3DCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'view.toggle-layer-3d',
    title: 'Toggle 3D Layer',
    description: 'Show or hide the 3D layer in the viewport',
    keywords: ['3d', 'layer', 'viewport', 'toggle'],
    menuPath: 'view',
    keybinding: '3',
    when: 'viewportFocused && !isInputFocused',
    addToMenu: true,
    menuOrder: 22,
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
    await operations.invoke(new ToggleUIFlagOperation('showLayer3D', 'Toggle 3D Layer'));

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
