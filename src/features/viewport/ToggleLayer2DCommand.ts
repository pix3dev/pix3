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
    // "Show 2D", not "Toggle 2D Layer": this is a viewport DIMENSION filter, and the word
    // "layer" already means a draw band (CanvasLayer2D / zIndex) in this editor. One word must not
    // mean two things in the same menu — Peek's branch chips would have made it three.
    title: 'Show 2D',
    description: 'Show or hide 2D content in the viewport',
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
    await operations.invoke(new ToggleUIFlagOperation('showLayer2D', 'Show 2D'));

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
