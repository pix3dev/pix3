import * as THREE from 'three';
import { MathUtils } from 'three';
import type { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { SceneGraph } from '@pix3/runtime';
import { NodeBase } from '@pix3/runtime';
import { Node2D } from '@pix3/runtime';
import { Node3D } from '@pix3/runtime';
import type { Camera3D } from '@pix3/runtime';
import type { DirectionalLightNode } from '@pix3/runtime';
import type { SpotLightNode } from '@pix3/runtime';
import { appState } from '@/state';
import type { OperationService } from '@/services/OperationService';
import {
  TransformCompleteOperation,
  type TransformState,
} from '@/features/properties/TransformCompleteOperation';
import type {
  Transform2DCompleteParams,
  Transform2DState,
} from '@/features/properties/Transform2DCompleteOperation';
import { Transform2DBatchOperation } from '@/features/properties/Transform2DBatchOperation';
import { TargetTransformOperation } from '@/features/properties/TargetTransformOperation';
import type {
  TransformTool2d,
  TwoDHandle,
  Active2DTransform,
  Transform2DUpdateOptions,
  Selection2DOverlay,
} from '@/services/TransformTool2d';
import type { TransformMode } from '../ViewportRenderService';

/**
 * Dependencies the transform session borrows from {@link ViewportRendererService}.
 * Scoped to exactly what this collaborator needs; the facade owns the transform
 * controls, the transform gizmo, the scene graph, the 2D transform tool, the 2D
 * selection overlay + HUD, the operation service (mutation gateway), and the
 * render-request/interaction machinery, and passes them in via closures so this
 * object never reaches back into the facade directly. The list is long because
 * this cluster genuinely threads through a lot of both 2D and 3D interaction
 * machinery.
 */
export interface ViewportTransformSessionDeps {
  getTransformControls(): TransformControls | undefined;
  clearTransformGizmo(): void;
  attachTransformControlsForSelection(node?: Node3D | null): void;
  updateSelection(): void;
  getTargetNodeForObject(
    object: THREE.Object3D
  ): Camera3D | DirectionalLightNode | SpotLightNode | null;
  getOperationService(): OperationService;
  getActiveSceneGraph(): SceneGraph | null;
  getSceneGraph(sceneId: string): SceneGraph | null;
  getSelection2DOverlay(): Selection2DOverlay | undefined;
  getOrthographicCamera(): THREE.OrthographicCamera | undefined;
  getTransformTool2d(): TransformTool2d;
  getViewportSize(): { width: number; height: number };
  begin2DInteraction(): void;
  end2DInteraction(): void;
  updateSelection2DHud(): void;
  updateNodeTransform(node: NodeBase): void;
  syncAll2DVisuals(): void;
  update2DSelectionOverlayForNodes(nodeIds: string[]): void;
  requestRender(): void;
}

/**
 * Owns the editor viewport's transform-session state and both its commit paths:
 * the 3D-gizmo drag (TransformControls-driven) completion path and the 2D
 * drag-transform (TransformTool2d-driven) path, plus the shared transform-mode
 * and target-selection state. Extracted from ViewportRendererService
 * (decomposition step 12/13). Not `@injectable()` — it is an owned collaborator
 * constructed by the facade with borrowed dependencies.
 *
 * The state fields are public mutable fields because the facade's still-on-facade
 * dispatchers (attachTransformControlsForSelection / updateSelection / render-loop
 * gizmo-mode checks / createTransformControls listeners / raycastObject /
 * scene-teardown) read and write them directly at many call sites; wrapping them
 * behind a method API would buy no behavioral benefit and much more diff risk.
 */
export class ViewportTransformSession {
  currentTransformMode: TransformMode = 'select';
  active2DTransform?: Active2DTransform;
  transformStartStates = new Map<
    string,
    { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }
  >();
  targetTransformStartStates = new Map<string, THREE.Vector3>();
  activeTargetNodeId: string | null = null;
  activeTargetDragNodeId: string | null = null;

  constructor(private readonly deps: ViewportTransformSessionDeps) {}

  setTransformMode(mode: TransformMode): void {
    // Set the transform mode for the gizmo
    this.currentTransformMode = mode;

    if (mode === 'select') {
      // In select mode, hide the transform gizmo
      this.deps.clearTransformGizmo();
      // Detach from current object
      const transformControls = this.deps.getTransformControls();
      if (transformControls) {
        transformControls.detach();
      }
    } else {
      const transformControls = this.deps.getTransformControls();
      if (transformControls) {
        // In transform modes, set the mode on TransformControls
        transformControls.setMode(mode);
        this.deps.attachTransformControlsForSelection();
      }
    }
  }

  setActiveTargetSelection(nodeId: string): void {
    if (this.activeTargetNodeId === nodeId) {
      return;
    }
    this.activeTargetNodeId = nodeId;
    this.deps.updateSelection();
  }

  clearActiveTargetSelection(): void {
    if (this.activeTargetNodeId === null) {
      return;
    }
    this.activeTargetNodeId = null;
    this.deps.updateSelection();
  }

  has2DTransform(): boolean {
    return this.active2DTransform !== undefined;
  }

  start2DTransform(screenX: number, screenY: number, handle: TwoDHandle): void {
    const selection2DOverlay = this.deps.getSelection2DOverlay();
    const orthographicCamera = this.deps.getOrthographicCamera();
    if (!selection2DOverlay || !orthographicCamera) {
      return;
    }

    const activeSceneId = appState.scenes.activeSceneId;
    if (!activeSceneId) return;
    const sceneGraph = this.deps.getSceneGraph(activeSceneId);
    if (!sceneGraph) return;

    const transformTool2d = this.deps.getTransformTool2d();
    const transform = transformTool2d.startTransform(
      screenX,
      screenY,
      handle,
      selection2DOverlay,
      sceneGraph,
      orthographicCamera,
      this.deps.getViewportSize()
    );

    if (transform) {
      this.active2DTransform = transform;
      // Set active handle for visual feedback (accent color during drag)
      transformTool2d.setActiveHandle(handle, selection2DOverlay);
      this.deps.begin2DInteraction();
      // Reflect the correct HUD state from the first frame: move hides it,
      // resize keeps the live size badge, rotate shows the live angle badge.
      this.deps.updateSelection2DHud();
      console.debug('[ViewportRenderer] start 2D transform', {
        handle,
        nodeIds: this.active2DTransform.nodeIds,
      });
    }
  }

  update2DTransform(
    screenX: number,
    screenY: number,
    options: Transform2DUpdateOptions = {}
  ): void {
    if (!this.active2DTransform) {
      return;
    }

    const activeSceneId = appState.scenes.activeSceneId;
    if (!activeSceneId) return;
    const sceneGraph = this.deps.getSceneGraph(activeSceneId);
    if (!sceneGraph) return;

    this.deps
      .getTransformTool2d()
      .updateTransform(
        screenX,
        screenY,
        this.active2DTransform,
        sceneGraph,
        this.deps.getOrthographicCamera()!,
        this.deps.getViewportSize(),
        options
      );

    // Update visuals for each transformed node
    for (const nodeId of this.active2DTransform.nodeIds) {
      const node = sceneGraph.nodeMap.get(nodeId);
      if (node && node instanceof Node2D) {
        this.deps.updateNodeTransform(node);
      }
    }
    // A container resize proportionally scales its descendants (in TransformTool2d) — repaint all 2D
    // proxies once per frame so the child visuals track the drag. `childStartStates` is populated
    // (scale gesture only) for any container with eligible children, Group2D or a sprite parenting
    // other 2D nodes alike.
    const resizingContainer = (this.active2DTransform.childStartStates?.size ?? 0) > 0;
    if (resizingContainer) {
      this.deps.syncAll2DVisuals();
    }
  }

  async complete2DTransform(): Promise<void> {
    if (!this.active2DTransform) {
      return;
    }

    const { nodeIds, startStates, childStartStates, handle } = this.active2DTransform;
    const sceneGraph = this.deps.getActiveSceneGraph();
    if (!sceneGraph) {
      this.active2DTransform = undefined;
      this.deps.end2DInteraction();
      return;
    }

    const plans: Transform2DCompleteParams[] = [];

    for (const nodeId of nodeIds) {
      const node = sceneGraph.nodeMap.get(nodeId);
      if (!node || !(node instanceof Node2D)) continue;

      const startState = startStates.get(nodeId);
      if (!startState) continue;

      const previousState: Transform2DState = {
        position: { x: startState.position.x, y: startState.position.y },
        rotation: MathUtils.radToDeg(startState.rotation),
        scale: { x: startState.scale.x, y: startState.scale.y },
        ...(typeof startState.width === 'number' ? { width: startState.width } : {}),
        ...(typeof startState.height === 'number' ? { height: startState.height } : {}),
      };

      const dims = node as unknown as { width?: number; height?: number };
      const currentState: Transform2DState = {
        position: { x: node.position.x, y: node.position.y },
        rotation: MathUtils.radToDeg(node.rotation.z),
        scale: { x: node.scale.x, y: node.scale.y },
        ...(typeof dims.width === 'number' ? { width: dims.width } : {}),
        ...(typeof dims.height === 'number' ? { height: dims.height } : {}),
      };

      plans.push({ nodeId, previousState, currentState });
    }

    // Descendant plans for Group2D proportional resize — after the group plans so a container's
    // anchor reflow runs before its explicit child plans on apply/undo/redo.
    if (childStartStates) {
      for (const [childId, base] of childStartStates) {
        const child = sceneGraph.nodeMap.get(childId);
        if (!(child instanceof Node2D)) continue;
        const dims = child as Node2D & { width?: number; height?: number };
        const previousState: Transform2DState = {
          position: { x: base.position.x, y: base.position.y },
        };
        const currentState: Transform2DState = {
          position: { x: child.position.x, y: child.position.y },
        };
        if (base.kind === 'size') {
          previousState.width = base.width;
          previousState.height = base.height;
          currentState.width = dims.width;
          currentState.height = dims.height;
        } else {
          previousState.scale = { x: base.scale.x, y: base.scale.y };
          currentState.scale = { x: child.scale.x, y: child.scale.y };
        }
        plans.push({ nodeId: childId, previousState, currentState });
      }
    }

    if (plans.length > 0) {
      const label = handle.startsWith('scale-')
        ? 'Resize 2D Nodes'
        : handle === 'rotate'
          ? 'Rotate 2D Nodes'
          : 'Move 2D Nodes';
      await this.deps
        .getOperationService()
        .invokeAndPush(new Transform2DBatchOperation({ plans, label }));
    }

    const savedNodeIds = [...nodeIds];
    // Clear active handle visual feedback before clearing the transform
    this.deps.getTransformTool2d().clearActiveHandle(this.deps.getSelection2DOverlay());
    this.active2DTransform = undefined;
    this.deps.end2DInteraction();
    this.deps.update2DSelectionOverlayForNodes(savedNodeIds);
    this.deps.requestRender();
    console.debug('[ViewportRenderer] complete 2D transform', { nodeIds });
  }

  captureTransformStartState(obj: THREE.Object3D): void {
    const targetNode = this.deps.getTargetNodeForObject(obj);
    if (targetNode) {
      this.targetTransformStartStates.set(targetNode.nodeId, targetNode.getTargetPosition());
      this.activeTargetDragNodeId = targetNode.nodeId;
      return;
    }

    if (!(obj instanceof Node3D)) {
      return;
    }

    const nodeId = obj.nodeId;
    this.transformStartStates.set(nodeId, {
      position: obj.position.clone(),
      rotation: obj.rotation.clone(),
      scale: obj.scale.clone(),
    });
  }

  updateTargetTransformFromControl(): void {
    const transformedObject = this.deps.getTransformControls()?.object;
    if (!transformedObject) {
      return;
    }

    const targetNode = this.deps.getTargetNodeForObject(transformedObject);
    if (!targetNode) {
      return;
    }

    const targetPosition = transformedObject.getWorldPosition(new THREE.Vector3());
    targetNode.setTargetPosition(targetPosition);
  }

  async handleTransformCompleted(): Promise<void> {
    const transformedObject = this.deps.getTransformControls()?.object;
    if (!transformedObject) {
      this.transformStartStates.clear();
      this.targetTransformStartStates.clear();
      this.activeTargetDragNodeId = null;
      return;
    }

    const targetNode = this.deps.getTargetNodeForObject(transformedObject);
    if (targetNode) {
      const startTargetPos = this.targetTransformStartStates.get(targetNode.nodeId);
      if (!startTargetPos) {
        this.transformStartStates.clear();
        this.targetTransformStartStates.clear();
        this.activeTargetDragNodeId = null;
        return;
      }

      try {
        const currentTargetPos = transformedObject.getWorldPosition(new THREE.Vector3());
        const operation = new TargetTransformOperation({
          nodeId: targetNode.nodeId,
          previousTargetPos: {
            x: startTargetPos.x,
            y: startTargetPos.y,
            z: startTargetPos.z,
          },
          currentTargetPos: {
            x: currentTargetPos.x,
            y: currentTargetPos.y,
            z: currentTargetPos.z,
          },
        });

        await this.deps.getOperationService().invokeAndPush(operation);
      } catch (error) {
        console.error('[ViewportRenderer] Error handling target transform completion:', error);
      } finally {
        this.transformStartStates.clear();
        this.targetTransformStartStates.clear();
        this.activeTargetDragNodeId = null;
      }
      return;
    }

    if (!(transformedObject instanceof Node3D)) {
      this.transformStartStates.clear();
      this.targetTransformStartStates.clear();
      this.activeTargetDragNodeId = null;
      return;
    }

    const node = transformedObject;
    const nodeId = node.nodeId;
    const startState = this.transformStartStates.get(nodeId);

    if (!startState) {
      this.transformStartStates.clear();
      this.targetTransformStartStates.clear();
      this.activeTargetDragNodeId = null;
      return;
    }

    try {
      // Build current state
      const currentState: TransformState = {
        position: {
          x: node.position.x,
          y: node.position.y,
          z: node.position.z,
        },
        rotation: {
          x: MathUtils.radToDeg(node.rotation.x),
          y: MathUtils.radToDeg(node.rotation.y),
          z: MathUtils.radToDeg(node.rotation.z),
        },
        scale: {
          x: node.scale.x,
          y: node.scale.y,
          z: node.scale.z,
        },
      };

      // Convert start state rotation to degrees for comparison
      const previousState: TransformState = {
        position: startState.position,
        rotation: {
          x: MathUtils.radToDeg(startState.rotation.x),
          y: MathUtils.radToDeg(startState.rotation.y),
          z: MathUtils.radToDeg(startState.rotation.z),
        },
        scale: startState.scale,
      };

      // Create and push transform operation with before/after states
      const operation = new TransformCompleteOperation({
        nodeId,
        previousState,
        currentState,
      });

      await this.deps.getOperationService().invokeAndPush(operation);
    } catch (error) {
      console.error('[ViewportRenderer] Error handling transform completion:', error);
    } finally {
      this.transformStartStates.clear();
      this.targetTransformStartStates.clear();
      this.activeTargetDragNodeId = null;
    }
  }
}
