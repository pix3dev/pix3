import { CreateNodeOperationBase } from '@/core/CreateNodeOperationBase';
import { Camera2D, type SceneGraph } from '@pix3/runtime';
import { Vector2 } from 'three';

export interface CreateCamera2DOperationParams {
  cameraName?: string;
  priority?: number;
  zoom?: number;
  position?: Vector2;
  parentNodeId?: string | null;
}

export class CreateCamera2DOperation extends CreateNodeOperationBase<CreateCamera2DOperationParams> {
  protected getMetadataId(): string {
    return 'scene.create-camera2d';
  }

  protected getMetadataTitle(): string {
    return 'Create Camera2D';
  }

  protected getMetadataDescription(): string {
    return 'Create a 2D game camera (pan / zoom / limits / shake) in the scene';
  }

  protected getMetadataTags(): string[] {
    return ['scene', '2d', 'camera', 'follow', 'zoom', 'node'];
  }

  protected getNodeTypeName(): string {
    return 'Camera2D';
  }

  protected createNode(params: CreateCamera2DOperationParams, nodeId: string) {
    const node = new Camera2D({
      id: nodeId,
      name: params.cameraName || 'Camera2D',
      priority: params.priority,
      zoom: params.zoom,
      position: params.position,
    });
    return node as SceneGraph['rootNodes'][0];
  }
}
