import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { SceneStateUpdater } from '@/core/SceneStateUpdater';
import { Group2D, Node2D, Node3D, NodeBase, SceneManager } from '@pix3/runtime';
import { Quaternion, Vector3 } from 'three';
import { isPrefabChildNode } from '@/features/scene/prefab-utils';

export interface GroupSelectedNodesOperationParams {
  nodeIds: string[];
}

interface ReparentRecord {
  nodeId: string;
  previousParentId: string | null;
  previousIndex: number;
}

export class GroupSelectedNodesOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.group-selected-nodes',
    title: 'Group Selected Nodes',
    description: 'Group selected nodes under a new container node',
    tags: ['scene', 'group', 'hierarchy'],
    affectsNodeStructure: true,
  };

  private readonly params: GroupSelectedNodesOperationParams;

  private createdGroup: NodeBase | null = null;
  private createdGroupParentId: string | null = null;
  private createdGroupIndex = -1;
  private movedNodes: ReparentRecord[] = [];
  private previousSelectionNodeIds: string[] = [];
  private previousPrimaryNodeId: string | null = null;
  private activeSceneIdAtCommit: string | null = null;

  constructor(params: GroupSelectedNodesOperationParams) {
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

    const requestedNodeIds = Array.from(new Set(this.params.nodeIds));
    const requestedNodes = requestedNodeIds
      .map(nodeId => sceneGraph.nodeMap.get(nodeId) ?? null)
      .filter((node): node is NodeBase => node instanceof NodeBase)
      // Grouping a prefab instance child would reparent it under a new container
      // inside the instance — not representable in the override format.
      .filter(node => !isPrefabChildNode(node));

    const topLevelNodes = this.filterTopLevelNodes(requestedNodes);
    if (topLevelNodes.length === 0) {
      return { didMutate: false };
    }

    const all2D = topLevelNodes.every(node => node instanceof Node2D);
    const all3D = topLevelNodes.every(node => node instanceof Node3D);

    if (!all2D && !all3D) {
      return { didMutate: false };
    }

    const orderedNodes = this.sortNodesByTreeOrder(sceneGraph.rootNodes, topLevelNodes);
    const commonParent = this.resolveCommonParent(orderedNodes);

    this.previousSelectionNodeIds = [...state.selection.nodeIds];
    this.previousPrimaryNodeId = state.selection.primaryNodeId;
    this.activeSceneIdAtCommit = activeSceneId;
    this.movedNodes = orderedNodes.map(node => ({
      nodeId: node.nodeId,
      previousParentId: node.parentNode?.nodeId ?? null,
      previousIndex: node.parentNode
        ? node.parentNode.children.indexOf(node)
        : sceneGraph.rootNodes.indexOf(node),
    }));

    const insertIndex = this.resolveInsertIndex(sceneGraph.rootNodes, orderedNodes, commonParent);
    const createdGroup = all2D
      ? new Group2D({
          id: this.generateNodeId('group2d', sceneGraph.nodeMap),
          name: 'Group2D',
          width: 100,
          height: 100,
        })
      : new Node3D({
          id: this.generateNodeId('node3d', sceneGraph.nodeMap),
          name: 'Node3D',
        });

    this.createdGroup = createdGroup;
    this.createdGroupParentId = commonParent?.nodeId ?? null;
    this.createdGroupIndex = insertIndex;

    this.insertNode(sceneGraph.rootNodes, createdGroup, commonParent, insertIndex);
    sceneGraph.nodeMap.set(createdGroup.nodeId, createdGroup);

    for (const node of orderedNodes) {
      this.reparentNode(sceneGraph.rootNodes, node, createdGroup, -1);
    }

    SceneStateUpdater.updateHierarchyState(state, activeSceneId, sceneGraph);
    SceneStateUpdater.markSceneDirty(state, activeSceneId);
    SceneStateUpdater.selectNode(state, createdGroup.nodeId);

    return {
      didMutate: true,
      commit: {
        label: `Group ${orderedNodes.length} node${orderedNodes.length > 1 ? 's' : ''}`,
        undo: () => this.undo(context),
        redo: () => this.redo(context),
      },
    };
  }

  private async undo(context: OperationContext): Promise<void> {
    if (!this.createdGroup || !this.activeSceneIdAtCommit) {
      return;
    }

    const { state, container } = context;
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const sceneGraph = sceneManager.getSceneGraph(this.activeSceneIdAtCommit);
    if (!sceneGraph) {
      return;
    }

    const sortedByRestoreIndex = [...this.movedNodes].sort(
      (a, b) => a.previousIndex - b.previousIndex
    );

    for (const record of sortedByRestoreIndex) {
      const node = sceneGraph.nodeMap.get(record.nodeId);
      if (!(node instanceof NodeBase)) {
        continue;
      }
      const parent = record.previousParentId
        ? (sceneGraph.nodeMap.get(record.previousParentId) ?? null)
        : null;
      this.reparentNode(
        sceneGraph.rootNodes,
        node,
        parent instanceof NodeBase ? parent : null,
        record.previousIndex
      );
    }

    this.removeNode(sceneGraph.rootNodes, this.createdGroup);
    sceneGraph.nodeMap.delete(this.createdGroup.nodeId);

    SceneStateUpdater.updateHierarchyState(state, this.activeSceneIdAtCommit, sceneGraph);
    SceneStateUpdater.markSceneDirty(state, this.activeSceneIdAtCommit);

    state.selection.nodeIds = [...this.previousSelectionNodeIds];
    state.selection.primaryNodeId = this.previousPrimaryNodeId;
  }

  private async redo(context: OperationContext): Promise<void> {
    if (!this.createdGroup || !this.activeSceneIdAtCommit) {
      return;
    }

    const { state, container } = context;
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const sceneGraph = sceneManager.getSceneGraph(this.activeSceneIdAtCommit);
    if (!sceneGraph) {
      return;
    }

    const parent = this.createdGroupParentId
      ? (sceneGraph.nodeMap.get(this.createdGroupParentId) ?? null)
      : null;
    this.insertNode(
      sceneGraph.rootNodes,
      this.createdGroup,
      parent instanceof NodeBase ? parent : null,
      this.createdGroupIndex
    );
    sceneGraph.nodeMap.set(this.createdGroup.nodeId, this.createdGroup);

    for (const record of this.movedNodes) {
      const node = sceneGraph.nodeMap.get(record.nodeId);
      if (!(node instanceof NodeBase)) {
        continue;
      }
      this.reparentNode(sceneGraph.rootNodes, node, this.createdGroup, -1);
    }

    SceneStateUpdater.updateHierarchyState(state, this.activeSceneIdAtCommit, sceneGraph);
    SceneStateUpdater.markSceneDirty(state, this.activeSceneIdAtCommit);
    SceneStateUpdater.selectNode(state, this.createdGroup.nodeId);
  }

  private generateNodeId(prefix: string, nodeMap: Map<string, NodeBase>): string {
    let id = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    while (nodeMap.has(id)) {
      id = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    }
    return id;
  }

  private resolveCommonParent(nodes: NodeBase[]): NodeBase | null {
    if (nodes.length === 0) {
      return null;
    }

    const firstParent = nodes[0].parentNode;
    const allSameParent = nodes.every(node => node.parentNode === firstParent);
    return allSameParent ? firstParent : null;
  }

  private resolveInsertIndex(
    rootNodes: NodeBase[],
    selectedNodes: NodeBase[],
    parent: NodeBase | null
  ): number {
    if (selectedNodes.length === 0) {
      return 0;
    }

    const indices = selectedNodes.map(node => {
      if (parent) {
        return parent.children.indexOf(node);
      }
      return rootNodes.indexOf(node);
    });

    return Math.max(0, Math.min(...indices));
  }

  private filterTopLevelNodes(nodes: NodeBase[]): NodeBase[] {
    const selectedIds = new Set(nodes.map(node => node.nodeId));
    return nodes.filter(node => {
      let current = node.parentNode;
      while (current) {
        if (selectedIds.has(current.nodeId)) {
          return false;
        }
        current = current.parentNode;
      }
      return true;
    });
  }

  private sortNodesByTreeOrder(rootNodes: NodeBase[], nodes: NodeBase[]): NodeBase[] {
    const order = new Map<string, number>();
    let index = 0;

    const visit = (node: NodeBase): void => {
      order.set(node.nodeId, index);
      index += 1;
      for (const child of node.children) {
        if (child instanceof NodeBase) {
          visit(child);
        }
      }
    };

    for (const root of rootNodes) {
      visit(root);
    }

    return [...nodes].sort((a, b) => (order.get(a.nodeId) ?? 0) - (order.get(b.nodeId) ?? 0));
  }

  private insertNode(
    rootNodes: NodeBase[],
    node: NodeBase,
    parent: NodeBase | null,
    index: number
  ): void {
    if (parent) {
      parent.add(node);
      const nextIndex = Math.max(0, Math.min(index, parent.children.length - 1));
      if (nextIndex < parent.children.length - 1) {
        parent.children.splice(nextIndex, 0, parent.children.pop() as NodeBase);
      }
      return;
    }

    if (node.parentNode) {
      node.removeFromParent();
    }

    const boundedIndex = Math.max(0, Math.min(index, rootNodes.length));
    rootNodes.splice(boundedIndex, 0, node);
  }

  private removeNode(rootNodes: NodeBase[], node: NodeBase): void {
    if (node.parentNode) {
      node.removeFromParent();
      return;
    }

    const rootIndex = rootNodes.indexOf(node);
    if (rootIndex !== -1) {
      rootNodes.splice(rootIndex, 1);
    }
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
        newParent.children.splice(newIndex, 0, newParent.children.pop() as NodeBase);
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
