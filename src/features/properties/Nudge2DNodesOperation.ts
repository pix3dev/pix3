import * as THREE from 'three';
import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { BulkOperationBuilder } from '@/core/BulkOperation';
import {
  Transform2DCompleteOperation,
  type Transform2DState,
} from '@/features/properties/Transform2DCompleteOperation';
import { Node2D, SceneManager } from '@pix3/runtime';

export interface Nudge2DNodesParams {
  /** World-space horizontal delta to apply to every target node. */
  dx: number;
  /** World-space vertical delta (screen up is positive, matching drag). */
  dy: number;
  /** Ids of the nodes to nudge. Non-2D ids are ignored. */
  nodeIds: string[];
}

/**
 * Moves one or more 2D nodes by a fixed world-space delta as a single,
 * batched history entry. Used by the arrow-key nudge commands. The actual
 * per-node mutation (and layout reflow) is delegated to
 * {@link Transform2DCompleteOperation} so behaviour matches dragging.
 */
export class Nudge2DNodesOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.nudge-2d-nodes',
    title: 'Nudge 2D Nodes',
    description: 'Move selected 2D nodes by a fixed step',
    tags: ['scene', 'transform', '2d', 'nudge'],
  };

  constructor(private readonly params: Nudge2DNodesParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { container } = context;
    const { dx, dy, nodeIds } = this.params;

    if (dx === 0 && dy === 0) {
      return { didMutate: false };
    }

    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const sceneGraph = sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      return { didMutate: false };
    }

    const nodes = nodeIds
      .map(nodeId => sceneGraph.nodeMap.get(nodeId) ?? null)
      .filter((node): node is Node2D => node instanceof Node2D);
    if (nodes.length === 0) {
      return { didMutate: false };
    }

    const bulk = new BulkOperationBuilder();
    for (const node of nodes) {
      const plan = this.createNodePlan(node, dx, dy);
      const result = await new Transform2DCompleteOperation(plan).perform(context);
      if (result.didMutate && result.commit) {
        bulk.add(result.commit);
      }
    }

    if (bulk.isEmpty()) {
      return { didMutate: false };
    }

    const label = nodes.length > 1 ? 'Move 2D Nodes' : 'Move 2D Node';
    return {
      didMutate: true,
      commit: bulk.build(label),
    };
  }

  /**
   * Builds a transform plan that shifts a node by (dx, dy) in world space.
   * The delta is applied in world coordinates (so nudging behaves identically
   * regardless of parent transforms) and then converted back to local space,
   * matching how Align2DNodesOperation moves nodes.
   */
  private createNodePlan(
    node: Node2D,
    dx: number,
    dy: number
  ): { nodeId: string; previousState: Transform2DState; currentState: Transform2DState } {
    node.updateWorldMatrix(true, false);
    const targetWorld = node
      .getWorldPosition(new THREE.Vector3())
      .add(new THREE.Vector3(dx, dy, 0));

    const targetLocal = targetWorld.clone();
    const parentNode = node.parentNode;
    if (parentNode) {
      parentNode.updateWorldMatrix(true, false);
      parentNode.worldToLocal(targetLocal);
    }

    return {
      nodeId: node.nodeId,
      previousState: {
        position: { x: node.position.x, y: node.position.y },
      },
      currentState: {
        position: { x: targetLocal.x, y: targetLocal.y },
      },
    };
  }
}
