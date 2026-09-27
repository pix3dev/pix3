import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import {
  AcceptAgentVersionOperation,
  type AcceptAgentVersionOperationParams,
} from '@/features/scene/AcceptAgentVersionOperation';

/** Internal (banner action): see {@link AcceptAgentVersionOperation}. */
export class AcceptAgentVersionCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.accept-agent-version',
    title: "Accept Agent's Version",
    description: 'Resolve merge conflicts in favour of the external version',
    keywords: ['merge', 'conflict', 'agent', 'accept'],
    addToMenu: false,
  };

  constructor(private readonly params: AcceptAgentVersionOperationParams) {
    super();
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (!context.state.scenes.descriptors[this.params.sceneId]) {
      return { canExecute: false, reason: 'Scene is not open', scope: 'scene', recoverable: false };
    }
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const pushed = await operations.invokeAndPush(new AcceptAgentVersionOperation(this.params));
    return { didMutate: pushed, payload: undefined };
  }
}
