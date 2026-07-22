import * as THREE from 'three';
import { MathUtils } from 'three';
import { NodeBase, Node2D, type SceneGraph } from '@pix3/runtime';
import type { PropertyDefinition } from '@pix3/runtime';
import type { Selection2DOverlay, TwoDHandle } from '@/services/TransformTool2d';
import { getNodeVisuals } from '@/ui/scene-tree/node-visuals.helper';
import { appState } from '@/state';

/**
 * A screen-space anchor for a 2D selection HUD badge: the projected edge
 * position, the outward/tangent directions used to push the badge clear of the
 * selection, and the badge's on-screen rotation.
 */
interface HudAnchor {
  x: number;
  y: number;
  directionX: number;
  directionY: number;
  tangentX: number;
  tangentY: number;
  rotationDeg: number;
}

/**
 * The slice of `ViewportRendererService` internals the 2D selection HUD needs.
 * Passed as closures because the overlay/camera/viewport/canvas host and the
 * active 2D transform are recreated/reassigned over the facade's lifetime, and
 * the borrowed methods (`projectWorldToOverlay`, `rotateVectorZ`, `getIconSvg`)
 * are used elsewhere on the facade and stay there.
 */
export interface ViewportSelection2DOverlayHudDeps {
  getSelection2DOverlay(): Selection2DOverlay | undefined;
  getOrthographicCamera(): THREE.OrthographicCamera | undefined;
  getViewportSize(): { width: number; height: number };
  getActive2DTransformHandle(): TwoDHandle | undefined;
  getCanvasHost(): HTMLElement | undefined;
  getSceneGraph(sceneId: string): SceneGraph | null;
  projectWorldToOverlay(world: THREE.Vector3): { x: number; y: number } | null;
  rotateVectorZ(vector: THREE.Vector3, angle: number): THREE.Vector3;
  getIconSvg(name: string, size: number): string;
}

/**
 * Owns the DOM badge HUD that floats near a 2D selection showing its name/size/
 * rotation, extracted from `ViewportRendererService`. The badges are absolutely
 * positioned DOM overlaid on the canvas host; they are laid out in screen space
 * and reprojected against the camera every painted frame.
 */
export class ViewportSelection2DOverlayHud {
  private hud?: {
    root: HTMLDivElement;
    top: HTMLDivElement;
    bottom: HTMLDivElement;
  };

  constructor(private readonly deps: ViewportSelection2DOverlayHudDeps) {}

  /** The current badge DOM state (for the facade's test-facing surface). */
  get badges(): { root: HTMLDivElement; top: HTMLDivElement; bottom: HTMLDivElement } | undefined {
    return this.hud;
  }

  attach(): void {
    const canvasHost = this.deps.getCanvasHost();
    if (!canvasHost) {
      return;
    }

    if (!this.hud) {
      const root = document.createElement('div');
      root.dataset.pix3OverlayHud = 'selection-2d';
      Object.assign(root.style, {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none',
        overflow: 'hidden',
        zIndex: '4',
      } satisfies Partial<CSSStyleDeclaration>);

      const top = this.createBadge();
      const bottom = this.createBadge();
      root.append(top, bottom);

      this.hud = { root, top, bottom };
    }

    if (this.hud.root.parentElement !== canvasHost) {
      canvasHost.appendChild(this.hud.root);
    }
  }

