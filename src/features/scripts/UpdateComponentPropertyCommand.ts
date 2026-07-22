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
import {
  UpdateComponentPropertyOperation,
  type UpdateComponentPropertyParams,
} from './UpdateComponentPropertyOperation';

export type UpdateComponentPropertyHistoryMode = 'immediate' | 'preview' | 'commit';

export interface UpdateComponentPropertyCommandParams extends UpdateComponentPropertyParams {
  historyMode?: UpdateComponentPropertyHistoryMode;
}

export class UpdateComponentPropertyCommand extends CommandBase<object, void> {
  readonly metadata: CommandMetadata = {
    id: 'scripts.update-component-property',
    title: 'Update Component Property',
    description: 'Update a script component property on a node',
    keywords: ['update', 'script', 'component', 'property'],
  };

  private readonly params: UpdateComponentPropertyCommandParams;

  constructor(params: UpdateComponentPropertyCommandParams) {
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
    // Component config on a prefab instance node is not serialized as an
    // override, so a value edit would be silently lost on save. Block it.
    if (isPrefabInstanceNode(context, this.params.nodeId)) {
      return { canExecute: false, reason: PREFAB_COMPONENT_LOCK_REASON, scope: 'selection' };
    }
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<object>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const op = new UpdateComponentPropertyOperation(this.params);
    const historyMode = this.params.historyMode ?? 'immediate';

    if (historyMode === 'preview') {
      const result = await operations.invoke(op);
      return { didMutate: result.didMutate, payload: {} };
    }

    const pushed = await operations.invokeAndPush(op);
    return { didMutate: pushed, payload: {} };
  }
}
