import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { NodeBase, Node2D, type SceneGraph } from '@pix3/runtime';
import {
  encodeCanvasScreenshot,
  type CanvasScreenshot,
  type CanvasScreenshotOptions,
} from '@/core/canvas-screenshot';
import type { FrameNodesOptions } from '../ViewportRenderService';

/** Saved editor camera state for transient framed captures (see captureFramedScreenshot). */
interface EditorCameraSnapshot {
  mainPos: THREE.Vector3;
  mainQuat: THREE.Quaternion;
  mainZoom: number;
  orbitTarget?: THREE.Vector3;
  orthoPos?: THREE.Vector3;
  orthoZoom?: number;
  orthoTarget?: THREE.Vector3;
}

/**
 * The slice of `ViewportRendererService` internals the screenshotter needs.
 * Passed as closures because the renderer/canvas/scene/camera are created lazily
 * and can be re-created on viewport re-init, and the called methods
 * (`renderFrame`, `frameNodes`, `isVisibleInHierarchy`, `get2DVisualRoot`,
 * `resolveSelectedFrameNodes`) are broadly used elsewhere on the facade and stay
 * there. `setSuppressGizmosForCapture` toggles a field the render loop reads.
 */
export interface ViewportScreenshotterDeps {
  getRenderer(): THREE.WebGLRenderer | undefined;
  getCanvas(): HTMLCanvasElement | undefined;
  getScene(): THREE.Scene | undefined;
  getCamera(): THREE.PerspectiveCamera | THREE.OrthographicCamera | undefined;
  getOrbitControls(): OrbitControls | undefined;
  getOrthographicCamera(): THREE.OrthographicCamera | undefined;
  getOrthographicControls(): OrbitControls | undefined;
  renderFrame(): void;
  getActiveSceneGraph(): SceneGraph | null;
  resolveSelectedFrameNodes(): NodeBase[];
  isVisibleInHierarchy(object: THREE.Object3D): boolean;
  frameNodes(nodes: readonly NodeBase[], opts: FrameNodesOptions): boolean;
  get2DVisualRoot(nodeId: string): THREE.Group | undefined;
  setSuppressGizmosForCapture(value: boolean): void;
}

/**
 * Owns the viewport's screenshot / framed-capture concern, extracted from
 * `ViewportRendererService`. Renders one frame synchronously and encodes the
 * canvas into an image, optionally transiently aiming the camera at scene
 * content and isolating a node before restoring the user's view.
 */
export class ViewportScreenshotter {
  constructor(private readonly deps: ViewportScreenshotterDeps) {}

  /**
   * Render one frame synchronously and copy the viewport canvas into an encoded image. The copy
   * must happen in the same task as the render — the WebGL drawing buffer is not preserved across
   * compositing (`preserveDrawingBuffer` is off), so reading the canvas later yields blank pixels.
   * Returns null when the viewport is not initialized (no project / canvas yet).
   */
  captureScreenshot(options: CanvasScreenshotOptions = {}): CanvasScreenshot | null {
    const canvas = this.deps.getCanvas();
    if (!this.deps.getRenderer() || !canvas || !this.deps.getScene() || !this.deps.getCamera()) {
      return null;
    }

    this.deps.renderFrame();
    return encodeCanvasScreenshot(canvas, options);
  }

  /**
   * Capture the editor viewport with the camera transiently aimed at scene
   * content, a selection, or a single node — then RESTORE the user's camera so a
   * watching human's view is never disturbed. Framing, gizmo suppression and
   * optional occluder isolation all happen inside one synchronous task (before the
   * browser composites) so there is no visible flicker, even in a background tab.
   *
   * Returns a `{ error }` object for actionable failures (node not found /
   * hidden / no frameable bounds), a `CanvasScreenshot` on success, or null when
   * the viewport is not initialized.
   */
  captureFramedScreenshot(opts: {
    maxSize?: number;
    frame: 'all' | 'selection' | 'node';
    nodeId?: string;
    isolate?: boolean;
    paddingMultiplier?: number;
  }): CanvasScreenshot | { error: string } | null {
    const canvas = this.deps.getCanvas();
    if (!this.deps.getRenderer() || !canvas || !this.deps.getScene() || !this.deps.getCamera()) {
      return null;
    }
    const sceneGraph = this.deps.getActiveSceneGraph();
    if (!sceneGraph) {
      return { error: 'No active scene — open a scene first.' };
    }

    // Resolve the nodes to frame.
    let targetNodes: NodeBase[];
    if (opts.frame === 'all') {
      targetNodes = sceneGraph.rootNodes.filter((n): n is NodeBase => n instanceof NodeBase);
      if (targetNodes.length === 0) {
        return { error: 'The scene is empty — nothing to frame.' };
      }
    } else if (opts.frame === 'selection') {
      targetNodes = this.deps.resolveSelectedFrameNodes();
      if (targetNodes.length === 0) {
        return { error: 'Nothing is selected — select a node or pass a nodeId.' };
      }
    } else {
      const nodeId = opts.nodeId ?? '';
      const node = sceneGraph.nodeMap.get(nodeId);
      if (!(node instanceof NodeBase)) {
        return { error: `No node with id "${nodeId}" (use find_nodes / scene_tree to get ids).` };
      }
      targetNodes = [node];
    }

    // A framed shot of a fully hidden node is blank pixels — say so instead.
    if (opts.frame !== 'all' && !targetNodes.some(n => this.deps.isVisibleInHierarchy(n))) {
      return {
        error: 'The target node is hidden (visible:false) — nothing would be captured.',
      };
    }

    const snapshot = this.snapshotEditorCameras();
    this.deps.setSuppressGizmosForCapture(true);
    try {
      const framed = this.deps.frameNodes(targetNodes, {
        persist: false,
        paddingMultiplier: opts.paddingMultiplier,
      });
      if (!framed) {
        return { error: 'Could not compute bounds for the target(s).' };
      }

      const renderAndEncode = (): CanvasScreenshot | { error: string } => {
        this.deps.renderFrame();
        const shot = encodeCanvasScreenshot(canvas, { maxSize: opts.maxSize });
        return shot ?? { error: 'Failed to encode the viewport image.' };
      };

      if (opts.isolate && opts.frame !== 'all') {
        return this.withNodeIsolation(targetNodes, renderAndEncode);
      }
      return renderAndEncode();
    } finally {
      this.deps.setSuppressGizmosForCapture(false);
      this.restoreEditorCameras(snapshot);
      // Repaint the restored view now so the framed frame never lingers on screen.
      this.deps.renderFrame();
    }
  }