  private createBadge(): HTMLDivElement {
    const badge = document.createElement('div');
    Object.assign(badge.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '6px',
      padding: '4px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(255, 255, 255, 0.16)',
      background: 'rgba(78, 141, 245, 0.96)',
      boxShadow: '0 10px 20px rgba(0, 0, 0, 0.24)',
      color: '#ffffff',
      fontFamily:
        '"Inter", "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
      fontSize: '12px',
      fontWeight: '700',
      lineHeight: '1.2',
      whiteSpace: 'nowrap',
      transformOrigin: 'center center',
      transform: 'translate(-50%, -50%)',
    } satisfies Partial<CSSStyleDeclaration>);
    return badge;
  }

  private getLocalBounds(overlay: Selection2DOverlay): THREE.Box3 {
    if (overlay.localBounds) {
      return overlay.localBounds;
    }

    return overlay.combinedBounds.clone().translate(overlay.centerWorld.clone().multiplyScalar(-1));
  }

  private normalizeRotation(rotationDeg: number): number {
    let normalized = ((rotationDeg % 360) + 360) % 360;
    if (normalized > 180) {
      normalized -= 360;
    }
    if (normalized > 90) {
      normalized -= 180;
    } else if (normalized < -90) {
      normalized += 180;
    }
    return normalized;
  }

  private getAnchor(edge: 'top' | 'bottom' | 'left' | 'right'): {
    x: number;
    y: number;
    directionX: number;
    directionY: number;
    tangentX: number;
    tangentY: number;
    rotationDeg: number;
  } | null {
    const overlay = this.deps.getSelection2DOverlay();
    if (!overlay) {
      return null;
    }

    const localBounds = this.getLocalBounds(overlay);
    const centerX = (localBounds.min.x + localBounds.max.x) / 2;
    const centerY = (localBounds.min.y + localBounds.max.y) / 2;
    const z = (localBounds.min.z + localBounds.max.z) / 2;
    const rotationZ = overlay.worldRotationZ ?? 0;
    let anchorLocal = new THREE.Vector3(centerX, localBounds.max.y, z);
    let outwardLocal = new THREE.Vector3(0, 1, 0);
    let tangentLocal = new THREE.Vector3(1, 0, 0);

    if (edge === 'bottom') {
      anchorLocal = new THREE.Vector3(centerX, localBounds.min.y, z);
      outwardLocal = new THREE.Vector3(0, -1, 0);
    } else if (edge === 'left') {
      anchorLocal = new THREE.Vector3(localBounds.min.x, centerY, z);
      outwardLocal = new THREE.Vector3(-1, 0, 0);
      tangentLocal = new THREE.Vector3(0, 1, 0);
    } else if (edge === 'right') {
      anchorLocal = new THREE.Vector3(localBounds.max.x, centerY, z);
      outwardLocal = new THREE.Vector3(1, 0, 0);
      tangentLocal = new THREE.Vector3(0, 1, 0);
    }

    const anchorWorld = this.deps.rotateVectorZ(anchorLocal, rotationZ).add(overlay.centerWorld);
    const outwardWorld = this.deps.rotateVectorZ(outwardLocal, rotationZ).multiplyScalar(10);
    const tangentWorld = this.deps.rotateVectorZ(tangentLocal, rotationZ).multiplyScalar(10);
    const anchorScreen = this.deps.projectWorldToOverlay(anchorWorld);
    if (!anchorScreen) {
      return null;
    }

    const outwardScreen = this.deps.projectWorldToOverlay(anchorWorld.clone().add(outwardWorld));
    const tangentScreen = this.deps.projectWorldToOverlay(anchorWorld.clone().add(tangentWorld));
    let directionX = 0;
    let directionY = edge === 'top' ? -1 : 1;
    let tangentX = 1;
    let tangentY = 0;

    if (outwardScreen) {
      const deltaX = outwardScreen.x - anchorScreen.x;
      const deltaY = outwardScreen.y - anchorScreen.y;
      const length = Math.hypot(deltaX, deltaY);
      if (length > 0.0001) {
        directionX = deltaX / length;
        directionY = deltaY / length;
      }
    }

    if (tangentScreen) {
      const deltaX = tangentScreen.x - anchorScreen.x;
      const deltaY = tangentScreen.y - anchorScreen.y;
      const length = Math.hypot(deltaX, deltaY);
      if (length > 0.0001) {
        tangentX = deltaX / length;
        tangentY = deltaY / length;
      }
    }

    return {
      x: anchorScreen.x,
      y: anchorScreen.y,
      directionX,
      directionY,
      tangentX,
      tangentY,
      rotationDeg: this.normalizeRotation(MathUtils.radToDeg(Math.atan2(tangentY, tangentX))),
    };
  }

  private getAnchors(): {
    top: {
      x: number;
      y: number;
      directionX: number;
      directionY: number;
      tangentX: number;
      tangentY: number;
      rotationDeg: number;
    };
    bottom: {
      x: number;
      y: number;
      directionX: number;
      directionY: number;
      tangentX: number;
      tangentY: number;
      rotationDeg: number;
    };
  } | null {
    const anchors = (['top', 'bottom', 'left', 'right'] as const)
      .map(edge => this.getAnchor(edge))
      .filter(
        (
          anchor
        ): anchor is {
          x: number;
          y: number;
          directionX: number;
          directionY: number;
          tangentX: number;
          tangentY: number;
          rotationDeg: number;
        } => Boolean(anchor)
      );

    if (anchors.length === 0) {
      return null;
    }

    let top = anchors[0];
    let bottom = anchors[0];
    for (const anchor of anchors) {
      if (anchor.y < top.y) {
        top = anchor;
      }
      if (anchor.y > bottom.y) {
        bottom = anchor;
      }
    }

    return { top, bottom };
  }

  private positionBadge(
    badge: HTMLDivElement,
    anchor: {
      x: number;
      y: number;
      directionX: number;
      directionY: number;
      tangentX: number;
      tangentY: number;
      rotationDeg: number;
    },
    offsetPx: number
  ): void {
    const viewportSize = this.deps.getViewportSize();
    const x = Math.min(
      viewportSize.width - 14,
      Math.max(14, anchor.x + anchor.directionX * offsetPx)
    );
    const y = Math.min(
      viewportSize.height - 14,
      Math.max(14, anchor.y + anchor.directionY * offsetPx)
    );

    badge.style.left = `${x}px`;
    badge.style.top = `${y}px`;
    badge.style.transform = `translate(-50%, -50%) rotate(${anchor.rotationDeg}deg)`;
  }

  private getBadgeOffset(
    badge: HTMLDivElement,
    anchor: {
      x: number;
      y: number;
      directionX: number;
      directionY: number;
      tangentX: number;
      tangentY: number;
      rotationDeg: number;
    },
    rotateHandleScreen: { x: number; y: number } | null,
    baseOffsetPx: number
  ): number {
    if (!rotateHandleScreen) {
      return baseOffsetPx;
    }

    const projectedDistance =
      (rotateHandleScreen.x - anchor.x) * anchor.directionX +
      (rotateHandleScreen.y - anchor.y) * anchor.directionY;
    if (projectedDistance <= 0) {
      return baseOffsetPx;
    }

    return Math.max(baseOffsetPx, projectedDistance + badge.offsetHeight / 2 + 12);
  }

  update(): void {
    this.attach();

    // Keep the HUD alive during resize/rotate: a plain move surfaces nothing,
    // a resize keeps the live size badge, and a rotate swaps that badge for a
    // live angle readout (the size is hidden until the pointer is released).
    const activeHandle = this.deps.getActive2DTransformHandle();
    const isMoving = activeHandle === 'move';
    const isRotating = activeHandle === 'rotate';

    const selection2DOverlay = this.deps.getSelection2DOverlay();
    const viewportSize = this.deps.getViewportSize();
    if (
      !selection2DOverlay ||
      !this.hud ||
      !this.deps.getOrthographicCamera() ||
      viewportSize.width <= 0 ||
      viewportSize.height <= 0 ||
      isMoving
    ) {
      this.hide();
      return;
    }

    const activeSceneId = appState.scenes.activeSceneId;
    if (!activeSceneId) {
      this.hide();
      return;
    }

    const sceneGraph = this.deps.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      this.hide();
      return;
    }

    const bounds = this.getLocalBounds(selection2DOverlay);
    const size = bounds.getSize(new THREE.Vector3());
    const anchors = this.getAnchors();
    if (!anchors) {
      this.hide();
      return;
    }
    const { top: topAnchor, bottom: bottomAnchor } = anchors;

    const topBadgeData = this.getTopBadgeData(selection2DOverlay.nodeIds, sceneGraph.nodeMap);
    const bottomBadgeText = isRotating
      ? this.getAngleText(
          selection2DOverlay.nodeIds,
          sceneGraph.nodeMap,
          selection2DOverlay.worldRotationZ ?? 0
        )
      : this.getSizeText(selection2DOverlay.nodeIds, sceneGraph.nodeMap, size);

    this.renderBadge(
      this.hud.top,
      topBadgeData.iconName,
      topBadgeData.label,
      topBadgeData.backgroundColor,
      `${topBadgeData.label}${topBadgeData.typeLabel ? ` · ${topBadgeData.typeLabel}` : ''}`
    );
    this.renderBadge(this.hud.bottom, null, bottomBadgeText.text, '#4e8df5', bottomBadgeText.text);

    this.applyBadgePositions(topAnchor, bottomAnchor);
  }

  /**
   * Reproject the HUD badge anchors against the current camera and lay the
   * badges out, without rebuilding their content. Called every painted frame
   * while a 2D selection is shown so the badges stay glued to the object as the
   * camera pans/zooms: the WebGL selection frame and transform handles are
   * world-space meshes that follow the camera on their own, but these DOM badges
   * are positioned in screen space and would otherwise stay put during a pan.
   */
  reposition(): void {
    const hud = this.hud;
    const viewportSize = this.deps.getViewportSize();
    if (
      !this.deps.getSelection2DOverlay() ||
      !hud ||
      !this.deps.getOrthographicCamera() ||
      viewportSize.width <= 0 ||
      viewportSize.height <= 0
    ) {
      return;
    }

    // Nothing is currently shown (no selection, or hidden mid-move):
    // update() owns the show/hide decision, so bail here.
    if (hud.top.style.display === 'none' && hud.bottom.style.display === 'none') {
      return;
    }

    const anchors = this.getAnchors();
    if (!anchors) {
      return;
    }

    this.applyBadgePositions(anchors.top, anchors.bottom);
  }

  private applyBadgePositions(topAnchor: HudAnchor, bottomAnchor: HudAnchor): void {
    const hud = this.hud;
    if (!hud) {
      return;
    }

    const rotateHandleScreen = this.getRotateHandleScreenPosition();
    const topOffset = this.getBadgeOffset(hud.top, topAnchor, rotateHandleScreen, 18);
    const bottomOffset = this.getBadgeOffset(hud.bottom, bottomAnchor, rotateHandleScreen, 18);

    this.positionBadge(hud.top, topAnchor, topOffset);
    this.positionBadge(hud.bottom, bottomAnchor, bottomOffset);
  }

  hide(): void {
    if (!this.hud) {
      return;
    }

    this.hud.top.style.display = 'none';
    this.hud.bottom.style.display = 'none';
  }

  private renderBadge(
    badge: HTMLDivElement,
    iconName: string | null,
    label: string,
    backgroundColor: string,
    title: string
  ): void {
    badge.replaceChildren();
    badge.style.display = 'inline-flex';
    badge.style.background = backgroundColor;
    badge.title = title;

    if (iconName) {
      const icon = document.createElement('span');
      icon.setAttribute('aria-hidden', 'true');
      Object.assign(icon.style, {
        width: '12px',
        height: '12px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: '0',
        flex: '0 0 auto',
      } satisfies Partial<CSSStyleDeclaration>);
      icon.innerHTML = this.deps.getIconSvg(iconName, 12);
      badge.appendChild(icon);
    }

    const text = document.createElement('span');
    text.textContent = label;
    badge.appendChild(text);
  }

  private getTopBadgeData(
    nodeIds: string[],
    nodeMap: Map<string, NodeBase>
  ): {
    iconName: string;
    label: string;
    backgroundColor: string;
    typeLabel: string | null;
  } {
    if (nodeIds.length === 1) {
      const node = nodeMap.get(nodeIds[0]);
      if (node) {
        const visuals = getNodeVisuals(node);
        return {
          iconName: visuals.icon,
          label: node.name,
          backgroundColor: '#4e8df5',
          typeLabel: node.type,
        };
      }
    }

    return {
      iconName: 'layers',
      label: `${nodeIds.length} selected`,
      backgroundColor: '#4e8df5',
      typeLabel: null,
    };
  }

  private getRotateHandleScreenPosition(): { x: number; y: number } | null {
    const rotationHandle = this.deps.getSelection2DOverlay()?.rotationHandle;
    if (!rotationHandle) {
      return null;
    }

    const worldPosition = rotationHandle.getWorldPosition(new THREE.Vector3());
    return this.deps.projectWorldToOverlay(worldPosition);
  }

  private getSizeText(
    nodeIds: string[],
    nodeMap: Map<string, NodeBase>,
    fallbackBoundsSize: THREE.Vector3
  ): { text: string } {
    if (nodeIds.length === 1) {
      const node = nodeMap.get(nodeIds[0]);
      if (node instanceof Node2D) {
        const nodeSize = this.getNodeInspectorSize(node);
        if (nodeSize) {
          return {
            text: `${this.formatDimension(nodeSize.width, nodeSize.widthPrecision)} x ${this.formatDimension(nodeSize.height, nodeSize.heightPrecision)}`,
          };
        }
      }
    }

    return {
      text: `${this.formatDimension(fallbackBoundsSize.x)} x ${this.formatDimension(fallbackBoundsSize.y)}`,
    };
  }

  private getAngleText(
    nodeIds: string[],
    nodeMap: Map<string, NodeBase>,
    fallbackRotationZ: number
  ): { text: string } {
    let radians = fallbackRotationZ;
    if (nodeIds.length === 1) {
      const node = nodeMap.get(nodeIds[0]);
      if (node instanceof Node2D) {
        radians = node.rotation.z;
      }
    }

    // Normalize to (-180, 180] for a readable live readout.
    let degrees = MathUtils.radToDeg(radians) % 360;
    if (degrees > 180) {
      degrees -= 360;
    } else if (degrees <= -180) {
      degrees += 360;
    }
    if (Object.is(degrees, -0)) {
      degrees = 0;
    }

    return { text: `${this.formatDimension(degrees, 1)}°` };
  }

  private getNodeInspectorSize(node: Node2D): {
    width: number;
    height: number;
    widthPrecision: number;
    heightPrecision: number;
  } | null {
    const sizedNode = node as Node2D & { width?: number; height?: number };
    if (typeof sizedNode.width !== 'number' || typeof sizedNode.height !== 'number') {
      return null;
    }

    const schemaGetter = (
      node.constructor as { getPropertySchema?: () => { properties: PropertyDefinition[] } }
    ).getPropertySchema;
    const schema = typeof schemaGetter === 'function' ? schemaGetter() : null;
    const widthPrecision =
      schema?.properties.find((property: PropertyDefinition) => property.name === 'width')?.ui
        ?.precision ?? 0;
    const heightPrecision =
      schema?.properties.find((property: PropertyDefinition) => property.name === 'height')?.ui
        ?.precision ?? 0;

    return {
      width: sizedNode.width,
      height: sizedNode.height,
      widthPrecision,
      heightPrecision,
    };
  }

  private formatDimension(value: number, precision: number = 1): string {
    const safePrecision = Math.max(0, precision);
    const rounded = Number(value.toFixed(safePrecision));
    if (safePrecision === 0) {
      return String(Math.round(rounded));
    }

    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(safePrecision);
  }

  dispose(): void {
    this.hud?.root.remove();
    this.hud = undefined;
  }
}
