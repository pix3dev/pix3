import { CreateNodeOperationBase } from '@/core/CreateNodeOperationBase';
import type { OperationContext } from '@/core/Operation';
import {
  Node2D,
  Node3D,
  SceneManager,
  type NodeBase,
  type SceneNodeDefinition,
} from '@pix3/runtime';
import { Box3, Vector3 } from 'three';
import { ViewportRendererService } from '@/services/ViewportRenderService';
import { stringify } from 'yaml';

export interface CreatePrefabInstanceOperationParams {
  prefabPath: string;
  nodeName?: string;
  parentNodeId?: string | null;
  properties?: Record<string, unknown>;
  insertIndex?: number;
  /** Viewport pixel coordinates of a drop, used to position a root-level drop. */
  viewportScreenPoint?: { x: number; y: number } | null;
}

export class CreatePrefabInstanceOperation extends CreateNodeOperationBase<CreatePrefabInstanceOperationParams> {
  protected getMetadataId(): string {
    return 'scene.create-prefab-instance';
  }
  protected getMetadataTitle(): string {
    return 'Create Prefab Instance';
  }
  protected getMetadataDescription(): string {
    return 'Create an instance of a prefab in the scene';
  }
  protected getMetadataTags(): string[] {
    return ['scene', 'prefab', 'instance', 'node'];
  }
  protected getNodeTypeName(): string {
    return 'PrefabInstance'; // or just empty, it's not used directly
  }

  protected async createNode(
    params: CreatePrefabInstanceOperationParams,
    nodeId: string,
    context: OperationContext
  ) {
    const { state, container } = context;
    const activeSceneId = state.scenes.activeSceneId!;
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );

    const prefabPath = this.normalizePrefabPath(params.prefabPath);
    if (!prefabPath.startsWith('res://')) {
      throw new Error('Invalid prefab path');
    }

    const definition: SceneNodeDefinition = {
      id: nodeId,
      instance: prefabPath,
      name: params.nodeName,
      properties: params.properties,
    };

    const tempDocument = {
      version: '1.0.0', // assuming this is ok since sceneGraph was accessed via state
      root: [definition],
    };

    const parsed = await sceneManager.parseScene(stringify(tempDocument), {
      filePath: state.scenes.descriptors[activeSceneId]?.filePath,
    });
    const rootNode = parsed.rootNodes[0];
    if (!rootNode) {
      throw new Error('Failed to parse prefab instance');
    }

    // Position a viewport drop at the drop point. Only applies to root-level
    // drops (no parent), where local space equals world space.
    if (params.viewportScreenPoint && params.parentNodeId == null) {
      this.applyDropPosition(rootNode, params.viewportScreenPoint, context);
    }

    return rootNode;
  }

  private applyDropPosition(
    node: NodeBase,
    screenPoint: { x: number; y: number },
    context: OperationContext
  ): void {
    const viewportRenderer = context.container.getService<ViewportRendererService>(
      context.container.getOrCreateToken(ViewportRendererService)
    );

    if (node instanceof Node2D) {
      const point = viewportRenderer.resolve2DAssetDropPosition(screenPoint.x, screenPoint.y);
      if (point) {
        node.position.set(point.x, point.y, node.position.z);
      }
      return;
    }

    if (node instanceof Node3D) {
      const size = new Box3().setFromObject(node).getSize(new Vector3());
      const point = viewportRenderer.resolve3DAssetDropPosition(screenPoint.x, screenPoint.y, size);
      if (point) {
        node.position.copy(point);
      }
    }
  }

  private normalizePrefabPath(path: string): string {
    return path.replace(/\\/g, '/');
  }
}
