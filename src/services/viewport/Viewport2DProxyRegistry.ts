import * as THREE from 'three';
import type { AnimationResource } from '@pix3/runtime';
import { AnimatedSprite2D } from '@pix3/runtime';
import { NodeBase } from '@pix3/runtime';
import { Node2D } from '@pix3/runtime';
import { Group2D } from '@pix3/runtime';
import { findAnimationClip } from '@pix3/runtime';
import { Sprite2D } from '@pix3/runtime';
import { TiledSprite2D } from '@pix3/runtime';
import { ColorRect2D } from '@pix3/runtime';
import { buildTiledSpriteGeometry, type TiledSpriteGeometryParams } from '@pix3/runtime';
import { UIControl2D } from '@pix3/runtime';
import { Button2D } from '@pix3/runtime';
import { Label2D } from '@pix3/runtime';
import {
  LABEL_AUTO_SIZE_BLEED,
  layoutLabelText,
  paintLabelCanvas,
  type LabelLayout,
} from '@pix3/runtime';
import { Slider2D } from '@pix3/runtime';
import { Bar2D } from '@pix3/runtime';
import { Checkbox2D } from '@pix3/runtime';
import { InventorySlot2D } from '@pix3/runtime';
import { getProjectTextureFiltering } from '@pix3/runtime';
import { appState } from '@/state';
import {
  deriveAnimationDocumentId,
  parseAnimationResourceText,
} from '@/features/scene/animation-asset-utils';

const LAYER_2D = 1;
/** sRGB of the accent token oklch(0.8 0.15 75) — keep in sync with --accent in src/index.css. */
const EDITOR_ACCENT_COLOR = 0xf5ae39;

/**
 * Configure a texture for 2D/sprite display: sRGB color space with mipmaps
 * disabled.
 *
 * Mipmap generation for these (frequently non-power-of-two) sprite textures is
 * broken on some ANGLE/D3D11 backends (notably Qualcomm Adreno on Windows on
 * ARM): the first GPU upload samples as transparent black and three.js caches
 * that empty upload (the texture version never changes afterwards), so the
 * sprite stays permanently invisible — with the apparent opacity varying by
 * the sampled mip level, i.e. by camera zoom or sprite size. Sprites are drawn
 * roughly 1:1 in the orthographic viewport, so mipmaps add no value here.
 *
 * Pure (no instance state) so it is a module-level function shared by the proxy
 * registry and the facade's remaining 3D texture-sync paths.
 */
export function configureSpriteTexture(texture: THREE.Texture): void {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  const filter =
    getProjectTextureFiltering() === 'nearest' ? THREE.NearestFilter : THREE.LinearFilter;
  texture.minFilter = filter;
  texture.magFilter = filter;
}

/**
 * World-space pixel thickness for 1px-wide screen features at a given ortho
 * zoom. Pure (only reads devicePixelRatio) so it is a module-level function
 * shared by the proxy registry and the facade's remaining frame builders.
 */
export function getFrameThicknessWorldPx(zoom: number): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const safeZoom = Math.max(0.0001, zoom);
  return dpr / safeZoom;
}

/**
 * Dependencies the proxy registry borrows from {@link ViewportRendererService}.
 * Scoped to exactly what this collaborator needs; the facade owns the resource
 * manager, the render-request path, the shader-effect install/uninstall pair
 * (its `uninstall` half is used by the facade's `disposeObject3D`), the generic
 * `disposeObject3D`, and the orthographic camera, and passes them in via
 * closures so the registry never reaches back into the facade directly.
 */
export interface Viewport2DProxyRegistryDeps {
  readBlob(path: string): Promise<Blob>;
  readText(path: string): Promise<string>;
  requestRender(): void;
  installProxyEffects(node: NodeBase, material: THREE.Material): void;
  disposeObject3D(root: THREE.Object3D): void;
  getOrthographicCamera(): THREE.OrthographicCamera | undefined;
}

/**
 * Owns every 2D node type's editor "proxy visual": the separate THREE.js meshes
 * the editor draws in place of the runtime 2D nodes (Group2D, Sprite2D,
 * ColorRect2D, AnimatedSprite2D, TiledSprite2D, UIControl2D). Extracted from
 * ViewportRendererService (decomposition steps 6-7/13). Not `@injectable()` — it
 * is an owned collaborator constructed by the facade with borrowed dependencies.
 *
 * The six visual maps are public mutable fields because the facade's node
 * dispatchers (processNodeForRendering / updateNodeTransform / syncAll2DVisuals /
 * dispose paths) read and write them directly at many call sites; wrapping them
 * behind a method API would buy no behavioral benefit and much more diff risk.
 */
export class Viewport2DProxyRegistry {
  readonly group2DVisuals = new Map<string, THREE.Group>();
  readonly animatedSprite2DVisuals = new Map<string, THREE.Group>();
  readonly sprite2DVisuals = new Map<string, THREE.Group>();
  readonly colorRect2DVisuals = new Map<string, THREE.Group>();
  readonly tiledSprite2DVisuals = new Map<string, THREE.Group>();
  readonly uiControl2DVisuals = new Map<string, THREE.Group>();
  // Shared 2D context for Label2D text measurement (layout mirroring the runtime).
  private labelMeasureCtx: CanvasRenderingContext2D | null = null;

  constructor(private readonly deps: Viewport2DProxyRegistryDeps) {}

  getVisualRoot(nodeId: string): THREE.Group | undefined {
    return (
      this.group2DVisuals.get(nodeId) ??
      this.sprite2DVisuals.get(nodeId) ??
      this.colorRect2DVisuals.get(nodeId) ??
      this.animatedSprite2DVisuals.get(nodeId) ??
      this.tiledSprite2DVisuals.get(nodeId) ??
      this.uiControl2DVisuals.get(nodeId)
    );
  }

