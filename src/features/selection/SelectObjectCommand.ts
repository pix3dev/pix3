import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
} from '@/core/command';
import { OperationService } from '@/services/OperationService';
import {
  SelectObjectOperation,
  type SelectObjectParams,
} from '@/features/selection/SelectObjectOperation';

export type SelectObjectExecutePayload = object;

export class SelectObjectCommand extends CommandBase<SelectObjectExecutePayload, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.select-object',
    title: 'Select Object',
    description: 'Select one or more objects in the scene hierarchy',
    keywords: ['select', 'object', 'node', 'hierarchy'],
  };

  private readonly params: SelectObjectParams;

  constructor(params: SelectObjectParams) {
    super();
    this.params = params;
  }

  async execute(
    context: CommandContext
  ): Promise<CommandExecutionResult<SelectObjectExecutePayload>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const op = new SelectObjectOperation(this.params);
    const pushed = await operations.invokeAndPush(op);
    return { didMutate: pushed, payload: {} };
  }
}

export const createSelectObjectCommand = (params: SelectObjectParams) =>
  new SelectObjectCommand(params);
export const selectObject = (nodeId: string | null) => new SelectObjectCommand({ nodeId });
export const selectObjects = (nodeIds: string[], primaryNodeId?: string | null) =>
  new SelectObjectCommand({ nodeIds, primaryNodeId: primaryNodeId ?? nodeIds[0] ?? null });
export const toggleObjectSelection = (nodeId: string) =>
  new SelectObjectCommand({ nodeId, additive: true });
export const selectObjectRange = (nodeId: string) =>
  new SelectObjectCommand({ nodeId, range: true });
