import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { requireActiveScene } from '@/features/scene/scene-command-utils';
import {
  ConvertNodeTypeOperation,
  type ConvertNodeTypeOperationParams,
} from '@/features/scene/ConvertNodeTypeOperation';

export interface ConvertNodeTypeCommandPayload {
  nodeId: string;
}

/**
 * Replace a node with a new node of a different type in place (see {@link ConvertNodeTypeOperation}).
 * Thin command wrapper so the swap lands in undo/redo through the operation service.
 */
export class ConvertNodeTypeCommand extends CommandBase<ConvertNodeTypeCommandPayload, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.convert-node-type',
    title: 'Convert Node Type',
    description: 'Replace a node with a new node of a different type, keeping its content',
    keywords: ['convert', 'change', 'type', 'node', 'replace', 'swap'],
  };

  constructor(private readonly params: ConvertNodeTypeOperationParams) {
    super();
  }

  preconditions(context: CommandContext) {
    return requireActiveScene(context, 'An active scene is required to convert a node');
  }

  async execute(
    context: CommandContext
  ): Promise<CommandExecutionResult<ConvertNodeTypeCommandPayload>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const pushed = await operationService.invokeAndPush(new ConvertNodeTypeOperation(this.params));
    return {
      didMutate: pushed,
      payload: { nodeId: this.params.nodeId },
    };
  }
}
