import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import {
  GroupSelectedNodesOperation,
  type GroupSelectedNodesOperationParams,
} from '@/features/scene/GroupSelectedNodesOperation';
import {
  allResolvedNodesArePrefabChildren,
  requireActiveScene,
} from '@/features/scene/scene-command-utils';

export class GroupSelectedNodesCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.group-selected-nodes',
    title: 'Group Selection',
    description: 'Group selected nodes under a new Node3D or Group2D container',
    keywords: ['group', 'selection', 'container'],
    menuPath: 'edit',
    keybinding: 'Mod+G',
    when: '!isInputFocused && (viewportFocused || sceneTreeFocused)',
    addToMenu: true,
    menuOrder: 16,
  };

  private readonly params?: GroupSelectedNodesOperationParams;

  constructor(params?: GroupSelectedNodesOperationParams) {
    super();
    this.params = params;
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    const activeSceneCheck = requireActiveScene(
      context,
      'An active scene is required to group nodes'
    );
    if (!activeSceneCheck.canExecute) {
      return activeSceneCheck;
    }

    const nodeIds = this.params?.nodeIds ?? context.state.selection.nodeIds;
    if (nodeIds.length === 0) {
      return {
        canExecute: false,
        reason: 'At least one node must be selected to group',
        scope: 'selection',
      };
    }

    if (allResolvedNodesArePrefabChildren(context, nodeIds)) {
      return {
        canExecute: false,
        reason: 'Prefab instance children cannot be grouped — open the prefab to edit its contents',
        scope: 'selection',
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );

    const nodeIds = this.params?.nodeIds ?? context.state.selection.nodeIds;
    const op = new GroupSelectedNodesOperation({ nodeIds: [...nodeIds] });
    const pushed = await operationService.invokeAndPush(op);

    return { didMutate: pushed, payload: undefined };
  }
}
