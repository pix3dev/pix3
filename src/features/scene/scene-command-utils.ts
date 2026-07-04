import type { CommandContext, CommandPreconditionResult } from '@/core/command';
import { SceneManager } from '@pix3/runtime';
import { isPrefabChildNode, isPrefabNode } from '@/features/scene/prefab-utils';

/** Shared reason for blocking component edits on prefab instance nodes. */
export const PREFAB_COMPONENT_LOCK_REASON =
  'Components of a prefab instance are managed by the prefab — open it to edit';

/**
 * True when `nodeId` resolves (in the active scene) to a node that is part of a
 * prefab instance (root or child). Component edits on such nodes are not
 * serialized as overrides, so structural component commands reject them.
 */
export const isPrefabInstanceNode = (
  context: CommandContext,
  nodeId: string | undefined | null
): boolean => {
  if (!nodeId) {
    return false;
  }
  const sceneManager = context.container.getService<SceneManager>(
    context.container.getOrCreateToken(SceneManager)
  );
  const node = sceneManager.getActiveSceneGraph()?.nodeMap.get(nodeId);
  return !!node && isPrefabNode(node);
};

/**
 * True when every id in `nodeIds` resolves to a prefab instance child (a node
 * whose structure is owned by its prefab). Used by structural commands to reject
 * selections that contain nothing they are allowed to act on.
 */
export const allResolvedNodesArePrefabChildren = (
  context: CommandContext,
  nodeIds: readonly string[]
): boolean => {
  if (nodeIds.length === 0) {
    return false;
  }

  const sceneManager = context.container.getService<SceneManager>(
    context.container.getOrCreateToken(SceneManager)
  );
  const sceneGraph = sceneManager.getActiveSceneGraph();
  if (!sceneGraph) {
    return false;
  }

  let resolvedAny = false;
  for (const nodeId of nodeIds) {
    const node = sceneGraph.nodeMap.get(nodeId);
    if (!node) {
      continue;
    }
    resolvedAny = true;
    if (!isPrefabChildNode(node)) {
      return false;
    }
  }

  return resolvedAny;
};

export const requireActiveScene = (
  context: CommandContext,
  reason: string
): CommandPreconditionResult => {
  const sceneManager = context.container.getService<SceneManager>(
    context.container.getOrCreateToken(SceneManager)
  );

  if (!sceneManager.getActiveSceneGraph()) {
    return {
      canExecute: false,
      reason,
      scope: 'scene',
    };
  }

  return { canExecute: true };
};

export const getCreatedNodeIdFromSelection = (
  context: CommandContext,
  didMutate: boolean
): string => {
  if (!didMutate) {
    return '';
  }

  return context.state.selection.primaryNodeId ?? '';
};
