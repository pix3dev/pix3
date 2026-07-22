import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { BulkOperationBuilder } from '@/core/BulkOperation';
import { Transform2DCompleteOperation } from '@/features/properties/Transform2DCompleteOperation';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { Group2D, SceneManager } from '@pix3/runtime';
import { buildFitPlans, computeContentsLocalRect } from './group2d-resize-utils';

export interface FitGroup2DToContentsParams {
  nodeId: string;
}

/**
 * Resize a Group2D so its box wraps its contents, without moving any child in world space (§A of the
 * design). Composes a group plan + per-direct-child compensation plans into one undoable step,
 * mirroring {@link Align2DNodesOperation}.
 */
export class FitGroup2DToContentsOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.fit-group2d-to-contents',
    title: 'Fit Group to Contents',
    description: 'Resize a Group2D to wrap its children without moving them in world space',
    tags: ['scene', '2d', 'layout', 'group'],
  };

  constructor(private readonly params: FitGroup2DToContentsParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state, container } = context;
    const activeSceneId = state.scenes.activeSceneId;
    if (!activeSceneId) {
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

    const viewportRenderer = container.getService<ViewportRendererService>(
      container.getOrCreateToken(ViewportRendererService)
    );

    const rect = computeContentsLocalRect(group, node =>
      viewportRenderer.getNodeOnlyLocalCorners(node)
    );
    if (!rect) {
      return { didMutate: false };
    }

    const plans = buildFitPlans(group, rect);
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

    const refreshOverlay = (): void => {
      try {
        viewportRenderer.updateSelection();
        viewportRenderer.requestRender();
      } catch {
        // viewport may not be initialized (e.g. headless tests) — ignore
      }
    };

    const commit = bulk.build('Fit Group to Contents');
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
