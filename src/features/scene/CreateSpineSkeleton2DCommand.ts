import { type CommandMetadata } from '@/core/command';
import {
  CreateNodeBaseCommand,
  type CreateNodeCommandPayload,
} from '@/features/scene/CreateNodeBaseCommand';
import {
  CreateSpineSkeleton2DOperation,
  type CreateSpineSkeleton2DOperationParams,
} from '@/features/scene/CreateSpineSkeleton2DOperation';

export class CreateSpineSkeleton2DCommand extends CreateNodeBaseCommand<
  CreateSpineSkeleton2DOperationParams,
  CreateNodeCommandPayload
> {
  readonly metadata: CommandMetadata = {
    id: 'scene.create-spineskeleton2d',
    title: 'Create SpineSkeleton2D',
    description: 'Create a Spine skeleton in the scene',
    menuPath: 'create/2d',
    addToMenu: true,
    menuOrder: 165,
    keywords: ['create', 'spine', 'skeleton', 'bones', 'animation', '2d'],
  };

  constructor(params: CreateSpineSkeleton2DOperationParams = {}) {
    super(
      params,
      operationParams => new CreateSpineSkeleton2DOperation(operationParams),
      'An active scene is required to create a SpineSkeleton2D'
    );
  }
}