  /**
   * Editor-side counterpart of the runtime's `assign2DRenderOrder`: assigns
   * contiguous `renderOrder` to the 2D proxy-visual meshes in scene-tree DFS
   * order so viewport stacking matches the authored hierarchy. The runtime 2D
   * nodes are never added to the editor scene — only these proxies are drawn —
   * so without this pass three.js falls back to its transparent sort (view z,
   * then object creation id), which reshuffles stacking whenever a visual is
   * recreated (texture load, label change, tree edits).
   *
   * Editor adornments (anchor markers, Group2D outlines, selection/hover
   * frames) sit under `THREE.Group`s with a non-zero `renderOrder`; three.js
   * uses a group's `renderOrder` as `groupOrder`, which sorts before per-mesh
   * `renderOrder`, so they keep floating above scene content and are skipped
   * here. Within one visual, meshes keep their authored stacking (e.g. control
   * skin below its label) because the rebase sorts by the previous values —
   * the same idempotency argument as the runtime pass.
   */
  assignRenderOrder(rootNodes: readonly NodeBase[]): void {
    const visualRoots = new Set<THREE.Object3D>([
      ...this.group2DVisuals.values(),
      ...this.sprite2DVisuals.values(),
      ...this.colorRect2DVisuals.values(),
      ...this.animatedSprite2DVisuals.values(),
      ...this.tiledSprite2DVisuals.values(),
      ...this.uiControl2DVisuals.values(),
    ]);
    let next = 0;

    const collectContentMeshes = (object: THREE.Object3D, content: THREE.Object3D[]): void => {
      for (const child of object.children) {
        if (visualRoots.has(child)) {
          continue; // Another node's visual — it is ordered at its own tree position.
        }
        if ((child as THREE.Group).isGroup && child.renderOrder !== 0) {
          continue; // Floating adornment — stays above content via groupOrder.
        }
        if ((child as THREE.Mesh).isMesh) {
          content.push(child);
        }
        collectContentMeshes(child, content);
      }
    };

    const assignVisual = (visualRoot: THREE.Group): void => {
      const content: THREE.Object3D[] = [];
      collectContentMeshes(visualRoot, content);
      content
        .map((mesh, index) => ({ mesh, index }))
        .sort((a, b) => a.mesh.renderOrder - b.mesh.renderOrder || a.index - b.index)
        .forEach(entry => {
          entry.mesh.renderOrder = next++;
        });
    };

    const visitNode = (node: NodeBase): void => {
      if (node instanceof Node2D) {
        const visualRoot = this.getVisualRoot(node.nodeId);
        if (visualRoot) {
          assignVisual(visualRoot);
        }
      }
      for (const child of node.children) {
        if (child instanceof NodeBase) {
          visitNode(child);
        }
      }
    };

    for (const node of rootNodes) {
      visitNode(node);
    }
  }

  private getCrisp2DPosition(position: THREE.Vector3): { x: number; y: number; z: number } {
    return {
      x: Math.round(position.x),
      y: Math.round(position.y),
      z: position.z,
    };
  }

  apply2DVisualTransform(node: Node2D, visualRoot: THREE.Group): void {
    const crispPosition = this.getCrisp2DPosition(node.position);
    visualRoot.position.set(crispPosition.x, crispPosition.y, crispPosition.z);
    visualRoot.rotation.copy(node.rotation);
    visualRoot.scale.set(node.scale.x, node.scale.y, 1);
    visualRoot.visible = node.visible;
  }

  /**
   * Show a Sprite2D's anchor/pivot marker only while its node is selected. The
   * marker is created hidden and only meaningful for the node being edited, so
   * this keeps the pivot cross off every other sprite in the scene.
   */
  updateSprite2DAnchorMarkerVisibility(): void {
    const selectedIds = new Set(appState.selection.nodeIds);
    for (const [nodeId, visualRoot] of this.sprite2DVisuals) {
      const anchorMarker = visualRoot.userData.anchorMarker as THREE.Group | undefined;
      if (anchorMarker) {
        anchorMarker.visible = selectedIds.has(nodeId);
      }
    }
  }

