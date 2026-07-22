import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { requireActiveScene } from '@/features/scene/scene-command-utils';
import { ResizeGroup2DOperation, type ResizeGroup2DParams } from './ResizeGroup2DOperation';

export type ResizeGroup2DCommandParams = ResizeGroup2DParams;

/**
 * Resize a Group2D from the inspector, proportionally scaling its children (Figma-style). A separate
 * command from the generic property update so the child-scaling is an explicit *editor authoring*
 * gesture — non-inspector width/height writes (agent tools, scripts) keep box-only + anchor-reflow
 * semantics.
 */
export class ResizeGroup2DCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.resize-group2d',
    title: 'Resize Group',
    description: 'Resize a Group2D and proportionally scale its children',
    keywords: ['group', 'resize', 'size', 'scale', '2d'],
    addToMenu: false,
  };

  constructor(private readonly params: ResizeGroup2DCommandParams) {
    super();
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    const activeSceneCheck = requireActiveScene(
      context,
      'An active scene is required to resize a group'
    );
    if (!activeSceneCheck.canExecute) {
      return activeSceneCheck;
    }

    if (context.state.ui.isPlaying || context.state.collaboration.isReadOnly) {
      return {
        canExecute: false,
        reason: 'Cannot edit the scene while playing or in read-only mode',
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );

    const pushed = await operationService.invokeAndPush(
      new ResizeGroup2DOperation({
        nodeId: this.params.nodeId,
        width: this.params.width,
        height: this.params.height,
      })
    );

    return { didMutate: pushed, payload: undefined };
  }
}
