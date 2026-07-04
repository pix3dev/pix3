import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { SceneStateUpdater } from '@/core/SceneStateUpdater';
import { NodeBase, SceneManager } from '@pix3/runtime';
import { parse, stringify } from 'yaml';
import { isPrefabChildNode } from '@/features/scene/prefab-utils';

export interface DuplicateNodesOperationParams {
  nodeIds: string[];
}

interface SerializedComponent {
  id?: string;
  type?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

interface SerializedNode {
  id: string;
  type?: string;
  name?: string;
  instance?: string;
  groups?: string[];
  properties?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  children?: SerializedNode[];
  components?: SerializedComponent[];
}

interface SerializedScene {
  version: string;
  description?: string;
  metadata?: Record<string, unknown>;
  root: SerializedNode[];
}

interface CreatedCloneEntry {
  node: NodeBase;
  parentId: string | null;
  index: number;
}

export class DuplicateNodesOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.duplicate-nodes',
    title: 'Duplicate Nodes',
    description: 'Duplicate selected nodes and their nested hierarchy',
    tags: ['scene', 'duplicate', 'clone', 'hierarchy'],
    affectsNodeStructure: true,
  };

  private readonly params: DuplicateNodesOperationParams;
  private readonly createdEntries: CreatedCloneEntry[] = [];
  private previousSelectionNodeIds: string[] = [];
  private previousPrimaryNodeId: string | null = null;
  private activeSceneIdAtCommit: string | null = null;

  constructor(params: DuplicateNodesOperationParams) {
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
      // Prefab instance children cannot be duplicated in place (the clone would
      // live inside the instance and be discarded on save). Instance roots are
      // fine — they round-trip as a second `instance:` reference.
      .filter(node => !isPrefabChildNode(node));

    const topLevelNodes = this.filterTopLevelNodes(requestedNodes);
    if (topLevelNodes.length === 0) {
      return { didMutate: false };
    }

    const orderedTopLevelNodes = this.sortNodesByTreeOrder(sceneGraph.rootNodes, topLevelNodes);

    this.createdEntries.length = 0;
    this.previousSelectionNodeIds = [...state.selection.nodeIds];
    this.previousPrimaryNodeId = state.selection.primaryNodeId;
    this.activeSceneIdAtCommit = activeSceneId;

    const parentOffsets = new Map<string, number>();
    const reservedIds = new Set<string>(sceneGraph.nodeMap.keys());

    for (const sourceNode of orderedTopLevelNodes) {
      const sourceParent = sourceNode.parentNode;
      const sourceIndex = sourceParent
        ? sourceParent.children.indexOf(sourceNode)
        : sceneGraph.rootNodes.indexOf(sourceNode);

      const parentKey = sourceParent?.nodeId ?? '__root__';
      const offset = parentOffsets.get(parentKey) ?? 0;
      const insertIndex = Math.max(0, sourceIndex + 1 + offset);
      parentOffsets.set(parentKey, offset + 1);

      const serializedCloneRoot = await this.serializeAndPrepareCloneRoot(
        sceneManager,
        sceneGraph.version,
        sourceNode,
        reservedIds
      );
      const duplicatedRoot = await this.instantiateFromDefinition(
        sceneManager,
        sceneGraph.version,
        serializedCloneRoot
      );
      if (!duplicatedRoot) {
        continue;
      }

      this.insertNode(sceneGraph.rootNodes, duplicatedRoot, sourceParent, insertIndex);
      this.registerSubtree(sceneManager, sceneGraph.nodeMap, duplicatedRoot, activeSceneId);

      this.createdEntries.push({
        node: duplicatedRoot,
        parentId: sourceParent?.nodeId ?? null,
        index: insertIndex,
      });
    }

    if (this.createdEntries.length === 0) {
      return { didMutate: false };
    }

    SceneStateUpdater.updateHierarchyState(state, activeSceneId, sceneGraph);
    SceneStateUpdater.markSceneDirty(state, activeSceneId);

    state.selection.nodeIds = this.createdEntries.map(entry => entry.node.nodeId);
    state.selection.primaryNodeId = this.createdEntries[0]?.node.nodeId ?? null;

    return {
      didMutate: true,
      commit: {
        label: `Duplicate ${this.createdEntries.length} node${this.createdEntries.length > 1 ? 's' : ''}`,
        undo: () => this.undo(context),
        redo: () => this.redo(context),
      },
    };
  }

  private async undo(context: OperationContext): Promise<void> {
    if (!this.activeSceneIdAtCommit) {
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

    for (let i = this.createdEntries.length - 1; i >= 0; i -= 1) {
      this.unregisterSubtree(sceneManager, sceneGraph.nodeMap, this.createdEntries[i].node);
      this.removeNode(sceneGraph.rootNodes, this.createdEntries[i].node);
    }

    SceneStateUpdater.updateHierarchyState(state, this.activeSceneIdAtCommit, sceneGraph);
    SceneStateUpdater.markSceneDirty(state, this.activeSceneIdAtCommit);

    state.selection.nodeIds = [...this.previousSelectionNodeIds];
    state.selection.primaryNodeId = this.previousPrimaryNodeId;
  }

  private async redo(context: OperationContext): Promise<void> {
    if (!this.activeSceneIdAtCommit) {
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

    for (const entry of this.createdEntries) {
      const parent = entry.parentId ? (sceneGraph.nodeMap.get(entry.parentId) ?? null) : null;
      const parentNode = parent instanceof NodeBase ? parent : null;
      this.insertNode(sceneGraph.rootNodes, entry.node, parentNode, entry.index);
      this.registerSubtree(
        sceneManager,
        sceneGraph.nodeMap,
        entry.node,
        this.activeSceneIdAtCommit
      );
    }

    SceneStateUpdater.updateHierarchyState(state, this.activeSceneIdAtCommit, sceneGraph);
    SceneStateUpdater.markSceneDirty(state, this.activeSceneIdAtCommit);

    state.selection.nodeIds = this.createdEntries.map(entry => entry.node.nodeId);
    state.selection.primaryNodeId = this.createdEntries[0]?.node.nodeId ?? null;
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

  private async serializeAndPrepareCloneRoot(
    sceneManager: SceneManager,
    version: string,
    sourceNode: NodeBase,
    reservedIds: Set<string>
  ): Promise<SerializedNode> {
    const subtreeMap = new Map<string, NodeBase>();
    this.collectSubtreeNodes(sourceNode, subtreeMap);

    const serialized = sceneManager.serializeScene({
      version,
      rootNodes: [sourceNode],
      nodeMap: subtreeMap,
      metadata: {},
    });

    const parsed = parse(serialized);
    const sceneDoc = this.asSerializedScene(parsed);
    const cloneRoot = sceneDoc.root[0];

    this.rewriteIdsRecursively(cloneRoot, reservedIds);

    if (typeof cloneRoot.name === 'string' && cloneRoot.name.trim().length > 0) {
      cloneRoot.name = `${cloneRoot.name} Copy`;
    }

    return cloneRoot;
  }

  private async instantiateFromDefinition(
    sceneManager: SceneManager,
    version: string,
    root: SerializedNode
  ): Promise<NodeBase | null> {
    const doc: SerializedScene = {
      version,
      root: [root],
      metadata: {},
    };

    const graph = await sceneManager.parseScene(stringify(doc));
    return graph.rootNodes[0] ?? null;
  }

  private asSerializedScene(value: unknown): SerializedScene {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Failed to duplicate node: invalid serialized scene document.');
    }

    const maybeScene = value as Partial<SerializedScene>;
    if (!Array.isArray(maybeScene.root) || maybeScene.root.length === 0) {
      throw new Error('Failed to duplicate node: serialized scene has no root nodes.');
    }

    const version = typeof maybeScene.version === 'string' ? maybeScene.version : '1.0';
    return {
      version,
      description: maybeScene.description,
      metadata:
        maybeScene.metadata && typeof maybeScene.metadata === 'object' ? maybeScene.metadata : {},
      root: maybeScene.root,
    };
  }

  private rewriteIdsRecursively(node: SerializedNode, reservedIds: Set<string>): void {
    const typeHint = typeof node.type === 'string' ? node.type : 'node';
    node.id = this.generateUniqueNodeId(typeHint, reservedIds);

    if (node.components && Array.isArray(node.components)) {
      for (const component of node.components) {
        const componentType =
          typeof component.type === 'string' && component.type.length > 0
            ? component.type
            : 'component';
        component.id = `${node.id}-${componentType}-${Math.random().toString(36).slice(2, 9)}`;
      }
    }

    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        this.rewriteIdsRecursively(child, reservedIds);
      }
    }
  }

  private generateUniqueNodeId(typeHint: string, reservedIds: Set<string>): string {
    const prefix = typeHint.toLowerCase().replace(/[^a-z0-9]/g, '-') || 'node';

    let nextId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    while (reservedIds.has(nextId)) {
      nextId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    }

    reservedIds.add(nextId);
    return nextId;
  }

  private collectSubtreeNodes(node: NodeBase, target: Map<string, NodeBase>): void {
    target.set(node.nodeId, node);
    for (const child of node.children) {
      if (child instanceof NodeBase) {
        this.collectSubtreeNodes(child, target);
      }
    }
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

  private registerSubtree(
    sceneManager: SceneManager,
    nodeMap: Map<string, NodeBase>,
    node: NodeBase,
    sceneId: string
  ): void {
    nodeMap.set(node.nodeId, node);
    for (const group of node.groups) {
      sceneManager.addNodeToGroup(node, group, sceneId);
    }

    for (const child of node.children) {
      if (child instanceof NodeBase) {
        this.registerSubtree(sceneManager, nodeMap, child, sceneId);
      }
    }
  }

  private unregisterSubtree(
    sceneManager: SceneManager,
    nodeMap: Map<string, NodeBase>,
    node: NodeBase
  ): void {
    for (const child of node.children) {
      if (child instanceof NodeBase) {
        this.unregisterSubtree(sceneManager, nodeMap, child);
      }
    }

    for (const group of node.groups) {
      sceneManager.removeNodeFromGroup(node, group, this.activeSceneIdAtCommit ?? undefined);
    }

    nodeMap.delete(node.nodeId);
  }
}
