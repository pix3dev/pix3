import { Node2D } from '@pix3/runtime';
import type { NodeBase } from '@pix3/runtime';
import type { SceneGraph } from '@pix3/runtime';
import { isPrefabChildNode, isPrefabNode } from '@/features/scene/prefab-utils';

/**
 * Determines if a node is a 2D node (Node2D or its subclasses)
 */
function is2DNode(node: NodeBase): boolean {
  return node instanceof Node2D;
}

/**
 * Validates if a dragged node can be dropped on a target node.
 *
 * @param draggedNodeId - ID of the node being dragged
 * @param targetNodeId - ID of the target node (null for root level)
 * @param sceneGraph - Scene graph containing both nodes
 * @param position - Drop position: 'inside', 'before', or 'after'
 * @returns true if drop is valid, false otherwise
 */
export function canDropNode(
  draggedNodeId: string,
  targetNodeId: string | null,
  sceneGraph: SceneGraph,
  position: 'inside' | 'before' | 'after'
): boolean {
  const draggedNode = sceneGraph.nodeMap.get(draggedNodeId);
  if (!draggedNode) return false;

  // Prefab instance children are structurally locked: their layout is owned by
  // the prefab file, and the override format only round-trips property diffs, so
  // moving one would be silently lost on save. Block dragging it anywhere.
  if (isPrefabChildNode(draggedNode)) return false;

  // For before/after positions, always allow (reordering siblings)
  if (position === 'before' || position === 'after') {
    if (targetNodeId) {
      const targetNode = sceneGraph.nodeMap.get(targetNodeId);
      if (targetNode) {
        // Prevent dropping before/after itself
        if (targetNodeId === draggedNodeId) return false;

        // Check if target is a descendant of dragged node (circular reference)
        if (isDescendantOf(targetNode, draggedNodeId)) return false;

        // Dropping as a sibling of a prefab child would insert the node inside
        // the instance subtree — not representable in the override format.
        // (An instance ROOT is fine: its parent is outside the instance.)
        if (isPrefabChildNode(targetNode)) return false;
      }
    }
    return true;
  }

  // For 'inside' position, target must exist
  if (!targetNodeId) {
    // Dropping to root level - always allowed
    return true;
  }

  const targetNode = sceneGraph.nodeMap.get(targetNodeId);
  if (!targetNode) return false;

  // Never drop inside a prefab instance (root or child) — its children are owned
  // by the prefab and structural edits do not survive serialization.
  if (isPrefabNode(targetNode)) return false;

  // Prevent dropping inside itself or its descendants
  if (targetNodeId === draggedNodeId || isDescendantOf(targetNode, draggedNodeId)) {
    return false;
  }

  // Target must be a container
  if (!targetNode.isContainer) {
    return false;
  }

  // Dimensions must match (2D can only go into 2D, 3D into 3D)
  const draggedIs2D = is2DNode(draggedNode);
  const targetIs2D = is2DNode(targetNode);

  if (draggedIs2D !== targetIs2D) {
    return false;
  }

  return true;
}

/**
 * Checks if a node is a descendant of another node
 */
function isDescendantOf(node: NodeBase, ancestorId: string): boolean {
  let current = node.parentNode;
  while (current) {
    if (current.nodeId === ancestorId) return true;
    current = current.parentNode;
  }
  return false;
}
