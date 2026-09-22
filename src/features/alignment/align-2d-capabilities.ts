import { Node2D, type NodeBase } from '@pix3/runtime';
import type { Align2DActionId } from './types';

/**
 * Which alignment actions the current selection admits.
 *
 * One source of truth for two consumers that must agree: the viewport toolbar (which hides a group
 * whose actions cannot run) and `preconditions()` of the `Node ▸ Align` / `Node ▸ Distribute`
 * commands (which greys the row). They used to be one hand-rolled block inside `editor-tab.ts`,
 * reachable only from the component — so a menu row would have had to guess.
 */
export interface Align2DCapabilities {
  /** At least one selected node is a `Node2D`; nothing in the strip applies otherwise. */
  readonly has2DSelection: boolean;
  /** Aligning against the parent (or the viewport, for roots) needs one shared 2D container. */
  readonly canAlignToContainer: boolean;
  /** Aligning against the selection's own bounds needs at least two nodes to have bounds. */
  readonly canAlignToSelectionBounds: boolean;
  /** Distribution moves the nodes *between* the outer two, so it needs at least three. */
  readonly canDistributeSelection: boolean;
}

/** Nothing is selected, or there is no scene: every group is unavailable. */
export const NO_ALIGN_2D_CAPABILITIES: Align2DCapabilities = {
  has2DSelection: false,
  canAlignToContainer: false,
  canAlignToSelectionBounds: false,
  canDistributeSelection: false,
};

/** The narrow slice of a scene graph this needs — `SceneGraph` and test doubles both satisfy it. */
export interface Align2DNodeLookup {
  readonly nodeMap: { get(nodeId: string): NodeBase | undefined };
}

/**
 * Derive {@link Align2DCapabilities} from a scene graph and the selected node ids.
 */
export const computeAlign2DCapabilities = (
  sceneGraph: Align2DNodeLookup | null | undefined,
  selectedNodeIds: readonly string[]
): Align2DCapabilities => {
  if (!sceneGraph) {
    return NO_ALIGN_2D_CAPABILITIES;
  }

  const selected2DNodes = selectedNodeIds
    .map(nodeId => sceneGraph.nodeMap.get(nodeId) ?? null)
    .filter((node): node is Node2D => node instanceof Node2D);

  if (selected2DNodes.length === 0) {
    return NO_ALIGN_2D_CAPABILITIES;
  }

  const sharedParent = selected2DNodes[0]?.parentNode ?? null;
  const sharesParent = selected2DNodes.every(node => node.parentNode === sharedParent);

  return {
    has2DSelection: true,
    canAlignToContainer: sharesParent && (sharedParent === null || sharedParent instanceof Node2D),
    canAlignToSelectionBounds: selected2DNodes.length > 1,
    canDistributeSelection: selected2DNodes.length > 2,
  };
};

/** Which capability an action depends on. */
export const align2DActionRequirement = (
  action: Align2DActionId
): 'container' | 'selection-bounds' | 'distribute' => {
  if (action.startsWith('distribute-')) {
    return 'distribute';
  }
  return action.startsWith('container-') ? 'container' : 'selection-bounds';
};

/** True when `action` can run against the selection described by `capabilities`. */
export const canRunAlign2DAction = (
  action: Align2DActionId,
  capabilities: Align2DCapabilities
): boolean => {
  if (!capabilities.has2DSelection) {
    return false;
  }
  switch (align2DActionRequirement(action)) {
    case 'container':
      return capabilities.canAlignToContainer;
    case 'selection-bounds':
      return capabilities.canAlignToSelectionBounds;
    case 'distribute':
      return capabilities.canDistributeSelection;
  }
};

/** Why an action is unavailable, for a blocked command's `reason`. */
export const align2DActionBlockedReason = (action: Align2DActionId): string => {
  switch (align2DActionRequirement(action)) {
    case 'container':
      return 'Select 2D nodes that share one 2D container to align against it';
    case 'selection-bounds':
      return 'Select at least two 2D nodes to align them to the selection bounds';
    case 'distribute':
      return 'Select at least three 2D nodes to distribute them';
  }
};
