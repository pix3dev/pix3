import { Node2D, Node3D, type SceneGraph } from '@pix3/runtime';
import type { NavigationMode } from '@/state';

/**
 * Which layer/navigation dimensions the active scene actually needs, derived
 * from its content. A scene that holds only 2D nodes has no use for the 3D
 * layer or 3D navigation, and vice versa — the viewport toolbar hides the
 * irrelevant controls and navigation is locked to the available dimension.
 */
export interface SceneLayerCapabilities {
  /** The scene contains at least one {@link Node2D}. */
  readonly has2D: boolean;
  /** The scene contains at least one {@link Node3D}. */
  readonly has3D: boolean;
}

/**
 * Permissive default used when the scene is empty, holds only neutral nodes
 * (e.g. PostProcess / AudioPlayer), or no scene graph is available yet. Both
 * dimensions stay enabled so the user can start adding content of either kind
 * and nothing is hidden spuriously.
 */
const BOTH: SceneLayerCapabilities = { has2D: true, has3D: true };

/**
 * Classify a scene graph by the kind of visual content it holds. Neutral nodes
 * that are neither {@link Node2D} nor {@link Node3D} do not count toward either
 * dimension.
 */
export function deriveSceneLayerCapabilities(
  sceneGraph: SceneGraph | null | undefined
): SceneLayerCapabilities {
  if (!sceneGraph) {
    return BOTH;
  }

  let has2D = false;
  let has3D = false;
  for (const node of sceneGraph.nodeMap.values()) {
    if (node instanceof Node2D) {
      has2D = true;
    } else if (node instanceof Node3D) {
      has3D = true;
    }
    if (has2D && has3D) {
      break;
    }
  }

  // Empty / neutral-only scenes stay permissive.
  if (!has2D && !has3D) {
    return BOTH;
  }

  return { has2D, has3D };
}

/**
 * Given the current navigation mode and the scene's capabilities, return the
 * mode that should actually be active. When both dimensions exist (or the scene
 * is permissive) the current mode is preserved; when only one exists navigation
 * is locked to it.
 */
export function resolveValidNavigationMode(
  current: NavigationMode,
  capabilities: SceneLayerCapabilities
): NavigationMode {
  if (capabilities.has2D && capabilities.has3D) {
    return current;
  }
  if (capabilities.has3D) {
    return '3d';
  }
  if (capabilities.has2D) {
    return '2d';
  }
  return current;
}

/** Whether the given navigation mode is usable for a scene's capabilities. */
export function isNavigationModeAvailable(
  mode: NavigationMode,
  capabilities: SceneLayerCapabilities
): boolean {
  return mode === '2d' ? capabilities.has2D : capabilities.has3D;
}

/**
 * Whether the scene mixes 2D and 3D content. The layer-visibility toggles and
 * the navigation-mode toggle are only meaningful in this case — with a single
 * layer there is nothing to reveal by hiding it, so those controls are hidden.
 */
export function isMixedScene(capabilities: SceneLayerCapabilities): boolean {
  return capabilities.has2D && capabilities.has3D;
}
