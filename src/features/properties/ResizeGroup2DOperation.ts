import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { BulkOperationBuilder } from '@/core/BulkOperation';
import {
  Transform2DCompleteOperation,
  type Transform2DCompleteParams,
} from '@/features/properties/Transform2DCompleteOperation';
import { buildProportionalResizePlans } from '@/features/scene/group2d-resize-utils';
import { ViewportRendererService } from '@/services/ViewportRenderService';
import { Group2D, SceneManager } from '@pix3/runtime';

export interface ResizeGroup2DParams {
  nodeId: string;
  width: number;
  height: number;
}

/**
 * Resize a Group2D to `(width, height)` and proportionally scale its children's positions and sizes
 * about the group's center origin (§B of the design — Figma-style group resize). Anchored
 * (`layoutEnabled`) children are left to the runtime anchor reflow. One undoable step: the group's
 * own size plan first (so its reflow runs before the explicit child plans), then the descendant
 * plans, composed via {@link BulkOperationBuilder}.
 */
export class ResizeGroup2DOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.resize-group2d',
    title: 'Resize Group',
    description: 'Resize a Group2D and proportionally scale its children',
    tags: ['property', 'transform', '2d', 'group'],
  };

  constructor(private readonly params: ResizeGroup2DParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state, container } = context;
    const activeSceneId = state.scenes.activeSceneId;
    if (!activeSceneId) {
      return { didMutate: false };
    }

    const { width, height } = this.params;
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      return { didMutate: false };
    }

    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const sceneGraph = sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      return { didMutate: false };
    }

    const group = sceneGraph.nodeMap.get(this.params.nodeId);
    if (!(group instanceof Group2D)) {
      return { didMutate: false };
    }

    const oldWidth = group.width;
    const oldHeight = group.height;
    if (oldWidth === width && oldHeight === height) {
      return { didMutate: false };
    }

    const plans: Transform2DCompleteParams[] = [
      {
        nodeId: group.nodeId,
        previousState: { width: oldWidth, height: oldHeight },
        currentState: { width, height },
      },
      ...buildProportionalResizePlans(
        group,
        { width: oldWidth, height: oldHeight },
        { width, height }
      ),
    ];

    const bulk = new BulkOperationBuilder();
    for (const plan of plans) {
      const result = await new Transform2DCompleteOperation(plan).perform(context);
      if (result.didMutate && result.commit) {
        bulk.add(result.commit);
      }
    }

    if (bulk.isEmpty()) {
      return { didMutate: false };
    }

    const viewportRenderer = container.getService<ViewportRendererService>(
      container.getOrCreateToken(ViewportRendererService)
    );
    const refreshOverlay = (): void => {
      try {
        viewportRenderer.updateSelection();
        viewportRenderer.requestRender();
      } catch {
        // viewport may not be initialized (e.g. headless tests) — ignore
      }
    };

    const commit = bulk.build('Resize Group');
    refreshOverlay();

    return {
      didMutate: true,
      commit: {
        ...commit,
        undo: async () => {
          await commit.undo();
          refreshOverlay();
        },
        redo: async () => {
          await commit.redo();
          refreshOverlay();
        },
      },
    };
  }
}