  /**
   * Create a rectangle outline visual representation for a Group2D node.
   */
  createGroup2DVisual(node: Group2D): THREE.Group {
    // Visual hierarchy:
    // - root group: position/rotation/scale (transform scale)
    // - size group: width/height only (does NOT affect children)
    // - frame: four meshes representing the border with actual thickness in screen space

    const root = new THREE.Group();
    root.position.copy(node.position);
    root.rotation.copy(node.rotation);
    root.scale.set(node.scale.x, node.scale.y, 1);
    root.visible = node.visible;
    root.layers.set(LAYER_2D);

    const sizeGroup = new THREE.Group();
    sizeGroup.scale.set(node.width, node.height, 1);
    sizeGroup.layers.set(LAYER_2D);
    // groupOrder: keeps the outline above hierarchy-ordered 2D content meshes.
    sizeGroup.renderOrder = 410;

    // Create four border lines as actual meshes with thickness.
    // Border mesh lives in normalized space (sizeGroup scales to node width/height),
    // so convert world-pixel thickness into normalized local units.
    const thickness = getFrameThicknessWorldPx(1);
    const safeWidth = Math.max(1, Math.abs(node.width));
    const safeHeight = Math.max(1, Math.abs(node.height));
    const thicknessX = Math.min(1, thickness / safeWidth);
    const thicknessY = Math.min(1, thickness / safeHeight);

    // Top border
    const topGeometry = new THREE.PlaneGeometry(1, 1);
    const topMaterial = new THREE.MeshBasicMaterial({
      color: 0x96cbf6,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    topMaterial.userData.baseOpacity = 1;
    const topBorder = new THREE.Mesh(topGeometry, topMaterial);
    topBorder.position.set(0, 0.5 - thicknessY / 2, 0); // Align top edge
    topBorder.scale.set(1, thicknessY, 1);
    topBorder.layers.set(LAYER_2D);
    topBorder.renderOrder = 410;
    topBorder.userData.isGroup2DVisual = true;
    topBorder.userData.nodeId = node.nodeId;
    topBorder.userData.lineMaterial = topMaterial; // Store reference for color updates
    topBorder.userData.edge = 'top';

    // Bottom border
    const bottomGeometry = new THREE.PlaneGeometry(1, 1);
    const bottomMaterial = new THREE.MeshBasicMaterial({
      color: 0x96cbf6,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    bottomMaterial.userData.baseOpacity = 1;
    const bottomBorder = new THREE.Mesh(bottomGeometry, bottomMaterial);
    bottomBorder.position.set(0, -0.5 + thicknessY / 2, 0); // Align bottom edge
    bottomBorder.scale.set(1, thicknessY, 1);
    bottomBorder.layers.set(LAYER_2D);
    bottomBorder.renderOrder = 410;
    bottomBorder.userData.isGroup2DVisual = true;
    bottomBorder.userData.nodeId = node.nodeId;
    bottomBorder.userData.lineMaterial = bottomMaterial; // Store reference for color updates
    bottomBorder.userData.edge = 'bottom';

    // Left border
    const leftGeometry = new THREE.PlaneGeometry(1, 1);
    const leftMaterial = new THREE.MeshBasicMaterial({
      color: 0x96cbf6,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    leftMaterial.userData.baseOpacity = 1;
    const leftBorder = new THREE.Mesh(leftGeometry, leftMaterial);
    leftBorder.position.set(-0.5 + thicknessX / 2, 0, 0); // Align left edge
    leftBorder.scale.set(thicknessX, 1, 1);
    leftBorder.layers.set(LAYER_2D);
    leftBorder.renderOrder = 410;
    leftBorder.userData.isGroup2DVisual = true;
    leftBorder.userData.nodeId = node.nodeId;
    leftBorder.userData.lineMaterial = leftMaterial; // Store reference for color updates
    leftBorder.userData.edge = 'left';

    // Right border
    const rightGeometry = new THREE.PlaneGeometry(1, 1);
    const rightMaterial = new THREE.MeshBasicMaterial({
      color: 0x96cbf6,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    rightMaterial.userData.baseOpacity = 1;
    const rightBorder = new THREE.Mesh(rightGeometry, rightMaterial);
    rightBorder.position.set(0.5 - thicknessX / 2, 0, 0); // Align right edge
    rightBorder.scale.set(thicknessX, 1, 1);
    rightBorder.layers.set(LAYER_2D);
    rightBorder.renderOrder = 410;
    rightBorder.userData.isGroup2DVisual = true;
    rightBorder.userData.nodeId = node.nodeId;
    rightBorder.userData.lineMaterial = rightMaterial; // Store reference for color updates
    rightBorder.userData.edge = 'right';

    sizeGroup.add(topBorder, bottomBorder, leftBorder, rightBorder);
    root.add(sizeGroup);

    // Keep references for updates
    root.userData.isGroup2DVisualRoot = true;
    root.userData.nodeId = node.nodeId;
    root.userData.sizeGroup = sizeGroup;
    this.apply2DVisualOpacity(node, root);

    return root;
  }

  /**
   * Create a visual representation for an AnimatedSprite2D node.
   */
  createAnimatedSprite2DVisual(node: AnimatedSprite2D): THREE.Group {
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.computeBoundingBox();

    const material = new THREE.MeshBasicMaterial({
      color: node.color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
    });
    material.userData.baseOpacity = 1;
    this.deps.installProxyEffects(node, material);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.layers.set(LAYER_2D);
    mesh.userData.isAnimatedSprite2DVisual = true;
    mesh.userData.nodeId = node.nodeId;

    const root = new THREE.Group();
    root.position.copy(node.position);
    root.rotation.copy(node.rotation);
    root.scale.set(node.scale.x, node.scale.y, 1);
    root.visible = node.visible;
    root.layers.set(LAYER_2D);

    const sizeGroup = new THREE.Group();
    sizeGroup.scale.set(node.width ?? 64, node.height ?? 64, 1);
    sizeGroup.layers.set(LAYER_2D);
    sizeGroup.add(mesh);
    root.add(sizeGroup);

    root.userData.isAnimatedSprite2DVisualRoot = true;
    root.userData.nodeId = node.nodeId;
    root.userData.sizeGroup = sizeGroup;
    root.userData.spriteMesh = mesh;
    root.userData.animationResourcePath = node.animationResourcePath ?? null;
    root.userData.currentClip = node.currentClip;
    root.userData.currentFrame = node.currentFrame;
    root.userData.color = node.color;

    this.syncAnimatedSprite2DVisual(node, root);
    return root;
  }

  /**
   * Create a visual representation for a Sprite2D node.
   * Renders the texture if available, or a placeholder rectangle if not.
   */
  createSprite2DVisual(node: Sprite2D): THREE.Group {
    // Visual hierarchy:
    // - root group: position/rotation/scale (transform scale)
    // - size group: width/height only (does NOT affect children)
    // - mesh: normalized quad
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.computeBoundingBox();

    const material = new THREE.MeshBasicMaterial({
      color: 0xcccccc,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
    });
    material.userData.baseOpacity = 1;
    this.applyTextureToSprite2DMaterial(node, material);
    this.deps.installProxyEffects(node, material);

    const mesh = new THREE.Mesh(geometry, material);

    const anchor = this.getSprite2DAnchor(node);
    mesh.position.set(0.5 - anchor.x, 0.5 - anchor.y, 0);

    mesh.layers.set(LAYER_2D);
    mesh.userData.isSprite2DVisual = true;
    mesh.userData.nodeId = node.nodeId;

    const root = new THREE.Group();
    root.position.copy(node.position);
    root.rotation.copy(node.rotation);
    root.scale.set(node.scale.x, node.scale.y, 1);
    root.visible = node.visible;
    root.layers.set(LAYER_2D);

    const sizeGroup = new THREE.Group();
    const w = node.width ?? node.originalWidth ?? 64;
    const h = node.height ?? node.originalHeight ?? (96 / 217) * 64; // arbitrary but consistent
    sizeGroup.scale.set(w, h, 1);
    sizeGroup.layers.set(LAYER_2D);
    sizeGroup.add(mesh);

    const anchorMarker = this.createSprite2DAnchorMarker(node, w, h);
    sizeGroup.add(anchorMarker);
    root.add(sizeGroup);

    root.userData.isSprite2DVisualRoot = true;
    root.userData.nodeId = node.nodeId;
    root.userData.sizeGroup = sizeGroup;
    root.userData.spriteMesh = mesh;
    root.userData.anchorMarker = anchorMarker;
    root.userData.texturePath = node.getEffectiveTexturePath() ?? null;
    this.apply2DVisualOpacity(node, root);

    return root;
  }

  /**
   * Create a solid-fill proxy visual for a ColorRect2D node. Mirrors the
   * Sprite2D proxy structure (root transform group → size group → normalized
   * quad) but paints the node's authored color instead of a texture and is
   * always center-origin (no anchor pivot / marker). Without this, ColorRect2D
   * had no editor proxy at all, so the rectangle was invisible in the viewport
   * and could not be picked or framed for selection.
   */
  createColorRect2DVisual(node: ColorRect2D): THREE.Group {
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.computeBoundingBox();

    const material = new THREE.MeshBasicMaterial({
      color: node.color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
    });
    material.userData.baseOpacity = 1;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(0, 0, 0);
    mesh.layers.set(LAYER_2D);
    mesh.userData.isColorRect2DVisual = true;
    mesh.userData.nodeId = node.nodeId;

    const root = new THREE.Group();
    root.position.copy(node.position);
    root.rotation.copy(node.rotation);
    root.scale.set(node.scale.x, node.scale.y, 1);
    root.visible = node.visible;
    root.layers.set(LAYER_2D);

    const sizeGroup = new THREE.Group();
    sizeGroup.scale.set(node.width, node.height, 1);
    sizeGroup.layers.set(LAYER_2D);
    sizeGroup.add(mesh);
    root.add(sizeGroup);

    root.userData.isColorRect2DVisualRoot = true;
    root.userData.nodeId = node.nodeId;
    root.userData.sizeGroup = sizeGroup;
    root.userData.colorRectMesh = mesh;
    this.apply2DVisualOpacity(node, root);

    return root;
  }

  /**
   * Sync the ColorRect2D proxy mesh color from the node's authored `color`.
   * `Color.set` applies the same sRGB → linear conversion the runtime uses, so
   * the editor swatch matches play mode.
   */
  applyColorRect2DColor(node: ColorRect2D, visualRoot: THREE.Group): void {
    const mesh = visualRoot.userData.colorRectMesh as THREE.Mesh | undefined;
    if (mesh && mesh.material instanceof THREE.MeshBasicMaterial) {
      mesh.material.color.set(node.color);
      mesh.material.needsUpdate = true;
    }
  }

  private createSprite2DAnchorMarker(_node: Sprite2D, width: number, height: number): THREE.Group {
    const marker = new THREE.Group();
    marker.position.set(0, 0, 0.01);
    marker.layers.set(LAYER_2D);
    marker.renderOrder = 420;
    marker.userData.isSprite2DAnchorMarker = true;
    // Anchor/pivot markers are only meaningful for the node the user is editing,
    // so they stay hidden until selection turns them on (see
    // updateSprite2DAnchorMarkerVisibility). Otherwise every sprite in the scene
    // shows a pivot cross, which is visual noise.
    marker.visible = false;

    const horizontal = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0x13161b,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        depthWrite: false,
      })
    );
    horizontal.layers.set(LAYER_2D);
    horizontal.renderOrder = 420;
    horizontal.material.userData.baseOpacity = 1;
    horizontal.userData.anchorMarkerPart = 'horizontal';
    marker.add(horizontal);

    const vertical = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0x13161b,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        depthWrite: false,
      })
    );
    vertical.layers.set(LAYER_2D);
    vertical.renderOrder = 420;
    vertical.material.userData.baseOpacity = 1;
    vertical.userData.anchorMarkerPart = 'vertical';
    marker.add(vertical);

    const center = new THREE.Mesh(
      new THREE.CircleGeometry(0.5, 16),
      new THREE.MeshBasicMaterial({
        color: EDITOR_ACCENT_COLOR,
        transparent: true,
        opacity: 1,
        depthTest: false,
        depthWrite: false,
      })
    );
    center.layers.set(LAYER_2D);
    center.renderOrder = 421;
    center.material.userData.baseOpacity = 1;
    center.userData.anchorMarkerPart = 'center';
    marker.add(center);

    this.updateSprite2DAnchorMarker(
      marker,
      Math.abs(width),
      Math.abs(height),
      getFrameThicknessWorldPx(this.deps.getOrthographicCamera()?.zoom ?? 1)
    );

    return marker;
  }

  updateSprite2DAnchorMarker(
    marker: THREE.Group,
    width: number,
    height: number,
    thickness: number
  ): void {
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    const localThicknessX = Math.min(0.3, thickness / safeWidth);
    const localThicknessY = Math.min(0.3, thickness / safeHeight);
    const horizontalLength = Math.min(0.45, (thickness * 10) / safeWidth);
    const verticalLength = Math.min(0.45, (thickness * 10) / safeHeight);
    const centerSizeX = Math.min(0.2, (thickness * 4) / safeWidth);
    const centerSizeY = Math.min(0.2, (thickness * 4) / safeHeight);

    marker.traverse(child => {
      if (!(child instanceof THREE.Mesh)) {
        return;
      }

      const part = child.userData.anchorMarkerPart as
        | 'horizontal'
        | 'vertical'
        | 'center'
        | undefined;

      if (part === 'horizontal') {
        child.scale.set(horizontalLength * 2, localThicknessY, 1);
      } else if (part === 'vertical') {
        child.scale.set(localThicknessX, verticalLength * 2, 1);
      } else if (part === 'center') {
        child.scale.set(centerSizeX, centerSizeY, 1);
      }
    });
  }

  getSprite2DAnchor(node: Sprite2D): { x: number; y: number } {
    const rawAnchor = (node as unknown as { anchor?: { x?: number; y?: number } }).anchor;
    const x = Number(rawAnchor?.x);
    const y = Number(rawAnchor?.y);
    return {
      x: Number.isFinite(x) ? x : 0.5,
      y: Number.isFinite(y) ? y : 0.5,
    };
  }

  /**
   * Re-apply the project's 2D texture filtering mode to every live 2D proxy
   * texture. Called when the project setting changes so the crisp/smoothed look
   * updates immediately without reloading textures. 3D textures are untouched.
   */
  reapplyTextureFiltering(): void {
    const filter =
      getProjectTextureFiltering() === 'nearest' ? THREE.NearestFilter : THREE.LinearFilter;
    const applyToRoot = (root: THREE.Object3D): void => {
      root.traverse(child => {
        if (!(child instanceof THREE.Mesh)) {
          return;
        }
        const material = child.material;
        const map = material instanceof THREE.MeshBasicMaterial ? material.map : null;
        if (map) {
          map.minFilter = filter;
          map.magFilter = filter;
          map.needsUpdate = true;
        }
      });
    };

    const registries = [
      this.sprite2DVisuals,
      this.animatedSprite2DVisuals,
      this.tiledSprite2DVisuals,
      this.uiControl2DVisuals,
    ];
    for (const registry of registries) {
      for (const root of registry.values()) {
        applyToRoot(root);
      }
    }

    this.deps.requestRender();
  }

  applyTextureToSprite2DMaterial(node: Sprite2D, material: THREE.MeshBasicMaterial): void {
    // Effective = localized (textureKey via the preview locale) else authored.
    const texturePath = node.getEffectiveTexturePath();
    if (!texturePath) {
      return;
    }

    const textureLoader = new THREE.TextureLoader();

    void (async () => {
      try {
        const blob = await this.deps.readBlob(texturePath);
        const blobUrl = URL.createObjectURL(blob);

        textureLoader.load(
          blobUrl,
          texture => {
            try {
              configureSpriteTexture(texture);
              material.map = texture;
              material.color.set(0xffffff);
              material.transparent = true;
              material.needsUpdate = true;
            } finally {
              URL.revokeObjectURL(blobUrl);
            }
          },
          undefined,
          () => {
            URL.revokeObjectURL(blobUrl);
          }
        );
      } catch {
        const schemeMatch = /^([a-z]+[a-z0-9+.-]*):\/\//i.exec(texturePath);
        const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : '';

        if (scheme === 'http' || scheme === 'https' || scheme === '') {
          try {
            const texture = textureLoader.load(texturePath);
            configureSpriteTexture(texture);
            material.map = texture;
            material.color.set(0xffffff);
            material.transparent = true;
            material.needsUpdate = true;
          } catch {
            // Keep placeholder material
          }
        }
      }
    })();
  }

  /**
   * Create a visual representation for a TiledSprite2D node. Unlike the Sprite2D
   * proxy (a unit quad scaled by a size group), the geometry is size-baked because
   * its UVs depend on the rect size, borders, and texture — so it is rebuilt via
   * the shared {@link buildTiledSpriteGeometry} whenever any of those change.
   */
  createTiledSprite2DVisual(node: TiledSprite2D): THREE.Group {
    const texWidth = node.textureWidth || 0;
    const texHeight = node.textureHeight || 0;
    const geometry = buildTiledSpriteGeometry(
      this.tiledSprite2DGeometryParams(node, texWidth, texHeight)
    );

    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
    });
    material.userData.baseOpacity = 1;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set((0.5 - node.anchor.x) * node.width, (0.5 - node.anchor.y) * node.height, 0);
    mesh.layers.set(LAYER_2D);
    mesh.userData.isTiledSprite2DVisual = true;
    mesh.userData.nodeId = node.nodeId;

    const root = new THREE.Group();
    root.position.copy(node.position);
    root.rotation.copy(node.rotation);
    root.scale.set(node.scale.x, node.scale.y, 1);
    root.visible = node.visible;
    root.layers.set(LAYER_2D);
    root.add(mesh);

    root.userData.isTiledSprite2DVisualRoot = true;
    root.userData.nodeId = node.nodeId;
    root.userData.tiledMesh = mesh;
    root.userData.texturePath = node.texturePath ?? null;
    root.userData.textureWidth = texWidth;
    root.userData.textureHeight = texHeight;
    root.userData.geometrySignature = this.tiledSprite2DSignature(node, texWidth, texHeight);

    this.applyTextureToTiledSprite2DVisual(node, root);
    this.apply2DVisualOpacity(node, root);

    return root;
  }