  private snapshotEditorCameras(): EditorCameraSnapshot {
    const camera = this.deps.getCamera()!;
    return {
      mainPos: camera.position.clone(),
      mainQuat: camera.quaternion.clone(),
      mainZoom: camera.zoom,
      orbitTarget: this.deps.getOrbitControls()?.target.clone(),
      orthoPos: this.deps.getOrthographicCamera()?.position.clone(),
      orthoZoom: this.deps.getOrthographicCamera()?.zoom,
      orthoTarget: this.deps.getOrthographicControls()?.target.clone(),
    };
  }

  private restoreEditorCameras(s: EditorCameraSnapshot): void {
    const camera = this.deps.getCamera();
    if (camera) {
      camera.position.copy(s.mainPos);
      camera.quaternion.copy(s.mainQuat);
      camera.zoom = s.mainZoom;
      camera.updateProjectionMatrix();
    }
    const orbitControls = this.deps.getOrbitControls();
    if (orbitControls && s.orbitTarget) {
      orbitControls.target.copy(s.orbitTarget);
      orbitControls.update();
    }
    const orthographicCamera = this.deps.getOrthographicCamera();
    if (orthographicCamera && s.orthoPos && s.orthoZoom !== undefined) {
      orthographicCamera.position.copy(s.orthoPos);
      orthographicCamera.zoom = s.orthoZoom;
      orthographicCamera.updateProjectionMatrix();
    }
    const orthographicControls = this.deps.getOrthographicControls();
    if (orthographicControls && s.orthoTarget) {
      orthographicControls.target.copy(s.orthoTarget);
    }
  }

  /**
   * Run `fn` with every node OUTSIDE the keep-set (the targets, their descendants
   * and their ancestors) hidden, then restore original visibility. Used to capture
   * a node unobstructed by foreground content. 3D nodes are hidden by their own
   * `visible` flag (hides the subtree); 2D nodes by hiding their proxy visual root
   * (the editor draws proxies, not the runtime nodes). Ancestors stay visible so
   * inherited transforms and nested 2D visual roots survive.
   */
  private withNodeIsolation<T>(keepNodes: readonly NodeBase[], fn: () => T): T {
    const sceneGraph = this.deps.getActiveSceneGraph();
    if (!sceneGraph) return fn();

    const keep = new Set<NodeBase>();
    const addSubtree = (node: NodeBase): void => {
      keep.add(node);
      for (const child of node.children) {
        if (child instanceof NodeBase) addSubtree(child);
      }
    };
    const ancestors = new Set<NodeBase>();
    for (const node of keepNodes) {
      addSubtree(node);
      let parent = node.parent;
      while (parent instanceof NodeBase) {
        ancestors.add(parent);
        parent = parent.parent;
      }
    }

    const saved = new Map<THREE.Object3D, boolean>();
    const hide = (obj: THREE.Object3D): void => {
      if (!saved.has(obj)) saved.set(obj, obj.visible);
      obj.visible = false;
    };

    for (const node of sceneGraph.nodeMap.values()) {
      if (!(node instanceof NodeBase) || keep.has(node) || ancestors.has(node)) {
        continue;
      }
      // 3D subtree hides via inherited visibility on the node object itself.
      hide(node);
      // 2D nodes render as separate proxy visuals — hide the proxy root too.
      if (node instanceof Node2D) {
        const visualRoot = this.deps.get2DVisualRoot(node.nodeId);
        if (visualRoot) hide(visualRoot);
      }
    }

    try {
      return fn();
    } finally {
      for (const [obj, visible] of saved) {
        obj.visible = visible;
      }
    }
  }
}
