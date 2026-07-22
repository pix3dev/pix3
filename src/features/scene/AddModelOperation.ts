import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { AssetLoader, MeshInstance, Node3D, SceneManager } from '@pix3/runtime';
import { Box3, Vector3 } from 'three';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import {
  insertNodeAtIndex,
  removeNodeFromSceneGraph,
  resolveDefault3DParent,
  resolvePlacementParent,
} from '@/features/scene/node-placement';
import { SceneStateUpdater } from '@/core/SceneStateUpdater';

export interface AddModelOperationParams {
  modelPath: string; // res:// path to .glb/.gltf file
  modelName?: string;
  parentNodeId?: string | null;
  insertIndex?: number;
  position?: Vector3;
  viewportScreenPoint?: { x: number; y: number } | null;
}

export class AddModelOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.add-model',
    title: 'Add Model',
    description: 'Add a model instance to the scene',
    tags: ['scene', 'model', 'node'],
    affectsNodeStructure: true,
  };

  private readonly params: AddModelOperationParams;

  constructor(params: AddModelOperationParams) {
    this.params = params;
  }

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state, container } = context;
    const activeSceneId = state.scenes.activeSceneId;

    if (!activeSceneId) {
      return { didMutate: false };
    }

    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const sceneGraph = sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      return { didMutate: false };
    }

    // Generate a unique node ID
    const nodeId = `model-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    // Load the model using AssetLoader to get the actual geometry
    const assetLoader = container.getService<AssetLoader>(container.getOrCreateToken(AssetLoader));

    const modelName = this.params.modelName || this.deriveModelName(this.params.modelPath);

    let node: MeshInstance;
    try {
      const result = await assetLoader.loadAsset(this.params.modelPath, nodeId, modelName);
      node = result.node as MeshInstance;
    } catch (error) {
      console.error('[AddModelOperation] Failed to load model:', error);
      return { didMutate: false };
    }

    const hasExplicitHierarchyPlacement =
      this.params.parentNodeId !== undefined || typeof this.params.insertIndex === 'number';
    const explicitParent = resolvePlacementParent(sceneGraph, this.params.parentNodeId ?? null);
    const defaultParent = resolveDefault3DParent(sceneGraph);
    const targetParent =
      explicitParent instanceof Node3D
        ? explicitParent
        : hasExplicitHierarchyPlacement
          ? null
          : defaultParent instanceof Node3D
            ? defaultParent
            : null;
    const parentNodeId = targetParent?.nodeId ?? null;

    const dropPosition = this.resolveDropPosition(context, node);
    if (dropPosition) {
      this.applyWorldPosition(node, targetParent, dropPosition);
    }

    const insertIndex = insertNodeAtIndex(sceneGraph, node, targetParent, this.params.insertIndex);
    sceneGraph.nodeMap.set(node.nodeId, node);

    SceneStateUpdater.updateHierarchyState(state, activeSceneId, sceneGraph);
    SceneStateUpdater.markSceneDirty(state, activeSceneId);
    SceneStateUpdater.selectNode(state, node.nodeId);
    state.scenes.lastLoadedAt = Date.now();

    const resolveCommittedParent = () => {
      const parent = resolvePlacementParent(sceneGraph, parentNodeId);
      return parent instanceof Node3D ? parent : null;
    };

    return {
      didMutate: true,
      commit: {
        label: `Add model: ${modelName}`,
        undo: () => {
          removeNodeFromSceneGraph(sceneGraph, node);
          sceneGraph.nodeMap.delete(node.nodeId);
          SceneStateUpdater.updateHierarchyState(state, activeSceneId, sceneGraph);
          SceneStateUpdater.markSceneDirty(state, activeSceneId);
          SceneStateUpdater.clearSelectionIfTargeted(state, node.nodeId);
          state.scenes.lastLoadedAt = Date.now();
        },
        redo: () => {
          insertNodeAtIndex(sceneGraph, node, resolveCommittedParent(), insertIndex);
          sceneGraph.nodeMap.set(node.nodeId, node);
          SceneStateUpdater.updateHierarchyState(state, activeSceneId, sceneGraph);
          SceneStateUpdater.markSceneDirty(state, activeSceneId);
          SceneStateUpdater.selectNode(state, node.nodeId);
          state.scenes.lastLoadedAt = Date.now();
        },
      },
    };
  }

  private deriveModelName(modelPath: string): string {
    // Extract filename from path, e.g., "res://models/cube.glb" -> "cube"
    const match = modelPath.match(/\/([^/]+)\.(glb|gltf)$/i);
    return match ? match[1] : 'Model';
  }

  private resolveDropPosition(context: OperationContext, node: MeshInstance): Vector3 | null {
    if (this.params.position) {
      return this.params.position.clone();
    }

    const screenPoint = this.params.viewportScreenPoint;
    if (!screenPoint) {
      return null;
    }

    const viewportRenderer = context.container.getService<ViewportRendererService>(
      context.container.getOrCreateToken(ViewportRendererService)
    );
    const modelBounds = new Box3().setFromObject(node);
    const modelSize = modelBounds.getSize(new Vector3());

    return viewportRenderer.resolve3DAssetDropPosition(screenPoint.x, screenPoint.y, modelSize);
  }

  private applyWorldPosition(
    node: MeshInstance,
    parentNode: Node3D | null,
    worldPosition: Vector3
  ): void {
    if (parentNode) {
      node.position.copy(parentNode.worldToLocal(worldPosition.clone()));
      return;
    }

    node.position.copy(worldPosition);
  }
}