  private tiledSprite2DGeometryParams(
    node: TiledSprite2D,
    textureWidth: number,
    textureHeight: number
  ): TiledSpriteGeometryParams {
    return {
      mode: node.patchMode,
      width: node.width,
      height: node.height,
      textureWidth,
      textureHeight,
      border: { ...node.sliceBorder },
      drawCenter: node.drawCenter,
      axisStretchHorizontal: node.axisStretchHorizontal,
      axisStretchVertical: node.axisStretchVertical,
      tileScale: { x: node.tileScale.x, y: node.tileScale.y },
      tileOffset: { x: node.tileOffset.x, y: node.tileOffset.y },
    };
  }

  private tiledSprite2DSignature(
    node: TiledSprite2D,
    textureWidth: number,
    textureHeight: number
  ): string {
    const b = node.sliceBorder;
    return [
      node.patchMode,
      node.width,
      node.height,
      b.left,
      b.right,
      b.top,
      b.bottom,
      node.drawCenter,
      node.axisStretchHorizontal,
      node.axisStretchVertical,
      node.tileScale.x,
      node.tileScale.y,
      node.tileOffset.x,
      node.tileOffset.y,
      textureWidth,
      textureHeight,
    ].join('|');
  }

  private rebuildTiledSprite2DGeometry(node: TiledSprite2D, visualRoot: THREE.Group): void {
    const mesh = visualRoot.userData.tiledMesh as THREE.Mesh | undefined;
    if (!mesh) {
      return;
    }
    const texWidth = (visualRoot.userData.textureWidth as number) ?? 0;
    const texHeight = (visualRoot.userData.textureHeight as number) ?? 0;
    const geometry = buildTiledSpriteGeometry(
      this.tiledSprite2DGeometryParams(node, texWidth, texHeight)
    );
    mesh.geometry.dispose();
    mesh.geometry = geometry;
    mesh.position.set((0.5 - node.anchor.x) * node.width, (0.5 - node.anchor.y) * node.height, 0);
    visualRoot.userData.geometrySignature = this.tiledSprite2DSignature(node, texWidth, texHeight);
  }

