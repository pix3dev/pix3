import type { NodeBase } from '../nodes/NodeBase';
import { SceneLoader, type ParseSceneOptions } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { Node2D } from '../nodes/Node2D';

export interface SceneGraph {
  version: string;
  description?: string;
  rootNodes: NodeBase[];
  nodeMap: Map<string, NodeBase>;
  metadata: Record<string, unknown>;
}

export class SceneManager {
  private readonly sceneLoader: SceneLoader;
  private readonly sceneSaver: SceneSaver;

  private readonly sceneGraphs = new Map<string, SceneGraph>();
  private readonly groupMaps = new Map<string, Map<string, Set<NodeBase>>>();
  private activeSceneId: string | null = null;

  constructor(sceneLoader: SceneLoader, sceneSaver: SceneSaver) {
    this.sceneLoader = sceneLoader;
    this.sceneSaver = sceneSaver;
  }

  /** Runtime prefab spawn — see {@link SceneLoader.instantiatePrefab}. */
  async instantiatePrefab(instancePath: string, instanceId: string) {
    return await this.sceneLoader.instantiatePrefab(instancePath, instanceId);
  }

  async parseScene(sceneText: string, options: ParseSceneOptions = {}): Promise<SceneGraph> {
    return await this.sceneLoader.parseScene(sceneText, options);
  }

  serializeScene(graph: SceneGraph): string {
    return this.sceneSaver.serializeScene(graph);
  }

  setActiveSceneGraph(sceneId: string, graph: SceneGraph): void {
    // Replacing an existing graph (e.g. scene reload from disk) — free the old
    // graph's GPU resources so geometries/materials/textures are not leaked.
    const previous = this.sceneGraphs.get(sceneId);
    if (previous && previous !== graph) {
      this.disposeSceneGraph(previous);
    }
    this.sceneGraphs.set(sceneId, graph);
    this.groupMaps.set(sceneId, this.buildGroupMap(graph));
    this.activeSceneId = sceneId;
    // Debug logging to help trace when scenes are registered as active
    console.debug('[SceneManager] setActiveSceneGraph', {
      sceneId,
      rootCount: graph.rootNodes.length,
    });
  }

  /**
   * Switch the active scene to an already-registered graph WITHOUT replacing it.
   *
   * Use this when re-activating an editor tab whose scene is still loaded (the
   * common tab-switch case): the graph — and with it every live node identity
   * and the scene's undo history — must be preserved, only the "active" pointer
   * moves. `setActiveSceneGraph` is the wrong tool there because it disposes and
   * replaces the graph.
   *
   * Returns `false` (and leaves the active pointer unchanged) if no graph is
   * registered under `sceneId`, so callers can detect a stale id instead of
   * silently pointing `getActiveSceneGraph()` at nothing.
   */
  setActiveScene(sceneId: string): boolean {
    if (!this.sceneGraphs.has(sceneId)) {
      return false;
    }
    this.activeSceneId = sceneId;
    return true;
  }

  getSceneGraph(sceneId: string): SceneGraph | null {
    const graph = this.sceneGraphs.get(sceneId) ?? null;

    return graph;
  }

  getActiveSceneGraph(): SceneGraph | null {
    if (!this.activeSceneId) {
      return null;
    }
    const graph = this.sceneGraphs.get(this.activeSceneId) ?? null;

    return graph;
  }

  /**
   * Resize root 2D layout containers to match viewport dimensions.
   *
   * @param width Viewport width in pixels
   * @param height Viewport height in pixels
   */
  resizeRoot(width: number, height: number, _skipLegacyLayoutRoot: boolean = false): void {
    const graph = this.getActiveSceneGraph();
    if (!graph) return;

    for (const node of graph.rootNodes) {
      if (node instanceof Node2D) {
        node.applyAnchoredLayoutRecursive({ width, height }, { width, height });
      }
    }
  }

