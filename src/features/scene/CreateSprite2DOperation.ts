import { CreateNodeOperationBase } from '@/core/CreateNodeOperationBase';
import type { OperationContext } from '@/core/Operation';
import { resolve2DParentForCreation } from '@/features/scene/node-placement';
import { AssetLoader, Sprite2D, type SceneGraph } from '@pix3/runtime';
import { Vector2 } from 'three';

export interface CreateSprite2DOperationParams {
  spriteName?: string;
  width?: number;
  height?: number;
  position?: Vector2;
  texturePath?: string | null;
  parentNodeId?: string | null;
  insertIndex?: number;
}

export class CreateSprite2DOperation extends CreateNodeOperationBase<CreateSprite2DOperationParams> {
  protected getMetadataId(): string {
    return 'scene.create-sprite2d';
  }
  protected getMetadataTitle(): string {
    return 'Create Sprite2D';
  }
  protected getMetadataDescription(): string {
    return 'Create a 2D sprite in the scene';
  }
  protected getMetadataTags(): string[] {
    return ['scene', '2d', 'sprite', 'node'];
  }
  protected getNodeTypeName(): string {
    return 'Sprite2D';
  }

  protected resolveParentNode(
    sceneGraph: SceneGraph,
    _context: OperationContext,
    params: CreateSprite2DOperationParams
  ): SceneGraph['rootNodes'][0] | null {
    return resolve2DParentForCreation(sceneGraph, params.parentNodeId ?? null, null) as
      | SceneGraph['rootNodes'][0]
      | null;
  }

  protected async createNode(
    params: CreateSprite2DOperationParams,
    nodeId: string,
    context: OperationContext
  ) {
    const { container } = context;
    const spriteName = params.spriteName || 'Sprite2D';
    const texturePath = params.texturePath ?? 'https://placehold.co/100x100.png';

    const textureSize = await this.resolveTextureSize(container, texturePath);
    const initialWidth = params.width ?? textureSize?.width;
    const initialHeight = params.height ?? textureSize?.height;

    const node = new Sprite2D({
      id: nodeId,
      name: spriteName,
      position: params.position,
      texturePath,
      width: initialWidth,
      height: initialHeight,
    });

    if (textureSize) {
      node.originalWidth = textureSize.width;
      node.originalHeight = textureSize.height;
      node.textureAspectRatio = textureSize.width / textureSize.height;
    }
    return node as SceneGraph['rootNodes'][0];
  }

  private async resolveTextureSize(
    container: OperationContext['container'],
    texturePath: string | null
  ): Promise<{ width: number; height: number } | null> {
    if (!texturePath || !this.isImageResource(texturePath)) {
      return null;
    }

    try {
      const assetLoader = container.getService<AssetLoader>(
        container.getOrCreateToken(AssetLoader)
      );
      const texture = await assetLoader.loadTexture(texturePath);
      const image = texture.image as
        | { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number }
        | undefined;
      const width = image?.naturalWidth ?? image?.width;
      const height = image?.naturalHeight ?? image?.height;
      texture.dispose();

      if (typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0) {
        return { width, height };
      }
    } catch {
      // Keep fallback defaults when loading fails.
    }

    return null;
  }

  private isImageResource(path: string): boolean {
    const normalized = path.toLowerCase().split('?')[0].split('#')[0];
    return /\.(png|jpe?g|gif|webp|bmp|svg|tiff?|avif)$/.test(normalized);
  }
}
