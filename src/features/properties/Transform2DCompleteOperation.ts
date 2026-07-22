import { MathUtils } from 'three';
import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { SceneManager } from '@pix3/runtime';
import { Node2D } from '@pix3/runtime';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';

export interface Transform2DState {
  position?: { x: number; y: number };
  rotation?: number; // degrees
  scale?: { x: number; y: number };
  width?: number;
  height?: number;
}

export interface Transform2DCompleteParams {
  nodeId: string;
  previousState: Transform2DState;
  currentState: Transform2DState;
}

export class Transform2DCompleteOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.transform2d-complete',
    title: 'Transform 2D Object',
    description: 'Complete a 2D transform operation on a scene object',
    tags: ['property', 'transform', '2d'],
  };

  private readonly params: Transform2DCompleteParams;

  constructor(params: Transform2DCompleteParams) {
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
    if (!node || !(node instanceof Node2D)) {
      return { didMutate: false };
    }

    if (this.isStateEqual(previousState, currentState)) {
      return { didMutate: false };
    }

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
        label: 'Transform 2D Object',
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

  private applyState(node: Node2D, state: Transform2DState): void {
    if (state.position) {
      node.position.set(state.position.x, state.position.y, node.position.z);
    }
    if (typeof state.rotation === 'number') {
      node.rotation.set(0, 0, MathUtils.degToRad(state.rotation));
    }
    if (state.scale) {
      node.scale.set(state.scale.x, state.scale.y, 1);
    }

    const dimsNode = node as Node2D & { width?: number; height?: number };
    const canSize = typeof dimsNode.width === 'number' && typeof dimsNode.height === 'number';
    if (canSize) {
      if (typeof state.width === 'number') {
        dimsNode.width = state.width;
      }
      if (typeof state.height === 'number') {
        dimsNode.height = state.height;
      }
    }

    node.captureAuthoredLayoutRectFromCurrent();
    if (node.isContainer && (typeof state.width === 'number' || typeof state.height === 'number')) {
      node.reflowAnchoredChildren();
      this.captureAnchoredDescendantRects(node);
    }
  }

  private isStateEqual(a: Transform2DState, b: Transform2DState): boolean {
    const eps = 0.0001;

    if (a.position && b.position) {
      if (
        Math.abs(a.position.x - b.position.x) > eps ||
        Math.abs(a.position.y - b.position.y) > eps
      ) {
        return false;
      }
    } else if (a.position || b.position) {
      return false;
    }

    if (typeof a.rotation === 'number' && typeof b.rotation === 'number') {
      if (Math.abs(a.rotation - b.rotation) > eps) {
        return false;
      }
    } else if (typeof a.rotation === 'number' || typeof b.rotation === 'number') {
      return false;
    }

    if (a.scale && b.scale) {
      if (Math.abs(a.scale.x - b.scale.x) > eps || Math.abs(a.scale.y - b.scale.y) > eps) {
        return false;
      }
    } else if (a.scale || b.scale) {
      return false;
    }

    if (typeof a.width === 'number' && typeof b.width === 'number') {
      if (Math.abs(a.width - b.width) > eps) {
        return false;
      }
    } else if (typeof a.width === 'number' || typeof b.width === 'number') {
      return false;
    }

    if (typeof a.height === 'number' && typeof b.height === 'number') {
      if (Math.abs(a.height - b.height) > eps) {
        return false;
      }
    } else if (typeof a.height === 'number' || typeof b.height === 'number') {
      return false;
    }

    return true;
  }

  private captureAnchoredDescendantRects(parent: Node2D): void {
    for (const child of parent.children) {
      if (child instanceof Node2D) {
        child.captureAuthoredLayoutRectFromCurrent();
        this.captureAnchoredDescendantRects(child);
      }
    }
  }
}
