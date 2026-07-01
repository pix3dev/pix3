/**
 * TransformTool2d - Handles 2D object transformation (move, rotate, scale)
 *
 * Encapsulates all 2D transform logic including:
 * - Selection frame and handle geometry creation
 * - Handle detection from screen coordinates
 * - Transform state tracking and updates
 * - Anchor point calculations for scale operations
 */

import * as THREE from 'three';
import { Node2D } from '@pix3/runtime';
import type { SceneGraph } from '@pix3/runtime';

export type TwoDHandle =
  | 'idle'
  | 'move'
  | 'rotate'
  | 'scale-n'
  | 'scale-s'
  | 'scale-e'
  | 'scale-w'
  | 'scale-ne'
  | 'scale-nw'
  | 'scale-se'
  | 'scale-sw';

export interface Transform2DState {
  position: THREE.Vector3;
  rotation: number;
  scale: THREE.Vector2;
  width?: number;
  height?: number;
  worldPosition?: THREE.Vector3;
  worldRotationZ?: number;
}

export interface Selection2DOverlay {
  group: THREE.Group;
  handles: THREE.Object3D[];
  frame: THREE.Group;
  nodeIds: string[];
  combinedBounds: THREE.Box3;
  centerWorld: THREE.Vector3;
  localBounds?: THREE.Box3;
  worldRotationZ?: number;
  rotationHandle?: THREE.Object3D;
}

export interface Active2DTransform {
  nodeIds: string[];
  handle: TwoDHandle;
  startPointerWorld: THREE.Vector3;
  startStates: Map<string, Transform2DState>;
  combinedBounds: THREE.Box3;
  startCenterWorld: THREE.Vector3;
  anchorWorld: THREE.Vector3;
  anchorLocal: THREE.Vector3;
  startSize: THREE.Vector2;
  overlayRotationZ?: number;
  moveConstraintAxis?: 'x' | 'y' | null;
}

export interface Transform2DUpdateOptions {
  preserveAspectRatio?: boolean;
  constrainMoveToAxis?: boolean;
  /** Snap moved nodes to a world-space grid. */
  snapToGrid?: boolean;
  /** Grid cell size in world units (used when snapToGrid is true). */
  gridSize?: number;
  /** Snap rotation to a fixed-degree grid (used with the rotate handle). */
  snapRotation?: boolean;
  /** Rotation snap increment in degrees (defaults to 5 when snapRotation is true). */
  rotationSnapDegrees?: number;
}

export class TransformTool2d {
  private readonly min2DSizeCssPx = 4;
  private readonly handleSizeCssPx = 10;
  private readonly frameWidthCssPx = 1;
  /** Extra CSS-pixel margin around handles for pointer hit testing */
  private readonly handleHitMarginCssPx = 4;
  /** Radius of handle corners in CSS pixels */
  private readonly handleCornerRadiusCssPx = 3;

  // Handle colors
  private readonly scaleHandleColor = 0x4e8df5;
  private readonly scaleHandleBorderColor = 0xffffff; // White contrast border
  private readonly scaleHandleHoverColor = 0xffffff; // White for obvious hover
  private readonly scaleHandleActiveColor = 0xffcf33; // Accent color for active drag
  private readonly rotateHandleColor = 0xf5b64e;
  private readonly rotateHandleBorderColor = 0xffffff; // White contrast border
  private readonly rotateHandleHoverColor = 0xffffff; // White for obvious hover
  private readonly rotateHandleActiveColor = 0xffcf33; // Accent color for active drag

  // Currently hovered handle (for visual feedback)
  private hoveredHandle: TwoDHandle = 'idle';
  // Currently active/dragging handle
  private activeHandle: TwoDHandle = 'idle';

