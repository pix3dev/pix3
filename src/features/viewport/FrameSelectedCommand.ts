import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { ViewportRendererService } from '@/services/ViewportRenderService';
import { ServiceContainer } from '@/fw/di';

export interface FrameSelectedParams {
  /**
   * Frame this specific node instead of the current selection. Used by the scene
   * tree (double-click / context menu) so framing targets the clicked node even
   * when the selection differs.
   */
  nodeId?: string;
}

/**
 * Move the camera to frame the selected node(s) — the "Frame Selected" gesture
 * (Blender/Unity/Godot F). With nothing selected it frames the whole scene, so
 * F stays useful either way. Switches the navigation mode when the target lives
 * in the other dimension. Works whether the viewport OR the scene tree has focus.
 * View-only: not undoable.
 */
export class FrameSelectedCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'view.frame-selected',
    title: 'Frame Selected',
    description:
      'Move the camera to frame the selected node(s); frames all when nothing is selected',
    keywords: ['frame', 'focus', 'zoom', 'selected', 'fit', 'center'],
    menuPath: 'view',
    keybinding: 'F',
    when: '(viewportFocused || sceneTreeFocused) && !isInputFocused',
    addToMenu: true,
    menuOrder: 30,
  };

  private readonly params: FrameSelectedParams;

  constructor(params: FrameSelectedParams = {}) {
    super();
    this.params = params;
  }

  preconditions(_context: CommandContext): CommandPreconditionResult {
    return { canExecute: true };
  }

  async execute(_context: CommandContext): Promise<CommandExecutionResult<void>> {
    const container = ServiceContainer.getInstance();
    const viewportRenderer = container.getService<ViewportRendererService>(
      container.getOrCreateToken(ViewportRendererService)
    );

    if (this.params.nodeId) {
      viewportRenderer.frameNodeById(this.params.nodeId, {
        persist: true,
        switchNavigationMode: true,
      });
    } else {
      viewportRenderer.frameSelected();
    }

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
