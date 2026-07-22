import * as THREE from 'three';
import { MathUtils } from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { appState } from '@/state';
import { resolveViewportClick } from '@/features/selection/SelectionScopeResolver';
import { NodeBase } from '@pix3/runtime';
import { Node2D } from '@pix3/runtime';
import { Group2D } from '@pix3/runtime';
import { AnimatedSprite2D } from '@pix3/runtime';
import { Sprite2D } from '@pix3/runtime';
import { TiledSprite2D } from '@pix3/runtime';
import { ColorRect2D } from '@pix3/runtime';
import { UIControl2D } from '@pix3/runtime';
import type { SceneGraph } from '@pix3/runtime';
import type { Viewport2DProxyRegistry } from './Viewport2DProxyRegistry';

const LAYER_GIZMOS = 2;

/**
 * Dependencies the pointer hit-testing math borrows from
 * {@link ViewportRendererService}. Scoped to exactly what this collaborator
 * needs: the facade owns the cameras/controls, the viewport size, the layer
 * visibility flags, the scene-graph lookup, the gizmo/icon adornment maps, the
 * 2D proxy registry, and the hierarchy-visibility / world-corner / overlay-
 * projection helpers, and passes them in via closures so this object never
 * reaches back into the facade directly. `appState` is a Valtio global and is
 * imported directly, same as every other collaborator.
 */
export interface ViewportPickingDeps {
  /** The active 3D/2D render camera (perspective in 3D, editor ortho in 2D). */
  getCamera(): THREE.PerspectiveCamera | THREE.OrthographicCamera | undefined;
  /** The dedicated 2D-overlay orthographic camera. */
  getOrthographicCamera(): THREE.OrthographicCamera | undefined;
  /** Orbit controls for the 3D camera (used for the drop-distance fallback). */
  getOrbitControls(): OrbitControls | undefined;
  /** Current viewport pixel size, for NDC conversion. */
  getViewportSize(): { width: number; height: number };
  /** Whether the 2D layer is currently visible/selectable. */
  isLayer2DVisible(): boolean;
  /** Whether the 3D layer is currently visible/selectable. */
  isLayer3DVisible(): boolean;
  /** Look up a scene graph by id (nullable). */
  getSceneGraph(sceneId: string): SceneGraph | null;
  /** The camera/light/particle billboard icon sprites, keyed by node id. */
  getNodeIcons(): ReadonlyMap<string, THREE.Sprite>;
  /** The camera/light target gizmos, keyed by node id. */
  getTargetGizmos(): ReadonlyMap<string, THREE.Object3D>;
  /** The 2D node editor proxy-visual registry. */
  getProxyRegistry(): Viewport2DProxyRegistry;
  /** Whether an object and all its ancestors are visible. */
  isVisibleInHierarchy(object: THREE.Object3D): boolean;
  /** The four world-space corners of a 2D node's own (descendant-excluding) box. */
  getNodeOnlyWorldCorners(node: Node2D): THREE.Vector3[];
  /** Project a world point into overlay (CSS-pixel) space, or null if unavailable. */
  projectWorldToOverlay(world: THREE.Vector3): { x: number; y: number } | null;
}

/**
 * Owns the pure pointer hit-testing math for the editor viewport: 2D
 * paint-order raycasting, 3D gizmo/target-sphere/icon raycasting, marquee-
 * rectangle hit testing, and screen↔NDC conversion. Extracted from
 * ViewportRendererService (decomposition step 11/13). Not `@injectable()` — it
 * is an owned collaborator constructed by the facade with borrowed
 * dependencies. The higher-level "what does a click/hover actually select"
 * dispatch (which also mutates drag / target-selection state) stays on the
 * facade and drives these methods.
 */
export class ViewportPicking {
  constructor(private readonly deps: ViewportPickingDeps) {}

  getSelectable2DNodeIdsInScreenRect(
    startX: number,
    startY: number,
    endX: number,
    endY: number
  ): string[] {
    if (!this.deps.getOrthographicCamera() || !this.deps.isLayer2DVisible()) {
      return [];
    }

    const activeSceneId = appState.scenes.activeSceneId;
    if (!activeSceneId) {
      return [];
    }

    const sceneGraph = this.deps.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      return [];
    }

