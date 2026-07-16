import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import type { AppStateSnapshot } from '@/state';

export interface SelectObjectParams {
  nodeId?: string | null;
  nodeIds?: string[];
  primaryNodeId?: string | null;
  additive?: boolean;
  range?: boolean;
  makePrimary?: boolean;
  /**
   * Figma-style isolation scope to set alongside the selection. Omit to leave
   * the current scope unchanged; pass `null` to pop back to the scene root; pass
   * a container nodeId to drill into it. Folded into the same undoable commit as
   * the selection so undo/redo restores selection and scope atomically.
   */
  focusNodeId?: string | null;
}

export class SelectObjectOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata;
  private readonly params: SelectObjectParams;

  constructor(params: SelectObjectParams) {
    this.params = params;
    this.metadata = {
      id: 'scene.select-object',
      title: 'Select Object',
      description: 'Select one or more objects in the scene hierarchy',
      tags: ['selection'],
      coalesceKey: undefined,
    };
  }

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state, snapshot } = context;
    const {
      nodeId = null,
      nodeIds,
      primaryNodeId = null,
      additive = false,
      range = false,
      makePrimary = false,
    } = this.params;

    const prevNodeIds = [...snapshot.selection.nodeIds];
    const prevPrimaryId = snapshot.selection.primaryNodeId;
    const prevFocusId = snapshot.selection.focusNodeId;

    const { newNodeIds, newPrimaryNodeId } = this.computeSelection(snapshot, {
      nodeId,
      nodeIds,
      primaryNodeId,
      additive,
      range,
      makePrimary,
    });

    // `focusNodeId` is optional in params: `undefined` leaves the current scope
    // untouched, an explicit value (including `null` = scene root) replaces it.
    const focusProvided = this.params.focusNodeId !== undefined;
    const newFocusId = focusProvided ? (this.params.focusNodeId ?? null) : prevFocusId;

    const selectionUnchanged =
      prevPrimaryId === newPrimaryNodeId &&
      prevNodeIds.length === newNodeIds.length &&
      prevNodeIds.every((id, i) => id === newNodeIds[i]);

    if (selectionUnchanged && prevFocusId === newFocusId) {
      return { didMutate: false };
    }

    state.selection.nodeIds = newNodeIds;
    state.selection.primaryNodeId = newPrimaryNodeId;
    state.selection.focusNodeId = newFocusId;

    return {
      didMutate: true,
      commit: {
        label: 'Select Object',
        beforeSnapshot: context.snapshot,
        undo: async () => {
          state.selection.nodeIds = [...prevNodeIds];
          state.selection.primaryNodeId = prevPrimaryId;
          state.selection.focusNodeId = prevFocusId;
        },
        redo: async () => {
          state.selection.nodeIds = [...newNodeIds];
          state.selection.primaryNodeId = newPrimaryNodeId;
          state.selection.focusNodeId = newFocusId;
        },
      },
    };
  }

  private computeSelection(
    snapshot: AppStateSnapshot,
    opts: Required<
      Omit<SelectObjectParams, 'nodeId' | 'nodeIds' | 'primaryNodeId' | 'focusNodeId'>
    > & {
      nodeId: string | null;
      nodeIds?: string[];
      primaryNodeId: string | null;
    }
  ): { newNodeIds: string[]; newPrimaryNodeId: string | null } {
    const { nodeId, nodeIds, primaryNodeId, additive, range, makePrimary } = opts;

    if (Array.isArray(nodeIds)) {
      const uniqueNodeIds = Array.from(
        new Set(nodeIds.filter((id): id is string => typeof id === 'string' && id.length > 0))
      );
      const nextPrimaryNodeId =
        uniqueNodeIds.length === 0
          ? null
          : primaryNodeId && uniqueNodeIds.includes(primaryNodeId)
            ? primaryNodeId
            : (uniqueNodeIds[0] ?? null);

      return {
        newNodeIds: uniqueNodeIds,
        newPrimaryNodeId: nextPrimaryNodeId,
      };
    }

    if (nodeId === null) {
      return { newNodeIds: [], newPrimaryNodeId: null };
    }

    if (range && snapshot.selection.primaryNodeId) {
      const sceneHierarchy = this.getActiveSceneHierarchy(snapshot);
      if (sceneHierarchy) {
        const allNodeIds = this.collectAllNodeIds(
          sceneHierarchy.rootNodes as readonly {
            nodeId?: string;
            id?: string;
            children?: unknown[];
          }[]
        );
        const primaryIndex = allNodeIds.indexOf(snapshot.selection.primaryNodeId);
        const targetIndex = allNodeIds.indexOf(nodeId);

        if (primaryIndex !== -1 && targetIndex !== -1) {
          const startIndex = Math.min(primaryIndex, targetIndex);
          const endIndex = Math.max(primaryIndex, targetIndex);
          const selection = allNodeIds.slice(startIndex, endIndex + 1);
          return { newNodeIds: selection, newPrimaryNodeId: snapshot.selection.primaryNodeId };
        }
      }
      return { newNodeIds: [nodeId], newPrimaryNodeId: nodeId };
    }

    if (additive) {
      const current = new Set(snapshot.selection.nodeIds);
      if (current.has(nodeId)) {
        current.delete(nodeId);
        const ids = Array.from(current);
        const newPrimary =
          snapshot.selection.primaryNodeId === nodeId
            ? ids.length > 0
              ? ids[0]
              : null
            : snapshot.selection.primaryNodeId;
        return { newNodeIds: ids, newPrimaryNodeId: newPrimary };
      }
      current.add(nodeId);
      const ids = Array.from(current);
      const newPrimary =
        makePrimary || !snapshot.selection.primaryNodeId
          ? nodeId
          : snapshot.selection.primaryNodeId;
      return { newNodeIds: ids, newPrimaryNodeId: newPrimary };
    }

    return { newNodeIds: [nodeId], newPrimaryNodeId: nodeId };
  }

  private getActiveSceneHierarchy(snapshot: AppStateSnapshot) {
    const activeSceneId = snapshot.scenes.activeSceneId;
    return activeSceneId ? snapshot.scenes.hierarchies[activeSceneId] : null;
  }

  private collectAllNodeIds(
    nodes: readonly { nodeId?: string; id?: string; children?: unknown[] }[]
  ): string[] {
    const result: string[] = [];
    const collect = (list: readonly { nodeId?: string; id?: string; children?: unknown[] }[]) => {
      for (const node of list) {
        const id = node.nodeId ?? node.id;
        if (typeof id === 'string' && id.length > 0) {
          result.push(id);
        }
        if (Array.isArray(node.children) && node.children.length) {
          collect(
            node.children as readonly { nodeId?: string; id?: string; children?: unknown[] }[]
          );
        }
      }
    };
    collect(nodes);
    return result;
  }
}
