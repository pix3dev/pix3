/**
 * RemoveEffectCommand - command to detach a shader effect from a GeometryMesh.
 */
import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/OperationService';
import {
  PREFAB_COMPONENT_LOCK_REASON,
  isPrefabInstanceNode,
} from '@/features/scene/scene-command-utils';
import { RemoveEffectOperation, type RemoveEffectParams } from './RemoveEffectOperation';

export class RemoveEffectCommand extends CommandBase<object, void> {
  readonly metadata: CommandMetadata = {
    id: 'effects.remove-effect',
    title: 'Remove Effect',
    description: 'Detach a shader effect from a mesh',
    keywords: ['remove', 'effect', 'shader'],
  };

  private readonly params: RemoveEffectParams;

  constructor(params: RemoveEffectParams) {
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
    const op = new RemoveEffectOperation(this.params);
    const pushed = await operations.invokeAndPush(op);
    return { didMutate: pushed, payload: {} };
  }
}
