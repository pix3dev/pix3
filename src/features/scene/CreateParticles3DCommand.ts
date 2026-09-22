import { type CommandMetadata } from '@/core/command';
import {
  CreateNodeBaseCommand,
  type CreateNodeCommandPayload,
} from '@/features/scene/CreateNodeBaseCommand';
import {
  CreateParticles3DOperation,
  type CreateParticles3DOperationParams,
} from '@/features/scene/CreateParticles3DOperation';

export class CreateParticles3DCommand extends CreateNodeBaseCommand<
  CreateParticles3DOperationParams,
  CreateNodeCommandPayload
> {
  readonly metadata: CommandMetadata = {
    id: 'scene.create-particles3d',
    title: 'Create Particles3D',
    description: 'Create a new 3D particle emitter in the scene',
    addToMenu: false,
    keywords: ['create', 'particles', 'vfx', '3d', 'emitter', 'effects', 'add'],
  };

  constructor(params: CreateParticles3DOperationParams = {}) {
    super(
      params,
      operationParams => new CreateParticles3DOperation(operationParams),
      'An active scene is required to create a Particles3D node'
    );
  }
}
