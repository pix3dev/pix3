import { CreateNodeOperationBase } from '@/core/CreateNodeOperationBase';
import { VirtualCamera3D, type SceneGraph } from '@pix3/runtime';
import { Vector3 } from 'three';

export interface CreateVirtualCamera3DOperationParams {
  cameraName?: string;
  priority?: number;
  fov?: number;
  position?: Vector3;
}

export class CreateVirtualCamera3DOperation extends CreateNodeOperationBase<CreateVirtualCamera3DOperationParams> {
  protected getMetadataId(): string {
    return 'scene.create-virtual-camera3d';
  }

  protected getMetadataTitle(): string {
    return 'Create Virtual Camera';
  }

  protected getMetadataDescription(): string {
    return 'Create a virtual camera (Cinemachine-lite) in the scene';
  }

  protected getMetadataTags(): string[] {
    return ['scene', '3d', 'camera', 'virtual', 'cinemachine', 'node'];
  }

  protected getNodeTypeName(): string {
    return 'VirtualCamera3D';
  }

  protected createNode(params: CreateVirtualCamera3DOperationParams, nodeId: string) {
    const node = new VirtualCamera3D({
      id: nodeId,
      name: params.cameraName || 'VirtualCamera3D',
      priority: params.priority,
      fov: params.fov,
      position: params.position,
    });
    return node as SceneGraph['rootNodes'][0];
  }
}
