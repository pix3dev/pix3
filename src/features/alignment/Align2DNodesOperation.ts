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
import { DEFAULT_VIEWPORT_BASE_HEIGHT, DEFAULT_VIEWPORT_BASE_WIDTH } from '@/core/ProjectManifest';
import { ViewportRendererService } from '@/services/ViewportRenderService';
import { Node2D, type NodeBase, SceneManager } from '@pix3/runtime';
import type { Align2DActionId } from './types';

export interface Align2DNodesOperationParams {
  action: Align2DActionId;
  nodeIds?: string[];
}

interface Rect2D {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

interface NodePlan {
  nodeId: string;
  previousState: Transform2DState;
  currentState: Transform2DState;
}

interface NodeEntry {
  node: Node2D;
  rect: Rect2D;
}

const POSITION_EPSILON = 0.0001;

export class Align2DNodesOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.align-2d-nodes',
    title: 'Align 2D Nodes',
    description:
      'Align selected 2D nodes to a container, selection bounds, or distribution pattern',
    tags: ['scene', 'alignment', '2d', 'layout'],
  };

  constructor(private readonly params: Align2DNodesOperationParams) {}

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

    const targetNodeIds = Array.from(new Set(this.params.nodeIds ?? state.selection.nodeIds));
    if (targetNodeIds.length === 0) {
      return { didMutate: false };
    }

    const selectedNodes = targetNodeIds
      .map(nodeId => sceneGraph.nodeMap.get(nodeId) ?? null)
      .filter((node): node is NodeBase => node !== null);

    if (selectedNodes.length === 0) {
      return { didMutate: false };
    }

    const nodes = selectedNodes.filter((node): node is Node2D => node instanceof Node2D);
    if (nodes.length === 0) {
      return { didMutate: false };
    }

    const viewportRenderer = container.getService<ViewportRendererService>(
      container.getOrCreateToken(ViewportRendererService)
    );

    const entries = nodes.map(node => ({
      node,
      rect: this.toRect(viewportRenderer.getNode2DBounds(node)),
    }));

    const plans = this.buildPlans(
      entries,
      viewportRenderer,
      state.project.manifest?.viewportBaseSize
    );
    if (plans.length === 0) {
      return { didMutate: false };
    }

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

    return {
      didMutate: true,
      commit: bulk.build(this.getActionLabel(this.params.action)),
    };
  }

  private buildPlans(
    entries: NodeEntry[],
    viewportRenderer: ViewportRendererService,
    viewportBaseSize:
      | {
          width: number;
          height: number;
        }
      | undefined
  ): NodePlan[] {
    if (entries.length === 0) {
      return [];
    }

    if (this.isContainerAction(this.params.action)) {
      const referenceRect = this.resolveContainerRect(entries, viewportRenderer, viewportBaseSize);
      if (!referenceRect) {
        return [];
      }
      return this.buildAlignmentPlans(
        entries,
        referenceRect,
        this.getAxisAction(this.params.action)
      );
    }

    if (this.isSelectionAction(this.params.action)) {
      if (entries.length < 2) {
        return [];
      }
      const referenceRect = this.unionRects(entries.map(entry => entry.rect));
      return this.buildAlignmentPlans(
        entries,
        referenceRect,
        this.getAxisAction(this.params.action)
      );
    }

    return this.buildDistributionPlans(entries, this.params.action);
  }

  private buildAlignmentPlans(
    entries: NodeEntry[],
    referenceRect: Rect2D,
    axisAction: 'left' | 'right' | 'top' | 'bottom' | 'center-x' | 'center-y'
  ): NodePlan[] {
    return entries
      .map(entry => {
        let deltaX = 0;
        let deltaY = 0;

        switch (axisAction) {
          case 'left':
            deltaX = referenceRect.left - entry.rect.left;
            break;
          case 'right':
            deltaX = referenceRect.right - entry.rect.right;
            break;
          case 'top':
            deltaY = referenceRect.top - entry.rect.top;
            break;
          case 'bottom':
            deltaY = referenceRect.bottom - entry.rect.bottom;
            break;
          case 'center-x':
            deltaX = referenceRect.centerX - entry.rect.centerX;
            break;
          case 'center-y':
            deltaY = referenceRect.centerY - entry.rect.centerY;
            break;
        }

        return this.createNodePlan(entry.node, deltaX, deltaY);
      })
      .filter((plan): plan is NodePlan => plan !== null);
  }

  private buildDistributionPlans(entries: NodeEntry[], action: Align2DActionId): NodePlan[] {
    if (entries.length < 3) {
      return [];
    }

    switch (action) {
      case 'distribute-gap-x':
        return this.buildGapDistributionPlans(entries, 'x');
      case 'distribute-gap-y':
        return this.buildGapDistributionPlans(entries, 'y');
      case 'distribute-center-x':
        return this.buildCenterDistributionPlans(entries, 'x');
      case 'distribute-center-y':
        return this.buildCenterDistributionPlans(entries, 'y');
      default:
        return [];
    }
  }

  private buildGapDistributionPlans(entries: NodeEntry[], axis: 'x' | 'y'): NodePlan[] {
    const sorted = this.sortEntries(entries, axis === 'x' ? 'left' : 'top', axis === 'y');
    const totalExtent =
      axis === 'x'
        ? sorted[sorted.length - 1].rect.right - sorted[0].rect.left
        : sorted[0].rect.top - sorted[sorted.length - 1].rect.bottom;
    const totalNodeSize = sorted.reduce(
      (sum, entry) => sum + (axis === 'x' ? entry.rect.width : entry.rect.height),
      0
    );
    const gap = (totalExtent - totalNodeSize) / (sorted.length - 1);

    let cursor = axis === 'x' ? sorted[0].rect.left : sorted[0].rect.top;

    return sorted
      .map(entry => {
        const deltaX = axis === 'x' ? cursor - entry.rect.left : 0;
        const deltaY = axis === 'y' ? cursor - entry.rect.top : 0;
        const plan = this.createNodePlan(entry.node, deltaX, deltaY);

        cursor += axis === 'x' ? entry.rect.width + gap : -(entry.rect.height + gap);
        return plan;
      })
      .filter((plan): plan is NodePlan => plan !== null);
  }

  private buildCenterDistributionPlans(entries: NodeEntry[], axis: 'x' | 'y'): NodePlan[] {
    const sorted = this.sortEntries(entries, axis === 'x' ? 'centerX' : 'centerY', axis === 'y');
    const firstCenter = axis === 'x' ? sorted[0].rect.centerX : sorted[0].rect.centerY;
    const lastCenter =
      axis === 'x'
        ? sorted[sorted.length - 1].rect.centerX
        : sorted[sorted.length - 1].rect.centerY;
    const step = (lastCenter - firstCenter) / (sorted.length - 1);

    return sorted
      .map((entry, index) => {
        const targetCenter = firstCenter + step * index;
        const deltaX = axis === 'x' ? targetCenter - entry.rect.centerX : 0;
        const deltaY = axis === 'y' ? targetCenter - entry.rect.centerY : 0;
        return this.createNodePlan(entry.node, deltaX, deltaY);
      })
      .filter((plan): plan is NodePlan => plan !== null);
  }

  private createNodePlan(node: Node2D, deltaX: number, deltaY: number): NodePlan | null {
    if (Math.abs(deltaX) <= POSITION_EPSILON && Math.abs(deltaY) <= POSITION_EPSILON) {
      return null;
    }

    node.updateWorldMatrix(true, false);
    const currentWorldPosition = node.getWorldPosition(new THREE.Vector3());
    const targetWorldPosition = currentWorldPosition.add(new THREE.Vector3(deltaX, deltaY, 0));
    const targetLocalPosition = targetWorldPosition.clone();
    const parentNode = node.parentNode;
    if (parentNode) {
      parentNode.updateWorldMatrix(true, false);
      parentNode.worldToLocal(targetLocalPosition);
    }

    return {
      nodeId: node.nodeId,
      previousState: {
        position: {
          x: node.position.x,
          y: node.position.y,
        },
      },
      currentState: {
        position: {
          x: targetLocalPosition.x,
          y: targetLocalPosition.y,
        },
      },
    };
  }

  private resolveContainerRect(
    entries: NodeEntry[],
    viewportRenderer: ViewportRendererService,
    viewportBaseSize:
      | {
          width: number;
          height: number;
        }
      | undefined
  ): Rect2D | null {
    const sharedParent = entries[0]?.node.parentNode ?? null;
    const sharesParent = entries.every(entry => entry.node.parentNode === sharedParent);
    if (!sharesParent) {
      return null;
    }

    if (sharedParent === null) {
      return this.getViewportBaseRect(viewportBaseSize);
    }

    if (!(sharedParent instanceof Node2D)) {
      return null;
    }

    return this.toRect(viewportRenderer.getNode2DBounds(sharedParent));
  }

  private getViewportBaseRect(
    viewportBaseSize:
      | {
          width: number;
          height: number;
        }
      | undefined
  ): Rect2D {
    const width =
      typeof viewportBaseSize?.width === 'number' && Number.isFinite(viewportBaseSize.width)
        ? viewportBaseSize.width
        : DEFAULT_VIEWPORT_BASE_WIDTH;
    const height =
      typeof viewportBaseSize?.height === 'number' && Number.isFinite(viewportBaseSize.height)
        ? viewportBaseSize.height
        : DEFAULT_VIEWPORT_BASE_HEIGHT;

    return this.createRect(-width / 2, width / 2, height / 2, -height / 2);
  }

  private unionRects(rects: Rect2D[]): Rect2D {
    const left = Math.min(...rects.map(rect => rect.left));
    const right = Math.max(...rects.map(rect => rect.right));
    const top = Math.max(...rects.map(rect => rect.top));
    const bottom = Math.min(...rects.map(rect => rect.bottom));
    return this.createRect(left, right, top, bottom);
  }

  private sortEntries(
    entries: NodeEntry[],
    metric: 'left' | 'top' | 'centerX' | 'centerY',
    descending: boolean
  ): NodeEntry[] {
    return [...entries].sort((a, b) => {
      const metricDelta = descending
        ? b.rect[metric] - a.rect[metric]
        : a.rect[metric] - b.rect[metric];

      if (Math.abs(metricDelta) > POSITION_EPSILON) {
        return metricDelta;
      }

      return a.node.nodeId.localeCompare(b.node.nodeId);
    });
  }

  private toRect(bounds: THREE.Box3): Rect2D {
    return this.createRect(bounds.min.x, bounds.max.x, bounds.max.y, bounds.min.y);
  }

  private createRect(left: number, right: number, top: number, bottom: number): Rect2D {
    return {
      left,
      right,
      top,
      bottom,
      width: right - left,
      height: top - bottom,
      centerX: (left + right) / 2,
      centerY: (top + bottom) / 2,
    };
  }

  private getAxisAction(
    action: Align2DActionId
  ): 'left' | 'right' | 'top' | 'bottom' | 'center-x' | 'center-y' {
    if (action.endsWith('left')) {
      return 'left';
    }
    if (action.endsWith('right')) {
      return 'right';
    }
    if (action.endsWith('top')) {
      return 'top';
    }
    if (action.endsWith('bottom')) {
      return 'bottom';
    }
    if (action.endsWith('center-x')) {
      return 'center-x';
    }
    return 'center-y';
  }

  private isContainerAction(action: Align2DActionId): boolean {
    return action.startsWith('container-');
  }

  private isSelectionAction(action: Align2DActionId): boolean {
    return action.startsWith('selection-');
  }

  private getActionLabel(action: Align2DActionId): string {
    const labels: Record<Align2DActionId, string> = {
      'container-left': 'Align Left to Container',
      'container-center-x': 'Align to Container Center Horizontally',
      'container-right': 'Align Right to Container',
      'container-top': 'Align Top to Container',
      'container-center-y': 'Align to Container Center Vertically',
      'container-bottom': 'Align Bottom to Container',
      'selection-left': 'Align Left to Selection Bounds',
      'selection-center-x': 'Align to Selection Center Horizontally',
      'selection-right': 'Align Right to Selection Bounds',
      'selection-top': 'Align Top to Selection Bounds',
      'selection-center-y': 'Align to Selection Center Vertically',
      'selection-bottom': 'Align Bottom to Selection Bounds',
      'distribute-gap-x': 'Distribute Horizontal Gaps',
      'distribute-gap-y': 'Distribute Vertical Gaps',
      'distribute-center-x': 'Distribute Centers Horizontally',
      'distribute-center-y': 'Distribute Centers Vertically',
    };

    return labels[action];
  }
}