  removeSceneGraph(sceneId: string): void {
    const graph = this.sceneGraphs.get(sceneId);
    if (graph) {
      this.disposeSceneGraph(graph);
    }
    this.sceneGraphs.delete(sceneId);
    this.groupMaps.delete(sceneId);
    if (this.activeSceneId === sceneId) {
      this.activeSceneId = null;
    }
  }

  addNodeToGroup(node: NodeBase, group: string, sceneId?: string): void {
    const resolvedSceneId = sceneId ?? this.activeSceneId;
    if (!resolvedSceneId) {
      return;
    }
    const groupMap = this.ensureGroupMap(resolvedSceneId);
    const nodes = groupMap.get(group) ?? new Set<NodeBase>();
    nodes.add(node);
    groupMap.set(group, nodes);
  }

  removeNodeFromGroup(node: NodeBase, group: string, sceneId?: string): void {
    const resolvedSceneId = sceneId ?? this.activeSceneId;
    if (!resolvedSceneId) {
      return;
    }
    const groupMap = this.ensureGroupMap(resolvedSceneId);
    const nodes = groupMap.get(group);
    if (!nodes) {
      return;
    }
    nodes.delete(node);
    if (nodes.size === 0) {
      groupMap.delete(group);
    }
  }

  getNodesInGroup(group: string, sceneId?: string): NodeBase[] {
    const resolvedSceneId = sceneId ?? this.activeSceneId;
    if (!resolvedSceneId) {
      return [];
    }
    const scene = this.sceneGraphs.get(resolvedSceneId);
    if (!scene) {
      return [];
    }

    const groupMap = this.ensureGroupMap(resolvedSceneId);
    const nodes = Array.from(groupMap.get(group) ?? []);
    const validNodes = nodes.filter(node => scene.nodeMap.has(node.nodeId));
    if (validNodes.length !== nodes.length) {
      this.groupMaps.set(resolvedSceneId, this.buildGroupMap(scene));
      return Array.from(this.groupMaps.get(resolvedSceneId)?.get(group) ?? []);
    }
    return validNodes;
  }

  callGroup(group: string, method: string, ...args: unknown[]): void {
    const nodes = this.getNodesInGroup(group);
    let invoked = 0;

    for (const node of nodes) {
      for (const component of node.components) {
        const candidate = (component as unknown as Record<string, unknown>)[method];
        if (typeof candidate === 'function') {
          (candidate as (...values: unknown[]) => void).apply(component, args);
          invoked += 1;
        }
      }
    }

    if (nodes.length > 0 && invoked === 0) {
      console.warn(`[SceneManager] callGroup("${group}", "${method}") found no callable methods.`);
    }
  }

  dispose(): void {
    for (const graph of this.sceneGraphs.values()) {
      this.disposeSceneGraph(graph);
    }
    this.sceneGraphs.clear();
    this.groupMaps.clear();
    this.activeSceneId = null;
  }

  /**
   * Free the GPU/runtime resources of every node in a scene graph. Call only
   * when the graph is being discarded (reload/replace, tab close, teardown) —
   * never for a graph whose nodes are still referenced (e.g. by undo history).
   */
  private disposeSceneGraph(graph: SceneGraph): void {
    for (const root of graph.rootNodes) {
      root.dispose();
    }
    graph.nodeMap.clear();
  }

  private ensureGroupMap(sceneId: string): Map<string, Set<NodeBase>> {
    const scene = this.sceneGraphs.get(sceneId);
    if (!scene) {
      return new Map<string, Set<NodeBase>>();
    }

    let groupMap = this.groupMaps.get(sceneId);
    if (!groupMap) {
      groupMap = this.buildGroupMap(scene);
      this.groupMaps.set(sceneId, groupMap);
    }
    return groupMap;
  }

  private buildGroupMap(scene: SceneGraph): Map<string, Set<NodeBase>> {
    const groupMap = new Map<string, Set<NodeBase>>();

    for (const node of scene.nodeMap.values()) {
      for (const group of node.groups) {
        const bucket = groupMap.get(group) ?? new Set<NodeBase>();
        bucket.add(node);
        groupMap.set(group, bucket);
      }
    }

    return groupMap;
  }
}
