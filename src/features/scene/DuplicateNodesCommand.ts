import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import {
  DuplicateNodesOperation,
  type DuplicateNodesOperationParams,
} from '@/features/scene/DuplicateNodesOperation';
import {
  allResolvedNodesArePrefabChildren,
  requireActiveScene,
} from '@/features/scene/scene-command-utils';

export class DuplicateNodesCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.duplicate-nodes',
    title: 'Duplicate',
    description: 'Duplicate selected nodes including their child hierarchy',
    keywords: ['duplicate', 'clone', 'copy', 'nodes'],
    menuPath: 'edit',
    keybinding: 'Mod+D',
    when: '!isInputFocused && (viewportFocused || sceneTreeFocused)',
    addToMenu: true,
    menuOrder: 15,
  };

  private readonly params?: DuplicateNodesOperationParams;

  constructor(params?: DuplicateNodesOperationParams) {
    super();
    this.params = params;
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    const activeSceneCheck = requireActiveScene(
      context,
      'An active scene is required to duplicate nodes'
    );
    if (!activeSceneCheck.canExecute) {
      return activeSceneCheck;
    }

    const nodeIds = this.params?.nodeIds ?? context.state.selection.nodeIds;
    if (nodeIds.length === 0) {
      return {
        canExecute: false,
        reason: 'At least one node must be selected to duplicate',
        scope: 'selection',
      };
    }

    if (allResolvedNodesArePrefabChildren(context, nodeIds)) {
      return {
        canExecute: false,
        reason:
          'Prefab instance children cannot be duplicated — open the prefab to edit its contents',
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
    const op = new DuplicateNodesOperation({ nodeIds: [...nodeIds] });
    const pushed = await operationService.invokeAndPush(op);

    return { didMutate: pushed, payload: undefined };
  }
}