  private applyTextureToTiledSprite2DVisual(node: TiledSprite2D, visualRoot: THREE.Group): void {
    const mesh = visualRoot.userData.tiledMesh as THREE.Mesh | undefined;
    if (!mesh || !(mesh.material instanceof THREE.MeshBasicMaterial)) {
      return;
    }
    const material = mesh.material;
    const texturePath = node.texturePath;
    if (!texturePath) {
      material.map = null;
      material.needsUpdate = true;
      return;
    }

    const onTextureReady = (texture: THREE.Texture) => {
      // Latest-wins + liveness guard: a load can resolve after the proxy was
      // disposed (leaking a rebuilt geometry) or after the node's texture was
      // swapped again (a stale load overwriting a newer one). Bail in both cases.
      if (
        this.tiledSprite2DVisuals.get(node.nodeId) !== visualRoot ||
        node.texturePath !== texturePath
      ) {
        texture.dispose();
        return;
      }

      configureSpriteTexture(texture);
      material.map = texture;
      material.color.set(0xffffff);
      material.transparent = true;
      material.needsUpdate = true;

      const img = texture.image as
        | { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number }
        | undefined;
      const w = img?.naturalWidth ?? img?.width;
      const h = img?.naturalHeight ?? img?.height;
      if (w && h) {
        visualRoot.userData.textureWidth = w;
        visualRoot.userData.textureHeight = h;
        // UVs (9-slice) and tile counts depend on the natural size — rebuild now.
        this.rebuildTiledSprite2DGeometry(node, visualRoot);
      }
    };

    const textureLoader = new THREE.TextureLoader();

    void (async () => {
      try {
        const blob = await this.deps.readBlob(texturePath);
        const blobUrl = URL.createObjectURL(blob);
        textureLoader.load(
          blobUrl,
          texture => {
            try {
              onTextureReady(texture);
            } finally {
              URL.revokeObjectURL(blobUrl);
            }
          },
          undefined,
          () => {
            URL.revokeObjectURL(blobUrl);
          }
        );
      } catch {
        const schemeMatch = /^([a-z]+[a-z0-9+.-]*):\/\//i.exec(texturePath);
        const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : '';
        if (scheme === 'http' || scheme === 'https' || scheme === '') {
          try {
            textureLoader.load(texturePath, texture => onTextureReady(texture));
          } catch {
            // Keep placeholder material
          }
        }
      }
    })();
  }

  syncTiledSprite2DVisual(node: TiledSprite2D, visualRoot: THREE.Group): void {
    this.apply2DVisualTransform(node, visualRoot);
    visualRoot.visible = node.visible;

    // React to a texture swap before rebuilding geometry (natural size may change).
    const mesh = visualRoot.userData.tiledMesh as THREE.Mesh | undefined;
    if (mesh && mesh.material instanceof THREE.MeshBasicMaterial) {
      const currentTexturePath = node.texturePath ?? null;
      const previousTexturePath = (visualRoot.userData.texturePath as string | null) ?? null;
      if (currentTexturePath !== previousTexturePath) {
        mesh.material.map = null;
        mesh.material.needsUpdate = true;
        visualRoot.userData.texturePath = currentTexturePath;
        visualRoot.userData.textureWidth = 0;
        visualRoot.userData.textureHeight = 0;
        this.applyTextureToTiledSprite2DVisual(node, visualRoot);
      }
    }

    const signature = this.tiledSprite2DSignature(
      node,
      (visualRoot.userData.textureWidth as number) ?? 0,
      (visualRoot.userData.textureHeight as number) ?? 0
    );
    if (signature !== visualRoot.userData.geometrySignature) {
      this.rebuildTiledSprite2DGeometry(node, visualRoot);
    } else if (mesh) {
      // Pivot can change without altering geometry.
      mesh.position.set((0.5 - node.anchor.x) * node.width, (0.5 - node.anchor.y) * node.height, 0);
    }

    this.apply2DVisualOpacity(node, visualRoot);
  }

