import { type CommandMetadata } from '@/core/command';
import {
  CreateNodeBaseCommand,
  type CreateNodeCommandPayload,
} from '@/features/scene/CreateNodeBaseCommand';
import {
  CreateCanvasLayer2DOperation,
  type CreateCanvasLayer2DOperationParams,
} from '@/features/scene/CreateCanvasLayer2DOperation';

export type CreateCanvasLayer2DCommandPayload = CreateNodeCommandPayload;

export class CreateCanvasLayer2DCommand extends CreateNodeBaseCommand<
  CreateCanvasLayer2DOperationParams,
  CreateCanvasLayer2DCommandPayload
> {
  readonly metadata: CommandMetadata = {
    id: 'scene.create-canvaslayer2d',
    title: 'Create CanvasLayer2D',
    description: 'Create a fixed UI overlay layer (drawn above post-processing) in the scene',
    keywords: ['create', 'canvas', 'layer', '2d', 'overlay', 'hud', 'ui', 'add'],
  };

  constructor(params: CreateCanvasLayer2DOperationParams = {}) {
    super(
      params,
      operationParams => new CreateCanvasLayer2DOperation(operationParams),
      'An active scene is required to create a CanvasLayer2D'
    );
  }
}
