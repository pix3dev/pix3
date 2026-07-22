import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/OperationService';
import {
  SetPreviewCameraOperation,
  type SetPreviewCameraParams,
} from './SetPreviewCameraOperation';

class SetPreviewCameraCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'viewport.set-preview-camera',
    title: 'Set Preview Camera',
    description: 'Choose the camera shown in the viewport preview inset',
    keywords: ['viewport', 'preview', 'camera', 'inset'],
  };

  constructor(private readonly params: SetPreviewCameraParams) {
    super();
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    const sceneId = this.params.sceneId ?? context.snapshot.scenes.activeSceneId;
    if (!sceneId) {
      return {
        canExecute: false,
        reason: 'An active scene is required to set the preview camera.',
        scope: 'scene',
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );

    const result = await operations.invoke(new SetPreviewCameraOperation(this.params));

    return {
      didMutate: result.didMutate,
      payload: undefined,
    };
  }
}

export const setPreviewCamera = (cameraNodeId: string | null, sceneId?: string | null) =>
  new SetPreviewCameraCommand({ cameraNodeId, sceneId });
