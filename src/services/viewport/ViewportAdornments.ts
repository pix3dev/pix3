import * as THREE from 'three';
import type { SceneGraph } from '@pix3/runtime';
import { NodeBase } from '@pix3/runtime';
import { Node3D } from '@pix3/runtime';
import { Camera3D } from '@pix3/runtime';
import { VirtualCamera3D } from '@pix3/runtime';
import { DirectionalLightNode } from '@pix3/runtime';
import { PointLightNode } from '@pix3/runtime';
import { SpotLightNode } from '@pix3/runtime';
import { Particles3D } from '@pix3/runtime';
import { appState } from '@/state';
import { configureSpriteTexture } from './Viewport2DProxyRegistry';

const LAYER_GIZMOS = 2;
const TARGET_DIRECTION_RAY_LENGTH = 500;
const DEFAULT_NODE_ICON_OPACITY = 0.95;
const SELECTED_NODE_ICON_OPACITY = 0.38;

/**
 * Dependencies the adornment subsystem borrows from {@link ViewportRendererService}.
 * Scoped to exactly what this collaborator needs; the facade owns the scene
 * graph, the editor scene, the layer-visibility policy, and the drag/transform
 * session state, and passes them in via closures so this object never reaches
 * back into the facade directly.
 */
export interface ViewportAdornmentsDeps {
  getActiveSceneGraph(): SceneGraph | null;
  getScene(): THREE.Scene | undefined;
  isLayer3DVisible(): boolean;
  shouldKeepSelectedNodeIcon(node: Node3D): boolean;
  getActiveTargetNodeId(): string | null;
  getActiveTargetDragNodeId(): string | null;
  getTransformControlObject(): THREE.Object3D | undefined;
}

/**
 * Owns the editor-viewport gizmo/icon subsystem for the 3D node types:
 * selection boxes, custom per-type selection gizmos (camera/light helpers),
 * camera/light "target" gizmos showing look-direction, and camera/light/particle
 * billboard icons. Extracted from ViewportRendererService (decomposition step
 * 9/13). Not `@injectable()` — it is an owned collaborator constructed by the
 * facade with borrowed dependencies.
 *
 * The four visual maps are public mutable fields because the facade's selection
 * dispatchers (updateSelection / attachTransformControlsForSelection / the
 * transform-controls objectChange listeners / dispose paths) read and write
 * them directly at many call sites; wrapping them behind a method API would buy
 * no behavioral benefit and much more diff risk.
 */
export class ViewportAdornments {
  readonly selectionBoxes = new Map<string, THREE.Box3Helper>();
  readonly selectionGizmos = new Map<string, THREE.Object3D>();
  readonly targetGizmos = new Map<string, THREE.Object3D>();
  readonly nodeIcons = new Map<string, THREE.Sprite>();
  private cameraIconTexture?: THREE.Texture;
  private lampIconTexture?: THREE.Texture;
  private particlesIconTexture?: THREE.Texture;

  constructor(private readonly deps: ViewportAdornmentsDeps) {}

  private ensureNodeIconTextures(): void {
    if (!this.cameraIconTexture) {
      new THREE.TextureLoader().load('/cam.png', texture => {
        configureSpriteTexture(texture);
        this.cameraIconTexture = texture;
        this.refreshNodeIconMaterials('camera');
      });
    }
    if (!this.lampIconTexture) {
      new THREE.TextureLoader().load('/lamp.png', texture => {
        configureSpriteTexture(texture);
        this.lampIconTexture = texture;
        this.refreshNodeIconMaterials('light');
      });
    }
    if (!this.particlesIconTexture) {
      new THREE.TextureLoader().load('/particles.png', texture => {
        configureSpriteTexture(texture);
        this.particlesIconTexture = texture;
        this.refreshNodeIconMaterials('particles');
      });
    }
  }

  private refreshNodeIconMaterials(kind: 'camera' | 'light' | 'particles'): void {
    for (const icon of this.nodeIcons.values()) {
      const iconKind =
        (icon.userData.iconKind as 'camera' | 'light' | 'particles' | undefined) ?? undefined;
      if (iconKind !== kind) {
        continue;
      }

      if (icon.material instanceof THREE.SpriteMaterial) {
        if (kind === 'camera') {
          icon.material.map = this.cameraIconTexture ?? null;
        } else if (kind === 'light') {
          icon.material.map = this.lampIconTexture ?? null;
        } else {
          icon.material.map = this.particlesIconTexture ?? null;
        }
        icon.material.opacity = DEFAULT_NODE_ICON_OPACITY;
        icon.material.needsUpdate = true;
      }
    }
  }