    const selectionRect = this.normalizeScreenRect(startX, startY, endX, endY);
    const hitNodeIds: string[] = [];

    const collectHits = (nodes: NodeBase[]): void => {
      for (const node of nodes) {
        if (this.isScreenRectSelectable2DNode(node)) {
          const screenRect = this.getNode2DScreenRect(node);
          if (screenRect && this.screenRectsIntersect(selectionRect, screenRect)) {
            hitNodeIds.push(node.nodeId);
          }
        }

        if (node.children.length > 0) {
          collectHits(node.children);
        }
      }
    };

    collectHits(sceneGraph.rootNodes);
    return hitNodeIds;
  }

  raycastNodeIcon(screenX: number, screenY: number): string | null {
    const camera = this.deps.getCamera();
    const nodeIcons = this.deps.getNodeIcons();
    if (!camera || nodeIcons.size === 0 || !this.deps.isLayer3DVisible()) {
      return null;
    }

    const raycaster = new THREE.Raycaster();
    raycaster.layers.set(LAYER_GIZMOS);

    const mouse = new THREE.Vector2();
    mouse.x = screenX * 2 - 1;
    mouse.y = -(screenY * 2 - 1);
    raycaster.setFromCamera(mouse, camera);

    const icons = Array.from(nodeIcons.values()).filter(icon => icon.visible);
    if (!icons.length) {
      return null;
    }

    const hits = raycaster.intersectObjects(icons, false);
    if (!hits.length) {
      return null;
    }

    const hitNodeId = hits[0].object.userData.nodeId;
    return typeof hitNodeId === 'string' ? hitNodeId : null;
  }

  raycastTargetSphere(screenX: number, screenY: number): string | null {
    const camera = this.deps.getCamera();
    const targetGizmos = this.deps.getTargetGizmos();
    if (!camera || targetGizmos.size === 0 || !this.deps.isLayer3DVisible()) {
      return null;
    }

    const raycaster = new THREE.Raycaster();
    raycaster.layers.set(LAYER_GIZMOS);

    const mouse = new THREE.Vector2();
    mouse.x = screenX * 2 - 1;
    mouse.y = -(screenY * 2 - 1);
    raycaster.setFromCamera(mouse, camera);

    const targetSpheres: THREE.Object3D[] = [];
    for (const gizmo of targetGizmos.values()) {
      gizmo.traverse(child => {
        if (child.userData.isTargetSphere && child.visible) {
          targetSpheres.push(child);
        }
      });
    }

    if (!targetSpheres.length) {
      return null;
    }

    const hits = raycaster.intersectObjects(targetSpheres, false);
    if (!hits.length) {
      return null;
    }

    const hitNodeId = hits[0].object.userData.parentNodeId;
    return typeof hitNodeId === 'string' ? hitNodeId : null;
  }

  raycast2D(pixelX: number, pixelY: number): NodeBase | null {
    const orthographicCamera = this.deps.getOrthographicCamera();
    if (!orthographicCamera || !this.deps.isLayer2DVisible()) {
      return null;
    }

    const mouse = this.toNdc(pixelX, pixelY);
    if (!mouse) {
      return null;
    }

    const raycaster = new THREE.Raycaster();
    raycaster.params.Line.threshold = 0.5;
    raycaster.layers.set(1);
    raycaster.setFromCamera(mouse, orthographicCamera);

    const proxyRegistry = this.deps.getProxyRegistry();
    // Only hit-test rendered 2D visuals; transparent container groups are intentionally skipped
    const candidates: THREE.Object3D[] = [
      ...proxyRegistry.animatedSprite2DVisuals.values(),
      ...proxyRegistry.sprite2DVisuals.values(),
      ...proxyRegistry.colorRect2DVisuals.values(),
      ...proxyRegistry.tiledSprite2DVisuals.values(),
      ...proxyRegistry.uiControl2DVisuals.values(),
    ];

    // console.debug('[ViewportRenderer] 2D raycast candidates', {
    //   count: candidates.length,
    //   nodeIds: candidates.map(c => c.userData?.nodeId).filter(Boolean),
    //   mouse,
    // });

    const intersects = raycaster
      .intersectObjects(candidates, true)
      .filter(intersection => this.deps.isVisibleInHierarchy(intersection.object));
    // console.debug(
    //   '[ViewportRenderer] 2D raycast intersects',
    //   intersects.map(i => ({
    //     nodeId: i.object.userData?.nodeId,
    //     distance: i.distance,
    //     point: i.point,
    //   }))
    // );
    if (!intersects.length) {
      // console.debug('[ViewportRenderer] 2D raycast miss at', { pixelX, pixelY });
      return null;
    }

    const activeSceneId = appState.scenes.activeSceneId;
    if (!activeSceneId) {
      return null;
    }

    const sceneGraph = this.deps.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      return null;
    }

    // In orthographic 2D all visuals share Z, so raycaster distance cannot order
    // them. Paint order (hence "closest to the camera") is scene-tree DFS order —
    // the exact walk `assign2DVisualRenderOrder` uses to rebase renderOrder — so a
    // node visited later in DFS is drawn on top. Rank each hit by its owning
    // node's DFS index and return the frontmost selectable one. Locked nodes are
    // click-through, so we fall past them to the next-frontmost hit.
    const paintOrder = this.build2DPaintOrderIndex(sceneGraph.rootNodes);
    const ranked = intersects
      .map(intersection => {
        const nid = intersection.object.userData?.nodeId as string | undefined;
        return nid ? { nodeId: nid, order: paintOrder.get(nid) ?? -1 } : null;
      })
      .filter((entry): entry is { nodeId: string; order: number } => entry !== null)
      .sort((a, b) => b.order - a.order);

    for (const entry of ranked) {
      const node = sceneGraph.nodeMap.get(entry.nodeId);
      if (!(node instanceof NodeBase)) {
        continue;
      }
      if (node.properties.locked) {
        continue;
      }
      return node;
    }

    return null;
  }

  /**
   * Build a `nodeId → paint-order index` map using the same scene-tree DFS walk
   * as {@link assign2DVisualRenderOrder}. A higher index means the node is
   * painted later, i.e. closer to the camera in the 2D overlay — used to resolve
   * the frontmost node under the pointer during 2D hit-testing.
   */
  private build2DPaintOrderIndex(rootNodes: readonly NodeBase[]): Map<string, number> {
    const index = new Map<string, number>();
    let next = 0;
    const visit = (node: NodeBase): void => {
      index.set(node.nodeId, next++);
      for (const child of node.children) {
        if (child instanceof NodeBase) {
          visit(child);
        }
      }
    };
    for (const node of rootNodes) {
      visit(node);
    }
    return index;
  }

  private normalizeScreenRect(
    startX: number,
    startY: number,
    endX: number,
    endY: number
  ): {
    left: number;
    right: number;
    top: number;
    bottom: number;
  } {
    return {
      left: Math.min(startX, endX),
      right: Math.max(startX, endX),
      top: Math.min(startY, endY),
      bottom: Math.max(startY, endY),
    };
  }

  private screenRectsIntersect(
    a: { left: number; right: number; top: number; bottom: number },
    b: { left: number; right: number; top: number; bottom: number }
  ): boolean {
    return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
  }

  private getNode2DScreenRect(node: Node2D): {
    left: number;
    right: number;
    top: number;
    bottom: number;
  } | null {
    const projectedCorners = this.deps
      .getNodeOnlyWorldCorners(node)
      .map(corner => this.deps.projectWorldToOverlay(corner))
      .filter(
        (
          point
        ): point is {
          x: number;
          y: number;
        } => point !== null
      );

    if (projectedCorners.length === 0) {
      return null;
    }

    let left = projectedCorners[0].x;
    let right = projectedCorners[0].x;
    let top = projectedCorners[0].y;
    let bottom = projectedCorners[0].y;

    for (let i = 1; i < projectedCorners.length; i += 1) {
      const point = projectedCorners[i];
      left = Math.min(left, point.x);
      right = Math.max(right, point.x);
      top = Math.min(top, point.y);
      bottom = Math.max(bottom, point.y);
    }

    return { left, right, top, bottom };
  }

  private isScreenRectSelectable2DNode(node: NodeBase): node is Node2D {
    if (!(node instanceof Node2D) || node instanceof Group2D) {
      return false;
    }

    if (
      !(
        node instanceof AnimatedSprite2D ||
        node instanceof Sprite2D ||
        node instanceof ColorRect2D ||
        node instanceof TiledSprite2D ||
        node instanceof UIControl2D
      )
    ) {
      return false;
    }

    if (Boolean(node.properties.locked) || !this.deps.isVisibleInHierarchy(node)) {
      return false;
    }

    return Boolean(this.get2DVisual(node));
  }

  /**
   * Resolve the node a click/hover should target from a raw hit leaf, applying
   * the Figma-style isolation scope (`appState.selection.focusNodeId`). Shared
   * with the click path (editor-tab) via {@link resolveViewportClick} so hover
   * highlights exactly what a click would select. Returns `null` if nothing
   * resolves or the candidate is not a live node.
   */
  resolveScoped2DCandidateNode(leafId: string, deep: boolean): NodeBase | null {
    const activeSceneId = appState.scenes.activeSceneId;
    if (!activeSceneId) {
      return null;
    }
    const sceneGraph = this.deps.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      return null;
    }
    const { candidateId } = resolveViewportClick(
      id => sceneGraph.nodeMap.get(id) ?? null,
      appState.selection.focusNodeId,
      leafId,
      { deep }
    );
    if (!candidateId) {
      return null;
    }
    const node = sceneGraph.nodeMap.get(candidateId);
    return node instanceof NodeBase ? node : null;
  }

  toNdc(screenX: number, screenY: number): THREE.Vector2 | null {
    const { width, height } = this.deps.getViewportSize();
    if (width <= 0 || height <= 0) return null;
    return new THREE.Vector2((screenX / width) * 2 - 1, -(screenY / height) * 2 + 1);
  }

  resolve3DAssetDropFallback(objectSize?: THREE.Vector3 | null): THREE.Vector3 | null {
    const camera = this.deps.getCamera();
    if (!camera) {
      return null;
    }

    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    if (forward.lengthSq() === 0) {
      forward.set(0, 0, -1);
    }
    forward.normalize();

    if (camera instanceof THREE.PerspectiveCamera) {
      const maxDim = Math.max(objectSize?.x ?? 1, objectSize?.y ?? 1, objectSize?.z ?? 1, 0.001);
      const fov = MathUtils.degToRad(camera.fov);
      const distance = Math.max((maxDim * 1.5) / Math.tan(fov / 2), camera.near + maxDim, 1);

      return camera.position.clone().add(forward.multiplyScalar(distance));
    }

    const orbitControls = this.deps.getOrbitControls();
    const orbitDistance = orbitControls
      ? camera.position.distanceTo(orbitControls.target)
      : Math.max(objectSize?.length() ?? 1, 10);

    return camera.position.clone().add(forward.multiplyScalar(Math.max(orbitDistance, 1)));
  }

  get2DVisual(node: Node2D): THREE.Object3D | undefined {
    const proxyRegistry = this.deps.getProxyRegistry();
    if (node instanceof Group2D) {
      return proxyRegistry.group2DVisuals.get(node.nodeId);
    }
    if (node instanceof AnimatedSprite2D) {
      return proxyRegistry.animatedSprite2DVisuals.get(node.nodeId);
    }
    if (node instanceof TiledSprite2D) {
      return proxyRegistry.tiledSprite2DVisuals.get(node.nodeId);
    }
    if (node instanceof Sprite2D) {
      return proxyRegistry.sprite2DVisuals.get(node.nodeId);
    }
    if (node instanceof ColorRect2D) {
      return proxyRegistry.colorRect2DVisuals.get(node.nodeId);
    }
    if (node instanceof UIControl2D) {
      return proxyRegistry.uiControl2DVisuals.get(node.nodeId);
    }
    return undefined;
  }
}
