/**
 * ViewportRendererService - Renders the Three.js 3D scene viewport
 *
 * IMPORTANT: This service is READ-ONLY for state. It visualizes the current scene structure
 * but never modifies appState. All mutations must go through Operations and OperationService.
 * This separation ensures clean UI state management and proper undo/redo support.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { MathUtils } from 'three';
import type { AnimationResource } from '@pix3/runtime';
import { AnimatedSprite2D } from '@pix3/runtime';
import { NodeBase } from '@pix3/runtime';
import { Node2D } from '@pix3/runtime';
import { Node3D } from '@pix3/runtime';
import { Group2D } from '@pix3/runtime';
import { findAnimationClip } from '@pix3/runtime';
import { Sprite2D } from '@pix3/runtime';
import { UIControl2D } from '@pix3/runtime';
import { Button2D } from '@pix3/runtime';
import { Label2D } from '@pix3/runtime';
import { Slider2D } from '@pix3/runtime';
import { Bar2D } from '@pix3/runtime';
import { Checkbox2D } from '@pix3/runtime';
import { InventorySlot2D } from '@pix3/runtime';
import { DirectionalLightNode } from '@pix3/runtime';
import { PointLightNode } from '@pix3/runtime';
import { SpotLightNode } from '@pix3/runtime';
import { Camera3D } from '@pix3/runtime';
import { MeshInstance } from '@pix3/runtime';
import { Sprite3D } from '@pix3/runtime';
import { Particles3D } from '@pix3/runtime';
import { AmbientLightNode } from '@pix3/runtime';
import { HemisphereLightNode } from '@pix3/runtime';
import { AssetLoader } from '@pix3/runtime';
import type { EditorPreviewContext, ScriptComponent } from '@pix3/runtime';
import { injectable, inject } from '@/fw/di';
import { SceneManager, InputService } from '@pix3/runtime';
import { OperationService } from '@/services/OperationService';
import { ResourceManager } from '@/services/ResourceManager';
import { appState } from '@/state';
import { subscribe } from 'valtio/vanilla';
import {
  deriveAnimationDocumentId,
  parseAnimationResourceText,
} from '@/features/scene/animation-asset-utils';
import {
  TransformCompleteOperation,
  type TransformState,
} from '@/features/properties/TransformCompleteOperation';
import {
  Transform2DCompleteOperation,
  type Transform2DState,
} from '@/features/properties/Transform2DCompleteOperation';
import { TargetTransformOperation } from '@/features/properties/TargetTransformOperation';
import {
  TransformTool2d,
  type TwoDHandle,
  type Active2DTransform,
  type Transform2DUpdateOptions,
  type Selection2DOverlay,
} from '@/services/TransformTool2d';
import { isDocumentActive } from './page-activity';

export type TransformMode = 'select' | 'translate' | 'rotate' | 'scale';
const EDITOR_ORTHOGRAPHIC_FRUSTUM_HEIGHT = 12;

const LAYER_3D = 0;
const LAYER_2D = 1;
const LAYER_GIZMOS = 2;
const TARGET_DIRECTION_RAY_LENGTH = 500;
const DEFAULT_VIEWPORT_BASE_WIDTH = 1920;
const DEFAULT_VIEWPORT_BASE_HEIGHT = 1080;
const DEFAULT_3D_CAMERA_POSITION = new THREE.Vector3(5, 5, 5);
const DEFAULT_3D_CAMERA_TARGET = new THREE.Vector3(0, 0, 0);
const DEFAULT_2D_CAMERA_Z = 100;
const DEFAULT_NODE_ICON_OPACITY = 0.95;
const SELECTED_NODE_ICON_OPACITY = 0.38;
const MIN_WORLD_BOUNDS_SIZE = 0.0001;
const TWO_D_FIT_PADDING_MULTIPLIER = 1.15;

@injectable()
export class ViewportRendererService {
  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(InputService)
  private readonly inputService!: InputService;

  @inject(OperationService)
  private readonly operationService!: OperationService;

  @inject(ResourceManager)
  private readonly resourceManager!: ResourceManager;

  @inject(AssetLoader)
  private readonly assetLoader!: AssetLoader;

  private renderer?: THREE.WebGLRenderer;
  private canvas?: HTMLCanvasElement;
  private canvasHost?: HTMLElement;
  private scene?: THREE.Scene;
  private camera?: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private perspectiveCamera?: THREE.PerspectiveCamera;
  private editorOrthographicCamera?: THREE.OrthographicCamera;
  private orthographicCamera?: THREE.OrthographicCamera;
  private orbitControls?: OrbitControls;
  private orthographicControls?: OrbitControls;
  private transformControls?: TransformControls;
  private transformGizmo?: THREE.Object3D;
  private currentTransformMode: TransformMode = 'select';
  private selectedObjects = new Set<THREE.Object3D>();
  private selectionBoxes = new Map<string, THREE.Box3Helper>();
  private selectionGizmos = new Map<string, THREE.Object3D>();
  private targetGizmos = new Map<string, THREE.Object3D>();
  private previewCamera: THREE.Camera | null = null;
  private group2DVisuals = new Map<string, THREE.Group>();
  private animatedSprite2DVisuals = new Map<string, THREE.Group>();
  private sprite2DVisuals = new Map<string, THREE.Group>();
  private sprite3DTexturePaths = new Map<string, string | null>();
  private particles3DTexturePaths = new Map<string, string | null>();
  private uiControl2DVisuals = new Map<string, THREE.Group>();
  private baseViewportFrame?: THREE.Group;
  private selection2DOverlay?: Selection2DOverlay;
  private active2DTransform?: Active2DTransform;
  // Hover preview frame for 2D nodes (before selection)
  private hoverPreview2D?: { nodeId: string; frame: THREE.Group };
  private animationId?: number;
  private isPaused = true;
  private isWindowFocused = isDocumentActive(document);
  private disposers: Array<() => void> = [];
  private gridHelper?: THREE.GridHelper;
  private editorAmbientLight?: THREE.AmbientLight;
  private editorDirectionalLight?: THREE.DirectionalLight;
  private nodeIcons = new Map<string, THREE.Sprite>();
  private cameraIconTexture?: THREE.Texture;
  private lampIconTexture?: THREE.Texture;
  private particlesIconTexture?: THREE.Texture;
  private transformStartStates = new Map<
    string,
    { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }
  >();
  private targetTransformStartStates = new Map<string, THREE.Vector3>();
  private activeTargetNodeId: string | null = null;
  private activeTargetDragNodeId: string | null = null;
  private lastActiveSceneId: string | null = null;
  private lastNodeDataChangeSignal = appState.scenes.nodeDataChangeSignal;
  private viewportSize = { width: 0, height: 0 };
  private transformTool2d: TransformTool2d;

  // Animation preview
  private animationMixers = new Map<string, THREE.AnimationMixer>();
  private animationTimer = new THREE.Timer();
  private previewAnimationActions = new Map<string, THREE.AnimationAction>();

  // Gesture handling for 2D navigation
  private panVelocity = { x: 0, y: 0 };
  private momentumAnimationId?: number;

  constructor() {
    this.transformTool2d = new TransformTool2d();
  }

  private disposeObject3D(root: THREE.Object3D): void {
    root.traverse(obj => {
      if (
        obj instanceof THREE.Mesh ||
        obj instanceof THREE.LineSegments ||
        obj instanceof THREE.Line
      ) {
        obj.geometry?.dispose();
        const material = (obj as THREE.Mesh).material as
          | THREE.Material
          | THREE.Material[]
          | undefined;
        if (material instanceof THREE.Material) {
          material.dispose();
        } else if (Array.isArray(material)) {
          material.forEach(m => m.dispose());
        }
      }
    });
  }

  /**
   * Backwards-compatible initialization. Prefer calling attachToHost() which will
   * ensure a single shared renderer + canvas instance.
   */
  initialize(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ensureInitialized();
  }

  /**
   * Ensure the renderer is initialized exactly once.
   * If no canvas was provided, a new canvas will be created.
   */
  ensureInitialized(): void {
    if (this.renderer) {
      return;
    }

    const canvas = this.canvas ?? document.createElement('canvas');
    this.canvas = canvas;
    if (!canvas.classList.contains('viewport-canvas')) {
      canvas.classList.add('viewport-canvas');
    }

    // Create Three.js renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });

    // Attach InputService to the renderer canvas
    this.inputService.attach(this.renderer.domElement);

    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x13161b, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = this.shouldEnableRendererShadowMap();
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    // Create scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x13161b);

    // Create camera
    this.perspectiveCamera = new THREE.PerspectiveCamera(75, 1, 0.1, 10000);
    this.perspectiveCamera.position.copy(DEFAULT_3D_CAMERA_POSITION);
    this.perspectiveCamera.lookAt(DEFAULT_3D_CAMERA_TARGET);
    this.camera = this.perspectiveCamera;

    this.editorOrthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);
    this.editorOrthographicCamera.position.copy(DEFAULT_3D_CAMERA_POSITION);
    this.editorOrthographicCamera.lookAt(DEFAULT_3D_CAMERA_TARGET);

    // Set up camera layers: layer 0 for 3D nodes, layer 1 for 2D nodes, layer 2 for gizmos
    // Main perspective camera renders 3D layer and gizmos
    this.perspectiveCamera.layers.disableAll();
    this.perspectiveCamera.layers.enable(LAYER_3D);
    this.perspectiveCamera.layers.enable(LAYER_GIZMOS);
    this.editorOrthographicCamera.layers.disableAll();
    this.editorOrthographicCamera.layers.enable(LAYER_3D);
    this.editorOrthographicCamera.layers.enable(LAYER_GIZMOS);

    // Create orthographic camera for 2D layer overlay
    this.orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.orthographicCamera.position.z = DEFAULT_2D_CAMERA_Z;
    // Orthographic camera only renders 2D layer
    this.orthographicCamera.layers.disableAll();
    this.orthographicCamera.layers.enable(LAYER_2D);

    // Add lights
    this.editorAmbientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(this.editorAmbientLight);

    this.editorDirectionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    this.editorDirectionalLight.position.set(5, 10, 7);
    this.editorDirectionalLight.castShadow = true;
    this.scene.add(this.editorDirectionalLight);

    // Add grid helper for reference
    this.gridHelper = new THREE.GridHelper(20, 20, 0x444444, 0x222222);
    this.scene.add(this.gridHelper);

    // Initialize OrbitControls
    this.createEditorOrbitControls();

    // Initialize 2D controls for the orthographic camera
    if (this.orthographicCamera) {
      this.orthographicControls = new OrbitControls(
        this.orthographicCamera,
        this.renderer.domElement
      );
      this.orthographicControls.enableRotate = false;
      this.orthographicControls.enableZoom = true;
      this.orthographicControls.enablePan = true;
      this.orthographicControls.enableDamping = true;
      this.orthographicControls.dampingFactor = 0.2;
      this.orthographicControls.screenSpacePanning = true;
    }

    // Initialize TransformControls for object manipulation
    this.createTransformControls();

    // Render loop will start on first attach/resume

    const syncViewportSceneState = () => {
      const currentSceneId = appState.scenes.activeSceneId;
      const currentNodeDataChangeSignal = appState.scenes.nodeDataChangeSignal;

      if (this.shouldSyncSceneContent(currentSceneId)) {
        this.lastNodeDataChangeSignal = currentNodeDataChangeSignal;
        this.syncSceneContent();
        return;
      }

      if (this.shouldRefreshSceneNodeData(currentNodeDataChangeSignal)) {
        this.refreshSceneNodeData();
      }
    };

    const unsubscribeScenes = subscribe(appState.scenes, () => {
      syncViewportSceneState();
      this.updateSelection();
      this.requestRender();
    });
    this.disposers.push(unsubscribeScenes);

    // Subscribe to selection changes
    const unsubscribeSelection = subscribe(appState.selection, () => {
      this.updateSelection();
      this.requestRender();
    });
    this.disposers.push(unsubscribeSelection);

    // Subscribe to hierarchy changes to detect node structure mutations
    // This handles cases where operations affect node structure (e.g., adding/removing nodes)
    const unsubscribeHierarchies = subscribe(appState.scenes.hierarchies, () => {
      this.syncSceneContent();
    });
    this.disposers.push(unsubscribeHierarchies);

    // Subscribe to UI changes
    const unsubscribeUi = subscribe(appState.ui, () => {
      this.toggleGrid();
      this.syncNavigationMode();
      this.syncLighting();
      this.syncEditorCameraProjection();
      this.syncBaseViewportFrame();
      this.updateNodeIconVisibility();
      this.handleFocusPause();
    });
    this.disposers.push(unsubscribeUi);

    const unsubscribeAnimations = subscribe(appState.animations, () => {
      this.syncAnimatedSprite2DVisuals();
      this.requestRender();
    });
    this.disposers.push(unsubscribeAnimations);

    const unsubscribeProject = subscribe(appState.project, () => {
      this.syncBaseViewportFrame();
      if (this.viewportSize.width > 0 && this.viewportSize.height > 0) {
        this.resize(this.viewportSize.width, this.viewportSize.height);
      }
    });
    this.disposers.push(unsubscribeProject);

    // Window focus handling
    const onFocus = () => {
      this.isWindowFocused = true;
      this.handleFocusPause();
    };
    const onBlur = () => {
      this.isWindowFocused = false;
      this.handleFocusPause();
    };
    const onVisibilityChange = () => {
      this.isWindowFocused = isDocumentActive(document);
      this.handleFocusPause();
    };
    const onPageShow = () => {
      this.isWindowFocused = isDocumentActive(document);
      this.handleFocusPause();
    };
    const onPageHide = () => {
      this.isWindowFocused = isDocumentActive(document);
      this.handleFocusPause();
    };

    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    this.disposers.push(() => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    });

    this.syncNavigationMode();
    this.syncLighting();
    this.syncEditorCameraProjection();
    this.syncBaseViewportFrame();

    // Initial sync
    syncViewportSceneState();
  }

  private shouldSyncSceneContent(currentSceneId: string | null): boolean {
    if (currentSceneId === this.lastActiveSceneId) {
      return false;
    }

    this.lastActiveSceneId = currentSceneId;
    return true;
  }

  private shouldRefreshSceneNodeData(currentNodeDataChangeSignal: number): boolean {
    if (currentNodeDataChangeSignal === this.lastNodeDataChangeSignal) {
      return false;
    }

    this.lastNodeDataChangeSignal = currentNodeDataChangeSignal;
    return true;
  }

  getCanvasElement(): HTMLCanvasElement | undefined {
    return this.canvas;
  }

  /**
   * Attach the shared canvas to a host element. The canvas will be physically
   * moved in the DOM to avoid multiple WebGL contexts.
   */
  attachToHost(host: HTMLElement): void {
    this.ensureInitialized();
    if (!this.canvas || !this.renderer) return;

    if (this.canvasHost !== host) {
      this.canvasHost = host;
      try {
        host.appendChild(this.canvas);
      } catch {
        // ignore
      }
    }

    // Ensure controls point at the active dom element.
    try {
      this.orbitControls?.connect(this.renderer.domElement);

      if (this.scene && this.transformControls) {
        try {
          this.scene.remove(this.transformControls as unknown as THREE.Object3D);
        } catch {
          // ignore
        }
      }

      this.transformControls?.dispose();
      if (this.camera) {
        this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
        const mode: 'translate' | 'rotate' | 'scale' =
          this.currentTransformMode === 'rotate'
            ? 'rotate'
            : this.currentTransformMode === 'scale'
              ? 'scale'
              : 'translate';
        this.transformControls.setMode(mode);
        this.transformControls.size = 0.6;

        // Ensure the internal raycaster can intersect with the gizmo, which we place on LAYER_GIZMOS
        this.transformControls.getRaycaster().layers.enable(LAYER_GIZMOS);

        this.transformControls.addEventListener('dragging-changed', (event: { value: unknown }) => {
          if (event.value) {
            this.setOrbitEnabled(false);
            if (this.transformControls?.object) {
              this.captureTransformStartState(this.transformControls.object);
            }
          } else {
            this.resetOrbitInternalState();
            this.setOrbitEnabled(true);
          }
        });
        this.transformControls.addEventListener('objectChange', () => {
          this.updateSelectionBoxes();
          this.updateTargetTransformFromControl();
        });
        this.transformControls.addEventListener('mouseUp', () => {
          this.handleTransformCompleted();
        });

        // TransformControls is a control object, not a Three.js object,
        // so we don't add it to the scene. It is attached to the DOM via attach() method.

        // Ensure the newly created TransformControls attaches to the currently selected object
        // and its new internal gizmo helper is added to the scene, replacing any stale visual helpers.
        this.updateSelection();
      }
    } catch {
      // ignore
    }

    this.resume();
  }

  pause(): void {
    this.isPaused = true;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = undefined;
    }
    this.cancelPanMomentum();
  }

  resume(): void {
    if (!this.renderer) {
      this.ensureInitialized();
    }
    if (!this.renderer) return;

    if (!this.isPaused) return;
    this.isPaused = false;
    this.animationTimer.update();
    this.startRenderLoop();
  }

  private handleFocusPause(): void {
    if (this.shouldPauseForWindowFocus()) {
      if (!this.isPaused && this.animationId) {
        cancelAnimationFrame(this.animationId);
        this.animationId = undefined;
      }
      this.cancelPanMomentum();
    } else {
      if (!this.isPaused && !this.animationId) {
        this.animationTimer.update();
        this.startRenderLoop();
      }
    }
  }

  captureCameraState(): {
    position: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
    zoom?: number;
  } | null {
    if (!this.camera || !this.orbitControls) return null;
    const position = this.camera.position;
    const target = this.orbitControls.target;
    return {
      position: { x: position.x, y: position.y, z: position.z },
      target: { x: target.x, y: target.y, z: target.z },
      zoom: this.camera.zoom,
    };
  }

  applyCameraState(state: {
    position: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
    zoom?: number;
  }): void {
    this.ensureInitialized();
    if (!this.camera || !this.orbitControls) return;

    this.camera.position.set(state.position.x, state.position.y, state.position.z);
    this.orbitControls.target.set(state.target.x, state.target.y, state.target.z);
    if (typeof state.zoom === 'number') {
      this.camera.zoom = state.zoom;
      this.camera.updateProjectionMatrix();
    }
    this.orbitControls.update();
  }

  private setOrbitEnabled(enabled: boolean): void {
    if (!this.orbitControls) return;
    if (enabled && appState.ui.navigationMode === '2d') {
      this.orbitControls.enabled = false;
      return;
    }
    this.orbitControls.enabled = enabled;
  }

  /**
   * Force-reset OrbitControls' internal state machine.
   *
   * Both OrbitControls and TransformControls listen for pointerdown on the
   * same canvas element.  OrbitControls processes the event first (it's
   * enabled at that point), enters ROTATE/PAN/DOLLY state and tracks the
   * pointer.  TransformControls then captures the pointer for gizmo dragging
   * and we disable orbit in the dragging-changed callback.  On pointerup,
   * OrbitControls' cleanup handler doesn't run properly (pointer capture
   * conflict), leaving its internal `state` stuck in a non-NONE value and a
   * phantom pointer in `_pointers`.  This blocks all subsequent interactions
   * (rotate, zoom, pan) even though `enabled` is true.
   *
   * Calling this method clears those stuck internals so OrbitControls can
   * accept new pointer interactions again.
   */
  private resetOrbitInternalState(): void {
    if (!this.orbitControls) return;
    const oc = this.orbitControls as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    oc.state = -1; // _STATE.NONE
    if (oc._pointers) oc._pointers.length = 0;
    if (oc._pointerPositions) {
      for (const key of Object.keys(oc._pointerPositions)) {
        delete oc._pointerPositions[key];
      }
    }
  }

  private syncNavigationMode(): void {
    const is2DMode = appState.ui.navigationMode === '2d';
    this.setOrbitEnabled(!is2DMode);
    if (this.orthographicControls) {
      // Disable orthographic controls entirely in 2D mode.
      // We handle pan/zoom gestures manually in ViewportPanel and call pan2D/zoom2D.
      // Keeping it enabled would cause it to intercept and swallow wheel/pointer events
      // via internal event.stopPropagation(), preventing the UI components from
      // receiving them for our custom gesture handling.
      this.orthographicControls.enabled = false;

      // Ensure damping is off if we were using it, though it shouldn't matter if disabled
      this.orthographicControls.enableZoom = false;
      this.orthographicControls.enablePan = false;
    }
  }

  private createEditorOrbitControls(): void {
    if (!this.camera || !this.renderer) {
      return;
    }

    this.orbitControls?.dispose();
    this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.3;
    this.orbitControls.autoRotate = false;
    this.orbitControls.enableZoom = true;
    this.orbitControls.enablePan = true;
  }

  private createTransformControls(): void {
    if (!this.camera || !this.renderer) {
      return;
    }

    const attachedObject = this.transformControls?.object ?? null;
    const existingMode = this.transformControls?.getMode() ?? this.currentTransformMode;

    if (this.transformControls && this.scene) {
      this.scene.remove(this.transformControls as unknown as THREE.Object3D);
      this.transformControls.detach();
      this.transformControls.dispose();
    }

    this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
    this.transformControls.setMode(existingMode === 'select' ? 'translate' : existingMode);
    this.transformControls.size = 0.6;
    this.transformControls.getRaycaster().layers.enable(LAYER_GIZMOS);

    this.transformControls.addEventListener('dragging-changed', (event: { value: unknown }) => {
      if (event.value) {
        this.setOrbitEnabled(false);
        if (this.transformControls?.object) {
          this.captureTransformStartState(this.transformControls.object);
        }
      } else {
        this.resetOrbitInternalState();
        this.setOrbitEnabled(true);
      }
    });

    this.transformControls.addEventListener('objectChange', () => {
      this.updateSelectionBoxes();
      this.updateTargetTransformFromControl();
    });

    this.transformControls.addEventListener('mouseUp', () => {
      this.handleTransformCompleted();
    });

    if (attachedObject) {
      this.transformControls.attach(attachedObject);
    }

    if (this.scene && this.currentTransformMode !== 'select' && this.transformControls.object) {
      this.scene.add(this.transformControls as unknown as THREE.Object3D);
    }
  }

  private syncEditorCameraProjection(): void {
    this.ensureInitialized();
    if (!this.renderer || !this.perspectiveCamera || !this.editorOrthographicCamera) {
      return;
    }

    const targetProjection = appState.ui.editorCameraProjection;
    const nextCamera =
      targetProjection === 'orthographic' ? this.editorOrthographicCamera : this.perspectiveCamera;

    if (this.camera === nextCamera) {
      return;
    }

    const previousCamera = this.camera ?? this.perspectiveCamera;
    const target = this.orbitControls?.target.clone() ?? DEFAULT_3D_CAMERA_TARGET.clone();
    const position = previousCamera.position.clone();
    const zoom = previousCamera.zoom;

    nextCamera.position.copy(position);
    nextCamera.zoom = zoom;
    nextCamera.lookAt(target);
    nextCamera.updateProjectionMatrix();
    this.camera = nextCamera;

    this.createEditorOrbitControls();
    if (this.orbitControls) {
      this.orbitControls.target.copy(target);
      this.orbitControls.update();
    }

    this.createTransformControls();
    this.syncNavigationMode();
    this.resize(this.viewportSize.width || 1, this.viewportSize.height || 1);
    this.attachTransformControlsForSelection();
    this.requestRender();
  }

  begin2DInteraction(): void {
    this.setOrbitEnabled(false);
    if (this.orthographicControls) {
      this.orthographicControls.enabled = false;
    }
  }

  end2DInteraction(): void {
    this.syncNavigationMode();
  }

  toggleGrid(): void {
    if (this.gridHelper && this.gridHelper) {
      this.gridHelper.visible = appState.ui.showGrid;
    }
  }

  private syncLighting(): void {
    const enabled = this.isEditorFallbackLightingEnabled();
    if (this.renderer) {
      this.renderer.shadowMap.enabled = this.shouldEnableRendererShadowMap();
    }
    if (this.editorAmbientLight) {
      this.editorAmbientLight.visible = enabled;
    }
    if (this.editorDirectionalLight) {
      this.editorDirectionalLight.visible = enabled;
    }
  }

  private isEditorFallbackLightingEnabled(): boolean {
    return appState.ui.showLighting && !this.activeSceneHasExplicitLights();
  }

  private shouldEnableRendererShadowMap(): boolean {
    return appState.ui.showLighting || this.activeSceneHasExplicitLights();
  }

  private activeSceneHasExplicitLights(): boolean {
    const sceneGraph = this.sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      return false;
    }

    return this.containsExplicitLights(sceneGraph.rootNodes);
  }

  private containsExplicitLights(nodes: readonly NodeBase[]): boolean {
    for (const node of nodes) {
      if (this.isExplicitLightNode(node)) {
        return true;
      }

      if (node.children.length > 0 && this.containsExplicitLights(node.children)) {
        return true;
      }
    }

    return false;
  }

  private isExplicitLightNode(
    node: NodeBase
  ): node is
    | DirectionalLightNode
    | PointLightNode
    | SpotLightNode
    | AmbientLightNode
    | HemisphereLightNode {
    return (
      node instanceof DirectionalLightNode ||
      node instanceof PointLightNode ||
      node instanceof SpotLightNode ||
      node instanceof AmbientLightNode ||
      node instanceof HemisphereLightNode
    );
  }

  private ensureNodeIconTextures(): void {
    if (!this.cameraIconTexture) {
      new THREE.TextureLoader().load('/cam.png', texture => {
        texture.colorSpace = THREE.SRGBColorSpace;
        this.cameraIconTexture = texture;
        this.refreshNodeIconMaterials('camera');
      });
    }
    if (!this.lampIconTexture) {
      new THREE.TextureLoader().load('/lamp.png', texture => {
        texture.colorSpace = THREE.SRGBColorSpace;
        this.lampIconTexture = texture;
        this.refreshNodeIconMaterials('light');
      });
    }
    if (!this.particlesIconTexture) {
      new THREE.TextureLoader().load('/particles.png', texture => {
        texture.colorSpace = THREE.SRGBColorSpace;
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

  zoomDefault(): void {
    if (appState.ui.navigationMode === '2d') {
      this.reset2DView();
      return;
    }

    if (!this.camera || !this.orbitControls) return;
    this.camera.position.copy(DEFAULT_3D_CAMERA_POSITION);
    this.camera.zoom = 1;
    this.camera.lookAt(DEFAULT_3D_CAMERA_TARGET);
    this.orbitControls.target.copy(DEFAULT_3D_CAMERA_TARGET);
    this.camera.updateProjectionMatrix();
    this.orbitControls.update();
    this.requestRender();
  }

  zoomAll(): void {
    if (appState.ui.navigationMode === '2d') {
      this.fit2DViewToSceneContent();
      return;
    }

    if (!this.camera || !this.scene || !this.orbitControls) return;

    const box = new THREE.Box3();
    const nodes: THREE.Object3D[] = [];
    this.scene.traverse(obj => {
      if (obj instanceof NodeBase) {
        nodes.push(obj);
      }
    });

    if (nodes.length === 0) {
      this.zoomDefault();
      return;
    }

    box.setFromObject(nodes[0]);
    for (let i = 1; i < nodes.length; i++) {
      box.expandByObject(nodes[i]);
    }

    if (box.isEmpty()) {
      this.zoomDefault();
      return;
    }

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    if (this.camera instanceof THREE.PerspectiveCamera) {
      const fov = this.camera.fov * (Math.PI / 180);
      const cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2)) * 2;

      this.camera.position.set(center.x + cameraZ, center.y + cameraZ, center.z + cameraZ);
    } else {
      const direction = this.camera.position.clone().sub(this.orbitControls.target);
      const distance = Math.max(direction.length(), 10);
      if (direction.lengthSq() === 0) {
        direction.set(1, 1, 1);
      }
      direction.normalize();
      this.camera.position.copy(center).add(direction.multiplyScalar(distance));

      const viewHeight = EDITOR_ORTHOGRAPHIC_FRUSTUM_HEIGHT;
      const viewWidth =
        viewHeight * Math.max(this.viewportSize.width / this.viewportSize.height, 1);
      const targetZoom =
        Math.max(0.1, Math.min(viewWidth / Math.max(size.x, 1), viewHeight / Math.max(size.y, 1))) *
        0.9;
      this.camera.zoom = targetZoom;
      this.camera.updateProjectionMatrix();
    }

    this.camera.lookAt(center);
    this.orbitControls.target.copy(center);
    this.orbitControls.update();
    this.requestRender();
  }

  private reset2DView(): void {
    if (!this.orthographicCamera) {
      return;
    }

    this.cancelPanMomentum();
    this.panVelocity.x = 0;
    this.panVelocity.y = 0;

    this.orthographicCamera.position.set(0, 0, DEFAULT_2D_CAMERA_Z);
    this.orthographicCamera.zoom = 1;
    this.orthographicCamera.updateProjectionMatrix();

    if (this.orthographicControls) {
      this.orthographicControls.target.set(0, 0, 0);
      this.orthographicControls.update();
    }

    this.sync2DServiceFrameThickness();
    if (this.selection2DOverlay) {
      this.refreshGizmoPositions();
    }
    this.saveZoomToState();
    this.requestRender();
  }

  private fit2DViewToSceneContent(): void {
    if (!this.orthographicCamera) {
      return;
    }

    const sceneGraph = this.sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      this.reset2DView();
      return;
    }

    const contentBounds = this.collect2DContentBounds(sceneGraph.rootNodes);
    if (!contentBounds || this.isDegenerateBounds(contentBounds)) {
      this.reset2DView();
      return;
    }

    const size = contentBounds.getSize(new THREE.Vector3());
    const center = contentBounds.getCenter(new THREE.Vector3());
    const paddedWidth = Math.max(size.x * TWO_D_FIT_PADDING_MULTIPLIER, 1);
    const paddedHeight = Math.max(size.y * TWO_D_FIT_PADDING_MULTIPLIER, 1);
    const baseWidth = Math.max(
      Math.abs(this.orthographicCamera.right - this.orthographicCamera.left),
      1
    );
    const baseHeight = Math.max(
      Math.abs(this.orthographicCamera.top - this.orthographicCamera.bottom),
      1
    );
    const targetZoom = Math.max(0.1, Math.min(baseWidth / paddedWidth, baseHeight / paddedHeight));

    this.cancelPanMomentum();
    this.panVelocity.x = 0;
    this.panVelocity.y = 0;

    this.orthographicCamera.position.set(center.x, center.y, DEFAULT_2D_CAMERA_Z);
    this.orthographicCamera.zoom = targetZoom;
    this.orthographicCamera.updateProjectionMatrix();

    if (this.orthographicControls) {
      this.orthographicControls.target.set(center.x, center.y, 0);
      this.orthographicControls.update();
    }

    this.sync2DServiceFrameThickness();
    if (this.selection2DOverlay) {
      this.refreshGizmoPositions();
    }
    this.saveZoomToState();
    this.requestRender();
  }

  private collect2DContentBounds(nodes: readonly NodeBase[]): THREE.Box3 | null {
    let bounds: THREE.Box3 | null = null;

    const traverse = (currentNodes: readonly NodeBase[]) => {
      for (const node of currentNodes) {
        if (node instanceof Node2D && this.isVisibleInHierarchy(node)) {
          const nodeBounds = this.getNodeOnlyBounds(node);
          if (!this.isDegenerateBounds(nodeBounds)) {
            bounds = bounds ? bounds.union(nodeBounds) : nodeBounds.clone();
          }
        }

        if (node.children.length > 0) {
          const childNodes = node.children.filter(
            (child): child is NodeBase => child instanceof NodeBase
          );
          traverse(childNodes);
        }
      }
    };

    traverse(nodes);
    return bounds;
  }

  private isDegenerateBounds(bounds: THREE.Box3): boolean {
    if (bounds.isEmpty()) {
      return true;
    }

    const size = bounds.getSize(new THREE.Vector3());
    const maxSize = Math.max(size.x, size.y, size.z);
    return !Number.isFinite(maxSize) || maxSize <= MIN_WORLD_BOUNDS_SIZE;
  }

  private shouldSkipSelectionBounds(node: Node3D): boolean {
    return node instanceof Camera3D || this.isExplicitLightNode(node);
  }

  private shouldKeepSelectedNodeIcon(node: Node3D): boolean {
    return node instanceof Camera3D || this.isExplicitLightNode(node);
  }

  resize(width: number, height: number): void {
    if (!this.renderer || !this.camera) return;

    this.viewportSize = { width, height };

    const pixelWidth = Math.ceil(width * window.devicePixelRatio);
    const pixelHeight = Math.ceil(height * window.devicePixelRatio);

    this.renderer.setSize(pixelWidth, pixelHeight, false);
    if (this.perspectiveCamera) {
      this.perspectiveCamera.aspect = width / height;
      this.perspectiveCamera.updateProjectionMatrix();
    }
    if (this.editorOrthographicCamera) {
      const halfHeight = EDITOR_ORTHOGRAPHIC_FRUSTUM_HEIGHT / 2;
      const halfWidth = halfHeight * (width / height);
      this.editorOrthographicCamera.left = -halfWidth;
      this.editorOrthographicCamera.right = halfWidth;
      this.editorOrthographicCamera.top = halfHeight;
      this.editorOrthographicCamera.bottom = -halfHeight;
      this.editorOrthographicCamera.updateProjectionMatrix();
    }

    const viewportBaseSize = this.getProjectViewportBaseSize();
    const baseAspect = viewportBaseSize.width / viewportBaseSize.height;
    const viewportAspect = width / height;

    // Compute adaptive logical camera dimensions (Expand / Match-Min mode).
    // The viewportBaseSize must always fit entirely within the camera view:
    // if the viewport is wider than the base, expand width; if taller, expand height.
    let cameraWidth = viewportBaseSize.width;
    let cameraHeight = viewportBaseSize.height;
    if (viewportAspect >= baseAspect) {
      cameraHeight = viewportBaseSize.height;
      cameraWidth = cameraHeight * viewportAspect;
    } else {
      cameraWidth = viewportBaseSize.width;
      cameraHeight = cameraWidth / viewportAspect;
    }

    // Update orthographic camera to the adaptive logical camera dimensions.
    // This keeps 2D composition stable regardless of editor viewport pixel size
    // while ensuring anchored elements track the visible camera edges.
    if (this.orthographicCamera) {
      this.orthographicCamera.left = -cameraWidth / 2;
      this.orthographicCamera.right = cameraWidth / 2;
      this.orthographicCamera.top = cameraHeight / 2;
      this.orthographicCamera.bottom = -cameraHeight / 2;
      this.orthographicCamera.updateProjectionMatrix();
    }

    // Reflow root-anchored 2D nodes against the authored base viewport frame.
    // The orthographic camera can expand beyond the yellow frame for previewing,
    // but authored root anchors stay relative to the base frame itself.
    this.sceneManager.resizeRoot(viewportBaseSize.width, viewportBaseSize.height, true);

    // Sync all 2D visuals after layout recalculation
    this.syncAll2DVisuals();
    this.syncBaseViewportFrame();

    // Trigger a single frame render to ensure the viewport is updated
    // even if rendering is currently paused (e.g. window unfocused).
    this.requestRender();
  }

  reflow2DLayout(): void {
    this.resize(this.viewportSize.width || 1, this.viewportSize.height || 1);
  }

  /**
   * Set the animation to preview for a specific MeshInstance node.
   * Pass null as animationName to stop playback.
   */
  setPreviewAnimation(nodeId: string, animationName: string | null): void {
    const mixer = this.animationMixers.get(nodeId);
    if (!mixer) return;

    // Stop current action for this node
    const currentAction = this.previewAnimationActions.get(nodeId);
    if (currentAction) {
      currentAction.stop();
      this.previewAnimationActions.delete(nodeId);
    }

    if (animationName === null) return;

    // Find the MeshInstance node and look for the clip by name
    const sceneGraph = this.sceneManager.getActiveSceneGraph();
    if (!sceneGraph) return;

    const findMeshNode = (nodes: NodeBase[]): MeshInstance | null => {
      for (const node of nodes) {
        if (node instanceof MeshInstance && node.nodeId === nodeId) return node;
        const found = findMeshNode(node.children as NodeBase[]);
        if (found) return found;
      }
      return null;
    };

    const meshNode = findMeshNode(sceneGraph.rootNodes);
    if (!meshNode) return;

    const clip = meshNode.animations.find(c => c.name === animationName);
    if (!clip) return;

    const action = mixer.clipAction(clip);
    action.reset().play();
    this.previewAnimationActions.set(nodeId, action);
  }

  /**
   * Manually trigger a single frame render. Useful when the main loop
   * is paused but we still want to update the visual state (e.g. on resize).
   */
  requestRender(): void {
    if (!this.renderer || !this.scene || !this.camera) return;

    // Advance animation mixers
    this.animationTimer.update();
    const delta = this.animationTimer.getDelta();
    for (const mixer of this.animationMixers.values()) {
      mixer.update(delta);
    }

    this.tickParticlePreview(delta);
    this.tickComponentPreview(delta);

    // Update controls once before rendering if they exist
    const is2DMode = appState.ui.navigationMode === '2d';
    if (is2DMode) {
      this.orthographicControls?.update();
    } else {
      this.orbitControls?.update();
    }

    this.syncSprite3DBillboarding(this.camera);

    // Render main scene with perspective camera (3D layer and gizmos)
    if (appState.ui.showLayer3D) {
      this.renderer.autoClear = true;
      this.renderer.render(this.scene, this.camera);
    } else {
      this.renderer.autoClear = true;
      this.renderer.clear();
    }

    // Render 2D layer with orthographic camera if enabled
    if (appState.ui.showLayer2D && this.orthographicCamera) {
      const savedBackground = this.scene.background;
      this.scene.background = null;
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.scene, this.orthographicCamera);
      this.scene.background = savedBackground;
    }

    // Render camera preview inset if a camera is selected
    if (this.previewCamera) {
      const savedBackground = this.scene.background;
      this.scene.background = null;
      const pixelRatio = this.renderer.getPixelRatio();
      const previewAspect = this.getPreviewInsetAspect(this.previewCamera);
      const margin = 16;
      const borderWidth = 2;
      const maxInsetWidth = Math.min(this.viewportSize.width * 0.28, 360);
      const maxInsetHeight = Math.min(this.viewportSize.height * 0.28, 220);
      const widthFromHeight = maxInsetHeight * previewAspect;
      const insetWidth = Math.min(
        maxInsetWidth,
        widthFromHeight,
        this.viewportSize.width - margin * 2
      );
      const insetHeight = Math.min(
        insetWidth / previewAspect,
        maxInsetHeight,
        this.viewportSize.height - margin * 2
      );
      const insetX = Math.max(margin, this.viewportSize.width - insetWidth - margin);
      const insetY = Math.max(margin, this.viewportSize.height - insetHeight - margin);
      const outerX = Math.max(0, insetX - borderWidth);
      const outerY = Math.max(0, insetY - borderWidth);
      const outerWidth = Math.min(this.viewportSize.width - outerX, insetWidth + borderWidth * 2);
      const outerHeight = Math.min(
        this.viewportSize.height - outerY,
        insetHeight + borderWidth * 2
      );
      const outerColor = new THREE.Color(0xe8edf6);
      const innerBackground = new THREE.Color(0x090b10);
      const savedClearColor = this.renderer.getClearColor(new THREE.Color());
      const savedClearAlpha = this.renderer.getClearAlpha();

      this.renderer.setViewport(
        outerX * pixelRatio,
        outerY * pixelRatio,
        outerWidth * pixelRatio,
        outerHeight * pixelRatio
      );
      this.renderer.setScissor(
        outerX * pixelRatio,
        outerY * pixelRatio,
        outerWidth * pixelRatio,
        outerHeight * pixelRatio
      );
      this.renderer.setScissorTest(true);
      this.renderer.setClearColor(outerColor, 1);
      this.renderer.clear(true, true, false);

      this.renderer.setViewport(
        insetX * pixelRatio,
        insetY * pixelRatio,
        insetWidth * pixelRatio,
        insetHeight * pixelRatio
      );
      this.renderer.setScissor(
        insetX * pixelRatio,
        insetY * pixelRatio,
        insetWidth * pixelRatio,
        insetHeight * pixelRatio
      );
      this.renderer.setClearColor(innerBackground, 1);
      this.renderer.clear(true, true, false);
      this.renderer.clearDepth();

      const savedMask = this.previewCamera.layers.mask;
      this.previewCamera.layers.set(LAYER_3D);
      this.renderer.render(this.scene, this.previewCamera);

      this.previewCamera.layers.mask = savedMask;
      this.renderer.setClearColor(savedClearColor, savedClearAlpha);
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(
        0,
        0,
        this.viewportSize.width * pixelRatio,
        this.viewportSize.height * pixelRatio
      );
      this.scene.background = savedBackground;
    }

    this.renderer.autoClear = true;
  }

  private getPreviewInsetAspect(camera: THREE.Camera): number {
    if (
      camera instanceof THREE.PerspectiveCamera &&
      Number.isFinite(camera.aspect) &&
      camera.aspect > 0
    ) {
      return camera.aspect;
    }

    if (camera instanceof THREE.OrthographicCamera) {
      const width = Math.abs(camera.right - camera.left);
      const height = Math.abs(camera.top - camera.bottom);
      if (height > 0) {
        return width / height;
      }
    }

    const viewportAspect =
      this.viewportSize.height > 0 ? this.viewportSize.width / this.viewportSize.height : 16 / 9;
    return Number.isFinite(viewportAspect) && viewportAspect > 0 ? viewportAspect : 16 / 9;
  }

  private getProjectViewportBaseSize(): { width: number; height: number } {
    const width = appState.project.manifest?.viewportBaseSize?.width;
    const height = appState.project.manifest?.viewportBaseSize?.height;

    return {
      width:
        typeof width === 'number' && Number.isFinite(width) && width > 0
          ? width
          : DEFAULT_VIEWPORT_BASE_WIDTH,
      height:
        typeof height === 'number' && Number.isFinite(height) && height > 0
          ? height
          : DEFAULT_VIEWPORT_BASE_HEIGHT,
    };
  }

  private getCrisp2DPosition(position: THREE.Vector3): { x: number; y: number; z: number } {
    return {
      x: Math.round(position.x),
      y: Math.round(position.y),
      z: position.z,
    };
  }

  private apply2DVisualTransform(node: Node2D, visualRoot: THREE.Group): void {
    const crispPosition = this.getCrisp2DPosition(node.position);
    visualRoot.position.set(crispPosition.x, crispPosition.y, crispPosition.z);
    visualRoot.rotation.copy(node.rotation);
    visualRoot.scale.set(node.scale.x, node.scale.y, 1);
    visualRoot.visible = node.visible;
  }

  private getFrameThicknessWorldPx(zoom: number): number {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const safeZoom = Math.max(0.0001, zoom);
    return dpr / safeZoom;
  }

  private get2DWorldUnitsPerCssPixel(): THREE.Vector2 | null {
    if (!this.orthographicCamera) {
      return null;
    }

    const { width, height } = this.viewportSize;
    if (width <= 0 || height <= 0) {
      return null;
    }

    const safeZoom = Math.max(0.0001, this.orthographicCamera.zoom || 1);
    return new THREE.Vector2(
      Math.abs(this.orthographicCamera.right - this.orthographicCamera.left) / (safeZoom * width),
      Math.abs(this.orthographicCamera.top - this.orthographicCamera.bottom) / (safeZoom * height)
    );
  }

  private updateRectFrameEdges(
    frame: THREE.Group,
    width: number,
    height: number,
    thickness: number
  ): void {
    frame.traverse(child => {
      if (!(child instanceof THREE.Mesh)) {
        return;
      }
      const edge = child.userData.edge as 'top' | 'bottom' | 'left' | 'right' | undefined;
      if (edge === 'top') {
        child.position.set(0, height / 2 - thickness / 2, 0);
        child.scale.set(width, thickness, 1);
      } else if (edge === 'bottom') {
        child.position.set(0, -height / 2 + thickness / 2, 0);
        child.scale.set(width, thickness, 1);
      } else if (edge === 'left') {
        child.position.set(-width / 2 + thickness / 2, 0, 0);
        child.scale.set(thickness, height, 1);
      } else if (edge === 'right') {
        child.position.set(width / 2 - thickness / 2, 0, 0);
        child.scale.set(thickness, height, 1);
      }
    });
  }

  private sync2DServiceFrameThickness(): void {
    const zoom = this.orthographicCamera?.zoom ?? 1;
    const thickness = this.getFrameThicknessWorldPx(zoom);

    if (this.baseViewportFrame) {
      const width = this.baseViewportFrame.userData.viewportBaseWidth as number | undefined;
      const height = this.baseViewportFrame.userData.viewportBaseHeight as number | undefined;
      if (typeof width === 'number' && typeof height === 'number') {
        this.updateRectFrameEdges(this.baseViewportFrame, width, height, thickness);
      }
    }

    if (this.hoverPreview2D) {
      const width = this.hoverPreview2D.frame.userData.frameWidth as number | undefined;
      const height = this.hoverPreview2D.frame.userData.frameHeight as number | undefined;
      if (typeof width === 'number' && typeof height === 'number') {
        this.updateRectFrameEdges(this.hoverPreview2D.frame, width, height, thickness);
      }
    }

    for (const visualRoot of this.group2DVisuals.values()) {
      const sizeGroup = visualRoot.userData.sizeGroup as THREE.Group | undefined;
      if (!sizeGroup) {
        continue;
      }

      const nodeWidth = Math.abs(sizeGroup.scale.x);
      const nodeHeight = Math.abs(sizeGroup.scale.y);
      const safeWidth = Math.max(1, nodeWidth);
      const safeHeight = Math.max(1, nodeHeight);
      const localThicknessX = Math.min(1, thickness / safeWidth);
      const localThicknessY = Math.min(1, thickness / safeHeight);

      sizeGroup.traverse(child => {
        if (!(child instanceof THREE.Mesh)) {
          return;
        }
        const edge = child.userData.edge as 'top' | 'bottom' | 'left' | 'right' | undefined;
        if (edge === 'top') {
          child.position.set(0, 0.5 - localThicknessY / 2, 0);
          child.scale.set(1, localThicknessY, 1);
        } else if (edge === 'bottom') {
          child.position.set(0, -0.5 + localThicknessY / 2, 0);
          child.scale.set(1, localThicknessY, 1);
        } else if (edge === 'left') {
          child.position.set(-0.5 + localThicknessX / 2, 0, 0);
          child.scale.set(localThicknessX, 1, 1);
        } else if (edge === 'right') {
          child.position.set(0.5 - localThicknessX / 2, 0, 0);
          child.scale.set(localThicknessX, 1, 1);
        }
      });
    }

    for (const visualRoot of this.sprite2DVisuals.values()) {
      const sizeGroup = visualRoot.userData.sizeGroup as THREE.Group | undefined;
      const anchorMarker = visualRoot.userData.anchorMarker as THREE.Group | undefined;
      if (!sizeGroup || !anchorMarker) {
        continue;
      }

      this.updateSprite2DAnchorMarker(
        anchorMarker,
        Math.abs(sizeGroup.scale.x),
        Math.abs(sizeGroup.scale.y),
        thickness
      );
    }

    if (this.selection2DOverlay) {
      this.transformTool2d.updateHandlePositions(
        this.selection2DOverlay,
        this.orthographicCamera!,
        this.viewportSize
      );
    }
  }

  private createBaseViewportFrame(width: number, height: number): THREE.Group {
    const thickness = this.getFrameThicknessWorldPx(1);

    // Create a group to hold all border meshes
    const frame = new THREE.Group();
    frame.layers.set(LAYER_2D);
    frame.renderOrder = 950;
    frame.userData.isBaseViewportFrame = true;

    // Top border
    const topGeometry = new THREE.PlaneGeometry(1, 1);
    const topMaterial = new THREE.MeshBasicMaterial({
      color: 0xffcf33,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    const topBorder = new THREE.Mesh(topGeometry, topMaterial);
    topBorder.position.set(0, height / 2 - thickness / 2, 0); // Align to top edge
    topBorder.scale.set(width, thickness, 1);
    topBorder.layers.set(LAYER_2D);
    topBorder.renderOrder = 950;
    topBorder.userData.isBaseViewportFrame = true;
    topBorder.userData.edge = 'top';
    frame.add(topBorder);

    // Bottom border
    const bottomGeometry = new THREE.PlaneGeometry(1, 1);
    const bottomMaterial = new THREE.MeshBasicMaterial({
      color: 0xffcf33,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    const bottomBorder = new THREE.Mesh(bottomGeometry, bottomMaterial);
    bottomBorder.position.set(0, -height / 2 + thickness / 2, 0); // Align to bottom edge
    bottomBorder.scale.set(width, thickness, 1);
    bottomBorder.layers.set(LAYER_2D);
    bottomBorder.renderOrder = 950;
    bottomBorder.userData.isBaseViewportFrame = true;
    bottomBorder.userData.edge = 'bottom';
    frame.add(bottomBorder);

    // Left border
    const leftGeometry = new THREE.PlaneGeometry(1, 1);
    const leftMaterial = new THREE.MeshBasicMaterial({
      color: 0xffcf33,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    const leftBorder = new THREE.Mesh(leftGeometry, leftMaterial);
    leftBorder.position.set(-width / 2 + thickness / 2, 0, 0); // Align to left edge
    leftBorder.scale.set(thickness, height, 1);
    leftBorder.layers.set(LAYER_2D);
    leftBorder.renderOrder = 950;
    leftBorder.userData.isBaseViewportFrame = true;
    leftBorder.userData.edge = 'left';
    frame.add(leftBorder);

    // Right border
    const rightGeometry = new THREE.PlaneGeometry(1, 1);
    const rightMaterial = new THREE.MeshBasicMaterial({
      color: 0xffcf33,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    const rightBorder = new THREE.Mesh(rightGeometry, rightMaterial);
    rightBorder.position.set(width / 2 - thickness / 2, 0, 0); // Align to right edge
    rightBorder.scale.set(thickness, height, 1);
    rightBorder.layers.set(LAYER_2D);
    rightBorder.renderOrder = 950;
    rightBorder.userData.isBaseViewportFrame = true;
    rightBorder.userData.edge = 'right';
    frame.add(rightBorder);

    return frame;
  }

  private syncBaseViewportFrame(): void {
    if (!this.scene) {
      return;
    }

    const viewportBaseSize = this.getProjectViewportBaseSize();

    // Check if rebuild is needed - need to cast userData to access custom properties
    let needsRebuild = true;
    if (this.baseViewportFrame) {
      const userData = this.baseViewportFrame.userData as {
        viewportBaseWidth?: number;
        viewportBaseHeight?: number;
      };
      needsRebuild =
        userData.viewportBaseWidth !== viewportBaseSize.width ||
        userData.viewportBaseHeight !== viewportBaseSize.height;
    } else {
      needsRebuild = true;
    }

    if (needsRebuild) {
      if (this.baseViewportFrame) {
        this.scene.remove(this.baseViewportFrame);
        // Dispose all geometries and materials in the group
        this.baseViewportFrame.traverse(obj => {
          if (obj instanceof THREE.Mesh && obj.geometry) {
            obj.geometry.dispose();
            if (obj.material instanceof THREE.Material) {
              obj.material.dispose();
            }
          }
        });
      }

      this.baseViewportFrame = this.createBaseViewportFrame(
        viewportBaseSize.width,
        viewportBaseSize.height
      );

      // Cast userData to set custom viewport dimensions
      this.baseViewportFrame.userData['viewportBaseWidth'] = viewportBaseSize.width;
      this.baseViewportFrame.userData['viewportBaseHeight'] = viewportBaseSize.height;

      this.scene.add(this.baseViewportFrame);
    }

    if (!this.baseViewportFrame) {
      return;
    }

    if (this.baseViewportFrame.parent !== this.scene) {
      this.scene.add(this.baseViewportFrame);
    }

    this.baseViewportFrame.visible = appState.ui.showLayer2D;
    this.sync2DServiceFrameThickness();
  }

  /**
   * Sync all Group2D, AnimatedSprite2D, and Sprite2D visuals to match their node state.
   * Called after layout recalculation to update visual positions/sizes.
   */
  private syncAll2DVisuals(): void {
    const sceneGraph = this.sceneManager.getActiveSceneGraph();
    if (!sceneGraph) return;

    // Recursively update all 2D nodes in the scene
    const updateNode2DVisuals = (nodes: NodeBase[]) => {
      for (const node of nodes) {
        if (node instanceof Group2D) {
          const visualRoot = this.group2DVisuals.get(node.nodeId);
          if (visualRoot) {
            this.apply2DVisualTransform(node, visualRoot);
            const sizeGroup = visualRoot.userData.sizeGroup as THREE.Object3D | undefined;
            if (sizeGroup) {
              sizeGroup.scale.set(node.width, node.height, 1);
            }
            this.apply2DVisualOpacity(node, visualRoot);
          }
        } else if (node instanceof AnimatedSprite2D) {
          const visualRoot = this.animatedSprite2DVisuals.get(node.nodeId);
          if (visualRoot) {
            this.syncAnimatedSprite2DVisual(node, visualRoot);
          }
        } else if (node instanceof Sprite2D) {
          const visualRoot = this.sprite2DVisuals.get(node.nodeId);
          if (visualRoot) {
            this.apply2DVisualTransform(node, visualRoot);
            const sizeGroup = visualRoot.userData.sizeGroup as THREE.Object3D | undefined;
            if (sizeGroup) {
              sizeGroup.scale.set(node.width ?? 64, node.height ?? 64, 1);
            }
            this.apply2DVisualOpacity(node, visualRoot);
          }
        } else if (node instanceof UIControl2D) {
          const visualRoot = this.uiControl2DVisuals.get(node.nodeId);
          if (visualRoot) {
            this.apply2DVisualTransform(node, visualRoot);
            const sizeGroup = visualRoot.userData.sizeGroup as THREE.Object3D | undefined;
            if (sizeGroup) {
              const { width, height } = this.getUIControlDimensions(node);
              sizeGroup.scale.set(width, height, 1);
            }
            this.apply2DVisualOpacity(node, visualRoot);
          }
        }
        updateNode2DVisuals(node.children);
      }
    };

    updateNode2DVisuals(sceneGraph.rootNodes);

    // Also refresh gizmo positions if there's a 2D selection
    if (this.selection2DOverlay) {
      this.refreshGizmoPositions();
    }
  }

  /**
   * Pan the 2D camera by the given delta in screen space.
   * Only active in 2D mode.
   */
  pan2D(deltaX: number, deltaY: number): void {
    if (
      !this.orthographicControls ||
      !this.orthographicCamera ||
      appState.ui.navigationMode !== '2d'
    ) {
      return;
    }

    // Scale delta by current zoom level so pan feels consistent at any zoom.
    const zoomFactor = this.orthographicCamera.zoom;
    const scaledDeltaX = deltaX / zoomFactor;
    const scaledDeltaY = deltaY / zoomFactor;
    const panScale = 0.5;

    // Translate both camera position and target so it pans instead of rotating.
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.orthographicCamera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.orthographicCamera.quaternion);
    const panOffset = right
      .multiplyScalar(scaledDeltaX * panScale)
      .add(up.multiplyScalar(-scaledDeltaY * panScale));

    this.orthographicCamera.position.add(panOffset);
    this.orthographicControls.target.add(panOffset);

    // Track velocity for momentum animation (unused if handled via OS inertia events)
    this.panVelocity.x = scaledDeltaX * 0.5;
    this.panVelocity.y = -scaledDeltaY * 0.5;
  }

  /**
   * Pan the 2D camera by a drag delta in CSS pixels.
   * This path keeps direct-manipulation panning aligned with the pointer/finger.
   */
  pan2DByDrag(deltaX: number, deltaY: number): void {
    if (
      !this.orthographicControls ||
      !this.orthographicCamera ||
      appState.ui.navigationMode !== '2d'
    ) {
      return;
    }

    const worldUnitsPerCssPixel = this.get2DWorldUnitsPerCssPixel();
    if (!worldUnitsPerCssPixel) {
      return;
    }

    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.orthographicCamera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.orthographicCamera.quaternion);
    const panOffset = right
      .multiplyScalar(deltaX * worldUnitsPerCssPixel.x)
      .add(up.multiplyScalar(-deltaY * worldUnitsPerCssPixel.y));

    this.orthographicCamera.position.add(panOffset);
    this.orthographicControls.target.add(panOffset);
    this.panVelocity.x = panOffset.x;
    this.panVelocity.y = panOffset.y;
  }

  /**
   * Zoom the 2D camera by the given factor (multiplied into current zoom).
   * Only active in 2D mode.
   */
  zoom2D(factor: number): void {
    if (!this.orthographicCamera || appState.ui.navigationMode !== '2d') {
      return;
    }

    const newZoom = Math.max(0.1, this.orthographicCamera.zoom * factor);
    this.orthographicCamera.zoom = newZoom;
    this.orthographicCamera.updateProjectionMatrix();
    this.sync2DServiceFrameThickness();

    // Rescale overlay handles to maintain constant screen-space size.
    if (this.selection2DOverlay) {
      this.refreshGizmoPositions();
    }

    this.saveZoomToState();
  }

  zoom2DAroundPoint(factor: number, screenX: number, screenY: number): void {
    if (!this.orthographicCamera || appState.ui.navigationMode !== '2d') {
      return;
    }

    const anchorBeforeZoom = this.screenToWorld2D(screenX, screenY);
    if (!anchorBeforeZoom) {
      this.zoom2D(factor);
      return;
    }

    const newZoom = Math.max(0.1, this.orthographicCamera.zoom * factor);
    this.orthographicCamera.zoom = newZoom;
    this.orthographicCamera.updateProjectionMatrix();

    const anchorAfterZoom = this.screenToWorld2D(screenX, screenY);
    if (anchorAfterZoom) {
      const anchorDelta = anchorBeforeZoom.sub(anchorAfterZoom);
      this.orthographicCamera.position.add(anchorDelta);
      this.orthographicControls?.target.add(anchorDelta);
    }

    this.sync2DServiceFrameThickness();
    if (this.selection2DOverlay) {
      this.refreshGizmoPositions();
    }

    this.saveZoomToState();
  }

  /**
   * Get current 2D zoom level.
   */
  getZoom2D(): number {
    return this.orthographicCamera?.zoom ?? 1;
  }

  /**
   * Set 2D zoom level directly.
   */
  setZoom2D(zoom: number): void {
    if (!this.orthographicCamera) {
      return;
    }
    const clampedZoom = Math.max(0.1, zoom);
    this.orthographicCamera.zoom = clampedZoom;
    this.orthographicCamera.updateProjectionMatrix();
    this.sync2DServiceFrameThickness();

    // Rescale overlay handles to maintain constant screen-space size.
    if (this.selection2DOverlay) {
      this.refreshGizmoPositions();
    }

    this.saveZoomToState();
  }

  /**
   * Save current 2D camera state to app state for persistence.
   */
  saveZoomToState(): void {
    const sceneId = appState.scenes.activeSceneId;
    if (!sceneId) return;

    if (!this.orthographicCamera || !this.orthographicControls) {
      return;
    }

    appState.scenes.cameraStates[sceneId] = {
      position: {
        x: this.orthographicCamera.position.x,
        y: this.orthographicCamera.position.y,
        z: this.orthographicCamera.position.z,
      },
      target: {
        x: this.orthographicControls.target.x,
        y: this.orthographicControls.target.y,
        z: this.orthographicControls.target.z,
      },
      zoom: this.getZoom2D(),
    };
  }

  /**
   * Restore 2D camera state from app state.
   */
  restoreZoomFromState(): void {
    const sceneId = appState.scenes.activeSceneId;
    if (!sceneId || !this.orthographicCamera || !this.orthographicControls) return;

    const cameraState = appState.scenes.cameraStates[sceneId];
    if (!cameraState) {
      return;
    }

    this.orthographicCamera.position.set(
      cameraState.position.x,
      cameraState.position.y,
      cameraState.position.z
    );
    this.orthographicControls.target.set(
      cameraState.target.x,
      cameraState.target.y,
      cameraState.target.z
    );

    if (typeof cameraState.zoom === 'number') {
      this.setZoom2D(cameraState.zoom);
      return;
    }

    this.sync2DServiceFrameThickness();
    if (this.selection2DOverlay) {
      this.refreshGizmoPositions();
    }
  }

  /**
   * Start pan momentum animation. Called after gesture ends.
   * Applies exponential damping to pan velocity over ~500ms.
   */
  startPanMomentum(): void {
    if (this.shouldPauseForWindowFocus()) {
      return;
    }

    if (this.momentumAnimationId) {
      cancelAnimationFrame(this.momentumAnimationId);
    }

    const frictionFactor = 0.95; // Per frame decay (5% loss per frame at 60fps ≈ 500ms total)
    const minVelocity = 0.001; // Below this, stop animating

    const animate = () => {
      if (this.isPaused || this.shouldPauseForWindowFocus()) {
        this.momentumAnimationId = undefined;
        return;
      }

      // Check if velocity is negligible
      const speed = Math.sqrt(
        this.panVelocity.x * this.panVelocity.x + this.panVelocity.y * this.panVelocity.y
      );

      if (speed < minVelocity) {
        // Save zoom when momentum animation ends
        this.saveZoomToState();
        this.momentumAnimationId = undefined;
        return;
      }

      // Apply pan with current velocity (no new delta)
      if (this.orthographicControls && appState.ui.navigationMode === '2d') {
        this.orthographicControls.target.x += this.panVelocity.x;
        this.orthographicControls.target.y += this.panVelocity.y;
      }

      // Decay velocity
      this.panVelocity.x *= frictionFactor;
      this.panVelocity.y *= frictionFactor;

      // Queue next frame
      this.momentumAnimationId = requestAnimationFrame(animate);
    };

    // Start animation
    this.momentumAnimationId = requestAnimationFrame(animate);
  }

  /**
   * Cancel any ongoing pan momentum animation.
   */
  cancelPanMomentum(): void {
    if (this.momentumAnimationId) {
      cancelAnimationFrame(this.momentumAnimationId);
      this.momentumAnimationId = undefined;
    }
  }

  setTransformMode(mode: TransformMode): void {
    // Set the transform mode for the gizmo
    this.currentTransformMode = mode;

    if (mode === 'select') {
      // In select mode, hide the transform gizmo
      if (this.transformGizmo && this.scene) {
        this.scene.remove(this.transformGizmo);
        this.transformGizmo = undefined;
      }
      // Detach from current object
      if (this.transformControls) {
        this.transformControls.detach();
      }
    } else if (this.transformControls) {
      // In transform modes, set the mode on TransformControls
      this.transformControls.setMode(mode);
      this.attachTransformControlsForSelection();
    }
  }

  /**
   * Raycast from camera through screen position and find the deepest NodeBase object.
   * Excludes locked nodes from selection.
   * @param screenX Normalized screen X coordinate (0 to 1)
   * @param screenY Normalized screen Y coordinate (0 to 1)
   * @returns The deepest NodeBase object under the pointer, or null if none found
   */
  raycastObject(screenX: number, screenY: number): NodeBase | null {
    if (!this.scene || !this.renderer) {
      return null;
    }

    const is2DMode = appState.ui.navigationMode === '2d';

    const layer2DEnabled = appState.ui.showLayer2D && Boolean(this.orthographicCamera);
    const layer3DEnabled = appState.ui.showLayer3D && Boolean(this.camera) && !is2DMode;

    if (!layer2DEnabled && !layer3DEnabled) {
      return null;
    }

    const pixelX = screenX * this.viewportSize.width;
    const pixelY = screenY * this.viewportSize.height;
    if (layer2DEnabled) {
      const hit2D = this.raycast2D(pixelX, pixelY);
      if (hit2D) {
        console.debug('[ViewportRenderer] 2D hit', hit2D.nodeId, 'at', { pixelX, pixelY });
        return hit2D;
      }
    }

    if (!layer3DEnabled || !this.camera) {
      this.clearActiveTargetSelection();
      return null;
    }

    const targetNodeId = this.raycastTargetSphere(screenX, screenY);
    if (targetNodeId) {
      this.setActiveTargetSelection(targetNodeId);
      const sceneGraph = this.sceneManager.getActiveSceneGraph();
      const node = sceneGraph?.nodeMap.get(targetNodeId);
      if (node instanceof NodeBase && node.visible && !node.properties.locked) {
        return node;
      }
      return null;
    }

    this.clearActiveTargetSelection();

    const iconNodeId = this.raycastNodeIcon(screenX, screenY);
    if (iconNodeId) {
      const sceneGraph = this.sceneManager.getActiveSceneGraph();
      const node = sceneGraph?.nodeMap.get(iconNodeId);
      if (node instanceof NodeBase && node.visible && !node.properties.locked) {
        return node;
      }
    }

    // Create raycaster and convert screen coordinates to normalized device coordinates
    const raycaster = new THREE.Raycaster();
    raycaster.layers.set(LAYER_3D);
    console.debug('[ViewportRenderer] 3D raycast at', { pixelX, pixelY });
    const mouse = new THREE.Vector2();

    // Convert from screen coordinates (0-1) to NDC (-1 to 1)
    mouse.x = screenX * 2 - 1;
    mouse.y = -(screenY * 2 - 1);

    // Cast ray from camera through mouse position
    raycaster.setFromCamera(mouse, this.camera);

    // Get all 3D objects in the scene
    const sceneObjects: THREE.Object3D[] = [];
    this.scene.traverse(obj => {
      if (obj instanceof Node3D) {
        sceneObjects.push(obj);
      }
    });

    // Raycast against all objects
    const intersects = raycaster.intersectObjects(sceneObjects, true);

    if (intersects.length === 0) {
      return null;
    }

    // Find the deepest NodeBase in the hierarchy
    // Start from the closest intersection and traverse up to find the deepest NodeBase ancestor
    // Skip locked nodes
    for (const intersection of intersects) {
      if (!this.isVisibleInHierarchy(intersection.object)) {
        continue;
      }

      let current: THREE.Object3D | null = intersection.object;

      // Traverse up the hierarchy to find the deepest NodeBase
      while (current) {
        if (current instanceof NodeBase) {
          // Skip locked nodes - they cannot be selected by pointer
          const isLocked = Boolean((current as NodeBase).properties.locked);
          if (!isLocked && this.isVisibleInHierarchy(current)) {
            return current;
          }
        }
        current = current.parent;
      }
    }

    return null;
  }

  private raycastNodeIcon(screenX: number, screenY: number): string | null {
    if (!this.camera || this.nodeIcons.size === 0 || !appState.ui.showLayer3D) {
      return null;
    }

    const raycaster = new THREE.Raycaster();
    raycaster.layers.set(LAYER_GIZMOS);

    const mouse = new THREE.Vector2();
    mouse.x = screenX * 2 - 1;
    mouse.y = -(screenY * 2 - 1);
    raycaster.setFromCamera(mouse, this.camera);

    const icons = Array.from(this.nodeIcons.values()).filter(icon => icon.visible);
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

  private raycastTargetSphere(screenX: number, screenY: number): string | null {
    if (!this.camera || this.targetGizmos.size === 0 || !appState.ui.showLayer3D) {
      return null;
    }

    const raycaster = new THREE.Raycaster();
    raycaster.layers.set(LAYER_GIZMOS);

    const mouse = new THREE.Vector2();
    mouse.x = screenX * 2 - 1;
    mouse.y = -(screenY * 2 - 1);
    raycaster.setFromCamera(mouse, this.camera);

    const targetSpheres: THREE.Object3D[] = [];
    for (const gizmo of this.targetGizmos.values()) {
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

  private raycast2D(pixelX: number, pixelY: number): NodeBase | null {
    if (!this.orthographicCamera || !appState.ui.showLayer2D) {
      return null;
    }

    const mouse = this.toNdc(pixelX, pixelY);
    if (!mouse) {
      return null;
    }

    const raycaster = new THREE.Raycaster();
    raycaster.params.Line.threshold = 0.5;
    raycaster.layers.set(1);
    raycaster.setFromCamera(mouse, this.orthographicCamera);

    // Only hit-test rendered 2D visuals; transparent container groups are intentionally skipped
    const candidates: THREE.Object3D[] = [
      ...this.animatedSprite2DVisuals.values(),
      ...this.sprite2DVisuals.values(),
      ...this.uiControl2DVisuals.values(),
    ];

    // console.debug('[ViewportRenderer] 2D raycast candidates', {
    //   count: candidates.length,
    //   nodeIds: candidates.map(c => c.userData?.nodeId).filter(Boolean),
    //   mouse,
    // });

    const intersects = raycaster
      .intersectObjects(candidates, true)
      .filter(intersection => this.isVisibleInHierarchy(intersection.object));
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

    // In orthographic 2D, all objects share the same Z so raycaster distance is
    // meaningless for depth ordering. Pick the topmost node by choosing the one
    // whose visual appears last in the flat candidates list (later = drawn on top).
    // Build an index map for O(1) order lookup.
    const orderMap = new Map<string, number>();
    let order = 0;
    for (const c of candidates) {
      const nid = c.userData?.nodeId as string | undefined;
      if (nid) {
        orderMap.set(nid, order++);
      }
    }

    let bestIntersect = intersects[0];
    let bestOrder =
      orderMap.get((bestIntersect.object.userData?.nodeId as string | undefined) ?? '') ?? -1;

    for (let i = 1; i < intersects.length; i++) {
      const nid = (intersects[i].object.userData?.nodeId as string | undefined) ?? '';
      const o = orderMap.get(nid) ?? -1;
      if (o > bestOrder) {
        bestOrder = o;
        bestIntersect = intersects[i];
      }
    }

    const nodeId = (bestIntersect.object.userData?.nodeId as string | undefined) ?? null;
    if (!nodeId) {
      return null;
    }

    const activeSceneId = appState.scenes.activeSceneId;
    if (!activeSceneId) {
      return null;
    }

    const sceneGraph = this.sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      return null;
    }

    const node = sceneGraph.nodeMap.get(nodeId);
    if (node instanceof NodeBase) {
      const isLocked = Boolean((node as NodeBase).properties.locked);
      if (isLocked) {
        console.debug('[ViewportRenderer] 2D hit on locked node', nodeId);
        return null;
      }
      return node;
    }

    return null;
  }

  private isVisibleInHierarchy(object: THREE.Object3D): boolean {
    let current: THREE.Object3D | null = object;
    while (current) {
      if (!current.visible) {
        return false;
      }
      current = current.parent;
    }
    return true;
  }

  updateNodeTransform(node: NodeBase): void {
    // Node is already a Three.js Object3D, so it updates automatically via reactivity
    if (this.scene && node instanceof Node3D) {
      // Ensure the node is in the scene if it's not already
      if (!node.parent) {
        this.scene.add(node);
      }

      // Update gizmo if it exists
      const gizmo = this.selectionGizmos.get(node.nodeId);
      if (gizmo) {
        node.updateMatrixWorld(true);

        // PointLightHelper doesn't self-position in update()
        if (gizmo instanceof THREE.PointLightHelper) {
          node.getWorldPosition(gizmo.position);
        }

        // Some helpers need explicit update
        gizmo.traverse(child => {
          const updatable = child as unknown as { update?: () => void };
          if (typeof updatable.update === 'function') {
            updatable.update();
          }
        });
      }

      if (node instanceof Sprite3D) {
        this.syncSprite3DTexture(node);
      }

      if (node instanceof Particles3D) {
        this.syncParticles3DTexture(node);
      }
    } else if (node instanceof Group2D) {
      const visualRoot = this.group2DVisuals.get(node.nodeId);
      if (visualRoot) {
        this.apply2DVisualTransform(node, visualRoot);
        const sizeGroup = visualRoot.userData.sizeGroup as THREE.Object3D | undefined;
        if (sizeGroup) {
          sizeGroup.scale.set(node.width, node.height, 1);
        }
        visualRoot.visible = node.visible;
        this.apply2DVisualOpacity(node, visualRoot);
      }
    } else if (node instanceof AnimatedSprite2D) {
      const visualRoot = this.animatedSprite2DVisuals.get(node.nodeId);
      if (visualRoot) {
        this.syncAnimatedSprite2DVisual(node, visualRoot);
      }
    } else if (node instanceof Sprite2D) {
      const visualRoot = this.sprite2DVisuals.get(node.nodeId);
      if (visualRoot) {
        this.apply2DVisualTransform(node, visualRoot);
        const sizeGroup = visualRoot.userData.sizeGroup as THREE.Object3D | undefined;
        if (sizeGroup) {
          // Use natural dimensions if width/height are undefined (first load)
          const w = node.width ?? node.originalWidth ?? 64;
          const h = node.height ?? node.originalHeight ?? 64;
          sizeGroup.scale.set(w, h, 1);
        }

        const mesh = visualRoot.userData.spriteMesh as THREE.Mesh | undefined;
        if (mesh) {
          const anchor = this.getSprite2DAnchor(node);
          mesh.position.set(0.5 - anchor.x, 0.5 - anchor.y, 0);
        }

        const anchorMarker = visualRoot.userData.anchorMarker as THREE.Group | undefined;
        if (anchorMarker) {
          anchorMarker.position.set(0, 0, 0.01);

          if (sizeGroup) {
            this.updateSprite2DAnchorMarker(
              anchorMarker,
              Math.abs(sizeGroup.scale.x),
              Math.abs(sizeGroup.scale.y),
              this.getFrameThicknessWorldPx(this.orthographicCamera?.zoom ?? 1)
            );
          }
        }

        if (mesh && mesh.material instanceof THREE.MeshBasicMaterial) {
          const currentTexturePath = node.texturePath ?? null;
          const previousTexturePath = (visualRoot.userData.texturePath as string | null) ?? null;
          if (currentTexturePath !== previousTexturePath) {
            mesh.material.map = null;
            mesh.material.needsUpdate = true;
            this.applyTextureToSprite2DMaterial(node, mesh.material);
            visualRoot.userData.texturePath = currentTexturePath;
          }
        }

        this.apply2DVisualOpacity(node, visualRoot);
      }
    } else if (node instanceof UIControl2D) {
      const visualRoot = this.uiControl2DVisuals.get(node.nodeId);
      if (visualRoot) {
        this.apply2DVisualTransform(node, visualRoot);

        const sizeGroup = visualRoot.userData.sizeGroup as THREE.Object3D | undefined;
        if (sizeGroup) {
          const { width, height } = this.getUIControlDimensions(node);
          sizeGroup.scale.set(width, height, 1);
        }

        const mesh = visualRoot.userData.controlMesh as THREE.Mesh | undefined;
        if (mesh && mesh.material instanceof THREE.MeshBasicMaterial) {
          mesh.material.userData.baseOpacity = node instanceof Label2D ? 0 : 1;
          mesh.material.color.setHex(this.getUIControlDefaultColor(node));

          const currentTexturePath =
            (node as UIControl2D & { texturePath?: string | null }).texturePath ?? null;
          const previousTexturePath = (visualRoot.userData.texturePath as string | null) ?? null;
          if (currentTexturePath !== previousTexturePath) {
            mesh.material.map = null;
            mesh.material.needsUpdate = true;
            this.applyTextureTo2DMaterial(node, mesh.material);
            visualRoot.userData.texturePath = currentTexturePath;
          }
        }

        this.updateUIControlLabelVisual(visualRoot, node);
        this.apply2DVisualOpacity(node, visualRoot);
      }
    }

    if (node instanceof Node2D && this.selection2DOverlay?.nodeIds.includes(node.nodeId)) {
      this.refreshGizmoPositions();
    }
  }

  updateNodeVisibility(node: NodeBase): void {
    if (node instanceof Group2D) {
      const visualRoot = this.group2DVisuals.get(node.nodeId);
      if (visualRoot) {
        visualRoot.visible = node.visible;
      }
    } else if (node instanceof AnimatedSprite2D) {
      const visualRoot = this.animatedSprite2DVisuals.get(node.nodeId);
      if (visualRoot) {
        visualRoot.visible = node.visible;
      }
    } else if (node instanceof Sprite2D) {
      const visualRoot = this.sprite2DVisuals.get(node.nodeId);
      if (visualRoot) {
        visualRoot.visible = node.visible;
      }
    } else if (node instanceof UIControl2D) {
      const visualRoot = this.uiControl2DVisuals.get(node.nodeId);
      if (visualRoot) {
        visualRoot.visible = node.visible;
      }
    }

    this.updateSelection();
  }

  updateSelection(): void {
    // Don't update selection while a 2D transform is in progress
    if (this.active2DTransform) {
      return;
    }

    // Detach transform controls from previous object
    if (this.transformControls) {
      this.transformControls.detach();
    }

    // Remove previous transform gizmo from scene
    if (this.transformGizmo && this.scene) {
      this.scene.remove(this.transformGizmo);
      this.transformGizmo = undefined;
    }

    // Clear previous selection boxes and dispose their Three.js resources
    for (const box of this.selectionBoxes.values()) {
      if (this.scene) {
        this.scene.remove(box);
      }
      // Dispose Three.js resources to prevent memory leaks
      box.geometry.dispose();
      if (box.material instanceof THREE.Material) {
        box.material.dispose();
      }
    }
    this.selectionBoxes.clear();

    // Clear previous selection gizmos
    for (const gizmo of this.selectionGizmos.values()) {
      if (this.scene) {
        this.scene.remove(gizmo);
      }
      gizmo.traverse(child => {
        if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
          child.geometry.dispose();
          if (child.material instanceof THREE.Material) {
            child.material.dispose();
          }
        }
      });
    }
    this.selectionGizmos.clear();

    // Clear previous target gizmos
    for (const gizmo of this.targetGizmos.values()) {
      if (this.scene) {
        this.scene.remove(gizmo);
      }
      gizmo.traverse(child => {
        if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
          child.geometry.dispose();
          if (child.material instanceof THREE.Material) {
            child.material.dispose();
          }
        }
      });
    }
    this.targetGizmos.clear();

    // Extra safety: remove any lingering selection boxes from the scene
    // (in case of reference mismatches)
    if (this.scene) {
      const toRemove: THREE.Object3D[] = [];
      this.scene.children.forEach(child => {
        const ud = child.userData as Record<string, unknown> | undefined;
        if (ud?.isSelectionBox || ud?.isTransformGizmo || ud?.isSelectionGizmo) {
          toRemove.push(child);
        }
      });
      toRemove.forEach(child => {
        this.scene?.remove(child);
      });
    }

    // Get selected node IDs from app state
    const { nodeIds } = appState.selection;
    if (this.activeTargetNodeId && !nodeIds.includes(this.activeTargetNodeId)) {
      this.activeTargetNodeId = null;
    }
    const activeSceneId = appState.scenes.activeSceneId;

    if (!activeSceneId) {
      return;
    }

    const sceneGraph = this.sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      return;
    }

    const previewCameraNodeId = appState.scenes.previewCameraNodeIds[activeSceneId] ?? null;

    // Clear previous selection object tracking
    this.selectedObjects.clear();
    this.previewCamera =
      previewCameraNodeId !== null
        ? (() => {
            const previewNode = sceneGraph.nodeMap.get(previewCameraNodeId);
            return previewNode instanceof Camera3D ? previewNode.camera : null;
          })()
        : null;

    // Add selection boxes for selected nodes and attach transform controls to the first one
    let firstSelectedNode: Node3D | null = null;
    const selected2DNodeIds: string[] = [];

    for (const nodeId of nodeIds) {
      const node = this.findNodeById(nodeId, sceneGraph.rootNodes);
      if (node && node instanceof Node3D) {
        if (!this.isVisibleInHierarchy(node)) {
          continue;
        }

        this.selectedObjects.add(node);

        if (!firstSelectedNode) {
          firstSelectedNode = node;
        }

        if (!this.shouldSkipSelectionBounds(node)) {
          const box = new THREE.Box3().setFromObject(node);
          if (this.isDegenerateBounds(box)) {
            continue;
          }
          const helper = new THREE.Box3Helper(box, new THREE.Color(0x00ff00));
          helper.userData.selectionBoxId = nodeId;
          helper.userData.isSelectionBox = true;
          helper.layers.set(LAYER_GIZMOS);
          helper.traverse(child => {
            child.layers.set(LAYER_GIZMOS);
          });
          this.selectionBoxes.set(nodeId, helper);
          this.scene?.add(helper);
        }

        // Create custom gizmos for specific node types
        const gizmo = this.createNodeGizmo(node);
        if (gizmo) {
          gizmo.userData.isSelectionGizmo = true;
          gizmo.layers.set(LAYER_GIZMOS);
          gizmo.traverse(child => {
            child.layers.set(LAYER_GIZMOS);
          });
          this.selectionGizmos.set(nodeId, gizmo);
          this.scene?.add(gizmo);
        }

        // Create target gizmos for cameras and directional lights
        const targetGizmo = this.createTargetGizmo(node);
        if (targetGizmo) {
          targetGizmo.userData.isTargetGizmo = true;
          targetGizmo.traverse(child => {
            child.layers.set(LAYER_GIZMOS);
          });
          this.targetGizmos.set(nodeId, targetGizmo);
          this.scene?.add(targetGizmo);
        }
      } else if (node && node instanceof Node2D) {
        if (this.isVisibleInHierarchy(node)) {
          selected2DNodeIds.push(nodeId);
        }
      }
    }

    if (selected2DNodeIds.length > 0) {
      this.update2DSelectionOverlayForNodes(selected2DNodeIds);
    } else {
      this.clear2DSelectionOverlay();
    }
    this.updateNodeIconVisibility();

    this.attachTransformControlsForSelection(firstSelectedNode);
  }

  private attachTransformControlsForSelection(firstSelectedNode?: Node3D | null): void {
    if (!this.transformControls || !this.scene || this.currentTransformMode === 'select') {
      return;
    }

    let nodeToAttach = firstSelectedNode ?? null;
    if (!nodeToAttach) {
      const { nodeIds } = appState.selection;
      const activeSceneId = appState.scenes.activeSceneId;
      if (!nodeIds.length || !activeSceneId) {
        return;
      }

      const sceneGraph = this.sceneManager.getSceneGraph(activeSceneId);
      if (!sceneGraph) {
        return;
      }

      const selectedNode = this.findNodeById(nodeIds[0], sceneGraph.rootNodes);
      if (selectedNode instanceof Node3D && this.isVisibleInHierarchy(selectedNode)) {
        nodeToAttach = selectedNode;
      }
    }

    if (!nodeToAttach) {
      return;
    }

    let transformObject: THREE.Object3D = nodeToAttach;
    const shouldAttachTarget =
      this.currentTransformMode === 'translate' &&
      this.activeTargetNodeId === nodeToAttach.nodeId &&
      (nodeToAttach instanceof Camera3D || nodeToAttach instanceof DirectionalLightNode);

    if (shouldAttachTarget) {
      const targetSphere = this.getTargetSphere(nodeToAttach.nodeId);
      if (targetSphere) {
        transformObject = targetSphere;
      } else {
        this.activeTargetNodeId = null;
      }
    }

    this.transformControls.attach(transformObject);
    this.transformGizmo = this.transformControls.getHelper();
    this.transformGizmo.userData.isTransformGizmo = true;
    this.transformGizmo.layers.set(LAYER_GIZMOS);
    this.transformGizmo.traverse(child => {
      child.userData.isTransformGizmo = true;
      child.layers.set(LAYER_GIZMOS);
    });
    this.scene.add(this.transformGizmo);
  }

  private setActiveTargetSelection(nodeId: string): void {
    if (this.activeTargetNodeId === nodeId) {
      return;
    }
    this.activeTargetNodeId = nodeId;
    this.updateSelection();
  }

  private clearActiveTargetSelection(): void {
    if (this.activeTargetNodeId === null) {
      return;
    }
    this.activeTargetNodeId = null;
    this.updateSelection();
  }

  private syncSceneContent(): void {
    try {
      const activeSceneId = appState.scenes.activeSceneId;

      if (!this.scene || !activeSceneId) {
        return;
      }

      const sceneGraph = this.sceneManager.getSceneGraph(activeSceneId);
      if (!sceneGraph) {
        return;
      }

      // Stop all preview animations and clean up mixers before rebuilding
      for (const action of this.previewAnimationActions.values()) {
        action.stop();
      }
      this.previewAnimationActions.clear();
      for (const mixer of this.animationMixers.values()) {
        mixer.stopAllAction();
      }
      this.animationMixers.clear();

      // Clean up previous 2D visuals
      for (const visual of this.group2DVisuals.values()) {
        if (visual.parent) {
          visual.parent.remove(visual);
        }
        this.disposeObject3D(visual);
      }
      this.group2DVisuals.clear();

      for (const visual of this.animatedSprite2DVisuals.values()) {
        if (visual.parent) {
          visual.parent.remove(visual);
        }
        this.disposeAnimatedSprite2DTexture(visual);
        this.disposeObject3D(visual);
      }
      this.animatedSprite2DVisuals.clear();

      for (const visual of this.sprite2DVisuals.values()) {
        if (visual.parent) {
          visual.parent.remove(visual);
        }
        this.disposeObject3D(visual);
      }
      this.sprite2DVisuals.clear();
      this.sprite3DTexturePaths.clear();
      this.particles3DTexturePaths.clear();

      for (const visual of this.uiControl2DVisuals.values()) {
        if (visual.parent) {
          visual.parent.remove(visual);
        }
        this.disposeObject3D(visual);
      }
      this.uiControl2DVisuals.clear();
      this.clearNodeIcons();

      // Remove all root nodes from scene (except lights and helpers)
      const objectsToRemove: THREE.Object3D[] = [];
      this.scene.children.forEach(child => {
        // Keep lights and grid
        if (!(child instanceof THREE.Light) && !(child instanceof THREE.GridHelper)) {
          objectsToRemove.push(child);
        }
      });

      objectsToRemove.forEach(obj => this.scene!.remove(obj));

      // Add scene graph root nodes and create visual representations for 2D nodes
      sceneGraph.rootNodes.forEach(node => {
        this.processNodeForRendering(node);
      });
      this.syncLighting();
      this.syncBaseViewportFrame();
      this.buildNodeIcons(sceneGraph.rootNodes);

      this.updateSelection();

      // Restore zoom for 2D mode
      if (appState.ui.navigationMode === '2d') {
        this.restoreZoomFromState();
      }
    } catch (err) {
      console.error('[ViewportRenderer] Error syncing scene content:', err);
    }
  }

  private refreshSceneNodeData(): void {
    const sceneGraph = this.sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      return;
    }

    const visit = (nodes: NodeBase[]) => {
      for (const node of nodes) {
        this.updateNodeTransform(node);
        if (node.children.length > 0) {
          visit(node.children);
        }
      }
    };

    visit(sceneGraph.rootNodes);
    this.updateNodeIconPositions();
    this.updateNodeIconVisibility();
  }

  /**
   * Process a node and its children for rendering.
   * Creates visual representations for Group2D, AnimatedSprite2D, and Sprite2D nodes.
   */
  private processNodeForRendering(node: NodeBase, parent2DVisualRoot?: THREE.Object3D): void {
    if (!this.scene) return;

    // Add 3D nodes to the scene with layer 0
    if (node instanceof Node3D && !node.parent) {
      this.scene.add(node);
      node.layers.set(LAYER_3D); // 3D nodes use layer 0
    }

    // Create AnimationMixer for MeshInstance nodes that have animations
    if (node instanceof MeshInstance && node.animations.length > 0) {
      if (!this.animationMixers.has(node.nodeId)) {
        const mixer = new THREE.AnimationMixer(node);
        this.animationMixers.set(node.nodeId, mixer);
      }
    }

    if (node instanceof Sprite3D) {
      this.syncSprite3DTexture(node);
    }

    if (node instanceof Particles3D) {
      this.syncParticles3DTexture(node);
    }

    let current2DVisualRoot = parent2DVisualRoot;

    if (node instanceof Group2D) {
      const visualRoot = this.createGroup2DVisual(node);
      this.group2DVisuals.set(node.nodeId, visualRoot);

      const parent = parent2DVisualRoot ?? this.scene;
      parent.add(visualRoot);
      current2DVisualRoot = visualRoot;
    } else if (node instanceof AnimatedSprite2D) {
      const visualRoot = this.createAnimatedSprite2DVisual(node);
      this.animatedSprite2DVisuals.set(node.nodeId, visualRoot);

      const parent = parent2DVisualRoot ?? this.scene;
      parent.add(visualRoot);
      current2DVisualRoot = visualRoot;
    } else if (node instanceof Sprite2D) {
      const visualRoot = this.createSprite2DVisual(node);
      this.sprite2DVisuals.set(node.nodeId, visualRoot);

      const parent = parent2DVisualRoot ?? this.scene;
      parent.add(visualRoot);
      current2DVisualRoot = visualRoot;
    } else if (node instanceof UIControl2D) {
      const visualRoot = this.createUIControl2DVisual(node);
      this.uiControl2DVisuals.set(node.nodeId, visualRoot);

      const parent = parent2DVisualRoot ?? this.scene;
      parent.add(visualRoot);
      current2DVisualRoot = visualRoot;
    }

    for (const child of node.children) {
      this.processNodeForRendering(child, current2DVisualRoot);
    }
  }

  /**
   * Create a rectangle outline visual representation for a Group2D node.
   */
  private createGroup2DVisual(node: Group2D): THREE.Group {
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

    // Create four border lines as actual meshes with thickness.
    // Border mesh lives in normalized space (sizeGroup scales to node width/height),
    // so convert world-pixel thickness into normalized local units.
    const thickness = this.getFrameThicknessWorldPx(1);
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

  private clearNodeIcons(): void {
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

  private buildNodeIcons(nodes: NodeBase[]): void {
    if (!this.scene) {
      return;
    }

    this.ensureNodeIconTextures();

    const addIconForNode = (node: NodeBase) => {
      if (!(node instanceof Node3D)) {
        return;
      }

      const isCamera = node instanceof Camera3D;
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
      this.scene?.add(icon);
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

  private updateNodeIconPositions(): void {
    const sceneGraph = this.sceneManager.getActiveSceneGraph();
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

  private updateNodeIconVisibility(): void {
    const sceneGraph = this.sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      return;
    }

    const selectedNodeIds = new Set(appState.selection.nodeIds);
    for (const [nodeId, icon] of this.nodeIcons.entries()) {
      const node = sceneGraph.nodeMap.get(nodeId);
      const isSelected = selectedNodeIds.has(nodeId);
      const keepVisibleWhenSelected =
        node instanceof Node3D && this.shouldKeepSelectedNodeIcon(node);
      const shouldShow =
        appState.ui.showLayer3D &&
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

  private createNodeGizmo(node: Node3D): THREE.Object3D | null {
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

  private createTargetGizmo(node: Node3D): THREE.Object3D | null {
    if (node instanceof Camera3D) {
      return this.createCameraTargetGizmo(node);
    } else if (node instanceof DirectionalLightNode) {
      return this.createDirectionalLightTargetGizmo(node);
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

  private createDirectionalLightTargetGizmo(node: DirectionalLightNode): THREE.Object3D {
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
    let cameraNode: Camera3D | DirectionalLightNode | null = null;
    if (node instanceof Camera3D) {
      cameraNode = node;
    } else if (node instanceof DirectionalLightNode) {
      cameraNode = node;
    }
    if (!cameraNode) return;

    let targetPos = cameraNode.getTargetPosition();
    if (
      this.activeTargetDragNodeId === node.nodeId &&
      this.transformControls?.object &&
      this.getTargetNodeForObject(this.transformControls.object)?.nodeId === node.nodeId
    ) {
      targetPos = this.transformControls.object.getWorldPosition(new THREE.Vector3());
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

  private getTargetSphere(nodeId: string): THREE.Object3D | null {
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

  private getTargetNodeForObject(object: THREE.Object3D): Camera3D | DirectionalLightNode | null {
    const parentNodeId = object.userData.parentNodeId;
    if (typeof parentNodeId !== 'string') {
      return null;
    }

    const sceneGraph = this.sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      return null;
    }

    const node = sceneGraph.nodeMap.get(parentNodeId);
    if (node instanceof Camera3D || node instanceof DirectionalLightNode) {
      return node;
    }
    return null;
  }

  private updateTargetGizmoSelectionState(gizmo: THREE.Object3D, nodeId: string): void {
    const isActive = this.activeTargetNodeId === nodeId;
    gizmo.traverse(child => {
      if (child.userData.isTargetOutline) {
        child.visible = isActive;
      }
    });
  }

  /**
   * Create a visual representation for an AnimatedSprite2D node.
   */
  private createAnimatedSprite2DVisual(node: AnimatedSprite2D): THREE.Group {
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.computeBoundingBox();

    const material = new THREE.MeshBasicMaterial({
      color: node.color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 1,
    });
    material.userData.baseOpacity = 1;

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
  private createSprite2DVisual(node: Sprite2D): THREE.Group {
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
    });
    material.userData.baseOpacity = 1;
    this.applyTextureToSprite2DMaterial(node, material);

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
    root.userData.texturePath = node.texturePath ?? null;
    this.apply2DVisualOpacity(node, root);

    return root;
  }

  private createSprite2DAnchorMarker(_node: Sprite2D, width: number, height: number): THREE.Group {
    const marker = new THREE.Group();
    marker.position.set(0, 0, 0.01);
    marker.layers.set(LAYER_2D);
    marker.renderOrder = 420;
    marker.userData.isSprite2DAnchorMarker = true;

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
        color: 0xffcf33,
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
      this.getFrameThicknessWorldPx(this.orthographicCamera?.zoom ?? 1)
    );

    return marker;
  }

  private updateSprite2DAnchorMarker(
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

  private getSprite2DAnchor(node: Sprite2D): { x: number; y: number } {
    const rawAnchor = (node as unknown as { anchor?: { x?: number; y?: number } }).anchor;
    const x = Number(rawAnchor?.x);
    const y = Number(rawAnchor?.y);
    return {
      x: Number.isFinite(x) ? x : 0.5,
      y: Number.isFinite(y) ? y : 0.5,
    };
  }

  private applySrgbColorSpace(texture: THREE.Texture): void {
    texture.colorSpace = THREE.SRGBColorSpace;
  }

  private applyTextureToSprite2DMaterial(node: Sprite2D, material: THREE.MeshBasicMaterial): void {
    const texturePath = node.texturePath;
    if (!texturePath) {
      return;
    }

    const textureLoader = new THREE.TextureLoader();

    void (async () => {
      try {
        const blob = await this.resourceManager.readBlob(texturePath);
        const blobUrl = URL.createObjectURL(blob);

        textureLoader.load(
          blobUrl,
          texture => {
            try {
              this.applySrgbColorSpace(texture);
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
            this.applySrgbColorSpace(texture);
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

  private syncAnimatedSprite2DVisual(node: AnimatedSprite2D, visualRoot: THREE.Group): void {
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
        parseAnimationResourceText(await this.resourceManager.readText(animationResourcePath));

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
      const blob = await this.resourceManager.readBlob(texturePath);
      const blobUrl = URL.createObjectURL(blob);

      return await new Promise(resolve => {
        textureLoader.load(
          blobUrl,
          texture => {
            try {
              this.applySrgbColorSpace(texture);
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
          this.applySrgbColorSpace(texture);
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

  private syncAnimatedSprite2DVisuals(): void {
    const sceneGraph = this.sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      return;
    }

    const visit = (nodes: NodeBase[]) => {
      for (const node of nodes) {
        if (node instanceof AnimatedSprite2D) {
          this.updateNodeTransform(node);
        }

        if (node.children.length > 0) {
          visit(node.children);
        }
      }
    };

    visit(sceneGraph.rootNodes);
  }

  private disposeAnimatedSprite2DTexture(visualRoot: THREE.Object3D): void {
    const texture = (visualRoot.userData.animationTexture as THREE.Texture | null) ?? null;
    if (texture) {
      texture.dispose();
    }

    visualRoot.userData.animationTexture = null;
    visualRoot.userData.animationTexturePath = null;
  }

  private syncSprite3DBillboarding(camera: THREE.Camera): void {
    const sceneGraph = this.sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      return;
    }

    const cameraQuaternion = camera.getWorldQuaternion(new THREE.Quaternion());
    const visit = (nodes: NodeBase[]) => {
      for (const node of nodes) {
        if (node instanceof Sprite3D) {
          node.applyBillboard(cameraQuaternion);
        } else if (node instanceof Particles3D) {
          node.applyBillboard(cameraQuaternion);
        }
        if (node.children.length > 0) {
          visit(node.children);
        }
      }
    };

    visit(sceneGraph.rootNodes);
  }

  private tickParticlePreview(dt: number): void {
    if (dt <= 0 || appState.ui.isPlaying) {
      return;
    }

    const sceneGraph = this.sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      return;
    }

    const visit = (nodes: NodeBase[]) => {
      for (const node of nodes) {
        if (node instanceof Particles3D && node.preview) {
          node.tick(dt);
        }

        if (node.children.length > 0) {
          visit(node.children);
        }
      }
    };

    visit(sceneGraph.rootNodes);
  }

  private tickComponentPreview(dt: number): void {
    if (dt <= 0 || appState.ui.isPlaying) {
      return;
    }

    const sceneGraph = this.sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      return;
    }

    const previewContext: EditorPreviewContext = {
      assetLoader: this.assetLoader,
      requestRender: () => {
        queueMicrotask(() => this.requestRender());
      },
    };

    const visit = (nodes: NodeBase[]) => {
      for (const node of nodes) {
        if (node.components && Array.isArray(node.components)) {
          for (const component of node.components) {
            this.tickPreviewComponent(component, dt, previewContext);
          }
        }

        if (node.children && node.children.length > 0) {
          visit(node.children);
        }
      }
    };

    visit(sceneGraph.rootNodes);
  }

  private tickPreviewComponent(
    component: ScriptComponent,
    dt: number,
    context: EditorPreviewContext
  ): void {
    if (!component.enabled || !component.tickEditorPreview) {
      return;
    }

    component.tickEditorPreview(dt, context);
  }

  private syncSprite3DTexture(node: Sprite3D): void {
    const currentTexturePath = node.texturePath ?? null;
    const previousTexturePath = this.sprite3DTexturePaths.get(node.nodeId) ?? null;
    if (currentTexturePath === previousTexturePath) {
      return;
    }

    this.sprite3DTexturePaths.set(node.nodeId, currentTexturePath);
    if (!currentTexturePath) {
      node.clearTexture();
      return;
    }

    const textureLoader = new THREE.TextureLoader();
    void (async () => {
      try {
        const blob = await this.resourceManager.readBlob(currentTexturePath);
        const blobUrl = URL.createObjectURL(blob);
        textureLoader.load(
          blobUrl,
          texture => {
            try {
              node.setTexture(texture);
            } finally {
              URL.revokeObjectURL(blobUrl);
            }
          },
          undefined,
          () => {
            URL.revokeObjectURL(blobUrl);
          }
        );
        return;
      } catch {
        const schemeMatch = /^([a-z]+[a-z0-9+.-]*):\/\//i.exec(currentTexturePath);
        const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : '';
        if (scheme === 'http' || scheme === 'https' || scheme === '') {
          const texture = textureLoader.load(currentTexturePath, undefined, undefined, () => {
            console.warn('[ViewportRenderer] Failed to load Sprite3D texture', currentTexturePath);
          });
          node.setTexture(texture);
          return;
        }
      }

      console.warn(
        '[ViewportRenderer] Skipping Sprite3D texture load for scheme',
        currentTexturePath
      );
    })();
  }

  private syncParticles3DTexture(node: Particles3D): void {
    const currentTexturePath = node.texturePath ?? null;
    const previousTexturePath = this.particles3DTexturePaths.get(node.nodeId) ?? null;
    if (currentTexturePath === previousTexturePath) {
      return;
    }

    this.particles3DTexturePaths.set(node.nodeId, currentTexturePath);
    if (!currentTexturePath) {
      node.clearTexture();
      return;
    }

    const textureLoader = new THREE.TextureLoader();
    void (async () => {
      try {
        const blob = await this.resourceManager.readBlob(currentTexturePath);
        const blobUrl = URL.createObjectURL(blob);
        textureLoader.load(
          blobUrl,
          texture => {
            try {
              node.setTexture(texture);
            } finally {
              URL.revokeObjectURL(blobUrl);
            }
          },
          undefined,
          () => {
            URL.revokeObjectURL(blobUrl);
          }
        );
        return;
      } catch {
        const schemeMatch = /^([a-z]+[a-z0-9+.-]*):\/\//i.exec(currentTexturePath);
        const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : '';
        if (scheme === 'http' || scheme === 'https' || scheme === '') {
          const texture = textureLoader.load(currentTexturePath, undefined, undefined, () => {
            console.warn(
              '[ViewportRenderer] Failed to load Particles3D texture',
              currentTexturePath
            );
          });
          node.setTexture(texture);
          return;
        }
      }

      console.warn(
        '[ViewportRenderer] Skipping Particles3D texture load for scheme',
        currentTexturePath
      );
    })();
  }

  private createUIControl2DVisual(node: UIControl2D): THREE.Group {
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

    if (node.label.trim().length > 0) {
      const labelMesh = this.createUIControlLabelMesh(node);
      root.add(labelMesh);
    }

    root.userData.isUIControl2DVisualRoot = true;
    root.userData.nodeId = node.nodeId;
    root.userData.sizeGroup = sizeGroup;
    root.userData.controlMesh = mesh;
    root.userData.texturePath =
      (node as UIControl2D & { texturePath?: string | null }).texturePath ?? null;
    this.apply2DVisualOpacity(node, root);

    return root;
  }

  private getUIControlDimensions(node: UIControl2D): { width: number; height: number } {
    if (node instanceof Button2D) {
      return { width: node.width, height: node.height };
    }

    if (node instanceof Label2D) {
      const fontSize = Math.max(8, node.labelFontSize || 16);
      const textLength = Math.max(1, node.label.length);
      return {
        width: Math.max(48, textLength * fontSize * 0.7),
        height: Math.max(24, fontSize * 1.8),
      };
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

  private getUIControlDefaultColor(node: UIControl2D): number {
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

  private applyTextureTo2DMaterial(node: UIControl2D, material: THREE.MeshBasicMaterial): void {
    const texturePath = (node as UIControl2D & { texturePath?: string | null }).texturePath;
    if (!texturePath) {
      return;
    }

    const textureLoader = new THREE.TextureLoader();

    (async () => {
      try {
        const blob = await this.resourceManager.readBlob(texturePath);
        const blobUrl = URL.createObjectURL(blob);

        textureLoader.load(
          blobUrl,
          texture => {
            try {
              this.applySrgbColorSpace(texture);
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
            this.applySrgbColorSpace(texture);
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

  private createUIControlLabelMesh(node: UIControl2D): THREE.Mesh {
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
    const measured = measureCtx.measureText(node.label || ' ');
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

    ctx.fillText(node.label, x, logicalHeight / 2);

    const texture = new THREE.CanvasTexture(canvas);
    this.applySrgbColorSpace(texture);
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
    mesh.layers.set(LAYER_2D);
    return mesh;
  }

  private updateUIControlLabelVisual(visualRoot: THREE.Group, node: UIControl2D): void {
    const existingLabel = visualRoot.children.find(child =>
      Boolean((child as THREE.Object3D).userData?.isUIControlLabel)
    );

    if (node.label.trim().length === 0) {
      if (existingLabel) {
        visualRoot.remove(existingLabel);
        this.disposeObject3D(existingLabel);
      }
      return;
    }

    if (existingLabel) {
      visualRoot.remove(existingLabel);
      this.disposeObject3D(existingLabel);
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

  private apply2DVisualOpacity(node: Node2D, visualRoot: THREE.Object3D): void {
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

  private findNodeById(nodeId: string, nodes: NodeBase[]): NodeBase | null {
    for (const node of nodes) {
      if (node.nodeId === nodeId) {
        return node;
      }
      const found = this.findNodeById(nodeId, node.children);
      if (found) {
        return found;
      }
    }
    return null;
  }

  private updateSelectionBoxes(): void {
    const sceneGraph = this.sceneManager.getActiveSceneGraph();
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

  private clear2DSelectionOverlay(): void {
    if (!this.selection2DOverlay || !this.scene) {
      this.selection2DOverlay = undefined;
      return;
    }

    const { group } = this.selection2DOverlay;
    this.scene.remove(group);
    group.traverse(obj => {
      if (
        obj instanceof THREE.Mesh ||
        obj instanceof THREE.LineSegments ||
        obj instanceof THREE.Line
      ) {
        obj.geometry?.dispose();
        if (obj.material instanceof THREE.Material) {
          obj.material.dispose();
        }
      }
    });
    this.selection2DOverlay = undefined;
    this.active2DTransform = undefined;
    this.end2DInteraction();
    console.debug('[ViewportRenderer] cleared 2D overlay');
  }

  /**
   * Get bounds for a single 2D node, NOT including its descendants.
   * Uses the node's own size/transform rather than recursively computing from children.
   */
  private getNodeOnlyBounds(node: Node2D): THREE.Box3 {
    const bounds = new THREE.Box3();

    // Get world transform
    node.updateWorldMatrix(true, false);
    const worldMatrix = node.matrixWorld;

    let corners: THREE.Vector3[];

    if (node instanceof Sprite2D) {
      // Account for sprite anchor offset: the visual mesh is shifted from the
      // node origin by (0.5 - anchor) * size.  In node-local space the sprite
      // occupies  [-ax*w .. (1-ax)*w]  x  [-ay*h .. (1-ay)*h].
      const w = node.width ?? 64;
      const h = node.height ?? 64;
      const ax = node.anchor?.x ?? 0.5;
      const ay = node.anchor?.y ?? 0.5;
      corners = [
        new THREE.Vector3(-ax * w, -ay * h, 0),
        new THREE.Vector3((1 - ax) * w, -ay * h, 0),
        new THREE.Vector3((1 - ax) * w, (1 - ay) * h, 0),
        new THREE.Vector3(-ax * w, (1 - ay) * h, 0),
      ];
    } else if (node instanceof AnimatedSprite2D) {
      const halfWidth = (node.width ?? 64) / 2;
      const halfHeight = (node.height ?? 64) / 2;
      corners = [
        new THREE.Vector3(-halfWidth, -halfHeight, 0),
        new THREE.Vector3(halfWidth, -halfHeight, 0),
        new THREE.Vector3(halfWidth, halfHeight, 0),
        new THREE.Vector3(-halfWidth, halfHeight, 0),
      ];
    } else {
      // Determine node size for other node types (center-origin)
      let halfWidth = 50; // Default
      let halfHeight = 50;

      if (node instanceof Group2D) {
        halfWidth = node.width / 2;
        halfHeight = node.height / 2;
      } else if (node instanceof UIControl2D) {
        const { width, height } = this.getUIControlDimensions(node);
        halfWidth = width / 2;
        halfHeight = height / 2;
      }

      corners = [
        new THREE.Vector3(-halfWidth, -halfHeight, 0),
        new THREE.Vector3(halfWidth, -halfHeight, 0),
        new THREE.Vector3(halfWidth, halfHeight, 0),
        new THREE.Vector3(-halfWidth, halfHeight, 0),
      ];
    }

    // Transform corners to world space and expand bounds
    for (const corner of corners) {
      corner.applyMatrix4(worldMatrix);
      bounds.expandByPoint(corner);
    }

    return bounds;
  }

  private update2DSelectionOverlayForNodes(nodeIds: string[]): void {
    // Don't recreate overlay during an active 2D transform - use refreshGizmoPositions instead
    if (this.active2DTransform) {
      this.refreshGizmoPositions();
      return;
    }

    if (!this.scene || !this.orthographicCamera) {
      return;
    }

    const activeSceneId = appState.scenes.activeSceneId;
    if (!activeSceneId) {
      this.clear2DSelectionOverlay();
      return;
    }

    const sceneGraph = this.sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      this.clear2DSelectionOverlay();
      return;
    }

    const node2DIds: string[] = [];
    const combinedBounds = new THREE.Box3();

    for (const nodeId of nodeIds) {
      const node = sceneGraph.nodeMap.get(nodeId);
      if (!node || !(node instanceof Node2D)) {
        console.debug('[ViewportRenderer] update2DOverlay: node not Node2D', nodeId);
        continue;
      }

      if (!this.isVisibleInHierarchy(node)) {
        continue;
      }

      const visual = this.get2DVisual(node);
      if (!visual) {
        console.debug('[ViewportRenderer] update2DOverlay: no visual for', nodeId);
        continue;
      }

      // Use node-only bounds (not including descendants)
      const nodeBounds = this.getNodeOnlyBounds(node);
      console.debug('[ViewportRenderer] update2DOverlay: nodeBounds', nodeId, nodeBounds);
      combinedBounds.union(nodeBounds);
      node2DIds.push(nodeId);
    }

    if (node2DIds.length === 0 || combinedBounds.isEmpty()) {
      console.debug('[ViewportRenderer] update2DOverlay: no valid 2D nodes or empty bounds');
      this.clear2DSelectionOverlay();
      return;
    }

    const center = combinedBounds.getCenter(new THREE.Vector3());
    console.debug('[ViewportRenderer] update2DOverlay: creating overlay', {
      node2DIds,
      center,
      combinedBounds,
    });

    this.clear2DSelectionOverlay();

    const frame = this.create2DFrame(combinedBounds);
    const handles = this.create2DHandles(combinedBounds);
    const group = new THREE.Group();
    group.add(frame, ...handles);
    group.renderOrder = 1000;
    group.layers.set(1);
    this.scene.add(group);

    this.selection2DOverlay = {
      group,
      handles,
      frame,
      nodeIds: node2DIds,
      combinedBounds,
      centerWorld: center,
      rotationHandle: handles.find(h => h.userData?.handleType === 'rotate'),
    };

    // Apply zoom compensation immediately so handles have the correct screen-space size.
    this.refreshGizmoPositions();
  }

  private refreshGizmoPositions(): void {
    if (!this.selection2DOverlay || !this.scene) return;

    const activeSceneId = appState.scenes.activeSceneId;
    if (!activeSceneId) return;

    const sceneGraph = this.sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) return;

    const combinedBounds = new THREE.Box3();
    for (const nodeId of this.selection2DOverlay.nodeIds) {
      const node = sceneGraph.nodeMap.get(nodeId);
      if (!node || !(node instanceof Node2D)) continue;
      if (!this.isVisibleInHierarchy(node)) {
        continue;
      }
      // Use node-only bounds (not including descendants)
      const nodeBounds = this.getNodeOnlyBounds(node);
      combinedBounds.union(nodeBounds);
    }

    if (combinedBounds.isEmpty()) {
      this.clear2DSelectionOverlay();
      return;
    }

    const center = combinedBounds.getCenter(new THREE.Vector3());
    this.selection2DOverlay.combinedBounds.copy(combinedBounds);
    this.selection2DOverlay.centerWorld.copy(center);
    this.sync2DServiceFrameThickness();
  }

  private create2DFrame(bounds: THREE.Box3): THREE.Group {
    return this.transformTool2d.createFrame(bounds);
  }

  private create2DHandles(bounds: THREE.Box3): THREE.Object3D[] {
    return this.transformTool2d.createHandles(bounds);
  }

  get2DHandleAt(screenX: number, screenY: number): TwoDHandle {
    if (!this.selection2DOverlay || !this.orthographicCamera) {
      return 'idle';
    }

    return this.transformTool2d.getHandleAt(
      screenX,
      screenY,
      this.selection2DOverlay,
      this.orthographicCamera,
      this.viewportSize
    );
  }

  has2DTransform(): boolean {
    return this.active2DTransform !== undefined;
  }

  /**
   * Update handle hover state for visual feedback.
   * Returns true if hover state changed (requires re-render).
   */
  updateHandleHover(screenX: number, screenY: number): boolean {
    return this.transformTool2d.updateHover(
      screenX,
      screenY,
      this.selection2DOverlay,
      this.orthographicCamera,
      this.viewportSize
    );
  }

  /**
   * Clear handle hover state (e.g., when cursor leaves viewport)
   */
  clearHandleHover(): boolean {
    return this.transformTool2d.clearHover(this.selection2DOverlay);
  }

  /**
   * Update 2D hover preview frame based on pointer position.
   * Shows a preview frame around the 2D node under the cursor.
   * Group2D nodes show in a different color.
   * Returns true if the hover state changed.
   */
  update2DHoverPreview(screenX: number, screenY: number): boolean {
    // Don't show hover preview during active transform or if selection overlay is being interacted with
    if (this.active2DTransform) {
      return this.clear2DHoverPreview();
    }

    // Don't show preview if pointer is over selection handles
    const handleType = this.get2DHandleAt(screenX, screenY);
    if (handleType !== 'idle') {
      return this.clear2DHoverPreview();
    }

    // Raycast to find 2D node under pointer
    const hit = this.raycast2D(screenX, screenY);

    // If no hit or same node, check if we should clear
    if (!hit) {
      return this.clear2DHoverPreview();
    }

    // Check if this node is already selected (don't show preview for selected nodes)
    const selectedNodeIds = appState.selection.nodeIds;
    if (selectedNodeIds.includes(hit.nodeId)) {
      return this.clear2DHoverPreview();
    }

    // If same node, no change needed
    if (this.hoverPreview2D?.nodeId === hit.nodeId) {
      return false;
    }

    // Clear previous preview
    this.clear2DHoverPreview();

    // Create new preview frame for this node
    if (hit instanceof Node2D && this.scene) {
      const bounds = this.getNodeOnlyBounds(hit);
      const isGroup2D = hit instanceof Group2D;

      // Create preview frame with different color for Group2D
      const previewColor = isGroup2D ? 0x4ecf4e : 0xffffff; // Green for Group2D, white for others
      const frame = this.create2DHoverPreviewFrame(bounds, previewColor);

      this.scene.add(frame);
      this.hoverPreview2D = { nodeId: hit.nodeId, frame };
      return true;
    }

    return false;
  }

  /**
   * Clear the 2D hover preview frame.
   * Returns true if there was a preview to clear.
   */
  clear2DHoverPreview(): boolean {
    if (!this.hoverPreview2D) {
      return false;
    }

    if (this.scene && this.hoverPreview2D.frame) {
      this.scene.remove(this.hoverPreview2D.frame);
      // Dispose all geometries and materials in the group
      this.hoverPreview2D.frame.traverse(obj => {
        if (obj instanceof THREE.Mesh && obj.geometry) {
          obj.geometry.dispose();
          if (obj.material instanceof THREE.Material) {
            obj.material.dispose();
          }
        }
      });
    }

    this.hoverPreview2D = undefined;
    return true;
  }

  /**
   * Create a preview frame for hovering over 2D nodes.
   */
  private create2DHoverPreviewFrame(bounds: THREE.Box3, color: number): THREE.Group {
    const min = bounds.min;
    const max = bounds.max;
    const width = max.x - min.x;
    const height = max.y - min.y;
    const centerX = (min.x + max.x) / 2;
    const centerY = (min.y + max.y) / 2;
    const z = (min.z + max.z) / 2 + 0.1; // Slightly above to prevent z-fighting

    const thickness = this.getFrameThicknessWorldPx(1);

    // Create a group to hold all border meshes
    const frame = new THREE.Group();
    frame.position.set(centerX, centerY, z);
    frame.userData.isHoverPreview = true;
    frame.userData.frameWidth = width;
    frame.userData.frameHeight = height;
    frame.renderOrder = 999; // Just below selection overlay
    frame.layers.set(LAYER_2D);

    // Top border
    const topGeometry = new THREE.PlaneGeometry(1, 1);
    const topMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.6,
      depthTest: false,
      depthWrite: false,
    });
    const topBorder = new THREE.Mesh(topGeometry, topMaterial);
    topBorder.position.set(0, height / 2 - thickness / 2, 0); // Align to top edge
    topBorder.scale.set(width, thickness, 1);
    topBorder.layers.set(LAYER_2D);
    topBorder.renderOrder = 999;
    topBorder.userData.edge = 'top';
    frame.add(topBorder);

    // Bottom border
    const bottomGeometry = new THREE.PlaneGeometry(1, 1);
    const bottomMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.6,
      depthTest: false,
      depthWrite: false,
    });
    const bottomBorder = new THREE.Mesh(bottomGeometry, bottomMaterial);
    bottomBorder.position.set(0, -height / 2 + thickness / 2, 0); // Align to bottom edge
    bottomBorder.scale.set(width, thickness, 1);
    bottomBorder.layers.set(LAYER_2D);
    bottomBorder.renderOrder = 999;
    bottomBorder.userData.edge = 'bottom';
    frame.add(bottomBorder);

    // Left border
    const leftGeometry = new THREE.PlaneGeometry(1, 1);
    const leftMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.6,
      depthTest: false,
      depthWrite: false,
    });
    const leftBorder = new THREE.Mesh(leftGeometry, leftMaterial);
    leftBorder.position.set(-width / 2 + thickness / 2, 0, 0); // Align to left edge
    leftBorder.scale.set(thickness, height, 1);
    leftBorder.layers.set(LAYER_2D);
    leftBorder.renderOrder = 999;
    leftBorder.userData.edge = 'left';
    frame.add(leftBorder);

    // Right border
    const rightGeometry = new THREE.PlaneGeometry(1, 1);
    const rightMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.6,
      depthTest: false,
      depthWrite: false,
    });
    const rightBorder = new THREE.Mesh(rightGeometry, rightMaterial);
    rightBorder.position.set(width / 2 - thickness / 2, 0, 0); // Align to right edge
    rightBorder.scale.set(thickness, height, 1);
    rightBorder.layers.set(LAYER_2D);
    rightBorder.renderOrder = 999;
    rightBorder.userData.edge = 'right';
    frame.add(rightBorder);

    return frame;
  }

  start2DTransform(screenX: number, screenY: number, handle: TwoDHandle): void {
    if (!this.selection2DOverlay || !this.orthographicCamera) {
      return;
    }

    const activeSceneId = appState.scenes.activeSceneId;
    if (!activeSceneId) return;
    const sceneGraph = this.sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) return;

    const transform = this.transformTool2d.startTransform(
      screenX,
      screenY,
      handle,
      this.selection2DOverlay,
      sceneGraph,
      this.orthographicCamera,
      this.viewportSize
    );

    if (transform) {
      this.active2DTransform = transform;
      // Set active handle for visual feedback (accent color during drag)
      this.transformTool2d.setActiveHandle(handle, this.selection2DOverlay);
      this.begin2DInteraction();
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
    const sceneGraph = this.sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) return;

    this.transformTool2d.updateTransform(
      screenX,
      screenY,
      this.active2DTransform,
      sceneGraph,
      this.orthographicCamera!,
      this.viewportSize,
      options
    );

    // Update visuals for each transformed node
    for (const nodeId of this.active2DTransform.nodeIds) {
      const node = sceneGraph.nodeMap.get(nodeId);
      if (node && node instanceof Node2D) {
        this.updateNodeTransform(node);
        // If resizing a Group2D, update layout for children only (do not recompute node itself)
        if (
          node instanceof Group2D &&
          this.active2DTransform.handle !== 'move' &&
          this.active2DTransform.handle !== 'rotate'
        ) {
          for (const child of node.children) {
            if (child instanceof Group2D) {
              const groupChild = child as Group2D & {
                updateLayout?: (width: number, height: number) => void;
              };
              groupChild.updateLayout?.(node.width, node.height);
            }
          }
          this.syncAll2DVisuals();
        }
      }
    }
  }

  async complete2DTransform(): Promise<void> {
    if (!this.active2DTransform) {
      return;
    }

    const { nodeIds, startStates } = this.active2DTransform;
    const sceneGraph = this.sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      this.active2DTransform = undefined;
      this.end2DInteraction();
      return;
    }

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

      const currentState: Transform2DState = {
        position: { x: node.position.x, y: node.position.y },
        rotation: MathUtils.radToDeg(node.rotation.z),
        scale: { x: node.scale.x, y: node.scale.y },
        ...(typeof (node as unknown as { width?: number }).width === 'number'
          ? { width: (node as unknown as { width?: number }).width }
          : {}),
        ...(typeof (node as unknown as { height?: number }).height === 'number'
          ? { height: (node as unknown as { height?: number }).height }
          : {}),
      };

      const op = new Transform2DCompleteOperation({
        nodeId,
        previousState,
        currentState,
      });

      await this.operationService.invokeAndPush(op);
    }

    const savedNodeIds = [...nodeIds];
    // Clear active handle visual feedback before clearing the transform
    this.transformTool2d.clearActiveHandle(this.selection2DOverlay);
    this.active2DTransform = undefined;
    this.end2DInteraction();
    this.update2DSelectionOverlayForNodes(savedNodeIds);
    console.debug('[ViewportRenderer] complete 2D transform', { nodeIds });
  }

  private toNdc(screenX: number, screenY: number): THREE.Vector2 | null {
    const { width, height } = this.viewportSize;
    if (width <= 0 || height <= 0) return null;
    return new THREE.Vector2((screenX / width) * 2 - 1, -(screenY / height) * 2 + 1);
  }

  private screenToWorld2D(screenX: number, screenY: number): THREE.Vector3 | null {
    if (!this.orthographicCamera) {
      return null;
    }

    const ndc = this.toNdc(screenX, screenY);
    if (!ndc) {
      return null;
    }

    return new THREE.Vector3(ndc.x, ndc.y, 0).unproject(this.orthographicCamera);
  }

  private get2DVisual(node: Node2D): THREE.Object3D | undefined {
    if (node instanceof Group2D) {
      return this.group2DVisuals.get(node.nodeId);
    }
    if (node instanceof AnimatedSprite2D) {
      return this.animatedSprite2DVisuals.get(node.nodeId);
    }
    if (node instanceof Sprite2D) {
      return this.sprite2DVisuals.get(node.nodeId);
    }
    if (node instanceof UIControl2D) {
      return this.uiControl2DVisuals.get(node.nodeId);
    }
    return undefined;
  }

  private startRenderLoop(): void {
    const render = () => {
      if (this.isPaused) {
        this.animationId = undefined;
        return;
      }

      if (this.shouldPauseForWindowFocus()) {
        this.animationId = undefined;
        return;
      }

      this.animationId = requestAnimationFrame(render);
      this.requestRender();
    };

    this.isPaused = false;
    render();
  }

  private shouldPauseForWindowFocus(): boolean {
    if (!appState.ui.pauseRenderingOnUnfocus || this.isWindowFocused) {
      return false;
    }

    // Keep collaborative cloud documents visually live even when the browser
    // window is not focused, so remote CRDT updates appear immediately.
    return appState.collaboration.accessMode === 'local';
  }

  private captureTransformStartState(obj: THREE.Object3D): void {
    const targetNode = this.getTargetNodeForObject(obj);
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

  private updateTargetTransformFromControl(): void {
    const transformedObject = this.transformControls?.object;
    if (!transformedObject) {
      return;
    }

    const targetNode = this.getTargetNodeForObject(transformedObject);
    if (!targetNode) {
      return;
    }

    const targetPosition = transformedObject.getWorldPosition(new THREE.Vector3());
    targetNode.setTargetPosition(targetPosition);
  }

  private async handleTransformCompleted(): Promise<void> {
    const transformedObject = this.transformControls?.object;
    if (!transformedObject) {
      this.transformStartStates.clear();
      this.targetTransformStartStates.clear();
      this.activeTargetDragNodeId = null;
      return;
    }

    const targetNode = this.getTargetNodeForObject(transformedObject);
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

        await this.operationService.invokeAndPush(operation);
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

      await this.operationService.invokeAndPush(operation);
    } catch (error) {
      console.error('[ViewportRenderer] Error handling transform completion:', error);
    } finally {
      this.transformStartStates.clear();
      this.targetTransformStartStates.clear();
      this.activeTargetDragNodeId = null;
    }
  }

  dispose(): void {
    // Cancel animation loop
    if (this.animationId !== undefined) {
      cancelAnimationFrame(this.animationId);
    }

    // Cancel pan momentum animation
    this.cancelPanMomentum();

    // Stop and dispose animation mixers
    for (const action of this.previewAnimationActions.values()) {
      action.stop();
    }
    this.previewAnimationActions.clear();
    for (const mixer of this.animationMixers.values()) {
      mixer.stopAllAction();
    }
    this.animationMixers.clear();

    // Dispose orbit controls
    this.orbitControls?.dispose();

    // Dispose transform controls
    this.transformControls?.dispose();

    // Dispose Three.js resources
    this.selectionBoxes.forEach(box => {
      box.geometry.dispose();
      if (box.material instanceof THREE.Material) {
        box.material.dispose();
      }
    });
    this.selectionBoxes.clear();

    for (const visual of this.group2DVisuals.values()) {
      this.disposeObject3D(visual);
    }
    this.group2DVisuals.clear();

    for (const visual of this.animatedSprite2DVisuals.values()) {
      this.disposeAnimatedSprite2DTexture(visual);
      this.disposeObject3D(visual);
    }
    this.animatedSprite2DVisuals.clear();

    for (const visual of this.sprite2DVisuals.values()) {
      this.disposeObject3D(visual);
    }
    this.sprite2DVisuals.clear();
    this.sprite3DTexturePaths.clear();
    this.particles3DTexturePaths.clear();

    for (const visual of this.uiControl2DVisuals.values()) {
      this.disposeObject3D(visual);
    }
    this.uiControl2DVisuals.clear();
    this.clearNodeIcons();

    this.clear2DSelectionOverlay();

    for (const gizmo of this.targetGizmos.values()) {
      gizmo.traverse(child => {
        if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
          child.geometry.dispose();
          if (child.material instanceof THREE.Material) {
            child.material.dispose();
          }
        }
      });
    }
    this.targetGizmos.clear();

    if (this.scene) {
      this.scene.traverse(obj => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry?.dispose();
          if (obj.material instanceof THREE.Material) {
            obj.material.dispose();
          }
        }
      });
    }

    this.renderer?.dispose();
    this.cameraIconTexture?.dispose();
    this.lampIconTexture?.dispose();
    this.cameraIconTexture = undefined;
    this.lampIconTexture = undefined;

    // Dispose subscriptions
    this.disposers.forEach(dispose => dispose());
    this.disposers = [];

    this.renderer = undefined;
    this.scene = undefined;
    this.camera = undefined;
    this.orthographicCamera = undefined;
    this.orbitControls = undefined;
    this.transformControls = undefined;
    this.transformGizmo = undefined;
  }
}
