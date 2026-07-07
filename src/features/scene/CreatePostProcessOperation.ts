import { CreateNodeOperationBase } from '@/core/CreateNodeOperationBase';
import { PostProcess, type SceneGraph } from '@pix3/runtime';

export interface CreatePostProcessOperationParams {
  nodeName?: string;
}

export class CreatePostProcessOperation extends CreateNodeOperationBase<CreatePostProcessOperationParams> {
  protected getMetadataId(): string {
    return 'scene.create-post-process';
  }

  protected getMetadataTitle(): string {
    return 'Create Post Process';
  }

  protected getMetadataDescription(): string {
    return 'Create a post-processing environment node (bloom, vignette, chromatic aberration, LUT)';
  }

  protected getMetadataTags(): string[] {
    return ['scene', 'post', 'processing', 'bloom', 'vignette', 'effect', 'environment', 'node'];
  }

  protected getNodeTypeName(): string {
    return 'PostProcess';
  }

  protected createNode(params: CreatePostProcessOperationParams, nodeId: string) {
    const node = new PostProcess({
      id: nodeId,
      name: params.nodeName || 'PostProcess',
    });
    return node as SceneGraph['rootNodes'][0];
  }
}
