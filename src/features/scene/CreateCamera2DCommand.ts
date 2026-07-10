import { type CommandMetadata } from '@/core/command';
import {
  CreateNodeBaseCommand,
  type CreateNodeCommandPayload,
} from '@/features/scene/CreateNodeBaseCommand';
import {
  CreateCamera2DOperation,
  type CreateCamera2DOperationParams,
} from '@/features/scene/CreateCamera2DOperation';

export type CreateCamera2DCommandPayload = CreateNodeCommandPayload;

export class CreateCamera2DCommand extends CreateNodeBaseCommand<
  CreateCamera2DOperationParams,
  CreateCamera2DCommandPayload
> {
  readonly metadata: CommandMetadata = {
    id: 'scene.create-camera2d',
    title: 'Create Camera2D',
    description: 'Create a 2D game camera (pan / zoom / limits / shake) in the scene',
    keywords: ['create', 'camera', '2d', 'follow', 'zoom', 'limits', 'shake', 'add'],
  };

  constructor(params: CreateCamera2DOperationParams = {}) {
    super(
      params,
      operationParams => new CreateCamera2DOperation(operationParams),
      'An active scene is required to create a Camera2D'
    );
  }
}
