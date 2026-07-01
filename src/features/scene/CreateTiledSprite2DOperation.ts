import { CreateNodeOperationBase } from '@/core/CreateNodeOperationBase';
import type { OperationContext } from '@/core/Operation';
import { resolve2DParentForCreation } from '@/features/scene/node-placement';
import { TiledSprite2D, type SceneGraph } from '@pix3/runtime';
import { Vector2 } from 'three';

export interface CreateTiledSprite2DOperationParams {
  nodeName?: string;
  width?: number;
  height?: number;
  position?: Vector2;
  texturePath?: string | null;
  parentNodeId?: string | null;
  insertIndex?: number;
}

export class CreateTiledSprite2DOperation extends CreateNodeOperationBase<CreateTiledSprite2DOperationParams> {
  protected getMetadataId(): string {
    return 'scene.create-tiledsprite2d';
  }
  protected getMetadataTitle(): string {
    return 'Create TiledSprite2D';
  }
  protected getMetadataDescription(): string {
    return 'Create a tiling / 9-slice 2D sprite in the scene';
  }
  protected getMetadataTags(): string[] {
    return ['scene', '2d', 'sprite', 'tile', 'nine-slice', 'panel', 'node', 'ui'];
  }
  protected getNodeTypeName(): string {
    return 'TiledSprite2D';
  }

  protected resolveParentNode(
    sceneGraph: SceneGraph,
    _context: OperationContext,
    params: CreateTiledSprite2DOperationParams
  ): SceneGraph['rootNodes'][0] | null {
    return resolve2DParentForCreation(sceneGraph, params.parentNodeId ?? null, null) as
      | SceneGraph['rootNodes'][0]
      | null;
  }

  protected createNode(params: CreateTiledSprite2DOperationParams, nodeId: string) {
    const nodeName = params.nodeName || 'TiledSprite2D';
    const node = new TiledSprite2D({
      id: nodeId,
      name: nodeName,
      position: params.position || new Vector2(100, 100),
      texturePath: params.texturePath ?? 'https://placehold.co/96x96.png',
      width: params.width ?? 128,
      height: params.height ?? 128,
    });
    return node as SceneGraph['rootNodes'][0];
  }
}
