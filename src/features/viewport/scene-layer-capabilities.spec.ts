import { describe, expect, it } from 'vitest';

import { Node2D, Node3D, PostProcess, type NodeBase, type SceneGraph } from '@pix3/runtime';
import {
  deriveSceneLayerCapabilities,
  isMixedScene,
  isNavigationModeAvailable,
  resolveValidNavigationMode,
} from './scene-layer-capabilities';

function graphOf(...nodes: NodeBase[]): SceneGraph {
  return {
    rootNodes: nodes,
    nodeMap: new Map(nodes.map(node => [node.nodeId, node])),
  } as unknown as SceneGraph;
}

describe('deriveSceneLayerCapabilities', () => {
  it('is permissive when no scene graph is available', () => {
    expect(deriveSceneLayerCapabilities(null)).toEqual({ has2D: true, has3D: true });
    expect(deriveSceneLayerCapabilities(undefined)).toEqual({ has2D: true, has3D: true });
  });

  it('is permissive for an empty scene', () => {
    expect(deriveSceneLayerCapabilities(graphOf())).toEqual({ has2D: true, has3D: true });
  });

  it('reports 2D-only when the scene holds only Node2D content', () => {
    const graph = graphOf(new Node2D({ id: 'a', name: 'Sprite' }));
    expect(deriveSceneLayerCapabilities(graph)).toEqual({ has2D: true, has3D: false });
  });

  it('reports 3D-only when the scene holds only Node3D content', () => {
    const graph = graphOf(new Node3D({ id: 'b', name: 'Mesh' }));
    expect(deriveSceneLayerCapabilities(graph)).toEqual({ has2D: false, has3D: true });
  });

  it('reports mixed when both 2D and 3D content exist', () => {
    const graph = graphOf(
      new Node2D({ id: 'a', name: 'Sprite' }),
      new Node3D({ id: 'b', name: 'Mesh' })
    );
    expect(deriveSceneLayerCapabilities(graph)).toEqual({ has2D: true, has3D: true });
  });

  it('ignores neutral nodes that are neither 2D nor 3D', () => {
    const graph = graphOf(new PostProcess({ id: 'p', name: 'PostProcess' }));
    // Only a neutral node — stays permissive.
    expect(deriveSceneLayerCapabilities(graph)).toEqual({ has2D: true, has3D: true });

    const graph2 = graphOf(
      new PostProcess({ id: 'p', name: 'PostProcess' }),
      new Node2D({ id: 'a', name: 'Sprite' })
    );
    // Neutral node does not add a 3D dimension.
    expect(deriveSceneLayerCapabilities(graph2)).toEqual({ has2D: true, has3D: false });
  });
});

describe('resolveValidNavigationMode', () => {
  it('preserves the current mode when both dimensions exist', () => {
    expect(resolveValidNavigationMode('3d', { has2D: true, has3D: true })).toBe('3d');
    expect(resolveValidNavigationMode('2d', { has2D: true, has3D: true })).toBe('2d');
  });

  it('locks to 2D for a 2D-only scene', () => {
    expect(resolveValidNavigationMode('3d', { has2D: true, has3D: false })).toBe('2d');
  });

  it('locks to 3D for a 3D-only scene', () => {
    expect(resolveValidNavigationMode('2d', { has2D: false, has3D: true })).toBe('3d');
  });
});

describe('isMixedScene', () => {
  it('is true only when both dimensions exist', () => {
    expect(isMixedScene({ has2D: true, has3D: true })).toBe(true);
    expect(isMixedScene({ has2D: true, has3D: false })).toBe(false);
    expect(isMixedScene({ has2D: false, has3D: true })).toBe(false);
  });
});

describe('isNavigationModeAvailable', () => {
  it('gates each mode by the matching dimension', () => {
    expect(isNavigationModeAvailable('2d', { has2D: true, has3D: false })).toBe(true);
    expect(isNavigationModeAvailable('3d', { has2D: true, has3D: false })).toBe(false);
    expect(isNavigationModeAvailable('3d', { has2D: false, has3D: true })).toBe(true);
    expect(isNavigationModeAvailable('2d', { has2D: false, has3D: true })).toBe(false);
  });
});
