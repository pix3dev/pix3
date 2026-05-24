import { CreateNodeOperationBase } from '@/core/CreateNodeOperationBase';
import type { OperationContext } from '@/core/Operation';
import { resolve2DParentForCreation } from '@/features/scene/node-placement';
import { AnimatedSprite2D, type SceneGraph } from '@pix3/runtime';
import { Vector2 } from 'three';

export interface CreateAnimatedSprite2DOperationParams {
  nodeName?: string;
  position?: Vector2;
  parentNodeId?: string | null;
  insertIndex?: number;
  animationResourcePath?: string | null;
  currentClip?: string;
}

export class CreateAnimatedSprite2DOperation extends CreateNodeOperationBase<CreateAnimatedSprite2DOperationParams> {
  protected getMetadataId(): string {
    return 'scene.create-animatedsprite2d';
  }

  protected getMetadataTitle(): string {
    return 'Create AnimatedSprite2D';
  }

  protected getMetadataDescription(): string {
    return 'Create a 2D animated sprite in the scene';
  }

  protected getMetadataTags(): string[] {
    return ['scene', '2d', 'animated', 'sprite', 'node', 'ui'];
  }

  protected getNodeTypeName(): string {
    return 'AnimatedSprite2D';
  }

  protected resolveParentNode(
    sceneGraph: SceneGraph,
    _context: OperationContext,
    params: CreateAnimatedSprite2DOperationParams
  ): SceneGraph['rootNodes'][0] | null {
    return resolve2DParentForCreation(sceneGraph, params.parentNodeId ?? null, null) as
      | SceneGraph['rootNodes'][0]
      | null;
  }

  protected createNode(params: CreateAnimatedSprite2DOperationParams, nodeId: string) {
    const nodeName = params.nodeName || 'AnimatedSprite2D';
    const node = new AnimatedSprite2D({
      id: nodeId,
      name: nodeName,
      position: params.position || new Vector2(100, 100),
      animationResourcePath: params.animationResourcePath ?? null,
      currentClip: params.currentClip,
      width: 64,
      height: 64,
    });
    return node as SceneGraph['rootNodes'][0];
  }
}
