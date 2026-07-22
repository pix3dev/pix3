import { stringify } from 'yaml';

import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { SceneStateUpdater } from '@/core/SceneStateUpdater';
import { SceneManager, NodeBase, type SceneNodeDefinition } from '@pix3/runtime';
import { FileSystemAPIService } from '@/services/project/FileSystemAPIService';

export interface SaveAsPrefabOperationParams {
  nodeId: string;
  prefabPath: string;
}

export class SaveAsPrefabOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.save-as-prefab',
    title: 'Save Branch As Prefab',
    description: 'Save selected node branch as prefab and replace it with an instance',
    tags: ['scene', 'prefab', 'save'],
    affectsNodeStructure: true,
  };

  private readonly params: SaveAsPrefabOperationParams;
  private sceneIdAtCommit: string | null = null;
  private parentNodeIdAtCommit: string | null = null;
  private indexAtCommit = -1;
  private originalNode: NodeBase | null = null;
  private instanceNode: NodeBase | null = null;
  private previousSelection: string[] = [];
  private previousPrimarySelection: string | null = null;

  constructor(params: SaveAsPrefabOperationParams) {
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
    const fs = container.getService<FileSystemAPIService>(
      container.getOrCreateToken(FileSystemAPIService)
    );
    const sceneGraph = sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      return { didMutate: false };
    }

    const sourceNode = sceneGraph.nodeMap.get(this.params.nodeId);
    if (!(sourceNode instanceof NodeBase)) {
      return { didMutate: false };
    }

    const prefabPath = this.normalizePrefabPath(this.params.prefabPath);
    if (!prefabPath.startsWith('res://')) {
      return { didMutate: false };
    }

    const subtreeMap = new Map<string, NodeBase>();
    this.collectSubtree(sourceNode, subtreeMap);
    const prefabText = sceneManager.serializeScene({
      version: sceneGraph.version ?? '1.0.0',
      rootNodes: [sourceNode],
      nodeMap: subtreeMap,
      metadata: {},
    });

    await fs.writeTextFile(prefabPath, prefabText);

    const replacementDoc = stringify({
      version: sceneGraph.version ?? '1.0.0',
      root: [
        {
          id: sourceNode.nodeId,
          name: sourceNode.name,
          instance: prefabPath,
        } as SceneNodeDefinition,
      ],
    });
    const replacementGraph = await sceneManager.parseScene(replacementDoc, {
      filePath: state.scenes.descriptors[activeSceneId]?.filePath,
    });
    const instanceNode = replacementGraph.rootNodes[0];
    if (!instanceNode) {
      return { didMutate: false };
    }

    const parentNode = sourceNode.parentNode;
    const parentId = parentNode?.nodeId ?? null;
    const index = parentNode
      ? parentNode.children.indexOf(sourceNode)
      : sceneGraph.rootNodes.indexOf(sourceNode);

    this.sceneIdAtCommit = activeSceneId;
    this.parentNodeIdAtCommit = parentId;
    this.indexAtCommit = index;
    this.originalNode = sourceNode;
    this.instanceNode = instanceNode;
    this.previousSelection = [...state.selection.nodeIds];
    this.previousPrimarySelection = state.selection.primaryNodeId;

    this.unregisterSubtree(sceneManager, sceneGraph, sourceNode, activeSceneId);
    this.removeNode(sceneGraph, sourceNode);

    this.insertNode(sceneGraph, instanceNode, parentNode, index);
    this.registerSubtree(sceneManager, sceneGraph, instanceNode, activeSceneId);

    SceneStateUpdater.updateHierarchyState(state, activeSceneId, sceneGraph);
    SceneStateUpdater.markSceneDirty(state, activeSceneId);
    SceneStateUpdater.selectNode(state, instanceNode.nodeId);

    return {
      didMutate: true,
      commit: {
        label: `Save ${sourceNode.name} as Prefab`,
        undo: () => this.undo(context),
        redo: () => this.redo(context),
      },
    };
  }

  private undo(context: OperationContext): void {
    if (!this.sceneIdAtCommit || !this.originalNode || !this.instanceNode) {
      return;
    }

    const { state, container } = context;
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const sceneGraph = sceneManager.getSceneGraph(this.sceneIdAtCommit);
    if (!sceneGraph) {
      return;
    }

    this.unregisterSubtree(sceneManager, sceneGraph, this.instanceNode, this.sceneIdAtCommit);
    this.removeNode(sceneGraph, this.instanceNode);

    const parent = this.parentNodeIdAtCommit
      ? (sceneGraph.nodeMap.get(this.parentNodeIdAtCommit) ?? null)
      : null;
    const parentNode = parent instanceof NodeBase ? parent : null;
    this.insertNode(sceneGraph, this.originalNode, parentNode, this.indexAtCommit);
    this.registerSubtree(sceneManager, sceneGraph, this.originalNode, this.sceneIdAtCommit);

    SceneStateUpdater.updateHierarchyState(state, this.sceneIdAtCommit, sceneGraph);
    SceneStateUpdater.markSceneDirty(state, this.sceneIdAtCommit);
    state.selection.nodeIds = [...this.previousSelection];
    state.selection.primaryNodeId = this.previousPrimarySelection;
  }

  private redo(context: OperationContext): void {
    if (!this.sceneIdAtCommit || !this.originalNode || !this.instanceNode) {
      return;
    }

    const { state, container } = context;
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const sceneGraph = sceneManager.getSceneGraph(this.sceneIdAtCommit);
    if (!sceneGraph) {
      return;
    }

    this.unregisterSubtree(sceneManager, sceneGraph, this.originalNode, this.sceneIdAtCommit);
    this.removeNode(sceneGraph, this.originalNode);

    const parent = this.parentNodeIdAtCommit
      ? (sceneGraph.nodeMap.get(this.parentNodeIdAtCommit) ?? null)
      : null;
    const parentNode = parent instanceof NodeBase ? parent : null;
    this.insertNode(sceneGraph, this.instanceNode, parentNode, this.indexAtCommit);
    this.registerSubtree(sceneManager, sceneGraph, this.instanceNode, this.sceneIdAtCommit);

    SceneStateUpdater.updateHierarchyState(state, this.sceneIdAtCommit, sceneGraph);
    SceneStateUpdater.markSceneDirty(state, this.sceneIdAtCommit);
    SceneStateUpdater.selectNode(state, this.instanceNode.nodeId);
  }

  private normalizePrefabPath(path: string): string {
    const trimmed = path.trim().replace(/\\/g, '/');
    if (trimmed.startsWith('res://')) {
      return trimmed;
    }
    return `res://${trimmed.replace(/^\/+/, '')}`;
  }

  private collectSubtree(node: NodeBase, target: Map<string, NodeBase>): void {
    target.set(node.nodeId, node);
    for (const child of node.children) {
      if (child instanceof NodeBase) {
        this.collectSubtree(child, target);
      }
    }
  }

  private insertNode(
    sceneGraph: { rootNodes: NodeBase[] },
    node: NodeBase,
    parentNode: NodeBase | null,
    index: number
  ): void {
    if (parentNode) {
      parentNode.add(node);
      const boundedIndex = Math.max(0, Math.min(index, parentNode.children.length - 1));
      if (boundedIndex < parentNode.children.length - 1) {
        parentNode.children.splice(boundedIndex, 0, parentNode.children.pop() as NodeBase);
      }
      return;
    }

    if (node.parentNode) {
      node.removeFromParent();
    }
    const boundedIndex = Math.max(0, Math.min(index, sceneGraph.rootNodes.length));
    sceneGraph.rootNodes.splice(boundedIndex, 0, node);
  }

  private removeNode(sceneGraph: { rootNodes: NodeBase[] }, node: NodeBase): void {
    if (node.parentNode) {
      node.removeFromParent();
      return;
    }
    const index = sceneGraph.rootNodes.indexOf(node);
    if (index >= 0) {
      sceneGraph.rootNodes.splice(index, 1);
    }
  }

  private registerSubtree(
    sceneManager: SceneManager,
    sceneGraph: { nodeMap: Map<string, NodeBase> },
    root: NodeBase,
    sceneId: string
  ): void {
    const stack: NodeBase[] = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        continue;
      }
      sceneGraph.nodeMap.set(node.nodeId, node);
      for (const group of node.groups) {
        sceneManager.addNodeToGroup(node, group, sceneId);
      }
      for (const child of node.children) {
        if (child instanceof NodeBase) {
          stack.push(child);
        }
      }
    }
  }

  private unregisterSubtree(
    sceneManager: SceneManager,
    sceneGraph: { nodeMap: Map<string, NodeBase> },
    root: NodeBase,
    sceneId: string
  ): void {
    const stack: NodeBase[] = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        continue;
      }
      for (const child of node.children) {
        if (child instanceof NodeBase) {
          stack.push(child);
        }
      }
      for (const group of node.groups) {
        sceneManager.removeNodeFromGroup(node, group, sceneId);
      }
      sceneGraph.nodeMap.delete(node.nodeId);
    }
  }
}
