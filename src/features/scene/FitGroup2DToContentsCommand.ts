import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/OperationService';
import { requireActiveScene } from '@/features/scene/scene-command-utils';
import {
  FitGroup2DToContentsOperation,
  type FitGroup2DToContentsParams,
} from './FitGroup2DToContentsOperation';

export type FitGroup2DToContentsCommandParams = FitGroup2DToContentsParams;

/**
 * Resize a Group2D to wrap its contents (inspector "Fit to contents" button). Validity beyond an
 * active, editable scene (target is a Group2D with descendants) is enforced by the operation
 * returning `didMutate: false`, and the button is disabled in the inspector when there's nothing to
 * fit.
 */
export class FitGroup2DToContentsCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.fit-group2d-to-contents',
    title: 'Fit Group to Contents',
    description: 'Resize the selected Group2D to wrap its children without moving them',
    keywords: ['group', 'fit', 'resize', 'contents', 'shrink', 'wrap', '2d'],
    addToMenu: false,
  };

  constructor(private readonly params: FitGroup2DToContentsCommandParams) {
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
      new FitGroup2DToContentsOperation({ nodeId: this.params.nodeId })
    );

    return { didMutate: pushed, payload: undefined };
  }
}