  clearNodeIcons(): void {
    for (const icon of this.nodeIcons.values()) {
      if (icon.parent) {
        icon.parent.remove(icon);
      }
      if (icon.material instanceof THREE.SpriteMaterial) {
        icon.material.dispose();
      }
    }
    this.nodeIcons.clear();
  }

  buildNodeIcons(nodes: NodeBase[]): void {
    const scene = this.deps.getScene();
    if (!scene) {
      return;
    }

    this.ensureNodeIconTextures();

    const addIconForNode = (node: NodeBase) => {
      if (!(node instanceof Node3D)) {
        return;
      }

      const isCamera = node instanceof Camera3D || node instanceof VirtualCamera3D;
      const isLight =
        node instanceof DirectionalLightNode ||
        node instanceof PointLightNode ||
        node instanceof SpotLightNode;
      const isParticles = node instanceof Particles3D;

      if (!isCamera && !isLight && !isParticles) {
        return;
      }

      const material = new THREE.SpriteMaterial({
        map: isCamera
          ? (this.cameraIconTexture ?? null)
          : isLight
            ? (this.lampIconTexture ?? null)
            : (this.particlesIconTexture ?? null),
        color: 0xffffff,
        transparent: true,
        opacity: DEFAULT_NODE_ICON_OPACITY,
        depthTest: false,
        depthWrite: false,
        sizeAttenuation: false,
      });

      const icon = new THREE.Sprite(material);
      icon.scale.set(0.15, 0.15, 0.15);
      icon.layers.set(LAYER_GIZMOS);
      icon.renderOrder = 999;
      icon.userData.nodeId = node.nodeId;
      icon.userData.iconKind = isCamera ? 'camera' : isLight ? 'light' : 'particles';
      this.nodeIcons.set(node.nodeId, icon);
      scene.add(icon);
    };

    const traverse = (roots: NodeBase[]) => {
      for (const node of roots) {
        addIconForNode(node);
        if (node.children.length > 0) {
          const childNodes = node.children.filter(
            (child): child is NodeBase => child instanceof NodeBase
          );
          traverse(childNodes);
        }
      }
    };

    traverse(nodes);
    this.updateNodeIconPositions();
    this.updateNodeIconVisibility();
  }

  updateNodeIconPositions(): void {
    const sceneGraph = this.deps.getActiveSceneGraph();
    if (!sceneGraph) {
      return;
    }

    const worldPos = new THREE.Vector3();
    for (const [nodeId, icon] of this.nodeIcons.entries()) {
      const node = sceneGraph.nodeMap.get(nodeId);
      if (!(node instanceof Node3D)) {
        icon.visible = false;
        continue;
      }
      node.updateMatrixWorld(true);
      node.getWorldPosition(worldPos);
      icon.position.copy(worldPos);
    }
  }

  updateNodeIconVisibility(): void {
    const sceneGraph = this.deps.getActiveSceneGraph();
    if (!sceneGraph) {
      return;
    }

    const selectedNodeIds = new Set(appState.selection.nodeIds);
    for (const [nodeId, icon] of this.nodeIcons.entries()) {
      const node = sceneGraph.nodeMap.get(nodeId);
      const isSelected = selectedNodeIds.has(nodeId);
      const keepVisibleWhenSelected =
        node instanceof Node3D && this.deps.shouldKeepSelectedNodeIcon(node);
      const shouldShow =
        this.deps.isLayer3DVisible() &&
        node instanceof Node3D &&
        node.visible &&
        (!isSelected || keepVisibleWhenSelected);

      icon.visible = shouldShow;

      if (icon.material instanceof THREE.SpriteMaterial) {
        icon.material.opacity =
          isSelected && keepVisibleWhenSelected
            ? SELECTED_NODE_ICON_OPACITY
            : DEFAULT_NODE_ICON_OPACITY;
        icon.material.needsUpdate = true;
      }
    }
  }

  createNodeGizmo(node: Node3D): THREE.Object3D | null {
    if (node instanceof Camera3D) {
      return this.createCameraGizmo(node);
    } else if (node instanceof DirectionalLightNode) {
      return this.createDirectionalLightGizmo(node);
    } else if (node instanceof PointLightNode) {
      return this.createPointLightGizmo(node);
    } else if (node instanceof SpotLightNode) {
      return this.createSpotLightGizmo(node);
    }
    return null;
  }

  private createCameraGizmo(node: Camera3D): THREE.Object3D {
    const helper = new THREE.CameraHelper(node.camera);
    helper.update();
    return helper;
  }

  private createDirectionalLightGizmo(node: DirectionalLightNode): THREE.Object3D {
    const helper = new THREE.DirectionalLightHelper(node.light, 1);
    helper.update();
    return helper;
  }

