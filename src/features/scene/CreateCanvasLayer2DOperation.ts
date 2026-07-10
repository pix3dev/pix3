import { CreateNodeOperationBase } from '@/core/CreateNodeOperationBase';
import { CanvasLayer2D, type SceneGraph } from '@pix3/runtime';
import { Vector2 } from 'three';

export interface CreateCanvasLayer2DOperationParams {
  layerName?: string;
  width?: number;
  height?: number;
  position?: Vector2;
  parentNodeId?: string | null;
}

export class CreateCanvasLayer2DOperation extends CreateNodeOperationBase<CreateCanvasLayer2DOperationParams> {
  protected getMetadataId(): string {
    return 'scene.create-canvaslayer2d';
  }

  protected getMetadataTitle(): string {
    return 'Create CanvasLayer2D';
  }

  protected getMetadataDescription(): string {
    return 'Create a fixed UI overlay layer (drawn above post-processing) in the scene';
  }

  protected getMetadataTags(): string[] {
    return ['scene', '2d', 'canvas', 'layer', 'overlay', 'hud', 'node', 'container'];
  }

  protected getNodeTypeName(): string {
    return 'CanvasLayer2D';
  }

  protected createNode(params: CreateCanvasLayer2DOperationParams, nodeId: string) {
    const node = new CanvasLayer2D({
      id: nodeId,
      name: params.layerName || 'CanvasLayer2D',
      width: params.width ?? 100,
      height: params.height ?? 100,
      position: params.position,
    });
    return node as SceneGraph['rootNodes'][0];
  }
}
