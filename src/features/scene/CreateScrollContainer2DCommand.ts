import { type CommandMetadata } from '@/core/command';
import {
  CreateNodeBaseCommand,
  type CreateNodeCommandPayload,
} from '@/features/scene/CreateNodeBaseCommand';
import {
  CreateScrollContainer2DOperation,
  type CreateScrollContainer2DOperationParams,
} from '@/features/scene/CreateScrollContainer2DOperation';

export type CreateScrollContainer2DCommandPayload = CreateNodeCommandPayload;

export class CreateScrollContainer2DCommand extends CreateNodeBaseCommand<
  CreateScrollContainer2DOperationParams,
  CreateScrollContainer2DCommandPayload
> {
  readonly metadata: CommandMetadata = {
    id: 'scene.create-scrollcontainer2d',
    title: 'Create ScrollContainer2D',
    description: 'Create a new 2D scroll container in the scene',
    keywords: ['create', 'scroll', 'container', '2d', 'ui', 'viewport', 'add'],
  };

  constructor(params: CreateScrollContainer2DOperationParams = {}) {
    super(
      params,
      operationParams => new CreateScrollContainer2DOperation(operationParams),
      'An active scene is required to create a ScrollContainer2D'
    );
  }
}