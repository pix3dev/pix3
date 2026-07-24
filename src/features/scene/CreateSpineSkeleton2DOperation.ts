import { CreateNodeOperationBase } from '@/core/CreateNodeOperationBase';
import type { OperationContext } from '@/core/Operation';
import { resolve2DParentForCreation } from '@/features/scene/node-placement';
import { SpineSkeleton2D, type SceneGraph } from '@pix3/runtime';
import { Vector2 } from 'three';

export interface CreateSpineSkeleton2DOperationParams {
  nodeName?: string;
  position?: Vector2;
  parentNodeId?: string | null;
  insertIndex?: number;
  skeletonPath?: string | null;
  atlasPath?: string | null;
  animation?: string;
}

export class CreateSpineSkeleton2DOperation extends CreateNodeOperationBase<CreateSpineSkeleton2DOperationParams> {
  protected getMetadataId(): string {
    return 'scene.create-spineskeleton2d';
  }

  protected getMetadataTitle(): string {
    return 'Create SpineSkeleton2D';
  }

  protected getMetadataDescription(): string {
    return 'Create a Spine skeleton in the scene';
  }

  protected getMetadataTags(): string[] {
    return ['scene', '2d', 'spine', 'skeleton', 'animation', 'node'];
  }

  protected getNodeTypeName(): string {
    return 'SpineSkeleton2D';
  }

  protected resolveParentNode(
    sceneGraph: SceneGraph,
    _context: OperationContext,
    params: CreateSpineSkeleton2DOperationParams
  ): SceneGraph['rootNodes'][0] | null {
    return resolve2DParentForCreation(sceneGraph, params.parentNodeId ?? null, null) as
      | SceneGraph['rootNodes'][0]
      | null;
  }

  protected createNode(params: CreateSpineSkeleton2DOperationParams, nodeId: string) {
    const node = new SpineSkeleton2D({
      id: nodeId,
      name: params.nodeName || 'SpineSkeleton2D',
      position: params.position || new Vector2(0, 0),
      skeletonPath: params.skeletonPath ?? null,
      atlasPath: params.atlasPath ?? null,
      animation: params.animation,
    });
    return node as SceneGraph['rootNodes'][0];
  }
}
