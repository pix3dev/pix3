import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import {
  UpdateObjectPropertyOperation,
  type UpdateObjectPropertyParams,
} from '@/features/properties/UpdateObjectPropertyOperation';
import { SceneManager } from '@pix3/runtime';

export type UpdateObjectPropertyExecutePayload = object;
export type UpdateObjectPropertyHistoryMode = 'immediate' | 'preview' | 'commit';

export interface UpdateObjectPropertyCommandParams extends UpdateObjectPropertyParams {
  historyMode?: UpdateObjectPropertyHistoryMode;
}

export class UpdateObjectPropertyCommand extends CommandBase<
  UpdateObjectPropertyExecutePayload,
  void
> {
  readonly metadata: CommandMetadata = {
    id: 'scene.update-object-property',
    title: 'Update Object Property',
    description: 'Update a property on a scene object',
    keywords: ['update', 'property', 'object', 'node', 'transform'],
  };

  private readonly params: UpdateObjectPropertyCommandParams;

  constructor(params: UpdateObjectPropertyCommandParams) {
    super();
    this.params = params;
  }

  preconditions(context: CommandContext) {
    const sceneManager = context.container.getService<SceneManager>(
      context.container.getOrCreateToken(SceneManager)
    );
    return { canExecute: Boolean(sceneManager.getActiveSceneGraph()) };
  }

  async execute(
    context: CommandContext
  ): Promise<CommandExecutionResult<UpdateObjectPropertyExecutePayload>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const op = new UpdateObjectPropertyOperation(this.params);
    const historyMode = this.params.historyMode ?? 'immediate';

    if (historyMode === 'preview') {
      const result = await operations.invoke(op);
      return { didMutate: result.didMutate, payload: {} };
    }

    const pushed = await operations.invokeAndPush(op);
    return { didMutate: pushed, payload: {} };
  }
}