  private setNodeWorldPosition(node: Node2D, worldPosition: THREE.Vector3): void {
    const parent = node.parent as THREE.Object3D | null;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      const local = worldPosition.clone();
      parent.worldToLocal(local);
      node.position.set(local.x, local.y, node.position.z);
      return;
    }
    node.position.set(worldPosition.x, worldPosition.y, node.position.z);
  }

  private setNodeWorldRotationZ(node: Node2D, worldRotationZ: number): void {
    const parent = node.parent as THREE.Object3D | null;
    if (!parent) {
      node.rotation.set(0, 0, worldRotationZ);
      return;
    }

    parent.updateWorldMatrix(true, false);
    const parentQuat = parent.getWorldQuaternion(new THREE.Quaternion());
    const parentEuler = new THREE.Euler().setFromQuaternion(parentQuat, 'XYZ');
    node.rotation.set(0, 0, worldRotationZ - parentEuler.z);
  }

  private getDpr(): number {
    // Keep 2D overlay sizing stable in CSS pixels; the ortho camera uses physical pixels.
    return typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
  }

  private getWorldUnitsPerCssPixel(
    orthographicCamera: THREE.OrthographicCamera,
    viewportSize: { width: number; height: number }
  ): THREE.Vector2 {
    const safeZoom = Math.max(0.0001, orthographicCamera.zoom || 1);
    const safeViewportWidth = Math.max(1, viewportSize.width);
    const safeViewportHeight = Math.max(1, viewportSize.height);
    const visibleWorldWidth =
      Math.abs(orthographicCamera.right - orthographicCamera.left) / safeZoom;
    const visibleWorldHeight =
      Math.abs(orthographicCamera.top - orthographicCamera.bottom) / safeZoom;

    return new THREE.Vector2(
      visibleWorldWidth / safeViewportWidth,
      visibleWorldHeight / safeViewportHeight
    );
  }

  private getMin2DSizeWorldPx(
    orthographicCamera?: THREE.OrthographicCamera,
    viewportSize?: { width: number; height: number }
  ): number {
    if (orthographicCamera && viewportSize) {
      const worldUnitsPerCssPixel = this.getWorldUnitsPerCssPixel(orthographicCamera, viewportSize);
      return Math.max(
        this.min2DSizeCssPx * worldUnitsPerCssPixel.x,
        this.min2DSizeCssPx * worldUnitsPerCssPixel.y
      );
    }

    return this.min2DSizeCssPx * this.getDpr();
  }

  private getHandleSizeWorldPx(): number {
    return this.handleSizeCssPx * this.getDpr();
  }

  private getFrameThicknessWorldPx(zoom: number): number {
    const safeZoom = Math.max(0.0001, zoom);
    return (this.frameWidthCssPx * this.getDpr()) / safeZoom;
  }

  private getHandleWorldSize(
    orthographicCamera: THREE.OrthographicCamera,
    viewportSize: { width: number; height: number }
  ): THREE.Vector2 {
    const worldUnitsPerCssPixel = this.getWorldUnitsPerCssPixel(orthographicCamera, viewportSize);
    return new THREE.Vector2(
      this.handleSizeCssPx * worldUnitsPerCssPixel.x,
      this.handleSizeCssPx * worldUnitsPerCssPixel.y
    );
  }

  private getFrameThicknessWorldSize(
    orthographicCamera: THREE.OrthographicCamera,
    viewportSize: { width: number; height: number }
  ): THREE.Vector2 {
    const worldUnitsPerCssPixel = this.getWorldUnitsPerCssPixel(orthographicCamera, viewportSize);
    return new THREE.Vector2(
      this.frameWidthCssPx * worldUnitsPerCssPixel.x,
      this.frameWidthCssPx * worldUnitsPerCssPixel.y
    );
  }

  private getOverlayLocalBounds(overlay: Selection2DOverlay): THREE.Box3 {
    if (overlay.localBounds) {
      return overlay.localBounds;
    }

    const center = overlay.combinedBounds.getCenter(new THREE.Vector3());
    return overlay.combinedBounds.clone().translate(center.multiplyScalar(-1));
  }

  private rotateVectorZ(vector: THREE.Vector3, angle: number): THREE.Vector3 {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new THREE.Vector3(
      vector.x * cos - vector.y * sin,
      vector.x * sin + vector.y * cos,
      vector.z
    );
  }

  private worldToOverlayLocal(
    worldPoint: THREE.Vector3,
    centerWorld: THREE.Vector3,
    rotationZ: number
  ): THREE.Vector3 {
    return this.rotateVectorZ(worldPoint.clone().sub(centerWorld), -rotationZ);
  }

  /**
   * Helper to generate a rounded-rectangle geometry in pixel space. Size and radius
   * are expressed in the same units (world/physical pixels). The shape is centered
   * at the origin.
   */
  private createRoundedRectGeometry(size: number, radius: number): THREE.ShapeGeometry {
    const half = size / 2;
    const shape = new THREE.Shape();
    shape.moveTo(-half + radius, -half);
    shape.lineTo(half - radius, -half);
    shape.quadraticCurveTo(half, -half, half, -half + radius);
    shape.lineTo(half, half - radius);
    shape.quadraticCurveTo(half, half, half - radius, half);
    shape.lineTo(-half + radius, half);
    shape.quadraticCurveTo(-half, half, -half, half - radius);
    shape.lineTo(-half, -half + radius);
    shape.quadraticCurveTo(-half, -half, -half + radius, -half);
    const geom = new THREE.ShapeGeometry(shape);
    geom.computeBoundingBox();
    return geom;
  }

  /**
   * Get the fixed rotation handle offset (public for consistency in ViewportRenderService)
   */
  getRotationHandleOffset(): number {
    return this.getHandleSizeWorldPx() * 3;
  }

  /**
   * Create a selection frame (rectangle outline) for 2D objects
   */
  createFrame(bounds: THREE.Box3): THREE.Group {
    const min = bounds.min;
    const max = bounds.max;
    const width = max.x - min.x;
    const height = max.y - min.y;
    const centerX = (min.x + max.x) / 2;
    const centerY = (min.y + max.y) / 2;
    const z = (min.z + max.z) / 2;

    const thickness = this.getFrameThicknessWorldPx(1);

    // Create a group to hold all border meshes
    const frame = new THREE.Group();
    frame.position.set(centerX, centerY, z);
    frame.userData.is2DFrame = true;
    frame.renderOrder = 1000;
    frame.layers.set(1);

    // Top border
    const topGeometry = new THREE.PlaneGeometry(1, 1);
    const topMaterial = new THREE.MeshBasicMaterial({
      color: 0x4e8df5,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
    });
    const topBorder = new THREE.Mesh(topGeometry, topMaterial);
    topBorder.position.set(0, height / 2 - thickness / 2, 0); // Align to top edge
    topBorder.scale.set(width, thickness, 1);
    topBorder.layers.set(1);
    topBorder.renderOrder = 1000;
    topBorder.userData.edge = 'top';
    frame.add(topBorder);

    // Bottom border
    const bottomGeometry = new THREE.PlaneGeometry(1, 1);
    const bottomMaterial = new THREE.MeshBasicMaterial({
      color: 0x4e8df5,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
    });
    const bottomBorder = new THREE.Mesh(bottomGeometry, bottomMaterial);
    bottomBorder.position.set(0, -height / 2 + thickness / 2, 0); // Align to bottom edge
    bottomBorder.scale.set(width, thickness, 1);
    bottomBorder.layers.set(1);
    bottomBorder.renderOrder = 1000;
    bottomBorder.userData.edge = 'bottom';
    frame.add(bottomBorder);

    // Left border
    const leftGeometry = new THREE.PlaneGeometry(1, 1);
    const leftMaterial = new THREE.MeshBasicMaterial({
      color: 0x4e8df5,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
    });
    const leftBorder = new THREE.Mesh(leftGeometry, leftMaterial);
    leftBorder.position.set(-width / 2 + thickness / 2, 0, 0); // Align to left edge
    leftBorder.scale.set(thickness, height, 1);
    leftBorder.layers.set(1);
    leftBorder.renderOrder = 1000;
    leftBorder.userData.edge = 'left';
    frame.add(leftBorder);

    // Right border
    const rightGeometry = new THREE.PlaneGeometry(1, 1);
    const rightMaterial = new THREE.MeshBasicMaterial({
      color: 0x4e8df5,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
    });
    const rightBorder = new THREE.Mesh(rightGeometry, rightMaterial);
    rightBorder.position.set(width / 2 - thickness / 2, 0, 0); // Align to right edge
    rightBorder.scale.set(thickness, height, 1);
    rightBorder.layers.set(1);
    rightBorder.renderOrder = 1000;
    rightBorder.userData.edge = 'right';
    frame.add(rightBorder);

    return frame;
  }

  /**
   * Create a single handle group: filled square with a contrast border outline.
   */
  private createHandleGroup(
    handleSize: number,
    fillColor: number,
    borderColor: number,
    type: string,
    position: THREE.Vector3,
    cornerRadius: number
  ): THREE.Group {
    const group = new THREE.Group();
    group.position.copy(position);
    group.userData.handleType = type;
    group.renderOrder = 1100;
    group.layers.set(1);

    // use provided corner radius
    const radius = cornerRadius;

    // Fill
    const fillGeom = this.createRoundedRectGeometry(handleSize, radius);
    const fillMat = new THREE.MeshBasicMaterial({
      color: fillColor,
      side: THREE.DoubleSide,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    });
    const fill = new THREE.Mesh(fillGeom, fillMat);
    fill.userData.handleType = type;
    fill.userData.isFill = true;
    fill.renderOrder = 1101;
    fill.layers.set(1);
    group.add(fill);

    // Border outline (slightly larger)
    const borderMargin = this.getDpr();
    const borderSize = handleSize + 2 * borderMargin;
    const borderRadius = radius + borderMargin;
    const borderGeom = this.createRoundedRectGeometry(borderSize, borderRadius);
    const borderMat = new THREE.MeshBasicMaterial({
      color: borderColor,
      side: THREE.DoubleSide,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    });
    const border = new THREE.Mesh(borderGeom, borderMat);
    border.userData.handleType = type;
    border.userData.isBorder = true;
    border.renderOrder = 1099;
    border.layers.set(1);
    group.add(border);

    return group;
  }

  /**
   * Create transformation handles (rounded squares with contrast borders) around the selection bounds
   */
  createHandles(bounds: THREE.Box3): THREE.Object3D[] {
    const min = bounds.min;
    const max = bounds.max;
    const z = (min.z + max.z) / 2;
    const midX = (min.x + max.x) / 2;
    const midY = (min.y + max.y) / 2;

    // Fixed rotation handle offset (3x handle size for consistent distance)
    const rotationOffset = this.getHandleSizeWorldPx() * 3;

    const positions: Record<Exclude<TwoDHandle, 'idle' | 'move'>, THREE.Vector3> = {
      'scale-nw': new THREE.Vector3(min.x, max.y, z),
      'scale-n': new THREE.Vector3(midX, max.y, z),
      'scale-ne': new THREE.Vector3(max.x, max.y, z),
      'scale-e': new THREE.Vector3(max.x, midY, z),
      'scale-se': new THREE.Vector3(max.x, min.y, z),
      'scale-s': new THREE.Vector3(midX, min.y, z),
      'scale-sw': new THREE.Vector3(min.x, min.y, z),
      'scale-w': new THREE.Vector3(min.x, midY, z),
      rotate: new THREE.Vector3(midX, max.y + rotationOffset, z),
    };

    const handleSize = this.getHandleSizeWorldPx();

    // calculate clamped corner radius in world pixels
    const cornerRadius = Math.min(this.handleCornerRadiusCssPx * this.getDpr(), handleSize / 2);

    const handles: THREE.Object3D[] = [];
    (
      Object.entries(positions) as Array<[Exclude<TwoDHandle, 'idle' | 'move'>, THREE.Vector3]>
    ).forEach(([type, pos]) => {
      const isRotate = type === 'rotate';
      const group = this.createHandleGroup(
        handleSize,
        isRotate ? this.rotateHandleColor : this.scaleHandleColor,
        isRotate ? this.rotateHandleBorderColor : this.scaleHandleBorderColor,
        type,
        pos,
        cornerRadius
      );
      handles.push(group);
    });

    // Connect rotation handle with a thin line for affordance
    const rotationPos = positions.rotate;
    if (rotationPos) {
      const lineGeom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(midX, max.y, z),
        new THREE.Vector3(rotationPos.x, rotationPos.y, z),
      ]);
      const lineMat = new THREE.LineBasicMaterial({ color: 0xf5b64e, depthTest: false });
      const connector = new THREE.Line(lineGeom, lineMat);
      connector.renderOrder = 1050;
      connector.layers.set(1);
      connector.userData.handleType = 'rotate';
      handles.push(connector);
    }

    return handles;
  }

  /**
   * Update the positions of handles when selection bounds change
   */
  updateHandlePositions(
    overlay: Selection2DOverlay,
    orthographicCamera: THREE.OrthographicCamera,
    viewportSize: { width: number; height: number }
  ): void {
    const bounds = this.getOverlayLocalBounds(overlay);
    const min = bounds.min;
    const max = bounds.max;
    const width = max.x - min.x;
    const height = max.y - min.y;
    const centerX = (min.x + max.x) / 2;
    const centerY = (min.y + max.y) / 2;
    const z = (min.z + max.z) / 2;
    const midX = (min.x + max.x) / 2;
    const midY = (min.y + max.y) / 2;
    const rotationZ = overlay.worldRotationZ ?? 0;

    overlay.group.position.copy(overlay.centerWorld);
    overlay.group.rotation.set(0, 0, rotationZ);

    const frameThickness = this.getFrameThicknessWorldSize(orthographicCamera, viewportSize);
    const handleSize = this.getHandleWorldSize(orthographicCamera, viewportSize);
    const handleBaseSize = Math.max(0.0001, this.getHandleSizeWorldPx());

    // Update frame edges
    overlay.frame.position.set(centerX, centerY, z);
    overlay.frame.traverse(child => {
      if (child instanceof THREE.Mesh) {
        const edge = child.userData.edge as 'top' | 'bottom' | 'left' | 'right' | undefined;
        if (edge === 'top') {
          child.position.set(0, height / 2 - frameThickness.y / 2, 0);
          child.scale.set(width, frameThickness.y, 1);
        } else if (edge === 'bottom') {
          child.position.set(0, -height / 2 + frameThickness.y / 2, 0);
          child.scale.set(width, frameThickness.y, 1);
        } else if (edge === 'left') {
          child.position.set(-width / 2 + frameThickness.x / 2, 0, 0);
          child.scale.set(frameThickness.x, height, 1);
        } else if (edge === 'right') {
          child.position.set(width / 2 - frameThickness.x / 2, 0, 0);
          child.scale.set(frameThickness.x, height, 1);
        }
      }
    });

    // Fixed rotation handle offset (3x handle size for consistent distance)
    const rotationOffset = handleSize.y * 3;

    const handlePositions: Record<string, THREE.Vector3> = {
      'scale-nw': new THREE.Vector3(min.x, max.y, z),
      'scale-n': new THREE.Vector3(midX, max.y, z),
      'scale-ne': new THREE.Vector3(max.x, max.y, z),
      'scale-e': new THREE.Vector3(max.x, midY, z),
      'scale-se': new THREE.Vector3(max.x, min.y, z),
      'scale-s': new THREE.Vector3(midX, min.y, z),
      'scale-sw': new THREE.Vector3(min.x, min.y, z),
      'scale-w': new THREE.Vector3(min.x, midY, z),
      rotate: new THREE.Vector3(midX, max.y + rotationOffset, z),
    };

    for (const handle of overlay.handles) {
      const type = handle.userData?.handleType as string | undefined;
      // The rotate connector line geometry is defined in world-space points; don't also translate the Line.
      if (type && handlePositions[type] && !(handle instanceof THREE.Line)) {
        handle.position.copy(handlePositions[type]);
      }
      if (type === 'rotate' && handle instanceof THREE.Line) {
        const lineGeom = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(midX, max.y, z),
          handlePositions.rotate,
        ]);
        handle.geometry.dispose();
        handle.geometry = lineGeom;
        handle.position.set(0, 0, 0);
      }
      if (handle instanceof THREE.Group || handle instanceof THREE.Mesh) {
        handle.scale.set(handleSize.x / handleBaseSize, handleSize.y / handleBaseSize, 1);
      }
    }

    overlay.group.updateMatrixWorld(true);
  }

  /**
   * Detect which handle is under the cursor at the given screen position.
   * Uses world-space distance check that correctly accounts for zoom-compensated handle sizes.
   */
  getHandleAt(
    screenX: number,
    screenY: number,
    overlay: Selection2DOverlay,
    orthographicCamera: THREE.OrthographicCamera,
    viewportSize: { width: number; height: number }
  ): TwoDHandle {
    const point = this.screenToWorld2D(screenX, screenY, orthographicCamera, viewportSize);
    if (!point) {
      return 'idle';
    }

    const worldUnitsPerCssPixel = this.getWorldUnitsPerCssPixel(orthographicCamera, viewportSize);
    const hitHalfWidth =
      ((this.handleSizeCssPx + this.handleHitMarginCssPx) * worldUnitsPerCssPixel.x) / 2;
    const hitHalfHeight =
      ((this.handleSizeCssPx + this.handleHitMarginCssPx) * worldUnitsPerCssPixel.y) / 2;

    // Test each handle position (prefer specific handles over 'move')
    let bestHandle: TwoDHandle = 'idle';
    let bestDist = Infinity;

    for (const handle of overlay.handles) {
      const type = handle.userData?.handleType as TwoDHandle | undefined;
      if (!type) continue;

      // Skip connector lines — they are affordance only
      if (handle instanceof THREE.Line) continue;

      // Get the handle's world position
      handle.updateWorldMatrix(true, false);
      const handleWorldPos = new THREE.Vector3();
      handle.getWorldPosition(handleWorldPos);

      // Square hit test (axis-aligned in world space)
      const dx = Math.abs(point.x - handleWorldPos.x);
      const dy = Math.abs(point.y - handleWorldPos.y);

      if (dx <= hitHalfWidth && dy <= hitHalfHeight) {
        const dist = dx + dy; // Manhattan distance for tie-breaking
        if (dist < bestDist) {
          bestDist = dist;
          bestHandle = type as TwoDHandle;
        }
      }
    }

    if (bestHandle !== 'idle') {
      return bestHandle;
    }

    // Fall back to 'move' if pointer is inside the selection bounds
    const bounds = this.getOverlayLocalBounds(overlay);
    const localPoint = this.worldToOverlayLocal(
      point,
      overlay.centerWorld,
      overlay.worldRotationZ ?? 0
    );
    if (point) {
      const inX = localPoint.x >= bounds.min.x && localPoint.x <= bounds.max.x;
      const inY = localPoint.y >= bounds.min.y && localPoint.y <= bounds.max.y;

      if (inX && inY) {
        return 'move';
      }
    }

    return 'idle';
  }

  /**
   * Begin a 2D transform operation with the given handle
   */
  startTransform(
    screenX: number,
    screenY: number,
    handle: TwoDHandle,
    overlay: Selection2DOverlay,
    sceneGraph: SceneGraph,
    orthographicCamera: THREE.OrthographicCamera,
    viewportSize: { width: number; height: number }
  ): Active2DTransform | null {
    if (!overlay) {
      return null;
    }

    const { nodeIds, combinedBounds, centerWorld } = overlay;
    if (nodeIds.length === 0) return null;

    const pointerWorld = this.screenToWorld2D(screenX, screenY, orthographicCamera, viewportSize);
    if (!pointerWorld) return null;

    const startStates = new Map<string, Transform2DState>();
    for (const nodeId of nodeIds) {
      const node = sceneGraph.nodeMap.get(nodeId);
      if (node && node instanceof Node2D) {
        node.updateWorldMatrix(true, false);
        const worldPosition = node.getWorldPosition(new THREE.Vector3());
        const worldQuat = node.getWorldQuaternion(new THREE.Quaternion());
        const worldEuler = new THREE.Euler().setFromQuaternion(worldQuat, 'XYZ');
        // Some Node2D subclasses (e.g., sprites) may expose width/height; avoid `any` by narrowing
        const dims = node as Node2D & { width?: number; height?: number };
        const width = typeof dims.width === 'number' ? dims.width : undefined;
        const height = typeof dims.height === 'number' ? dims.height : undefined;

        const state: Transform2DState = {
          position: node.position.clone(),
          rotation: node.rotation.z,
          scale: new THREE.Vector2(node.scale.x, node.scale.y),
          width,
          height,
          worldPosition,
          worldRotationZ: worldEuler.z,
        };

        startStates.set(nodeId, state);
      }
    }

    const overlayBounds = this.getOverlayLocalBounds(overlay);
    const size = overlayBounds.getSize(new THREE.Vector3());
    const startSize = new THREE.Vector2(size.x, size.y);
    const overlayRotationZ = overlay.worldRotationZ ?? 0;
    const anchorLocal = this.getAnchorLocal(handle, startSize);
    const anchorWorld = this.rotateVectorZ(anchorLocal, overlayRotationZ).add(centerWorld);

    return {
      nodeIds,
      handle,
      startPointerWorld: pointerWorld,
      startStates,
      combinedBounds: combinedBounds.clone(),
      startCenterWorld: centerWorld.clone(),
      anchorWorld,
      anchorLocal,
      startSize,
      overlayRotationZ,
      moveConstraintAxis: null,
    };
  }

  /**
   * Set the active handle being dragged (for visual feedback).
   * Call at the start of a drag operation.
   */
  setActiveHandle(handle: TwoDHandle, overlay: Selection2DOverlay): void {
    // Clear previous active handle styling
    if (this.activeHandle !== 'idle') {
      this.setHandleActiveState(overlay, this.activeHandle, false);
    }
    this.activeHandle = handle;
    if (handle !== 'idle') {
      this.setHandleActiveState(overlay, handle, true);
    }
  }

  /**
   * Clear the active handle (call at end of drag).
   */
  clearActiveHandle(overlay: Selection2DOverlay | undefined): void {
    if (overlay && this.activeHandle !== 'idle') {
      this.setHandleActiveState(overlay, this.activeHandle, false);
    }
    this.activeHandle = 'idle';
  }

  /**
   * Get the currently active/dragging handle.
   */
  getActiveHandle(): TwoDHandle {
    return this.activeHandle;
  }

  /**
   * Update node transforms during an active 2D transform operation
   */
  updateTransform(
    screenX: number,
    screenY: number,
    transform: Active2DTransform,
    sceneGraph: SceneGraph,
    orthographicCamera: THREE.OrthographicCamera,
    viewportSize: { width: number; height: number },
    options: Transform2DUpdateOptions = {}
  ): void {
    const pointerWorld = this.screenToWorld2D(screenX, screenY, orthographicCamera, viewportSize);
    if (!pointerWorld) return;

    const {
      handle,
      startPointerWorld,
      startStates,
      startCenterWorld,
      anchorWorld,
      anchorLocal,
      startSize,
      overlayRotationZ = 0,
    } = transform;

    if (handle === 'move') {
      const delta = pointerWorld.clone().sub(startPointerWorld);
      if (options.constrainMoveToAxis) {
        if (!transform.moveConstraintAxis && (delta.x !== 0 || delta.y !== 0)) {
          transform.moveConstraintAxis = Math.abs(delta.x) >= Math.abs(delta.y) ? 'x' : 'y';
        }

        if (transform.moveConstraintAxis === 'x') {
          delta.y = 0;
        } else if (transform.moveConstraintAxis === 'y') {
          delta.x = 0;
        }
      } else {
        transform.moveConstraintAxis = null;
      }

      const snapGrid =
        options.snapToGrid && options.gridSize && options.gridSize > 0 ? options.gridSize : 0;
      const constraintAxis = transform.moveConstraintAxis;

      for (const [nodeId, startState] of startStates) {
        const node = sceneGraph.nodeMap.get(nodeId);
        if (node && node instanceof Node2D) {
          const startWorld = startState.worldPosition ?? node.getWorldPosition(new THREE.Vector3());
          const newWorld = startWorld.clone().add(delta);
          if (snapGrid > 0) {
            // Snap each free axis to the nearest grid line; leave an
            // axis-constrained drag's fixed axis untouched.
            if (constraintAxis !== 'y') {
              newWorld.x = Math.round(newWorld.x / snapGrid) * snapGrid;
            }
            if (constraintAxis !== 'x') {
              newWorld.y = Math.round(newWorld.y / snapGrid) * snapGrid;
            }
          }
          this.setNodeWorldPosition(node, newWorld);
        }
      }
    } else if (handle === 'rotate') {
      const startAngle = Math.atan2(
        startPointerWorld.y - startCenterWorld.y,
        startPointerWorld.x - startCenterWorld.x
      );
      const currentAngle = Math.atan2(
        pointerWorld.y - startCenterWorld.y,
        pointerWorld.x - startCenterWorld.x
      );
      let deltaAngle = currentAngle - startAngle;

      if (options.snapRotation) {
        // Snap the overlay's resulting rotation to the nearest N-degree increment,
        // then apply that snapped delta uniformly so multi-selection keeps its
        // relative orientation. For a single node the overlay rotation equals the
        // node's world rotation, so it lands exactly on the grid (e.g. 0/5/10°).
        const stepDeg = options.rotationSnapDegrees ?? 5;
        const step = (stepDeg * Math.PI) / 180;
        if (step > 0) {
          const targetRotation = Math.round((overlayRotationZ + deltaAngle) / step) * step;
          deltaAngle = targetRotation - overlayRotationZ;
        }
      }

      for (const [nodeId, startState] of startStates) {
        const node = sceneGraph.nodeMap.get(nodeId);
        if (node && node instanceof Node2D) {
          const startWorldRot = startState.worldRotationZ ?? startState.rotation;
          this.setNodeWorldRotationZ(node, startWorldRot + deltaAngle);

          const startWorldPos =
            startState.worldPosition ?? node.getWorldPosition(new THREE.Vector3());
          const offsetFromCenter = startWorldPos.clone().sub(startCenterWorld);
          const rotatedOffset = new THREE.Vector3(
            offsetFromCenter.x * Math.cos(deltaAngle) - offsetFromCenter.y * Math.sin(deltaAngle),
            offsetFromCenter.x * Math.sin(deltaAngle) + offsetFromCenter.y * Math.cos(deltaAngle),
            0
          );
          const newPosition = startCenterWorld.clone().add(rotatedOffset);
          this.setNodeWorldPosition(node, newPosition);
        }
      }
    } else {
      const localPoint = this.worldToOverlayLocal(pointerWorld, startCenterWorld, overlayRotationZ);
      let width = startSize.x;
      let height = startSize.y;

      const minSize = this.getMin2DSizeWorldPx(orthographicCamera, viewportSize);

      const affectsX =
        handle === 'scale-e' ||
        handle === 'scale-w' ||
        handle === 'scale-ne' ||
        handle === 'scale-se' ||
        handle === 'scale-nw' ||
        handle === 'scale-sw';
      const affectsY =
        handle === 'scale-n' ||
        handle === 'scale-s' ||
        handle === 'scale-ne' ||
        handle === 'scale-se' ||
        handle === 'scale-nw' ||
        handle === 'scale-sw';

      if (affectsX) {
        width = Math.max(minSize, Math.abs(localPoint.x - anchorLocal.x));
      }
      if (affectsY) {
        height = Math.max(minSize, Math.abs(localPoint.y - anchorLocal.y));
      }

      const primaryNode =
        transform.nodeIds.length === 1
          ? (sceneGraph.nodeMap.get(transform.nodeIds[0]) ?? null)
          : null;
      let preserveAspect = Boolean(options.preserveAspectRatio && primaryNode);
      if (primaryNode && 'aspectRatioLocked' in primaryNode && primaryNode.aspectRatioLocked) {
        preserveAspect = true;
      }

      if (preserveAspect && startSize.x > 0 && startSize.y > 0) {
        const startRatio = startSize.x / startSize.y;
        if (affectsX && !affectsY) {
          height = width / startRatio;
        } else if (affectsY && !affectsX) {
          width = height * startRatio;
        } else if (affectsX && affectsY) {
          const scaleX = width / startSize.x;
          const scaleY = height / startSize.y;
          const maxScale = Math.max(scaleX, scaleY);
          width = startSize.x * maxScale;
          height = startSize.y * maxScale;
        }
      }

      const scaleFactorX = width / startSize.x;
      const scaleFactorY = height / startSize.y;

      const anchorLocalNew = this.getAnchorLocal(handle, new THREE.Vector2(width, height));
      const newCenterWorld = anchorWorld
        .clone()
        .sub(this.rotateVectorZ(anchorLocalNew, overlayRotationZ));

      for (const [nodeId, startState] of startStates) {
        const node = sceneGraph.nodeMap.get(nodeId);
        if (node && node instanceof Node2D) {
          const startWorldPos =
            startState.worldPosition ?? node.getWorldPosition(new THREE.Vector3());
          const offsetFromCenter = startWorldPos.clone().sub(startCenterWorld);
          const localOffset = this.rotateVectorZ(offsetFromCenter, -overlayRotationZ);
          const scaledLocalOffset = new THREE.Vector3(
            localOffset.x * scaleFactorX,
            localOffset.y * scaleFactorY,
            localOffset.z
          );
          const scaledOffset = this.rotateVectorZ(scaledLocalOffset, overlayRotationZ);
          const newPos = newCenterWorld.clone().add(scaledOffset);
          this.setNodeWorldPosition(node, newPos);

          const startWidth = typeof startState.width === 'number' ? startState.width : undefined;
          const startHeight = typeof startState.height === 'number' ? startState.height : undefined;
          const dimsNode = node as Node2D & { width?: number; height?: number };
          const hasSize =
            typeof dimsNode.width === 'number' &&
            typeof dimsNode.height === 'number' &&
            typeof startWidth === 'number' &&
            typeof startHeight === 'number';

          if (hasSize) {
            dimsNode.width = Math.max(minSize, startWidth * scaleFactorX);
            dimsNode.height = Math.max(minSize, startHeight * scaleFactorY);
            // Keep node.scale stable; size changes should primarily use width/height.
            node.scale.set(startState.scale.x, startState.scale.y, 1);
          } else {
            node.scale.set(startState.scale.x * scaleFactorX, startState.scale.y * scaleFactorY, 1);
          }
        }
      }
    }
  }

  /**
   * Calculate the anchor point (pivot) in local coordinates for a scale handle
   */
  private getAnchorLocal(handle: TwoDHandle, size: THREE.Vector2): THREE.Vector3 {
    const halfW = size.x / 2;
    const halfH = size.y / 2;
    switch (handle) {
      case 'scale-ne':
        return new THREE.Vector3(-halfW, -halfH, 0);
      case 'scale-nw':
        return new THREE.Vector3(halfW, -halfH, 0);
      case 'scale-se':
        return new THREE.Vector3(-halfW, halfH, 0);
      case 'scale-sw':
        return new THREE.Vector3(halfW, halfH, 0);
      case 'scale-n':
        return new THREE.Vector3(0, -halfH, 0);
      case 'scale-s':
        return new THREE.Vector3(0, halfH, 0);
      case 'scale-e':
        return new THREE.Vector3(-halfW, 0, 0);
      case 'scale-w':
        return new THREE.Vector3(halfW, 0, 0);
      default:
        return new THREE.Vector3(-halfW, -halfH, 0);
    }
  }

  /**
   * Convert screen coordinates to NDC (normalized device coordinates)
   */
  private toNdc(
    screenX: number,
    screenY: number,
    viewportSize: { width: number; height: number }
  ): THREE.Vector2 | null {
    const { width, height } = viewportSize;
    if (width <= 0 || height <= 0) return null;
    return new THREE.Vector2((screenX / width) * 2 - 1, -(screenY / height) * 2 + 1);
  }

  /**
   * Convert screen coordinates to world coordinates in the 2D layer
   */
  private screenToWorld2D(
    screenX: number,
    screenY: number,
    orthographicCamera: THREE.OrthographicCamera,
    viewportSize: { width: number; height: number }
  ): THREE.Vector3 | null {
    const ndc = this.toNdc(screenX, screenY, viewportSize);
    if (!ndc) return null;
    const point = new THREE.Vector3(ndc.x, ndc.y, 0);
    point.unproject(orthographicCamera);
    return point;
  }

  /**
   * Update hover state for handles based on cursor position.
   * Returns true if hover state changed (requires re-render).
   */
  updateHover(
    screenX: number,
    screenY: number,
    overlay: Selection2DOverlay | undefined,
    orthographicCamera: THREE.OrthographicCamera | undefined,
    viewportSize: { width: number; height: number }
  ): boolean {
    if (!overlay || !orthographicCamera) {
      if (this.hoveredHandle !== 'idle') {
        this.hoveredHandle = 'idle';
        return true;
      }
      return false;
    }

    const handle = this.getHandleAt(screenX, screenY, overlay, orthographicCamera, viewportSize);
    if (handle === this.hoveredHandle) {
      return false;
    }

    // Reset previous hovered handle color
    this.setHandleHoverState(overlay, this.hoveredHandle, false);

    // Set new hovered handle color
    this.hoveredHandle = handle;
    this.setHandleHoverState(overlay, handle, true);

    return true;
  }

  /**
   * Clear hover state (e.g., when cursor leaves viewport)
   */
  clearHover(overlay: Selection2DOverlay | undefined): boolean {
    if (this.hoveredHandle === 'idle') {
      return false;
    }
    if (overlay) {
      this.setHandleHoverState(overlay, this.hoveredHandle, false);
    }
    this.hoveredHandle = 'idle';
    return true;
  }

  /**
   * Get the currently hovered handle
   */
  getHoveredHandle(): TwoDHandle {
    return this.hoveredHandle;
  }

  /**
   * Apply a color to all fill meshes inside a handle (Group or direct Mesh).
   */
  private setHandleFillColor(handle: THREE.Object3D, color: number): void {
    if (handle instanceof THREE.Group) {
      for (const child of handle.children) {
        if (child instanceof THREE.Mesh && child.userData.isFill) {
          (child.material as THREE.MeshBasicMaterial).color.setHex(color);
          (child.material as THREE.MeshBasicMaterial).needsUpdate = true;
        }
      }
    } else if (handle instanceof THREE.Mesh) {
      (handle.material as THREE.MeshBasicMaterial).color.setHex(color);
      (handle.material as THREE.MeshBasicMaterial).needsUpdate = true;
    } else if (handle instanceof THREE.Line) {
      (handle.material as THREE.LineBasicMaterial).color.setHex(color);
      (handle.material as THREE.LineBasicMaterial).needsUpdate = true;
    }
  }

  /**
   * Set hover visual state for a specific handle
   */
  private setHandleHoverState(
    overlay: Selection2DOverlay,
    handle: TwoDHandle,
    isHovered: boolean
  ): void {
    // Don't change color if this handle is actively being dragged
    if (handle === this.activeHandle && this.activeHandle !== 'idle') {
      return;
    }

    if (handle === 'idle' || handle === 'move') {
      return;
    }

    for (const obj of overlay.handles) {
      const handleType = obj.userData?.handleType as TwoDHandle | undefined;
      if (handleType !== handle) {
        continue;
      }

      const isRotate = handleType === 'rotate';
      const defaultColor = isRotate ? this.rotateHandleColor : this.scaleHandleColor;
      const hoverColor = isRotate ? this.rotateHandleHoverColor : this.scaleHandleHoverColor;
      this.setHandleFillColor(obj, isHovered ? hoverColor : defaultColor);
    }
  }

  /**
   * Set active (dragging) visual state for a specific handle.
   * Active handles show in accent color.
   */
  private setHandleActiveState(
    overlay: Selection2DOverlay,
    handle: TwoDHandle,
    isActive: boolean
  ): void {
    if (handle === 'idle' || handle === 'move') {
      return;
    }

    for (const obj of overlay.handles) {
      const handleType = obj.userData?.handleType as TwoDHandle | undefined;
      if (handleType !== handle) {
        continue;
      }

      const isRotate = handleType === 'rotate';
      const defaultColor = isRotate ? this.rotateHandleColor : this.scaleHandleColor;
      const activeColor = isRotate ? this.rotateHandleActiveColor : this.scaleHandleActiveColor;
      this.setHandleFillColor(obj, isActive ? activeColor : defaultColor);
    }
  }
}
