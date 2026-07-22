import { MathUtils } from 'three';
import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { Node3D } from '@pix3/runtime';
import { SceneManager } from '@pix3/runtime';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';

export interface TransformState {
  position?: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
}

export interface TransformCompleteParams {
  nodeId: string;
  previousState: TransformState;
  currentState: TransformState;
}

export class TransformCompleteOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.transform-complete',
    title: 'Transform Object',
    description: 'Complete a transform operation on a scene object',
    tags: ['property', 'transform'],
  };

  private readonly params: TransformCompleteParams;

  constructor(params: TransformCompleteParams) {
    this.params = params;
  }

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { container, state } = context;
    const { nodeId, previousState, currentState } = this.params;

    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const sceneGraph = sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      return { didMutate: false };
    }

    const node = sceneGraph.nodeMap.get(nodeId);
    if (!node || !(node instanceof Node3D)) {
      return { didMutate: false };
    }

    // Check if anything actually changed
    if (this.isStateEqual(previousState, currentState)) {
      return { didMutate: false };
    }

    // Apply current state to node
    this.applyState(node, currentState);

    const activeSceneId = state.scenes.activeSceneId;
    if (activeSceneId) {
      state.scenes.lastLoadedAt = Date.now();
      const descriptor = state.scenes.descriptors[activeSceneId];
      if (descriptor) descriptor.isDirty = true;
    }

    try {
      const vr = container.getService<ViewportRendererService>(
        container.getOrCreateToken(ViewportRendererService)
      );
      vr.updateNodeTransform(node);
      // eslint-disable-next-line no-empty
    } catch {}

    return {
      didMutate: true,
      commit: {
        label: 'Transform Object',
        beforeSnapshot: context.snapshot,
        undo: async () => {
          this.applyState(node, previousState);
          if (activeSceneId) {
            state.scenes.lastLoadedAt = Date.now();
            const descriptor = state.scenes.descriptors[activeSceneId];
            if (descriptor) descriptor.isDirty = true;
          }
          try {
            const vr = container.getService<ViewportRendererService>(
              container.getOrCreateToken(ViewportRendererService)
            );
            vr.updateNodeTransform(node);
            // eslint-disable-next-line no-empty
          } catch {}
        },
        redo: async () => {
          this.applyState(node, currentState);
          if (activeSceneId) {
            state.scenes.lastLoadedAt = Date.now();
            const descriptor = state.scenes.descriptors[activeSceneId];
            if (descriptor) descriptor.isDirty = true;
          }
          try {
            const vr = container.getService<ViewportRendererService>(
              container.getOrCreateToken(ViewportRendererService)
            );
            vr.updateNodeTransform(node);
            // eslint-disable-next-line no-empty
          } catch {}
        },
      },
    };
  }

  private applyState(node: Node3D, state: TransformState): void {
    if (state.position) {
      node.position.set(state.position.x, state.position.y, state.position.z);
    }
    if (state.rotation) {
      // Rotation is stored in degrees but needs to be converted to radians
      node.rotation.set(
        MathUtils.degToRad(state.rotation.x),
        MathUtils.degToRad(state.rotation.y),
        MathUtils.degToRad(state.rotation.z)
      );
    }
    if (state.scale) {
      node.scale.set(state.scale.x, state.scale.y, state.scale.z);
    }
  }

  private isStateEqual(state1: TransformState, state2: TransformState): boolean {
    const eps = 0.0001;

    // Compare positions
    if (state1.position && state2.position) {
      if (
        Math.abs(state1.position.x - state2.position.x) > eps ||
        Math.abs(state1.position.y - state2.position.y) > eps ||
        Math.abs(state1.position.z - state2.position.z) > eps
      ) {
        return false;
      }
    } else if (state1.position || state2.position) {
      return false;
    }

    // Compare rotations
    if (state1.rotation && state2.rotation) {
      if (
        Math.abs(state1.rotation.x - state2.rotation.x) > eps ||
        Math.abs(state1.rotation.y - state2.rotation.y) > eps ||
        Math.abs(state1.rotation.z - state2.rotation.z) > eps
      ) {
        return false;
      }
    } else if (state1.rotation || state2.rotation) {
      return false;
    }

    // Compare scales
    if (state1.scale && state2.scale) {
      if (
        Math.abs(state1.scale.x - state2.scale.x) > eps ||
        Math.abs(state1.scale.y - state2.scale.y) > eps ||
        Math.abs(state1.scale.z - state2.scale.z) > eps
      ) {
        return false;
      }
    } else if (state1.scale || state2.scale) {
      return false;
    }

    return true;
  }
}