  private createPointLightGizmo(node: PointLightNode): THREE.Object3D {
    const helper = new THREE.PointLightHelper(node.light, 0.5);
    node.updateMatrixWorld(true);
    node.getWorldPosition(helper.position);
    helper.update();
    return helper;
  }

  private createSpotLightGizmo(node: SpotLightNode): THREE.Object3D {
    const helper = new THREE.SpotLightHelper(node.light);
    helper.update();
    return helper;
  }

  createTargetGizmo(node: Node3D): THREE.Object3D | null {
    if (node instanceof Camera3D) {
      return this.createCameraTargetGizmo(node);
    } else if (node instanceof DirectionalLightNode || node instanceof SpotLightNode) {
      return this.createLightTargetGizmo(node);
    }
    return null;
  }

  private createCameraTargetGizmo(node: Camera3D): THREE.Object3D {
    const targetPos = node.getTargetPosition();
    const nodeWorldPos = node.getWorldPosition(new THREE.Vector3());
    const rawDirection = targetPos.clone().sub(nodeWorldPos);
    const direction =
      rawDirection.lengthSq() > 1e-8
        ? rawDirection.normalize()
        : new THREE.Vector3(0, 0, -1).applyQuaternion(
            node.getWorldQuaternion(new THREE.Quaternion())
          );
    const farPos = nodeWorldPos.clone().add(direction.multiplyScalar(TARGET_DIRECTION_RAY_LENGTH));
    const gizmo = new THREE.Group();
    gizmo.userData.isTargetGizmo = true;
    gizmo.userData.parentNodeId = node.nodeId;

    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.2, 16, 16),
      new THREE.MeshBasicMaterial({
        color: 0xffff00,
        transparent: true,
        opacity: 0.8,
      })
    );
    sphere.position.copy(targetPos);
    sphere.userData.isTargetSphere = true;
    sphere.userData.parentNodeId = node.nodeId;
    gizmo.add(sphere);

    const outline = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 16, 16),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        wireframe: true,
        visible: false,
      })
    );
    outline.position.copy(targetPos);
    outline.userData.isTargetOutline = true;
    gizmo.add(outline);

    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([nodeWorldPos, farPos]),
      new THREE.LineBasicMaterial({
        color: 0xffff00,
        transparent: true,
        opacity: 0.5,
      })
    );
    line.userData.isTargetLine = true;
    line.userData.parentNodeId = node.nodeId;
    line.userData.rayLength = TARGET_DIRECTION_RAY_LENGTH;
    gizmo.add(line);

    this.updateTargetGizmoSelectionState(gizmo, node.nodeId);
    return gizmo;
  }

  private createLightTargetGizmo(node: DirectionalLightNode | SpotLightNode): THREE.Object3D {
    const targetPos = node.getTargetPosition();
    const nodeWorldPos = node.getWorldPosition(new THREE.Vector3());
    const rawDirection = targetPos.clone().sub(nodeWorldPos);
    const direction =
      rawDirection.lengthSq() > 1e-8
        ? rawDirection.normalize()
        : new THREE.Vector3(0, 0, -1).applyQuaternion(
            node.getWorldQuaternion(new THREE.Quaternion())
          );
    const farPos = nodeWorldPos.clone().add(direction.multiplyScalar(TARGET_DIRECTION_RAY_LENGTH));
    const gizmo = new THREE.Group();
    gizmo.userData.isTargetGizmo = true;
    gizmo.userData.parentNodeId = node.nodeId;

    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.2, 16, 16),
      new THREE.MeshBasicMaterial({
        color: 0xffff00,
        transparent: true,
        opacity: 0.8,
      })
    );
    sphere.position.copy(targetPos);
    sphere.userData.isTargetSphere = true;
    sphere.userData.parentNodeId = node.nodeId;
    gizmo.add(sphere);

    const outline = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 16, 16),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        wireframe: true,
        visible: false,
      })
    );
    outline.position.copy(targetPos);
    outline.userData.isTargetOutline = true;
    gizmo.add(outline);

    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([nodeWorldPos, farPos]),
      new THREE.LineBasicMaterial({
        color: 0xffff00,
        transparent: true,
        opacity: 0.5,
      })
    );
    line.userData.isTargetLine = true;
    line.userData.parentNodeId = node.nodeId;
    line.userData.rayLength = TARGET_DIRECTION_RAY_LENGTH;
    gizmo.add(line);

    this.updateTargetGizmoSelectionState(gizmo, node.nodeId);
    return gizmo;
  }

  private updateTargetGizmo(node: Node3D, gizmo: THREE.Object3D): void {
    let cameraNode: Camera3D | DirectionalLightNode | SpotLightNode | null = null;
    if (node instanceof Camera3D) {
      cameraNode = node;
    } else if (node instanceof DirectionalLightNode || node instanceof SpotLightNode) {
      cameraNode = node;
    }
    if (!cameraNode) return;

    let targetPos = cameraNode.getTargetPosition();
    const controlObject = this.deps.getTransformControlObject();
    if (
      this.deps.getActiveTargetDragNodeId() === node.nodeId &&
      controlObject &&
      this.getTargetNodeForObject(controlObject)?.nodeId === node.nodeId
    ) {
      targetPos = controlObject.getWorldPosition(new THREE.Vector3());
    }
    const nodeWorldPos = node.getWorldPosition(new THREE.Vector3());
    const rawDirection = targetPos.clone().sub(nodeWorldPos);
    const fallbackAxisZ = -1;
    const direction =
      rawDirection.lengthSq() > 1e-8
        ? rawDirection.normalize()
        : new THREE.Vector3(0, 0, fallbackAxisZ).applyQuaternion(
            node.getWorldQuaternion(new THREE.Quaternion())
          );

    gizmo.traverse(child => {
      if (child.userData.isTargetSphere || child.userData.isTargetOutline) {
        child.position.copy(targetPos);
      } else if (child.userData.isTargetLine) {
        const rayLength = child.userData.rayLength as number | undefined;
        const lineEndPos =
          typeof rayLength === 'number'
            ? nodeWorldPos.clone().add(direction.clone().multiplyScalar(rayLength))
            : targetPos;
        const positions = new Float32Array([
          nodeWorldPos.x,
          nodeWorldPos.y,
          nodeWorldPos.z,
          lineEndPos.x,
          lineEndPos.y,
          lineEndPos.z,
        ]);
        const geo = (child as THREE.Mesh).geometry as THREE.BufferGeometry;
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      }
    });

    this.updateTargetGizmoSelectionState(gizmo, node.nodeId);
  }

  getTargetSphere(nodeId: string): THREE.Object3D | null {
    const gizmo = this.targetGizmos.get(nodeId);
    if (!gizmo) {
      return null;
    }

    let sphere: THREE.Object3D | null = null;
    gizmo.traverse(child => {
      if (!sphere && child.userData.isTargetSphere) {
        sphere = child;
      }
    });
    return sphere;
  }

  getTargetNodeForObject(
    object: THREE.Object3D
  ): Camera3D | DirectionalLightNode | SpotLightNode | null {
    const parentNodeId = object.userData.parentNodeId;
    if (typeof parentNodeId !== 'string') {
      return null;
    }

    const sceneGraph = this.deps.getActiveSceneGraph();
    if (!sceneGraph) {
      return null;
    }

    const node = sceneGraph.nodeMap.get(parentNodeId);
    if (
      node instanceof Camera3D ||
      node instanceof DirectionalLightNode ||
      node instanceof SpotLightNode
    ) {
      return node;
    }
    return null;
  }

  private updateTargetGizmoSelectionState(gizmo: THREE.Object3D, nodeId: string): void {
    const isActive = this.deps.getActiveTargetNodeId() === nodeId;
    gizmo.traverse(child => {
      if (child.userData.isTargetOutline) {
        child.visible = isActive;
      }
    });
  }

  updateSelectionBoxes(): void {
    const sceneGraph = this.deps.getActiveSceneGraph();
    if (!sceneGraph) return;

    // Update all selection boxes to follow their objects during transform
    for (const [nodeId, box] of this.selectionBoxes.entries()) {
      const node = sceneGraph.nodeMap.get(nodeId);
      if (node && node instanceof Node3D) {
        const newBox = new THREE.Box3().setFromObject(node);
        box.box.copy(newBox);
      }
    }

    // Update all target gizmos to follow their objects during transform
    for (const [nodeId, gizmo] of this.targetGizmos.entries()) {
      const node = sceneGraph.nodeMap.get(nodeId);
      if (node && node instanceof Node3D) {
        this.updateTargetGizmo(node, gizmo);
      }
    }
  }

  /**
   * Dispose the shared node-icon textures on scene teardown. Mirrors the
   * facade's historical dispose exactly: the camera and lamp textures are
   * released and cleared; the particles texture is intentionally left untouched
   * (pre-existing behavior).
   */
  disposeIconTextures(): void {
    this.cameraIconTexture?.dispose();
    this.lampIconTexture?.dispose();
    this.cameraIconTexture = undefined;
    this.lampIconTexture = undefined;
  }
}
