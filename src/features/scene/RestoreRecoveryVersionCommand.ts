import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import {
  RestoreRecoveryVersionOperation,
  type RestoreRecoveryVersionOperationParams,
} from '@/features/scene/RestoreRecoveryVersionOperation';

/** Internal (merge banner / scene tab context menu): see {@link RestoreRecoveryVersionOperation}. */
export class RestoreRecoveryVersionCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.restore-recovery-version',
    title: 'Restore My Version',
    description: 'Restore a version of the scene from the recovery journal',
    keywords: ['restore', 'recovery', 'journal', 'version', 'agent'],
    addToMenu: false,
  };

  constructor(private readonly params: RestoreRecoveryVersionOperationParams) {
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
    const pushed = await operations.invokeAndPush(new RestoreRecoveryVersionOperation(this.params));
    return { didMutate: pushed, payload: undefined };
  }
}
