import { type CommandMetadata } from '@/core/command';
import {
  CreateNodeBaseCommand,
  type CreateNodeCommandPayload,
} from '@/features/scene/CreateNodeBaseCommand';
import {
  CreateVirtualCamera3DOperation,
  type CreateVirtualCamera3DOperationParams,
} from '@/features/scene/CreateVirtualCamera3DOperation';

export type CreateVirtualCamera3DCommandPayload = CreateNodeCommandPayload;

export class CreateVirtualCamera3DCommand extends CreateNodeBaseCommand<
  CreateVirtualCamera3DOperationParams,
  CreateVirtualCamera3DCommandPayload
> {
  readonly metadata: CommandMetadata = {
    id: 'scene.create-virtual-camera3d',
    title: 'Create Virtual Camera',
    description: 'Create a new virtual camera (Cinemachine-lite) in the scene',
    keywords: ['create', 'virtual', 'camera', 'cinemachine', '3d', 'vcam', 'add'],
  };

  constructor(params: CreateVirtualCamera3DOperationParams = {}) {
    super(
      params,
      operationParams => new CreateVirtualCamera3DOperation(operationParams),
      'An active scene is required to create a virtual camera'
    );
  }
}
