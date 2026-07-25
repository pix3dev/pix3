import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { requireActiveScene } from '@/features/scene/scene-command-utils';
import { Group2D, Node2D, SceneManager } from '@pix3/runtime';
import {
  FitGroup2DToContentsOperation,
  type FitGroup2DToContentsParams,
} from './FitGroup2DToContentsOperation';

export type FitGroup2DToContentsCommandParams = FitGroup2DToContentsParams;

/**
 * Resize a Group2D to wrap its contents — the inspector "Fit to contents" button, the Edit menu entry
 * and its shortcut. Without params the primary selection is used, so the menu/keybinding act on the
 * selected group.
 */
export class FitGroup2DToContentsCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.fit-group2d-to-contents',
    title: 'Fit Group to Contents',
    description: 'Resize the selected Group2D to wrap its children without moving them',
    keywords: ['group', 'fit', 'resize', 'contents', 'shrink', 'wrap', '2d'],
    menuPath: 'edit',
    keybinding: 'Mod+Alt+F',
    when: '!isInputFocused && (viewportFocused || sceneTreeFocused)',
    addToMenu: true,
    menuOrder: 17,
  };

  private readonly params?: FitGroup2DToContentsCommandParams;

  constructor(params?: FitGroup2DToContentsCommandParams) {
    super();
    this.params = params;
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    const activeSceneCheck = requireActiveScene(
      context,
      'An active scene is required to resize a group'
    );
    if (!activeSceneCheck.canExecute) {
      return activeSceneCheck;
    }

    if (context.state.ui.isPlaying || context.state.collaboration.isReadOnly) {
      return {
        canExecute: false,
        reason: 'Cannot edit the scene while playing or in read-only mode',
      };
    }

    const group = this.resolveGroup(context);
    if (!group) {
      return {
        canExecute: false,
        reason: 'Select a Group2D to fit to its contents',
        scope: 'selection',
      };
    }

    if (!group.children.some(child => child instanceof Node2D)) {
      return {
        canExecute: false,
        reason: 'This group has no 2D children to fit to',
        scope: 'selection',
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const group = this.resolveGroup(context);
    if (!group) {
      return { didMutate: false, payload: undefined };
    }

    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );

    const pushed = await operationService.invokeAndPush(
      new FitGroup2DToContentsOperation({ nodeId: group.nodeId })
    );

    return { didMutate: pushed, payload: undefined };
  }

  /** The explicit target, or the primary selection when invoked from the menu / keybinding. */
  private resolveGroup(context: CommandContext): Group2D | null {
    const nodeId = this.params?.nodeId ?? context.state.selection.primaryNodeId;
    if (!nodeId) {
      return null;
    }

    const sceneManager = context.container.getService<SceneManager>(
      context.container.getOrCreateToken(SceneManager)
    );
    const node = sceneManager.getActiveSceneGraph()?.nodeMap.get(nodeId);
    return node instanceof Group2D ? node : null;
  }
}
