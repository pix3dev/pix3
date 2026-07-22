import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import {
  ReparentNodeOperation,
  type ReparentNodeOperationParams,
} from '@/features/scene/ReparentNodeOperation';

export class ReparentNodeCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.reparent-node',
    title: 'Reparent Node',
    description: 'Move a node to a new parent or change its order',
    keywords: ['reparent', 'move', 'hierarchy', 'reorganize'],
  };

  private readonly params: ReparentNodeOperationParams;

  constructor(params: ReparentNodeOperationParams) {
    super();
    this.params = params;
  }

  preconditions(context: CommandContext) {
    const { state } = context;
    const activeSceneId = state.scenes.activeSceneId;

    if (!activeSceneId) {
      return {
        canExecute: false,
        reason: 'An active scene is required to reparent nodes',
        scope: 'scene' as const,
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );

    const op = new ReparentNodeOperation(this.params);
    const pushed = await operationService.invokeAndPush(op);

    return { didMutate: pushed, payload: undefined };
  }
}
