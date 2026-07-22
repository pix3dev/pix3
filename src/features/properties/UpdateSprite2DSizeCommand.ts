import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
} from '@/core/command';
import { SceneManager } from '@pix3/runtime';
import { OperationService } from '@/services/core/OperationService';
import {
  UpdateSprite2DSizeOperation,
  type UpdateSprite2DSizeParams,
} from '@/features/properties/UpdateSprite2DSizeOperation';

export type UpdateSprite2DSizePayload = object;

export class UpdateSprite2DSizeCommand extends CommandBase<UpdateSprite2DSizePayload, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.update-sprite2d-size',
    title: 'Update Sprite2D Size',
    description: 'Update Sprite2D width and height in one operation',
    keywords: ['sprite', '2d', 'size', 'width', 'height', 'resize'],
  };

  private readonly params: UpdateSprite2DSizeParams;

  constructor(params: UpdateSprite2DSizeParams) {
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
  ): Promise<CommandExecutionResult<UpdateSprite2DSizePayload>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const operation = new UpdateSprite2DSizeOperation(this.params);
    const pushed = await operations.invokeAndPush(operation);
    return { didMutate: pushed, payload: {} };
  }
}
