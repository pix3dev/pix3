import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { SceneManager } from '@pix3/runtime';
import { ref } from 'valtio/vanilla';
import { NodeBase } from '@pix3/runtime';
import { isPrefabChildNode } from '@/features/scene/prefab-utils';

export interface DeletedNodeInfo {
  node: NodeBase;
  parentId: string | null;
  index: number;
  children: DeletedNodeInfo[];
}

export interface DeleteObjectOperationParams {
  /** IDs of the nodes to delete */
  nodeIds: string[];
}

export class DeleteObjectOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.delete-object',
    title: 'Delete Object',
    description: 'Delete one or more nodes from the scene',
    tags: ['scene', 'node', 'delete', 'remove'],
    affectsNodeStructure: true,
  };

  private readonly params: DeleteObjectOperationParams;
  private deletedNodes: DeletedNodeInfo[] = [];

  constructor(params: DeleteObjectOperationParams) {
    this.params = params;
  }

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state, container } = context;
    const activeSceneId = state.scenes.activeSceneId;

    if (!activeSceneId) {
      console.log('[DeleteObjectOperation] No active scene');
      return { didMutate: false };
    }

    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const sceneGraph = sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      console.log('[DeleteObjectOperation] No scene graph');
      return { didMutate: false };
    }

    const nodesToDelete = new Set<string>(this.params.nodeIds);
    const deletedNodes: DeletedNodeInfo[] = [];

    for (const nodeId of nodesToDelete) {
      const node = sceneGraph.nodeMap.get(nodeId);
      if (!node) {
        console.log('[DeleteObjectOperation] Node not found:', nodeId);
        continue;
      }

      if (isPrefabChildNode(node)) {
        console.warn(
          `[DeleteObjectOperation] Skip delete for prefab child node "${node.nodeId}" (instance-locked).`
        );
        continue;
      }

      const deletedInfo = this.deleteNodeAndChildren(sceneGraph, node);
      if (deletedInfo) {
        deletedNodes.push(deletedInfo);
      }
    }

    if (deletedNodes.length === 0) {
      return { didMutate: false };
    }

    this.deletedNodes = deletedNodes;

    const nodeNames = deletedNodes.map(info => info.node.name).join(', ');

    const hierarchy = state.scenes.hierarchies[activeSceneId];
    if (hierarchy) {
      state.scenes.hierarchies[activeSceneId] = {
        version: hierarchy.version,
        description: hierarchy.description,
        rootNodes: ref([...sceneGraph.rootNodes]),
        metadata: hierarchy.metadata,
      };
    }

    const descriptor = state.scenes.descriptors[activeSceneId];
    if (descriptor) {
      descriptor.isDirty = true;
    }

    const deletedNodeIds = new Set<string>();
    const collectDeletedIds = (info: DeletedNodeInfo) => {
      deletedNodeIds.add(info.node.nodeId);
      for (const childInfo of info.children) {
        collectDeletedIds(childInfo);
      }
    };
    for (const deletedInfo of deletedNodes) {
      collectDeletedIds(deletedInfo);
    }

    state.selection.nodeIds = state.selection.nodeIds.filter(id => !deletedNodeIds.has(id));
    if (state.selection.primaryNodeId && deletedNodeIds.has(state.selection.primaryNodeId)) {
      state.selection.primaryNodeId = null;
    }

    return {
      didMutate: true,
      commit: {
        label: `Delete ${deletedNodes.length} object${deletedNodes.length > 1 ? 's' : ''}: ${nodeNames}`,
        undo: () => this.undoDelete(context),
        redo: () => this.redoDelete(context),
      },
    };
  }

  private deleteNodeAndChildren(
    sceneGraph: SceneManager['sceneGraphs'] extends Map<string, infer T> ? T : never,
    node: NodeBase
  ): DeletedNodeInfo | null {
    const parent = node.parentNode;
    const parentId = parent ? parent.nodeId : null;
    const index = parent ? parent.children.indexOf(node) : sceneGraph.rootNodes.indexOf(node);

    const childrenInfo: DeletedNodeInfo[] = [];
    // Each recursive removal mutates node.children, so traverse a stable copy.
    for (const child of [...node.children]) {
      if (child instanceof NodeBase) {
        const childInfo = this.deleteNodeAndChildren(sceneGraph, child);
        if (childInfo) {
          childrenInfo.push(childInfo);
        }
      }
    }

    if (parent) {
      node.removeFromParent();
    } else {
      const rootIndex = sceneGraph.rootNodes.indexOf(node);
      if (rootIndex !== -1) {
        sceneGraph.rootNodes.splice(rootIndex, 1);
      }
    }

    sceneGraph.nodeMap.delete(node.nodeId);

    return {
      node,
      parentId,
      index,
      children: childrenInfo,
    };
  }

  private async undoDelete(context: OperationContext): Promise<void> {
    const { state, container } = context;
    const activeSceneId = state.scenes.activeSceneId;

    if (!activeSceneId || this.deletedNodes.length === 0) {
      return;
    }

    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const sceneGraph = sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      return;
    }

    // Indices were recorded at removal time; undo removals in the opposite order.
    for (const deletedInfo of [...this.deletedNodes].reverse()) {
      this.restoreNodeAndChildren(sceneGraph, deletedInfo);
    }

    const hierarchy = state.scenes.hierarchies[activeSceneId];
    if (hierarchy) {
      state.scenes.hierarchies[activeSceneId] = {
        version: hierarchy.version,
        description: hierarchy.description,
        rootNodes: ref([...sceneGraph.rootNodes]),
        metadata: hierarchy.metadata,
      };
    }

    const descriptor = state.scenes.descriptors[activeSceneId];
    if (descriptor) {
      descriptor.isDirty = true;
    }
  }

  private restoreNodeAndChildren(
    sceneGraph: SceneManager['sceneGraphs'] extends Map<string, infer T> ? T : never,
    info: DeletedNodeInfo
  ): void {
    sceneGraph.nodeMap.set(info.node.nodeId, info.node);

    for (const childInfo of [...info.children].reverse()) {
      this.restoreNodeAndChildren(sceneGraph, childInfo);
    }

    if (info.parentId) {
      const parent = sceneGraph.nodeMap.get(info.parentId);
      if (parent) {
        parent.add(info.node);
        if (info.index >= 0 && info.index < parent.children.length - 1) {
          parent.children.splice(info.index, 0, parent.children.pop()!);
        }
      }
    } else {
      if (info.index >= 0 && info.index < sceneGraph.rootNodes.length) {
        sceneGraph.rootNodes.splice(info.index, 0, info.node);
      } else {
        sceneGraph.rootNodes.push(info.node);
      }
    }
  }

  private async redoDelete(context: OperationContext): Promise<void> {
    await this.perform(context);
  }
}
