import { Vector3 } from 'three';
import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { Node3D } from '@pix3/runtime';
import { Camera3D } from '@pix3/runtime';
import { DirectionalLightNode } from '@pix3/runtime';
import { SpotLightNode } from '@pix3/runtime';
import { SceneManager } from '@pix3/runtime';
import { ViewportRendererService } from '@/services/ViewportRenderService';

export interface TargetTransformState {
  position: { x: number; y: number; z: number };
}

export interface TargetTransformParams {
  nodeId: string;
  previousTargetPos: { x: number; y: number; z: number };
  currentTargetPos: { x: number; y: number; z: number };
}

export class TargetTransformOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.target-transform',
    title: 'Transform Target',
    description: 'Transform a camera or light target',
    tags: ['property', 'transform', 'target'],
  };

  private readonly params: TargetTransformParams;

  constructor(params: TargetTransformParams) {
    this.params = params;
  }

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { container, state } = context;
    const { nodeId, previousTargetPos, currentTargetPos } = this.params;

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

    const previousPos = new Vector3(previousTargetPos.x, previousTargetPos.y, previousTargetPos.z);
    const currentPos = new Vector3(currentTargetPos.x, currentTargetPos.y, currentTargetPos.z);

    if (previousPos.distanceTo(currentPos) < 0.0001) {
      return { didMutate: false };
    }

    this.applyTargetTransform(node, currentPos);

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
        label: 'Transform Target',
        beforeSnapshot: context.snapshot,
        undo: async () => {
          this.applyTargetTransform(node, previousPos);
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
          this.applyTargetTransform(node, currentPos);
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

  private applyTargetTransform(node: Node3D, targetPos: Vector3): void {
    if (node instanceof Camera3D) {
      node.setTargetPosition(targetPos);
    } else if (node instanceof DirectionalLightNode) {
      node.setTargetPosition(targetPos);
    } else if (node instanceof SpotLightNode) {
      node.setTargetPosition(targetPos);
    }
  }
}
