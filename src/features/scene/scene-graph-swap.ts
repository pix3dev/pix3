import { ref } from 'valtio/vanilla';
import type { SceneGraph, SceneManager } from '@pix3/runtime';
import type { AppState } from '@/state';

/**
 * Install `graph` as the graph of `sceneId` WITHOUT disposing the one it replaces, so an undoable
 * whole-graph operation (accept the agent's version, restore a journal version) can swap the
 * previous instance back on undo — with its node identities intact, every history entry recorded
 * against either instance keeps working after undo and redo.
 *
 * Keeps the selection of the nodes that still exist (by id), leaves the camera state and the scene
 * tree's collapsed ids alone (both are keyed by scene/node id), marks the scene dirty so autosave
 * writes it, and leaves `SceneManager`'s active scene pointer where it was.
 */
export function installSceneGraph(
  state: AppState,
  sceneManager: SceneManager,
  sceneId: string,
  graph: SceneGraph
): void {
  const previouslyActive = state.scenes.activeSceneId;
  sceneManager.setActiveSceneGraph(sceneId, graph, { disposePrevious: false });
  if (previouslyActive && previouslyActive !== sceneId) {
    sceneManager.setActiveScene(previouslyActive);
  }
  state.scenes.hierarchies[sceneId] = {
    version: graph.version ?? null,
    description: graph.description ?? null,
    rootNodes: ref(graph.rootNodes),
    metadata: graph.metadata ?? {},
  };
  if (state.scenes.activeSceneId === sceneId) {
    const keep = (id: string) => graph.nodeMap.has(id);
    const kept = state.selection.nodeIds.filter(keep);
    if (kept.length !== state.selection.nodeIds.length) state.selection.nodeIds = kept;
    if (state.selection.primaryNodeId && !keep(state.selection.primaryNodeId)) {
      state.selection.primaryNodeId = kept[0] ?? null;
    }
  }
  const descriptor = state.scenes.descriptors[sceneId];
  if (descriptor) descriptor.isDirty = true;
  state.scenes.lastLoadedAt = Date.now();
  state.scenes.nodeDataChangeSignal = state.scenes.nodeDataChangeSignal + 1;
}