  syncAnimatedSprite2DVisual(node: AnimatedSprite2D, visualRoot: THREE.Group): void {
    this.apply2DVisualTransform(node, visualRoot);

    const sizeGroup = visualRoot.userData.sizeGroup as THREE.Object3D | undefined;
    if (sizeGroup) {
      sizeGroup.scale.set(node.width ?? 64, node.height ?? 64, 1);
    }

    visualRoot.visible = node.visible;
    this.syncAnimatedSprite2DMaterial(node, visualRoot);
    this.apply2DVisualOpacity(node, visualRoot);
  }

  private syncAnimatedSprite2DMaterial(node: AnimatedSprite2D, visualRoot: THREE.Group): void {
    const mesh = visualRoot.userData.spriteMesh as THREE.Mesh | undefined;
    if (!mesh || !(mesh.material instanceof THREE.MeshBasicMaterial)) {
      return;
    }

    const material = mesh.material;
    const currentResourcePath = node.animationResourcePath?.trim() || null;
    const previousResourcePath =
      (visualRoot.userData.animationResourcePath as string | null) ?? null;
    const cachedTexturePath = (visualRoot.userData.animationTexturePath as string | null) ?? null;
    const openResource = currentResourcePath
      ? this.getLoadedAnimationResource(currentResourcePath)
      : null;
    const cachedResource =
      (visualRoot.userData.animationResource as AnimationResource | null) ?? null;

    visualRoot.userData.animationResourcePath = currentResourcePath;
    visualRoot.userData.currentClip = node.currentClip;
    visualRoot.userData.currentFrame = node.currentFrame;
    visualRoot.userData.color = node.color;

    if (openResource && openResource !== cachedResource) {
      visualRoot.userData.animationResource = openResource;
      if ((openResource.texturePath.trim() || null) !== cachedTexturePath) {
        void this.loadAnimatedSprite2DVisualAsset(node, visualRoot);
        this.applyAnimatedSprite2DPresentation(node, visualRoot, material);
        return;
      }
    }

    if (currentResourcePath !== previousResourcePath) {
      void this.loadAnimatedSprite2DVisualAsset(node, visualRoot);
      this.applyAnimatedSprite2DPresentation(node, visualRoot, material);
      return;
    }

    if (
      currentResourcePath &&
      !visualRoot.userData.animationResource &&
      !visualRoot.userData.animationLoadToken
    ) {
      void this.loadAnimatedSprite2DVisualAsset(node, visualRoot);
    }

    this.applyAnimatedSprite2DPresentation(node, visualRoot, material);
  }

  private applyAnimatedSprite2DPresentation(
    node: AnimatedSprite2D,
    visualRoot: THREE.Group,
    material?: THREE.MeshBasicMaterial
  ): void {
    const mesh = visualRoot.userData.spriteMesh as THREE.Mesh | undefined;
    const resolvedMaterial =
      material ?? (mesh?.material instanceof THREE.MeshBasicMaterial ? mesh.material : undefined);
    if (!resolvedMaterial) {
      return;
    }

    const resource = (visualRoot.userData.animationResource as AnimationResource | null) ?? null;
    const texture = (visualRoot.userData.animationTexture as THREE.Texture | null) ?? null;
    const clip = findAnimationClip(resource, node.currentClip);
    const frames = clip?.frames ?? [];
    const frameIndex =
      frames.length > 0 ? Math.max(0, Math.min(node.currentFrame, frames.length - 1)) : 0;
    const frame = frames[frameIndex] ?? null;

    if (texture) {
      if (resolvedMaterial.map !== texture) {
        resolvedMaterial.map = texture;
      }

      if (frame) {
        texture.offset.set(frame.offset.x, frame.offset.y);
        texture.repeat.set(frame.repeat.x, frame.repeat.y);
      } else {
        texture.offset.set(0, 0);
        texture.repeat.set(1, 1);
      }

      resolvedMaterial.color.set('#ffffff');
    } else {
      if (resolvedMaterial.map) {
        resolvedMaterial.map = null;
      }

      resolvedMaterial.color.set(node.color);
    }

    resolvedMaterial.transparent = true;
    resolvedMaterial.needsUpdate = true;
  }

  private async loadAnimatedSprite2DVisualAsset(
    node: AnimatedSprite2D,
    visualRoot: THREE.Group
  ): Promise<void> {
    const animationResourcePath = node.animationResourcePath?.trim() || '';
    const token = Number(visualRoot.userData.animationLoadToken ?? 0) + 1;
    visualRoot.userData.animationLoadToken = token;

    if (!animationResourcePath) {
      visualRoot.userData.animationResource = null;
      this.disposeAnimatedSprite2DTexture(visualRoot);
      this.applyAnimatedSprite2DPresentation(node, visualRoot);
      delete visualRoot.userData.animationLoadToken;
      return;
    }

    try {
      const resource =
        this.getLoadedAnimationResource(animationResourcePath) ??
        parseAnimationResourceText(await this.deps.readText(animationResourcePath));

      if (visualRoot.userData.animationLoadToken !== token) {
        return;
      }

      let texture: THREE.Texture | null = null;
      const texturePath = resource.texturePath.trim();
      if (texturePath) {
        texture = await this.loadAnimatedSpriteTexture(texturePath);
      }

      if (visualRoot.userData.animationLoadToken !== token) {
        texture?.dispose();
        return;
      }

      this.disposeAnimatedSprite2DTexture(visualRoot);
      visualRoot.userData.animationResource = resource;
      visualRoot.userData.animationTexture = texture;
      visualRoot.userData.animationTexturePath = texturePath || null;
      this.applyAnimatedSprite2DPresentation(node, visualRoot);
    } catch {
      if (visualRoot.userData.animationLoadToken !== token) {
        return;
      }

      visualRoot.userData.animationResource = null;
      this.disposeAnimatedSprite2DTexture(visualRoot);
      this.applyAnimatedSprite2DPresentation(node, visualRoot);
    } finally {
      if (visualRoot.userData.animationLoadToken === token) {
        delete visualRoot.userData.animationLoadToken;
      }
    }
  }

