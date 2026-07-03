import type { SceneGraph } from '@pix3/runtime';
import { NodeBase, SceneManager } from '@pix3/runtime';
import { SceneStateUpdater } from './SceneStateUpdater';
import {
  insertNodeAtIndex,
  removeNodeFromSceneGraph,
  resolvePlacementParent,
  type IndexedNodePlacement,
} from '@/features/scene/node-placement';
import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';

const isIndexedNodePlacement = (params: unknown): params is IndexedNodePlacement => {
  return typeof params === 'object' && params !== null;
};

export abstract class CreateNodeOperationBase<TParams> implements Operation<OperationInvokeResult> {
  protected abstract getMetadataId(): string;
  protected abstract getMetadataTitle(): string;
  protected abstract getMetadataDescription(): string;
  protected abstract getMetadataTags(): string[];
  protected abstract getNodeTypeName(): string;
  protected abstract createNode(
    params: TParams,
    nodeId: string,
    context: OperationContext
  ): SceneGraph['rootNodes'][0] | Promise<SceneGraph['rootNodes'][0]>;

  constructor(protected readonly params: TParams = {} as TParams) {}

  get metadata(): OperationMetadata {
    return {
      id: this.getMetadataId(),
      title: this.getMetadataTitle(),
      description: this.getMetadataDescription(),
      tags: this.getMetadataTags(),
      affectsNodeStructure: true,
    };
  }

  protected getNodeIdPrefix(): string {
    return this.getNodeTypeName()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-');
  }

  protected generateNodeId(): string {
    const prefix = this.getNodeIdPrefix();
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  protected getNodeName(): string {
    return this.getNodeTypeName();
  }

  protected getPlacementParams(params: TParams = this.params): IndexedNodePlacement {
    return isIndexedNodePlacement(params) ? params : {};
  }

  protected resolveParentNode(
    sceneGraph: SceneGraph,
    _context: OperationContext,
    params: TParams
  ): SceneGraph['rootNodes'][0] | null {
    const placement = this.getPlacementParams(params);
    return resolvePlacementParent(sceneGraph, placement.parentNodeId ?? null) as
      | SceneGraph['rootNodes'][0]
      | null;
  }

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state, container } = context;
    const sceneId = state.scenes.activeSceneId;

    if (!sceneId) {
      return { didMutate: false };
    }

    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );

    if (!sceneManager) {
      return { didMutate: false };
    }

    const sceneGraph = sceneManager.getSceneGraph(sceneId);
    if (!sceneGraph) {
      return { didMutate: false };
    }

    const nodeId = this.generateNodeId();
    const node = await this.createNode(this.params, nodeId, context);
    const placement = this.getPlacementParams();
    const parentNode = this.resolveParentNode(sceneGraph, context, this.params);
    const parentNodeId = parentNode?.nodeId ?? null;
    const insertIndex = insertNodeAtIndex(sceneGraph, node, parentNode, placement.insertIndex);
    const createdNodeId = node.nodeId;

    // Register the ENTIRE created subtree, not just the root. A prefab instance
    // (CreatePrefabInstanceOperation) returns a root with cloned children; if we
    // only index the root, every subsequent lookup of a child via
    // sceneGraph.nodeMap (inspector edits, gizmos, reparent, alignment) silently
    // no-ops until a reload rebuilds the map.
    this.registerSubtree(sceneManager, sceneGraph, node, sceneId);

    SceneStateUpdater.updateHierarchyState(state, sceneId, sceneGraph);
    SceneStateUpdater.markSceneDirty(state, sceneId);
    SceneStateUpdater.selectNode(state, createdNodeId);

    const nodeName = this.getNodeName();
    const resolveCommittedParent = () => resolvePlacementParent(sceneGraph, parentNodeId);

    return {
      didMutate: true,
      commit: {
        label: `Create ${nodeName}`,
        undo: () => {
          this.unregisterSubtree(sceneManager, sceneGraph, node, sceneId);
          removeNodeFromSceneGraph(sceneGraph, node);

          SceneStateUpdater.updateHierarchyState(state, sceneId, sceneGraph);
          SceneStateUpdater.markSceneDirty(state, sceneId);
          SceneStateUpdater.clearSelectionIfTargeted(state, createdNodeId);
        },
        redo: () => {
          insertNodeAtIndex(sceneGraph, node, resolveCommittedParent(), insertIndex);
          this.registerSubtree(sceneManager, sceneGraph, node, sceneId);
          SceneStateUpdater.updateHierarchyState(state, sceneId, sceneGraph);
          SceneStateUpdater.markSceneDirty(state, sceneId);
          SceneStateUpdater.selectNode(state, createdNodeId);
        },
      },
    };
  }

  private forEachInSubtree(
    root: SceneGraph['rootNodes'][0],
    visit: (node: SceneGraph['rootNodes'][0]) => void
  ): void {
    const stack: SceneGraph['rootNodes'][0][] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      visit(current);
      for (const child of current.children) {
        if (child instanceof NodeBase) {
          stack.push(child);
        }
      }
    }
  }

  private registerSubtree(
    sceneManager: SceneManager,
    sceneGraph: SceneGraph,
    root: SceneGraph['rootNodes'][0],
    sceneId: string
  ): void {
    this.forEachInSubtree(root, node => {
      sceneGraph.nodeMap.set(node.nodeId, node);
      for (const group of node.groups) {
        sceneManager.addNodeToGroup(node, group, sceneId);
      }
    });
  }

  private unregisterSubtree(
    sceneManager: SceneManager,
    sceneGraph: SceneGraph,
    root: SceneGraph['rootNodes'][0],
    sceneId: string
  ): void {
    this.forEachInSubtree(root, node => {
      for (const group of node.groups) {
        sceneManager.removeNodeFromGroup(node, group, sceneId);
      }
      sceneGraph.nodeMap.delete(node.nodeId);
    });
  }
}
