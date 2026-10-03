import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { SceneManager } from '@pix3/runtime';
import { canDropNode } from '@/fw/hierarchy-validation';
import { ref } from 'valtio/vanilla';
import type { NodeBase } from '@pix3/runtime';
import { Quaternion, Vector3 } from 'three';

export interface ReparentNodeOperationParams {
  /** ID of the node to move */
  nodeId: string;
  /** ID of the new parent node (or null for root) */
  newParentId: string | null;
  /** Index within the new parent's children (or -1 to append) */
  newIndex?: number;
}

export class ReparentNodeOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.reparent-node',
    title: 'Reparent Node',
    description: 'Move a node to a new parent or change its order',
    tags: ['scene', 'hierarchy', 'node', 'structure'],
    affectsNodeStructure: true,
  };

  private readonly params: ReparentNodeOperationParams;
  private previousParentId: string | null = null;
  private previousIndex: number = -1;

  constructor(params: ReparentNodeOperationParams) {
    this.params = params;
  }

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state, container } = context;
    const activeSceneId = state.scenes.activeSceneId;

    if (!activeSceneId) {
      console.log('[ReparentNodeOperation] No active scene');
      return { didMutate: false };
    }

    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const sceneGraph = sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      console.log('[ReparentNodeOperation] No scene graph');
      return { didMutate: false };
    }

    // Validate using the helper function
    if (!canDropNode(this.params.nodeId, this.params.newParentId, sceneGraph, 'inside')) {
      const draggedNode = sceneGraph.nodeMap.get(this.params.nodeId);
      const targetNode = this.params.newParentId
        ? sceneGraph.nodeMap.get(this.params.newParentId)
        : null;

      console.log('[ReparentNodeOperation] Invalid drop operation:', {
        draggedNode: draggedNode?.name,
        draggedType: draggedNode?.type,
        targetNode: targetNode?.name,
        targetType: targetNode?.type,
      });
      return { didMutate: false };
    }

    // Find the node to move
    const nodeToMove = sceneGraph.nodeMap.get(this.params.nodeId);
    if (!nodeToMove) {
      console.log('[ReparentNodeOperation] Node to move not found:', this.params.nodeId);
      return { didMutate: false };
    }

    // Prevent moving a node to itself or its descendants
    if (this.params.newParentId === this.params.nodeId) {
      console.log('[ReparentNodeOperation] Cannot move node to itself');
      return { didMutate: false };
    }

    // Validate new parent exists if provided and check if it's a descendant
    if (this.params.newParentId) {
      const newParent = sceneGraph.nodeMap.get(this.params.newParentId);
      if (!newParent) {
        console.log('[ReparentNodeOperation] New parent not found:', this.params.newParentId);
        return { didMutate: false };
      }

      // Prevent moving a node into its own descendants (circular reference)
      if (this.isDescendantOf(newParent, this.params.nodeId)) {
        console.log(
          '[ReparentNodeOperation] Cannot move to descendant - would create circular reference'
        );
        return { didMutate: false };
      }
    }

    // Store the previous state for undo
    const previousParent = nodeToMove.parentNode;
    if (previousParent) {
      this.previousParentId = previousParent.nodeId;
      this.previousIndex = previousParent.children.indexOf(nodeToMove);
    } else {
      this.previousParentId = null;
      this.previousIndex = sceneGraph.rootNodes.indexOf(nodeToMove);
    }

    const newIndex = this.params.newIndex ?? -1;
    const newParent = this.params.newParentId
      ? (sceneGraph.nodeMap.get(this.params.newParentId) ?? null)
      : null;
    if (this.params.newParentId && !newParent) {
      return { didMutate: false };
    }

    this.reparentNode(sceneGraph.rootNodes, nodeToMove, newParent, newIndex);

    // Update the state hierarchy - REPLACE the entire object to trigger reactivity
    const hierarchy = state.scenes.hierarchies[activeSceneId];
    if (hierarchy) {
      state.scenes.hierarchies[activeSceneId] = {
        version: hierarchy.version,
        description: hierarchy.description,
        rootNodes: ref([...sceneGraph.rootNodes]),
        metadata: hierarchy.metadata,
      };
    }

    // Mark scene as dirty
    const descriptor = state.scenes.descriptors[activeSceneId];
    if (descriptor) {
      descriptor.isDirty = true;
    }

    return {
      didMutate: true,
      commit: {
        label: `Move ${nodeToMove.name} to ${this.params.newParentId ? 'new parent' : 'root'}`,
        undo: () => this.undoReparent(context),
        redo: () => this.redoReparent(context),
      },
    };
  }

  private async undoReparent(context: OperationContext): Promise<void> {
    const { state, container } = context;
    const activeSceneId = state.scenes.activeSceneId;

    if (!activeSceneId) {
      return;
    }

    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const sceneGraph = sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      return;
    }

    const nodeToMove = sceneGraph.nodeMap.get(this.params.nodeId);
    if (!nodeToMove) {
      return;
    }

    const previousParent = this.previousParentId
      ? (sceneGraph.nodeMap.get(this.previousParentId) ?? null)
      : null;
    this.reparentNode(sceneGraph.rootNodes, nodeToMove, previousParent, this.previousIndex);

    // Update hierarchy state
    const hierarchy = state.scenes.hierarchies[activeSceneId];
    if (hierarchy) {
      state.scenes.hierarchies[activeSceneId] = {
        version: hierarchy.version,
        description: hierarchy.description,
        rootNodes: ref([...sceneGraph.rootNodes]),
        metadata: hierarchy.metadata,
      };
    }

    // Autosave may have cleared the flag since the original move.
    const descriptor = state.scenes.descriptors[activeSceneId];
    if (descriptor) {
      descriptor.isDirty = true;
    }
  }

  private async redoReparent(context: OperationContext): Promise<void> {
    // Re-run the perform logic
    await this.perform(context);
  }

  private isDescendantOf(node: NodeBase, ancestorId: string): boolean {
    let current = node.parentNode;
    while (current) {
      if (current.nodeId === ancestorId) {
        return true;
      }
      current = current.parentNode;
    }
    return false;
  }

  private reparentNode(
    rootNodes: NodeBase[],
    nodeToMove: NodeBase,
    newParent: NodeBase | null,
    newIndex: number
  ): void {
    nodeToMove.updateWorldMatrix(true, false);
    const worldPosition = new Vector3();
    const worldQuaternion = new Quaternion();
    const worldScale = new Vector3();
    nodeToMove.getWorldPosition(worldPosition);
    nodeToMove.getWorldQuaternion(worldQuaternion);
    nodeToMove.getWorldScale(worldScale);

    const rootIndex = rootNodes.indexOf(nodeToMove);
    if (rootIndex !== -1) {
      rootNodes.splice(rootIndex, 1);
    }

    if (newParent) {
      newParent.attach(nodeToMove);
      if (newIndex >= 0 && newIndex < newParent.children.length - 1) {
        newParent.children.splice(newIndex, 0, newParent.children.pop()!);
      }
      return;
    }

    if (nodeToMove.parentNode) {
      nodeToMove.removeFromParent();
    }

    nodeToMove.position.copy(worldPosition);
    nodeToMove.quaternion.copy(worldQuaternion);
    nodeToMove.scale.copy(worldScale);

    if (newIndex >= 0 && newIndex <= rootNodes.length) {
      rootNodes.splice(newIndex, 0, nodeToMove);
    } else {
      rootNodes.push(nodeToMove);
    }
  }
}
