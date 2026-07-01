import { CreateNodeOperationBase } from '@/core/CreateNodeOperationBase';
import { ScrollContainer2D, type SceneGraph } from '@pix3/runtime';
import { Vector2 } from 'three';

export interface CreateScrollContainer2DOperationParams {
  containerName?: string;
  width?: number;
  height?: number;
  position?: Vector2;
  parentNodeId?: string | null;
}

export class CreateScrollContainer2DOperation extends CreateNodeOperationBase<CreateScrollContainer2DOperationParams> {
  protected getMetadataId(): string {
    return 'scene.create-scrollcontainer2d';
  }

  protected getMetadataTitle(): string {
    return 'Create ScrollContainer2D';
  }

  protected getMetadataDescription(): string {
    return 'Create a 2D scroll container in the scene';
  }

  protected getMetadataTags(): string[] {
    return ['scene', '2d', 'scroll', 'container', 'ui', 'node'];
  }

  protected getNodeTypeName(): string {
    return 'ScrollContainer2D';
  }

  protected createNode(params: CreateScrollContainer2DOperationParams, nodeId: string) {
    const containerName = params.containerName || 'ScrollContainer2D';
    const width = params.width ?? 180;
    const height = params.height ?? 220;
    const node = new ScrollContainer2D({
      id: nodeId,
      name: containerName,
      width,
      height,
      position: params.position,
    });
    return node as SceneGraph['rootNodes'][0];
  }
}
