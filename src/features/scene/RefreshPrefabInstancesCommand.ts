import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import {
  RefreshPrefabInstancesOperation,
  type RefreshPrefabInstancesOperationParams,
} from '@/features/scene/RefreshPrefabInstancesOperation';

export class RefreshPrefabInstancesCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.refresh-prefab-instances',
    title: 'Refresh Prefab Instances',
    description: 'Refresh instantiated prefab branches in a loaded scene',
    keywords: ['scene', 'prefab', 'instance', 'refresh'],
  };

  private readonly params: RefreshPrefabInstancesOperationParams;

  constructor(params: RefreshPrefabInstancesOperationParams) {
    super();
    this.params = params;
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    const descriptor = context.state.scenes.descriptors[this.params.sceneId];
    if (!descriptor) {
      return {
        canExecute: false,
        reason: 'Scene not found for prefab refresh',
        scope: 'scene',
        recoverable: false,
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );

    const op = new RefreshPrefabInstancesOperation(this.params);
    const result = await operationService.invoke(op);

    return {
      didMutate: result.didMutate,
      payload: undefined,
    };
  }
}
