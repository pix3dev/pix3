import { type CommandMetadata } from '@/core/command';
import {
  CreateNodeBaseCommand,
  type CreateNodeCommandPayload,
} from '@/features/scene/CreateNodeBaseCommand';
import {
  CreateColorRect2DOperation,
  type CreateColorRect2DOperationParams,
} from '@/features/scene/CreateColorRect2DOperation';

export type CreateColorRect2DCommandPayload = CreateNodeCommandPayload;

export class CreateColorRect2DCommand extends CreateNodeBaseCommand<
  CreateColorRect2DOperationParams,
  CreateColorRect2DCommandPayload
> {
  readonly metadata: CommandMetadata = {
    id: 'scene.create-colorrect2d',
    title: 'Create ColorRect2D',
    description: 'Create a 2D color rectangle in the scene',
    addToMenu: false,
    keywords: ['create', 'color', 'rect', '2d', 'ui'],
  };

  constructor(params: CreateColorRect2DOperationParams = {}) {
    super(
      params,
      operationParams => new CreateColorRect2DOperation(operationParams),
      'An active scene is required to create a ColorRect2D'
    );
  }
}