  private async loadAnimatedSpriteTexture(texturePath: string): Promise<THREE.Texture | null> {
    const textureLoader = new THREE.TextureLoader();

    try {
      const blob = await this.deps.readBlob(texturePath);
      const blobUrl = URL.createObjectURL(blob);

      return await new Promise(resolve => {
        textureLoader.load(
          blobUrl,
          texture => {
            try {
              configureSpriteTexture(texture);
              resolve(texture);
            } finally {
              URL.revokeObjectURL(blobUrl);
            }
          },
          undefined,
          () => {
            URL.revokeObjectURL(blobUrl);
            resolve(null);
          }
        );
      });
    } catch {
      const schemeMatch = /^([a-z]+[a-z0-9+.-]*):\/\//i.exec(texturePath);
      const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : '';

      if (scheme === 'http' || scheme === 'https' || scheme === '') {
        try {
          const texture = textureLoader.load(texturePath);
          configureSpriteTexture(texture);
          return texture;
        } catch {
          return null;
        }
      }

      return null;
    }
  }

  private getLoadedAnimationResource(resourcePath: string): AnimationResource | null {
    const animationId = deriveAnimationDocumentId(resourcePath);
    const descriptor = appState.animations.descriptors[animationId];
    if (!descriptor || descriptor.filePath !== resourcePath) {
      return null;
    }

    return appState.animations.resources[animationId] ?? null;
  }

  disposeAnimatedSprite2DTexture(visualRoot: THREE.Object3D): void {
    const texture = (visualRoot.userData.animationTexture as THREE.Texture | null) ?? null;
    if (texture) {
      texture.dispose();
    }

    visualRoot.userData.animationTexture = null;
    visualRoot.userData.animationTexturePath = null;
  }

  createUIControl2DVisual(node: UIControl2D): THREE.Group {
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.computeBoundingBox();

    const material = new THREE.MeshBasicMaterial({
      color: this.getUIControlDefaultColor(node),
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 1,
      depthTest: false,
    });
    material.userData.baseOpacity = node instanceof Label2D ? 0 : 1;

    this.applyTextureTo2DMaterial(node, material);
    // Only Button2D hosts effects among UIControl2D; installs on the SKIN mesh.
    this.deps.installProxyEffects(node, material);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.layers.set(LAYER_2D);
    mesh.userData.isUIControl2DVisual = true;
    mesh.userData.nodeId = node.nodeId;

    const root = new THREE.Group();
    root.position.copy(node.position);
    root.rotation.copy(node.rotation);
    root.scale.set(node.scale.x, node.scale.y, 1);
    root.visible = node.visible;
    root.layers.set(LAYER_2D);

    const { width, height } = this.getUIControlDimensions(node);
    const sizeGroup = new THREE.Group();
    sizeGroup.scale.set(width, height, 1);
    sizeGroup.layers.set(LAYER_2D);
    sizeGroup.add(mesh);

    root.add(sizeGroup);

    if (node.getDisplayText().trim().length > 0) {
      const labelMesh = this.createUIControlLabelMesh(node);
      root.add(labelMesh);
    }

    root.userData.isUIControl2DVisualRoot = true;
    root.userData.nodeId = node.nodeId;
    root.userData.sizeGroup = sizeGroup;
    root.userData.controlMesh = mesh;
    root.userData.texturePath = this.getUIControlSkinTextureUrl(node);
    this.apply2DVisualOpacity(node, root);

    return root;
  }

  getUIControlDimensions(node: UIControl2D): { width: number; height: number } {
    if (node instanceof Button2D) {
      return { width: node.width, height: node.height };
    }

    if (node instanceof Label2D) {
      const box = this.measureLabel2DBox(node);
      return { width: box.width, height: box.height };
    }

    if (node instanceof Slider2D) {
      return { width: node.width, height: Math.max(node.height, node.handleSize) };
    }

    if (node instanceof Bar2D) {
      return { width: node.width, height: node.height };
    }

    if (node instanceof InventorySlot2D) {
      return { width: node.width, height: node.height };
    }

    if (node instanceof Checkbox2D) {
      return { width: node.size, height: node.size };
    }

    return { width: 100, height: 40 };
  }

  getUIControlDefaultColor(node: UIControl2D): number {
    if (node instanceof Button2D) {
      return new THREE.Color(node.backgroundColor).getHex();
    }
    if (node instanceof Slider2D) {
      return new THREE.Color(node.trackBackgroundColor).getHex();
    }
    if (node instanceof Bar2D) {
      return new THREE.Color(node.backBackgroundColor).getHex();
    }
    if (node instanceof InventorySlot2D) {
      return new THREE.Color(node.backdropColor).getHex();
    }
    if (node instanceof Checkbox2D) {
      return new THREE.Color(node.checked ? node.checkedColor : node.uncheckedColor).getHex();
    }
    return 0x96cbf6;
  }

  /**
   * The skin texture URL the editor proxy should display. Button2D exposes
   * per-state sprites; the proxy shows the effective-normal one (its explicit
   * normal sprite, else the legacy single skin). Other controls use texturePath.
   */
  getUIControlSkinTextureUrl(node: UIControl2D): string | null {
    if (node instanceof Button2D) {
      // Effective-normal: localized state key (preview locale), else the explicit
      // normal sprite, else the legacy single skin.
      return node.getEffectiveStateTexturePath('normal') ?? node.texturePath ?? null;
    }
    return node.texturePath ?? null;
  }

  applyTextureTo2DMaterial(node: UIControl2D, material: THREE.MeshBasicMaterial): void {
    const texturePath = this.getUIControlSkinTextureUrl(node);
    if (!texturePath) {
      return;
    }

    const textureLoader = new THREE.TextureLoader();

    (async () => {
      try {
        const blob = await this.deps.readBlob(texturePath);
        const blobUrl = URL.createObjectURL(blob);

        textureLoader.load(
          blobUrl,
          texture => {
            try {
              configureSpriteTexture(texture);
              material.map = texture;
              material.color.set(0xffffff);
              material.transparent = true;
              material.needsUpdate = true;
            } finally {
              URL.revokeObjectURL(blobUrl);
            }
          },
          undefined,
          () => {
            URL.revokeObjectURL(blobUrl);
          }
        );
      } catch {
        const schemeMatch = /^([a-z]+[a-z0-9+.-]*):\/\//i.exec(texturePath);
        const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : '';
        if (scheme === 'http' || scheme === 'https' || scheme === '') {
          try {
            const texture = textureLoader.load(texturePath);
            configureSpriteTexture(texture);
            material.map = texture;
            material.color.set(0xffffff);
            material.transparent = true;
            material.needsUpdate = true;
          } catch {
            // Keep flat color fallback
          }
        }
      }
    })();
  }

  /**
   * Mirror of the runtime Label2D box sizing: a fixed width wraps the text,
   * zero sizes auto-fit the laid-out lines. Keeps the editor proxy
   * pixel-consistent with what play mode renders.
   */
  private measureLabel2DBox(node: Label2D): { width: number; height: number; layout: LabelLayout } {
    const fontSize = Math.max(1, node.labelFontSize || 16);
    this.labelMeasureCtx ??= document.createElement('canvas').getContext('2d');
    const measureCtx = this.labelMeasureCtx;
    if (measureCtx) {
      measureCtx.font = `${fontSize}px ${node.labelFontFamily}`;
    }
    const layout = layoutLabelText(
      node.getDisplayText(),
      line => (measureCtx ? measureCtx.measureText(line).width : line.length * fontSize * 0.6),
      { fontSize, maxWidth: node.width > 0 ? node.width : 0 }
    );
    return {
      width: node.width > 0 ? node.width : Math.ceil(layout.textWidth) + LABEL_AUTO_SIZE_BLEED,
      height: node.height > 0 ? node.height : Math.ceil(layout.textHeight) + LABEL_AUTO_SIZE_BLEED,
      layout,
    };
  }

