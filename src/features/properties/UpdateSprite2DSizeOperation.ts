import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { SceneManager, Sprite2D } from '@pix3/runtime';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';

export interface UpdateSprite2DSizeParams {
  nodeId: string;
  width: number;
  height: number;
  aspectRatioLocked?: boolean;
}

export class UpdateSprite2DSizeOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.update-sprite2d-size',
    title: 'Update Sprite2D Size',
    description: 'Update Sprite2D width/height as a single operation',
    tags: ['property', 'transform', '2d', 'sprite'],
  };

  private readonly params: UpdateSprite2DSizeParams;

  constructor(params: UpdateSprite2DSizeParams) {
    this.params = params;
  }

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state, container } = context;
    const activeSceneId = state.scenes.activeSceneId;
    if (!activeSceneId) {
      return { didMutate: false };
    }

    if (!Number.isFinite(this.params.width) || this.params.width <= 0) {
      return { didMutate: false };
    }
    if (!Number.isFinite(this.params.height) || this.params.height <= 0) {
      return { didMutate: false };
    }

    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const sceneGraph = sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      return { didMutate: false };
    }

    const node = sceneGraph.nodeMap.get(this.params.nodeId);
    if (!(node instanceof Sprite2D)) {
      return { didMutate: false };
    }

    const previousWidth = node.width ?? 64;
    const previousHeight = node.height ?? 64;
    const previousAspectRatioLocked = node.aspectRatioLocked;
    const nextAspectRatioLocked = this.params.aspectRatioLocked ?? previousAspectRatioLocked;

    const widthChanged = previousWidth !== this.params.width;
    const heightChanged = previousHeight !== this.params.height;
    const lockChanged = previousAspectRatioLocked !== nextAspectRatioLocked;

    if (!widthChanged && !heightChanged && !lockChanged) {
      return { didMutate: false };
    }

    this.applyState(node, this.params.width, this.params.height, nextAspectRatioLocked);
    this.markSceneDirty(state, activeSceneId);
    this.updateViewport(container, node);

    return {
      didMutate: true,
      commit: {
        label: 'Update Sprite2D Size',
        beforeSnapshot: context.snapshot,
        undo: async () => {
          this.applyState(node, previousWidth, previousHeight, previousAspectRatioLocked);
          this.markSceneDirty(state, activeSceneId);
          this.updateViewport(container, node);
        },
        redo: async () => {
          this.applyState(node, this.params.width, this.params.height, nextAspectRatioLocked);
          this.markSceneDirty(state, activeSceneId);
          this.updateViewport(container, node);
        },
      },
    };
  }

  private applyState(
    node: Sprite2D,
    width: number,
    height: number,
    aspectRatioLocked: boolean
  ): void {
    node.width = width;
    node.height = height;
    node.aspectRatioLocked = aspectRatioLocked;
  }

  private markSceneDirty(state: OperationContext['state'], activeSceneId: string): void {
    state.scenes.lastLoadedAt = Date.now();
    const descriptor = state.scenes.descriptors[activeSceneId];
    if (descriptor) {
      descriptor.isDirty = true;
    }
  }

  private updateViewport(container: OperationContext['container'], node: Sprite2D): void {
    try {
      const viewport = container.getService<ViewportRendererService>(
        container.getOrCreateToken(ViewportRendererService)
      );
      viewport.updateNodeTransform(node);
      viewport.updateSelection();
      viewport.requestRender();
    } catch {
      // Ignore viewport update failures
    }
  }
}
