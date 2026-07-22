/**
 * RemoveComponentCommand - Command to remove a component from a node
 */

import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import {
  PREFAB_COMPONENT_LOCK_REASON,
  isPrefabInstanceNode,
} from '@/features/scene/scene-command-utils';
import { RemoveComponentOperation, type RemoveComponentParams } from './RemoveComponentOperation';

export class RemoveComponentCommand extends CommandBase<object, void> {
  readonly metadata: CommandMetadata = {
    id: 'scripts.remove-component',
    title: 'Remove Component',
    description: 'Remove a script component from a node',
    keywords: ['remove', 'component', 'script'],
  };

  private readonly params: RemoveComponentParams;

  constructor(params: RemoveComponentParams) {
    super();
    this.params = params;
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (!context.snapshot.scenes.activeSceneId) {
      return { canExecute: false, reason: 'No active scene', scope: 'scene' };
    }
    if (!this.params.nodeId) {
      return { canExecute: false, reason: 'No target node specified', scope: 'selection' };
    }
    if (isPrefabInstanceNode(context, this.params.nodeId)) {
      return { canExecute: false, reason: PREFAB_COMPONENT_LOCK_REASON, scope: 'selection' };
    }
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<object>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const op = new RemoveComponentOperation(this.params);
    const pushed = await operations.invokeAndPush(op);
    return { didMutate: pushed, payload: {} };
  }
}
