import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
} from '@/core/command';
import type { Operation, OperationInvokeResult } from '@/core/Operation';
import { OperationService } from '@/services/core/OperationService';
import {
  getCreatedNodeIdFromSelection,
  requireActiveScene,
} from '@/features/scene/scene-command-utils';

export interface CreateNodeCommandPayload {
  nodeId: string;
}

type CreateOperationFactory<TParams> = (params: TParams) => Operation<OperationInvokeResult>;

export abstract class CreateNodeBaseCommand<
  TParams,
  TPayload extends CreateNodeCommandPayload = CreateNodeCommandPayload,
> extends CommandBase<TPayload, void> {
  abstract readonly metadata: CommandMetadata;

  private readonly params: TParams;
  private readonly operationFactory: CreateOperationFactory<TParams>;
  private readonly activeSceneRequiredReason: string;

  constructor(
    params: TParams,
    operationFactory: CreateOperationFactory<TParams>,
    activeSceneRequiredReason: string
  ) {
    super();
    this.params = params;
    this.operationFactory = operationFactory;
    this.activeSceneRequiredReason = activeSceneRequiredReason;
  }

  preconditions(context: CommandContext) {
    return requireActiveScene(context, this.activeSceneRequiredReason);
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<TPayload>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );

    const op = this.operationFactory(this.params);
    const pushed = await operationService.invokeAndPush(op);
    const nodeId = getCreatedNodeIdFromSelection(context, pushed);

    return {
      didMutate: pushed,
      payload: { nodeId } as TPayload,
    };
  }
}
