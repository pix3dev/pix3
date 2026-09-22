import { type CommandMetadata } from '@/core/command';
import {
  CreateNodeBaseCommand,
  type CreateNodeCommandPayload,
} from '@/features/scene/CreateNodeBaseCommand';
import {
  CreateAnimatedSprite3DOperation,
  type CreateAnimatedSprite3DOperationParams,
} from '@/features/scene/CreateAnimatedSprite3DOperation';

export type CreateAnimatedSprite3DCommandPayload = CreateNodeCommandPayload;

export class CreateAnimatedSprite3DCommand extends CreateNodeBaseCommand<
  CreateAnimatedSprite3DOperationParams,
  CreateAnimatedSprite3DCommandPayload
> {
  readonly metadata: CommandMetadata = {
    id: 'scene.create-animatedsprite3d',
    title: 'Create AnimatedSprite3D',
    description: 'Create a 3D animated sprite in the scene',
    addToMenu: false,
    keywords: ['create', 'animated', 'sprite', '3d'],
  };

  constructor(params: CreateAnimatedSprite3DOperationParams = {}) {
    super(
      params,
      operationParams => new CreateAnimatedSprite3DOperation(operationParams),
      'An active scene is required to create an AnimatedSprite3D'
    );
  }
}