  private createLabel2DLabelMesh(node: Label2D): THREE.Mesh {
    const dprRaw = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const dpr = Math.max(1, Math.min(3, dprRaw));

    const { width, height, layout } = this.measureLabel2DBox(node);

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      const fallbackGeometry = new THREE.PlaneGeometry(0.1, 0.1);
      const fallbackMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
      fallbackMaterial.userData.baseOpacity = 0;
      return new THREE.Mesh(fallbackGeometry, fallbackMaterial);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintLabelCanvas(ctx, {
      layout,
      fontFamily: node.labelFontFamily,
      fontSize: Math.max(1, node.labelFontSize || 16),
      color: node.labelColor,
      align: node.labelAlign,
      vAlign: node.labelVAlign,
      width,
      height,
    });

    const texture = new THREE.CanvasTexture(canvas);
    configureSpriteTexture(texture);
    texture.needsUpdate = true;

    const geometry = new THREE.PlaneGeometry(width, height);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 1,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    material.userData.baseOpacity = 1;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.isUIControlLabel = true;
    mesh.renderOrder = 1002;
    mesh.position.z = 0.5;
    mesh.layers.set(LAYER_2D);
    return mesh;
  }

  private createUIControlLabelMesh(node: UIControl2D): THREE.Mesh {
    if (node instanceof Label2D) {
      return this.createLabel2DLabelMesh(node);
    }

    const dprRaw = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const dpr = Math.max(1, Math.min(3, dprRaw));

    const paddingX = 12;
    const paddingY = 8;
    const fontSize = Math.max(8, node.labelFontSize || 16);

    const measureCanvas = document.createElement('canvas');
    const measureCtx = measureCanvas.getContext('2d');
    if (!measureCtx) {
      const fallbackGeometry = new THREE.PlaneGeometry(0.1, 0.1);
      const fallbackMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
      fallbackMaterial.userData.baseOpacity = 0;
      return new THREE.Mesh(fallbackGeometry, fallbackMaterial);
    }
    measureCtx.font = `${fontSize}px ${node.labelFontFamily}`;
    const displayText = node.getDisplayText();
    const measured = measureCtx.measureText(displayText || ' ');
    const logicalWidth = Math.max(32, Math.ceil(measured.width + paddingX * 2));
    const logicalHeight = Math.max(20, Math.ceil(fontSize + paddingY * 2));

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(logicalWidth * dpr));
    canvas.height = Math.max(1, Math.round(logicalHeight * dpr));

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      const fallbackGeometry = new THREE.PlaneGeometry(0.1, 0.1);
      const fallbackMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
      fallbackMaterial.userData.baseOpacity = 0;
      return new THREE.Mesh(fallbackGeometry, fallbackMaterial);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, logicalWidth, logicalHeight);
    ctx.fillStyle = node.labelColor;
    ctx.font = `${fontSize}px ${node.labelFontFamily}`;
    ctx.textBaseline = 'middle';

    let x = logicalWidth / 2;
    if (node.labelAlign === 'left') {
      ctx.textAlign = 'left';
      x = paddingX;
    } else if (node.labelAlign === 'right') {
      ctx.textAlign = 'right';
      x = logicalWidth - paddingX;
    } else {
      ctx.textAlign = 'center';
    }

    ctx.fillText(displayText, x, logicalHeight / 2);

    const texture = new THREE.CanvasTexture(canvas);
    configureSpriteTexture(texture);
    texture.needsUpdate = true;

    const geometry = new THREE.PlaneGeometry(logicalWidth, logicalHeight);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 1,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    material.userData.baseOpacity = 1;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.isUIControlLabel = true;
    mesh.renderOrder = 1002;
    mesh.position.z = 0.5;
    // A checkbox reads as "[box] Label": lay the label out to the right of the
    // box rather than centered on it (matches the runtime Checkbox2D layout).
    if (node instanceof Checkbox2D) {
      mesh.position.x = node.size / 2 + logicalWidth / 2 + 6;
    }
    mesh.layers.set(LAYER_2D);
    return mesh;
  }

  updateUIControlLabelVisual(visualRoot: THREE.Group, node: UIControl2D): void {
    const existingLabel = visualRoot.children.find(child =>
      Boolean((child as THREE.Object3D).userData?.isUIControlLabel)
    );

    if (node.getDisplayText().trim().length === 0) {
      if (existingLabel) {
        visualRoot.remove(existingLabel);
        this.deps.disposeObject3D(existingLabel);
      }
      return;
    }

    if (existingLabel) {
      visualRoot.remove(existingLabel);
      this.deps.disposeObject3D(existingLabel);
    }

    const labelMesh = this.createUIControlLabelMesh(node);
    visualRoot.add(labelMesh);
  }

  private getEffective2DOpacity(node: Node2D): number {
    const effective = node.computedOpacity;
    if (!Number.isFinite(effective)) {
      return 1;
    }
    return Math.max(0, Math.min(1, effective));
  }

  apply2DVisualOpacity(node: Node2D, visualRoot: THREE.Object3D): void {
    const nodeOpacity = this.getEffective2DOpacity(node);

    visualRoot.traverse(obj => {
      const applyToMaterial = (material: THREE.Material): void => {
        if (
          !(material instanceof THREE.MeshBasicMaterial) &&
          !(material instanceof THREE.LineBasicMaterial)
        ) {
          return;
        }

        const baseOpacityRaw = material.userData.baseOpacity;
        const baseOpacity =
          typeof baseOpacityRaw === 'number' && Number.isFinite(baseOpacityRaw)
            ? Math.max(0, Math.min(1, baseOpacityRaw))
            : 1;

        if (material.userData.originalTransparent === undefined) {
          material.userData.originalTransparent = material.transparent;
        }

        material.opacity = baseOpacity * nodeOpacity;
        material.transparent =
          material.userData.originalTransparent || material.opacity < 1 || baseOpacity < 1;
        material.needsUpdate = true;
      };

      if (
        obj instanceof THREE.Mesh ||
        obj instanceof THREE.Line ||
        obj instanceof THREE.LineSegments
      ) {
        if (obj.material instanceof THREE.Material) {
          applyToMaterial(obj.material);
        } else if (Array.isArray(obj.material)) {
          for (const material of obj.material) {
            applyToMaterial(material);
          }
        }
      }
    });
  }
}
