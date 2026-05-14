import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/OperationService';
import { requireActiveScene } from '@/features/scene/scene-command-utils';
import { Align2DNodesOperation, type Align2DNodesOperationParams } from './Align2DNodesOperation';
import type { Align2DActionId } from './types';

export type Align2DNodesCommandParams = Align2DNodesOperationParams;

export class Align2DNodesCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.align-2d-nodes',
    title: 'Align 2D Nodes',
    description: 'Align selected 2D nodes from the viewport toolbar',
    keywords: ['align', 'distribute', '2d', 'layout'],
    addToMenu: false,
  };

  constructor(private readonly params: Align2DNodesCommandParams) {
    super();
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    const activeSceneCheck = requireActiveScene(
      context,
      'An active scene is required to align 2D nodes'
    );
    if (!activeSceneCheck.canExecute) {
      return activeSceneCheck;
    }

    const nodeIds = this.params.nodeIds ?? context.state.selection.nodeIds;
    if (nodeIds.length === 0) {
      return {
        canExecute: false,
        reason: 'At least one node must be selected to align',
        scope: 'selection',
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );

    const nodeIds = this.params.nodeIds ?? context.state.selection.nodeIds;
    const pushed = await operationService.invokeAndPush(
      new Align2DNodesOperation({
        action: this.params.action,
        nodeIds: [...nodeIds],
      })
    );

    return { didMutate: pushed, payload: undefined };
  }
}

export const align2DNodes = (action: Align2DActionId, nodeIds?: string[]) =>
  new Align2DNodesCommand({ action, nodeIds });
