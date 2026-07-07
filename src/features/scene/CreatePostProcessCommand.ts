import { type CommandMetadata } from '@/core/command';
import {
  CreateNodeBaseCommand,
  type CreateNodeCommandPayload,
} from '@/features/scene/CreateNodeBaseCommand';
import {
  CreatePostProcessOperation,
  type CreatePostProcessOperationParams,
} from '@/features/scene/CreatePostProcessOperation';

export type CreatePostProcessCommandPayload = CreateNodeCommandPayload;

export class CreatePostProcessCommand extends CreateNodeBaseCommand<
  CreatePostProcessOperationParams,
  CreatePostProcessCommandPayload
> {
  readonly metadata: CommandMetadata = {
    id: 'scene.create-post-process',
    title: 'Create Post Process',
    description: 'Create a post-processing environment node in the scene',
    keywords: ['create', 'post', 'processing', 'bloom', 'vignette', 'chromatic', 'lut', 'effect'],
  };

  constructor(params: CreatePostProcessOperationParams = {}) {
    super(
      params,
      operationParams => new CreatePostProcessOperation(operationParams),
      'An active scene is required to create a post-process node'
    );
  }
}
