import type { NodeBase } from '../nodes/NodeBase';
import { SceneLoader, type ParseSceneOptions } from './SceneLoader';
import type { SavedSceneDocument, SceneSaver } from './SceneSaver';
export interface SceneGraph {
    version: string;
    description?: string;
    rootNodes: NodeBase[];
    nodeMap: Map<string, NodeBase>;
    metadata: Record<string, unknown>;
}
export declare class SceneManager {
    private readonly sceneLoader;
    private readonly sceneSaver;
    private readonly sceneGraphs;
    private readonly groupMaps;
    private activeSceneId;
    /**
     * `sceneSaver` is optional: only hosts that write scenes back out (the editor)
     * need it. A runtime player that omits it keeps the serializer out of its
     * bundle entirely; {@link serializeScene} then throws instead of silently
     * returning nothing.
     */
    constructor(sceneLoader: SceneLoader, sceneSaver?: SceneSaver | null);
    /** Runtime prefab spawn — see {@link SceneLoader.instantiatePrefab}. */
    instantiatePrefab(instancePath: string, instanceId: string): Promise<NodeBase>;
    /**
     * Attach every component that could not be instantiated when its scene loaded because the script
     * type was not registered yet. The editor calls this after project scripts compile — that is the
     * moment `user:*` types appear, and before this existed the scene had already dropped them (and
     * the next save wrote the loss to disk).
     *
     * @returns how many components were attached across all open scenes.
     */
    resolvePendingComponents(): number;
    parseScene(sceneText: string, options?: ParseSceneOptions): Promise<SceneGraph>;
    serializeScene(graph: SceneGraph): string;
    /** The document {@link serializeScene} would stringify, as plain objects (no YAML). */
    serializeSceneDocument(graph: SceneGraph): SavedSceneDocument;
    setActiveSceneGraph(sceneId: string, graph: SceneGraph, options?: {
        readonly disposePrevious?: boolean;
    }): void;
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
    setActiveScene(sceneId: string): boolean;
    getSceneGraph(sceneId: string): SceneGraph | null;
    getActiveSceneGraph(): SceneGraph | null;
    /**
     * Resize root 2D layout containers to match viewport dimensions.
     *
     * @param width Viewport width in pixels
     * @param height Viewport height in pixels
     */
    resizeRoot(width: number, height: number, _skipLegacyLayoutRoot?: boolean): void;
    removeSceneGraph(sceneId: string): void;
    addNodeToGroup(node: NodeBase, group: string, sceneId?: string): void;
    removeNodeFromGroup(node: NodeBase, group: string, sceneId?: string): void;
    getNodesInGroup(group: string, sceneId?: string): NodeBase[];
    callGroup(group: string, method: string, ...args: unknown[]): void;
    dispose(): void;
    /**
     * Free the GPU/runtime resources of every node in a scene graph. Call only
     * when the graph is being discarded (reload/replace, tab close, teardown) —
     * never for a graph whose nodes are still referenced (e.g. by undo history).
     */
    private disposeSceneGraph;
    private ensureGroupMap;
    private buildGroupMap;
}
