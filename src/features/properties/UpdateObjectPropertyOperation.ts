import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { NodeBase } from '@pix3/runtime';
import { Node2D } from '@pix3/runtime';
import { Group2D } from '@pix3/runtime';
import { Sprite3D } from '@pix3/runtime';
import { SceneManager } from '@pix3/runtime';
import { ViewportRendererService } from '@/services/ViewportRenderService';
import { getNodePropertySchema } from '@pix3/runtime';
import type { PropertyDefinition } from '@/fw';
import type { ServiceContainer } from '@/fw/di';

export interface UpdateObjectPropertyParams {
  nodeId: string;
  propertyPath: string;
  value: unknown;
  previousValue?: unknown;
}

export class UpdateObjectPropertyOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.update-object-property',
    title: 'Update Object Property',
    description: 'Update a property on a scene object',
    tags: ['property', 'transform'],
  };

  private readonly params: UpdateObjectPropertyParams;

  constructor(params: UpdateObjectPropertyParams) {
    this.params = params;
  }

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { container, state } = context;
    const { nodeId, propertyPath, value } = this.params;

    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const sceneGraph = sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      return { didMutate: false };
    }

    const node = sceneGraph.nodeMap.get(nodeId);
    if (!node) {
      return { didMutate: false };
    }

    // Get property schema and definition
    const schema = getNodePropertySchema(node);
    const propDef = schema.properties.find(p => p.name === propertyPath);
    if (!propDef) {
      // Defensive fallback for runtime/editor schema drift.
      if (propertyPath === 'opacity' && node instanceof Node2D) {
        const previousValue = node.opacity;
        const nextValueRaw = Number(value);
        if (!Number.isFinite(nextValueRaw)) {
          return { didMutate: false };
        }
        const nextValue = Math.max(0, Math.min(1, nextValueRaw));
        if (previousValue === nextValue) {
          return { didMutate: false };
        }

        node.opacity = nextValue;

        const activeSceneId = state.scenes.activeSceneId;
        if (activeSceneId) {
          state.scenes.lastLoadedAt = Date.now();
          const descriptor = state.scenes.descriptors[activeSceneId];
          if (descriptor) descriptor.isDirty = true;
        }

        this.updateViewport(container, propertyPath, node);

        return {
          didMutate: true,
          commit: {
            label: 'Update Opacity',
            beforeSnapshot: context.snapshot,
            undo: async () => {
              node.opacity = previousValue;
              if (activeSceneId) {
                state.scenes.lastLoadedAt = Date.now();
                const descriptor = state.scenes.descriptors[activeSceneId];
                if (descriptor) descriptor.isDirty = true;
              }
              this.updateViewport(container, propertyPath, node);
            },
            redo: async () => {
              node.opacity = nextValue;
              if (activeSceneId) {
                state.scenes.lastLoadedAt = Date.now();
                const descriptor = state.scenes.descriptors[activeSceneId];
                if (descriptor) descriptor.isDirty = true;
              }
              this.updateViewport(container, propertyPath, node);
            },
          },
        };
      }
      return { didMutate: false };
    }

    const validation = this.validatePropertyUpdate(node, propDef, value);
    if (!validation.isValid) {
      console.warn('[UpdateObjectPropertyOperation] Validation failed:', validation.reason);
      return { didMutate: false };
    }

    const currentValue = propDef.getValue(node);
    const visibilityPreservation = this.createVisibilityPreservationState(
      node,
      propertyPath,
      currentValue
    );
    const hasPreviousValueOverride = Object.prototype.hasOwnProperty.call(
      this.params,
      'previousValue'
    );
    const previousValue = hasPreviousValueOverride ? this.params.previousValue : currentValue;
    const currentValueJson = JSON.stringify(currentValue);
    const previousValueJson = JSON.stringify(previousValue);
    const nextValueJson = JSON.stringify(value);

    if (currentValueJson === nextValueJson && previousValueJson === nextValueJson) {
      return { didMutate: false };
    }

    if (currentValueJson !== nextValueJson) {
      this.applyVisibilityPreservation(node, visibilityPreservation);
      // Set the property value using the schema's setValue method
      propDef.setValue(node, value);
      this.afterNodePropertyApplied(node, propertyPath);
    }

    const activeSceneId = state.scenes.activeSceneId;
    if (activeSceneId) {
      state.scenes.lastLoadedAt = Date.now();
      const descriptor = state.scenes.descriptors[activeSceneId];
      if (descriptor) descriptor.isDirty = true;
    }

    // Trigger viewport updates
    this.updateViewport(container, propertyPath, node);

    return {
      didMutate: true,
      commit: {
        label: `Update ${propDef.ui?.label || propertyPath}`,
        beforeSnapshot: context.snapshot,
        undo: async () => {
          this.restoreVisibilityPreservation(node, visibilityPreservation);
          propDef.setValue(node, previousValue);
          this.afterNodePropertyApplied(node, propertyPath);
          if (activeSceneId) {
            state.scenes.lastLoadedAt = Date.now();
            const descriptor = state.scenes.descriptors[activeSceneId];
            if (descriptor) descriptor.isDirty = true;
          }
          this.updateViewport(container, propertyPath, node);
        },
        redo: async () => {
          this.applyVisibilityPreservation(node, visibilityPreservation);
          propDef.setValue(node, value);
          this.afterNodePropertyApplied(node, propertyPath);
          if (activeSceneId) {
            state.scenes.lastLoadedAt = Date.now();
            const descriptor = state.scenes.descriptors[activeSceneId];
            if (descriptor) descriptor.isDirty = true;
          }
          this.updateViewport(container, propertyPath, node);
        },
      },
    };
  }

  private updateViewport(container: ServiceContainer, propertyPath: string, node: NodeBase) {
    try {
      const vr = container.getService(
        container.getOrCreateToken(ViewportRendererService)
      ) as ViewportRendererService;
      const isTransform = this.isTransformProperty(propertyPath);
      const is2DVisualProperty = this.is2DVisualProperty(propertyPath);
      if (isTransform) {
        vr.updateNodeTransform(node);
      } else if (this.is3DVisualProperty(propertyPath) && node instanceof Sprite3D) {
        vr.updateNodeTransform(node);
      } else if (is2DVisualProperty && node instanceof Node2D) {
        if (this.requires2DLayoutReflow(propertyPath)) {
          vr.reflow2DLayout();
        } else {
          vr.updateNodeTransform(node);
          if (this.isParentSizeProperty(propertyPath) && this.is2DContainer(node)) {
            this.updateDescendant2DTransforms(vr, node);
          }
        }
      } else if (propertyPath === 'visible') {
        vr.updateNodeVisibility(node);
      } else {
        vr.updateSelection();
      }
    } catch {
      // Silently ignore viewport renderer errors
    }
  }

  private createVisibilityPreservationState(
    node: NodeBase,
    propertyPath: string,
    currentValue: unknown
  ): { shouldPreserve: boolean; initialValue: boolean } {
    if (propertyPath !== 'visible' || typeof currentValue !== 'boolean') {
      return { shouldPreserve: false, initialValue: false };
    }

    const hasInitialVisibility =
      Object.prototype.hasOwnProperty.call(node.properties, 'initiallyVisible') ||
      Object.prototype.hasOwnProperty.call(node.properties, 'initially_visible');

    return {
      shouldPreserve: !hasInitialVisibility,
      initialValue: currentValue,
    };
  }

  private applyVisibilityPreservation(
    node: NodeBase,
    preservation: { shouldPreserve: boolean; initialValue: boolean }
  ): void {
    if (!preservation.shouldPreserve) {
      return;
    }

    node.properties.initiallyVisible = preservation.initialValue;
  }

  private restoreVisibilityPreservation(
    node: NodeBase,
    preservation: { shouldPreserve: boolean; initialValue: boolean }
  ): void {
    if (!preservation.shouldPreserve) {
      return;
    }

    delete node.properties.initiallyVisible;
  }

  private isTransformProperty(propertyPath: string): boolean {
    return ['position', 'rotation', 'scale'].includes(propertyPath);
  }

  private is2DVisualProperty(propertyPath: string): boolean {
    return [
      'opacity',
      'anchor',
      'layoutEnabled',
      'horizontalAlign',
      'verticalAlign',
      'width',
      'height',
      'size',
      'radius',
      'handleRadius',
      'showViewportOutline',
      'resolutionPreset',
      'label',
      'labelFontFamily',
      'labelFontSize',
      'labelColor',
      'labelAlign',
      'texture',
      'texturePath',
      'backgroundColor',
      'hoverColor',
      'pressedColor',
      'trackBackgroundColor',
      'trackFilledColor',
      'handleColor',
      'backdropColor',
      'borderColor',
      'selectionColor',
      'uncheckedColor',
      'checkedColor',
      'checkmarkColor',
      'barColor',
      'backBackgroundColor',
      'showBorder',
      'quantity',
      'showQuantity',
      'quantityFontSize',
      'enabled',
      'opacity',
      'checked',
      'value',
      'minValue',
      'maxValue',
      'handleSize',
    ].includes(propertyPath);
  }

  private is3DVisualProperty(propertyPath: string): boolean {
    return ['texture', 'texturePath', 'width', 'height', 'billboard', 'billboardRoll'].includes(
      propertyPath
    );
  }

  private isParentSizeProperty(propertyPath: string): boolean {
    return ['width', 'height', 'size', 'radius', 'resolutionPreset'].includes(propertyPath);
  }

  private is2DContainer(node: NodeBase): node is Group2D {
    return node instanceof Group2D;
  }

  private updateDescendant2DTransforms(vr: ViewportRendererService, parent: NodeBase): void {
    for (const child of parent.children) {
      if (child instanceof Node2D) {
        vr.updateNodeTransform(child);
      }
      this.updateDescendant2DTransforms(vr, child);
    }
  }

  private validatePropertyUpdate(
    _node: NodeBase,
    _propDef: PropertyDefinition,
    value: unknown
  ): { isValid: boolean; reason?: string } {
    if (value === null || value === undefined) {
      return { isValid: false, reason: 'Value cannot be null or undefined' };
    }
    return { isValid: true };
  }

  private afterNodePropertyApplied(node: NodeBase, propertyPath: string): void {
    if (!(node instanceof Node2D)) {
      return;
    }

    if (this.affects2DAuthoredRect(propertyPath)) {
      node.captureAuthoredLayoutRectFromCurrent();
    }

    if (this.isParentSizeProperty(propertyPath) && node.isContainer) {
      node.reflowAnchoredChildren();
      this.captureAnchoredDescendantRects(node);
    }
  }

  private affects2DAuthoredRect(propertyPath: string): boolean {
    return ['position', 'width', 'height', 'size', 'radius'].includes(propertyPath);
  }

  private requires2DLayoutReflow(propertyPath: string): boolean {
    return [
      'layoutEnabled',
      'horizontalAlign',
      'verticalAlign',
      'width',
      'height',
      'size',
      'radius',
      'resolutionPreset',
    ].includes(propertyPath);
  }

  private captureAnchoredDescendantRects(parent: NodeBase): void {
    for (const child of parent.children) {
      if (child instanceof Node2D) {
        child.captureAuthoredLayoutRectFromCurrent();
      }
      this.captureAnchoredDescendantRects(child);
    }
  }
}
