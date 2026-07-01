import { type CommandMetadata } from '@/core/command';
import {
  CreateNodeBaseCommand,
  type CreateNodeCommandPayload,
} from '@/features/scene/CreateNodeBaseCommand';
import {
  CreateTiledSprite2DOperation,
  type CreateTiledSprite2DOperationParams,
} from '@/features/scene/CreateTiledSprite2DOperation';

export type CreateTiledSprite2DCommandPayload = CreateNodeCommandPayload;

export class CreateTiledSprite2DCommand extends CreateNodeBaseCommand<
  CreateTiledSprite2DOperationParams,
  CreateTiledSprite2DCommandPayload
> {
  readonly metadata: CommandMetadata = {
    id: 'scene.create-tiledsprite2d',
    title: 'Create TiledSprite2D',
    description: 'Create a tiling / 9-slice 2D sprite for UI panels and bars',
    keywords: [
      'create',
      'tiled',
      'sprite',
      '2d',
      'nine',
      'slice',
      '9-patch',
      'ninepatch',
      'panel',
      'tile',
      'border',
    ],
  };

  constructor(params: CreateTiledSprite2DOperationParams = {}) {
    super(
      params,
      operationParams => new CreateTiledSprite2DOperation(operationParams),
      'An active scene is required to create a TiledSprite2D'
    );
  }
}
