import type { NodeBase } from '@pix3/runtime';
import type { SceneGraph } from '@pix3/runtime';
import { Node2D } from '@pix3/runtime';
import { Node3D } from '@pix3/runtime';

export interface IndexedNodePlacement {
  parentNodeId?: string | null;
  insertIndex?: number;
}

const isCompatible2DContainer = (node: NodeBase | null): node is NodeBase => {
  return Boolean(node && node instanceof Node2D && node.isContainer);
};

export const resolve2DParentForCreation = (
  sceneGraph: SceneGraph,
  parentNodeId: string | null,
  selectedNodeId: string | null
): NodeBase | null => {
  const explicitParent = parentNodeId ? (sceneGraph.nodeMap.get(parentNodeId) ?? null) : null;
  if (isCompatible2DContainer(explicitParent)) {
    return explicitParent;
  }

  const selectedParent = selectedNodeId ? (sceneGraph.nodeMap.get(selectedNodeId) ?? null) : null;
  if (isCompatible2DContainer(selectedParent)) {
    return selectedParent;
  }

  return null;
};

export const resolveDefault3DParent = (sceneGraph: SceneGraph): NodeBase | null => {
  return sceneGraph.rootNodes.find(node => node instanceof Node3D) ?? null;
};

export const resolvePlacementParent = (
  sceneGraph: SceneGraph,
  parentNodeId: string | null | undefined
): NodeBase | null => {
  if (!parentNodeId) {
    return null;
  }

  const parentNode = sceneGraph.nodeMap.get(parentNodeId);
  return parentNode instanceof Node3D || parentNode instanceof Node2D ? parentNode : null;
};

export const insertNodeAtIndex = (
  sceneGraph: SceneGraph,
  node: NodeBase,
  parentNode: NodeBase | null,
  index: number | undefined
): number => {
  if (parentNode) {
    parentNode.add(node);

    const maxIndex = parentNode.children.length - 1;
    const boundedIndex =
      typeof index === 'number' && index >= 0
        ? Math.max(0, Math.min(index, maxIndex))
        : maxIndex;

    if (boundedIndex < maxIndex) {
      parentNode.children.splice(boundedIndex, 0, parentNode.children.pop() as NodeBase);
    }

    return boundedIndex;
  }

  if (node.parentNode) {
    node.removeFromParent();
  }

  const boundedIndex =
    typeof index === 'number' && index >= 0
      ? Math.max(0, Math.min(index, sceneGraph.rootNodes.length))
      : sceneGraph.rootNodes.length;

  sceneGraph.rootNodes.splice(boundedIndex, 0, node);
  return boundedIndex;
};

export const removeNodeFromSceneGraph = (sceneGraph: SceneGraph, node: NodeBase): void => {
  if (node.parentNode) {
    node.removeFromParent();
    return;
  }

  const rootIndex = sceneGraph.rootNodes.indexOf(node);
  if (rootIndex !== -1) {
    sceneGraph.rootNodes.splice(rootIndex, 1);
  }
};

export const attachNode = (
  sceneGraph: SceneGraph,
  node: NodeBase,
  parentNode: NodeBase | null
): void => {
  insertNodeAtIndex(sceneGraph, node, parentNode, -1);
  sceneGraph.nodeMap.set(node.nodeId, node);
};

export const detachNode = (
  sceneGraph: SceneGraph,
  node: NodeBase,
  parentNode: NodeBase | null
): void => {
  if (parentNode || !node.parentNode) {
    removeNodeFromSceneGraph(sceneGraph, node);
  }
  sceneGraph.nodeMap.delete(node.nodeId);
};
