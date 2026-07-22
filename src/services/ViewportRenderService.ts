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
import { ViewportGpuTimer, type ViewportPerfSample } from './viewport/ViewportGpuTimer';
import { ViewportScreenshotter } from './viewport/ViewportScreenshotter';
import { ViewportSelection2DOverlayHud } from './viewport/ViewportSelection2DOverlayHud';
import { ViewportPreviewTicker } from './viewport/ViewportPreviewTicker';
import {
  Viewport2DProxyRegistry,
  configureSpriteTexture,
  getFrameThicknessWorldPx,
} from './viewport/Viewport2DProxyRegistry';
import {
  computeFallbackFramingBounds,
  computeOrtho2DFitZoom,
  computeOrtho3DFitZoom,
  computePerspectiveFitDistance,
  resolvePreservedViewDirection,
} from './viewport/viewport-framing-math';
import { AnimatedSprite2D } from '@pix3/runtime';
import { NodeBase } from '@pix3/runtime';
import { Node2D } from '@pix3/runtime';
import { Node3D } from '@pix3/runtime';
import { Group2D } from '@pix3/runtime';
import { Sprite2D } from '@pix3/runtime';
import { TiledSprite2D } from '@pix3/runtime';
import { ColorRect2D } from '@pix3/runtime';
import { UIControl2D } from '@pix3/runtime';
import { Label2D } from '@pix3/runtime';
import { DirectionalLightNode } from '@pix3/runtime';
import { PointLightNode } from '@pix3/runtime';
import { SpotLightNode } from '@pix3/runtime';
import { Camera3D } from '@pix3/runtime';
import { VirtualCamera3D } from '@pix3/runtime';
import { PostProcess, PostProcessingPipeline } from '@pix3/runtime';
import { GeometryMesh } from '@pix3/runtime';
import { isShaderEffectHost, type ShaderEffectStack } from '@pix3/runtime';
import { MeshInstance } from '@pix3/runtime';
import { Sprite3D } from '@pix3/runtime';
import { Particles3D } from '@pix3/runtime';
import { AmbientLightNode } from '@pix3/runtime';
import { HemisphereLightNode } from '@pix3/runtime';
import { AssetLoader } from '@pix3/runtime';
import type { SceneGraph } from '@pix3/runtime';
import { applyTextureRegionToTexture } from '@pix3/runtime';
import { injectable, inject } from '@/fw/di';
import { SceneManager, InputService } from '@pix3/runtime';
import { OperationService } from '@/services/OperationService';
import { ResourceManager } from '@/services/ResourceManager';
import { IconService } from '@/services/IconService';
import { appState } from '@/state';
import { subscribe } from 'valtio/vanilla';
import { resolveViewportClick } from '@/features/selection/SelectionScopeResolver';
import { type CanvasScreenshot, type CanvasScreenshotOptions } from '@/core/canvas-screenshot';
import {
  TransformCompleteOperation,
  type TransformState,
} from '@/features/properties/TransformCompleteOperation';
import type {
  Transform2DCompleteParams,
  Transform2DState,
} from '@/features/properties/Transform2DCompleteOperation';
import { Transform2DBatchOperation } from '@/features/properties/Transform2DBatchOperation';
import { Nudge2DNodesOperation } from '@/features/properties/Nudge2DNodesOperation';
import { TargetTransformOperation } from '@/features/properties/TargetTransformOperation';
import {
  deriveSceneLayerCapabilities,
  type SceneLayerCapabilities,
} from '@/features/viewport/scene-layer-capabilities';
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
/** sRGB of the canvas backdrop token oklch(0.13 0.008 250) — keep in sync with src/index.css .viewport-grid. */
const VIEWPORT_BACKGROUND_COLOR = 0x05080a;
/** sRGB of the accent token oklch(0.8 0.15 75) — keep in sync with --accent in src/index.css. */
const EDITOR_ACCENT_COLOR = 0xf5ae39;
const DEFAULT_VIEWPORT_BASE_WIDTH = 1920;
const DEFAULT_VIEWPORT_BASE_HEIGHT = 1080;
const DEFAULT_3D_CAMERA_POSITION = new THREE.Vector3(5, 5, 5);
const DEFAULT_3D_CAMERA_TARGET = new THREE.Vector3(0, 0, 0);
const DEFAULT_2D_CAMERA_Z = 100;
const DEFAULT_NODE_ICON_OPACITY = 0.95;
const SELECTED_NODE_ICON_OPACITY = 0.38;
const MIN_WORLD_BOUNDS_SIZE = 0.0001;
const TWO_D_DEFAULT_VIEW_PADDING_MULTIPLIER = 1.25;
const TWO_D_FIT_PADDING_MULTIPLIER = 1.15;
// Margin left around framed content (bounds inflation). Frame-selected is snug;
// frame-all leaves more breathing room around the whole scene.
const THREE_D_FRAME_SELECTED_PADDING_MULTIPLIER = 1.3;
const THREE_D_FRAME_ALL_PADDING_MULTIPLIER = 1.5;
// Fallback framing half-extents for degenerate bounds (empty groups, cameras,
// lights) so focusing them still produces a sensible view instead of NaN zoom.
const FRAME_FALLBACK_HALF_EXTENT_2D = 100;
const FRAME_FALLBACK_HALF_EXTENT_3D = 2.5;
const MARQUEE_PREVIEW_2D_COLOR = EDITOR_ACCENT_COLOR;
// While idle (no dirty flag, no animated previews) the render loop still
// paints one frame this often as a safety net for mutations that bypass
// requestRender() (async texture loads, background-tab agent screenshots).
const IDLE_RENDER_INTERVAL_MS = 500;
// Upper bound for the per-frame delta fed to preview tickers so the idle
// heartbeat gap doesn't fast-forward mixers/particles in one jump.
const MAX_PREVIEW_DELTA_S = 0.1;

// Re-exported for backward compat: this type now lives with the GPU timer it
// describes; consumers still import it from here.
export type { ViewportPerfSample } from './viewport/ViewportGpuTimer';

/** Options for {@link ViewportRendererService.frameNodes}. */
export interface FrameNodesOptions {
  /** Bounds inflation (>1 leaves margin). Defaults per dimension when omitted. */
  paddingMultiplier?: number;
  /**
   * Persist the move as a user navigation (cancel fling, save per-scene 2D zoom,
   * refresh gizmos). Default true. Transient captures pass false so the human's
   * remembered camera is untouched.
   */
  persist?: boolean;
  /**
   * When the frameable content's dimensionality differs from the active
   * navigation mode, switch the mode so the user's controls point at it. Only the
   * persistent F-key path passes true; transient captures never flip the mode
   * (both render passes always run, so cross-mode capture works regardless).
   */
  switchNavigationMode?: boolean;
}

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

  @inject(IconService)
  private readonly iconService!: IconService;

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
  /** Lazily created post-processing composer (only while a PostProcess node is
   * active). Editor previews the 3D band through it; 2D content and adornments
   * are drawn clean on top. Null when no effects are enabled. */
  private postFx: PostProcessingPipeline | null = null;
  private sprite3DTexturePaths = new Map<string, string | null>();
  private particles3DTexturePaths = new Map<string, string | null>();
  private geometryMeshMapPaths = new Map<string, string | null>();
  private baseViewportFrame?: THREE.Group;
  private selection2DOverlay?: Selection2DOverlay;
  private active2DTransform?: Active2DTransform;
  // Hover preview frame for 2D nodes (before selection)
  private hoverPreview2D?: { nodeId: string; frame: THREE.Group };
  private marqueePreview2DFrames = new Map<string, THREE.Group>();
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
  private lastNavigationMode = appState.ui.navigationMode;
  private lastNodeDataChangeSignal = appState.scenes.nodeDataChangeSignal;
  private cachedLayerCapabilities: SceneLayerCapabilities = { has2D: true, has3D: true };
  private cachedLayerCapabilitiesSceneId: string | null = null;
  private cachedLayerCapabilitiesSignal = -1;
  private viewportSize = { width: 0, height: 0 };
  private transformTool2d: TransformTool2d;

  // Animation preview
  private animationMixers = new Map<string, THREE.AnimationMixer>();
  private animationTimer = new THREE.Timer();
  private previewAnimationActions = new Map<string, THREE.AnimationAction>();

  // Gesture handling for 2D navigation
  private panVelocity = { x: 0, y: 0 };
  private momentumAnimationId?: number;

  // On-demand rendering: the rAF loop skips frames unless something marked
  // the viewport dirty, an editor preview is animating, or the idle
  // heartbeat (IDLE_RENDER_INTERVAL_MS) is due.
  private renderRequested = true;
  private isRenderingFrame = false;
  // When set, renderFrameBody skips the LAYER_GIZMOS pass (transform gizmo,
  // selection boxes, node icons) so framed agent screenshots come out clean.
  private suppressGizmosForCapture = false;
  private lastRenderedAt = 0;

  // --- Viewport performance sampling (for the status-bar tab-load readout) ---
  // Owns the GPU/CPU frame-timing concern. Reads the *current* renderer via a
  // getter since it's created lazily and can be re-created on viewport re-init.
  private readonly gpuTimer = new ViewportGpuTimer(() => this.renderer);
  // Owns the screenshot / framed-capture concern. Wired via closures because the
  // renderer/canvas/scene/camera are created lazily (viewport re-init) and the
  // called methods (renderFrame, frameNodes, isVisibleInHierarchy,
  // get2DVisualRoot, resolveSelectedFrameNodes) are used elsewhere and stay here.
  private readonly screenshotter = new ViewportScreenshotter({
    getRenderer: () => this.renderer,
    getCanvas: () => this.canvas,
    getScene: () => this.scene,
    getCamera: () => this.camera,
    getOrbitControls: () => this.orbitControls,
    getOrthographicCamera: () => this.orthographicCamera,
    getOrthographicControls: () => this.orthographicControls,
    renderFrame: () => this.renderFrame(),
    getActiveSceneGraph: () => this.sceneManager.getActiveSceneGraph(),
    resolveSelectedFrameNodes: () => this.resolveSelectedFrameNodes(),
    isVisibleInHierarchy: object => this.isVisibleInHierarchy(object),
    frameNodes: (nodes, opts) => this.frameNodes(nodes, opts),
    get2DVisualRoot: nodeId => this.get2DVisualRoot(nodeId),
    setSuppressGizmosForCapture: value => {
      this.suppressGizmosForCapture = value;
    },
  });
  // Owns the DOM badge HUD that floats near a 2D selection. Wired via closures
  // because the overlay/camera/viewport/canvas host and the active 2D transform
  // are recreated/reassigned over this object's lifetime, and the borrowed
  // methods (projectWorldToOverlay, rotateVectorZ, getIconSvg) stay on the facade.
  private readonly selection2DHud = new ViewportSelection2DOverlayHud({
    getSelection2DOverlay: () => this.selection2DOverlay,
    getOrthographicCamera: () => this.orthographicCamera,
    getViewportSize: () => this.viewportSize,
    getActive2DTransformHandle: () => this.active2DTransform?.handle,
    getCanvasHost: () => this.canvasHost,
    getSceneGraph: sceneId => this.sceneManager.getSceneGraph(sceneId),
    projectWorldToOverlay: world => this.projectWorldToOverlay(world),
    rotateVectorZ: (vector, angle) => this.rotateVectorZ(vector, angle),
    getIconSvg: (name, size) => this.iconService.getIconSvg(name, size),
  });
  // Owns the editor-only preview tickers (particle preview + script-component
  // editor preview) and the transient appearance overrides those components
  // push. Wired via closures because the scene graph, node lookups, 2D visual
  // proxies, and asset loader are resolved lazily / can change over this
  // object's lifetime, and the borrowed methods stay on the facade.
  private readonly previewTicker = new ViewportPreviewTicker({
    getActiveSceneGraph: () => this.sceneManager.getActiveSceneGraph(),
    findNodeById: (nodeId, nodes) => this.findNodeById(nodeId, nodes),
    get2DVisualRoot: nodeId => this.get2DVisualRoot(nodeId),
    getAssetLoader: () => this.assetLoader,
    requestRender: () => this.requestRender(),
  });
  // Owns every 2D node type's editor "proxy visual" (the separate THREE meshes
  // the editor draws in place of the runtime 2D nodes). Wired via closures
  // because the resource manager is injected lazily and the borrowed methods
  // (installProxyEffects — its uninstall half stays for disposeObject3D — and
  // disposeObject3D) and the orthographic camera stay on / are recreated by the
  // facade over this object's lifetime.
  private readonly proxyRegistry = new Viewport2DProxyRegistry({
    readBlob: path => this.resourceManager.readBlob(path),
    readText: path => this.resourceManager.readText(path),
    requestRender: () => this.requestRender(),
    installProxyEffects: (node, material) => this.installProxyEffects(node, material),
    disposeObject3D: root => this.disposeObject3D(root),
    getOrthographicCamera: () => this.orthographicCamera,
  });
  private readonly invalidateOnControlsChange = () => {
    this.renderRequested = true;
  };

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
          this.uninstallProxyEffects(material);
          material.dispose();
        } else if (Array.isArray(material)) {
          material.forEach(m => {
            this.uninstallProxyEffects(m);
            m.dispose();
          });
        }
      }
    });
  }

  /**
   * Wire a shader-effect host node's effect stack onto its editor proxy material
   * so effects render in the viewport exactly as they do in the runtime. The
   * stack is stamped on the material's `userData` so {@link disposeObject3D} can
   * detach it on every rebuild/dispose path — otherwise the stack's installed-
   * material set would accumulate disposed proxy materials. No-op for nodes that
   * don't host effects (only Sprite2D/AnimatedSprite2D/Button2D do among the 2D
   * proxies; Button2D installs on the SKIN material, never the label).
   */
  private installProxyEffects(node: NodeBase, material: THREE.Material): void {
    if (!isShaderEffectHost(node)) {
      return;
    }
    const stack = node.getShaderEffectStack();
    stack.install(material);
    (material.userData as { effectStack?: ShaderEffectStack }).effectStack = stack;
  }

  /** Detach an installed effect stack from a proxy material (see install above). */
  private uninstallProxyEffects(material: THREE.Material): void {
    const userData = material.userData as { effectStack?: ShaderEffectStack };
    if (userData.effectStack) {
      userData.effectStack.uninstall(material);
      userData.effectStack = undefined;
    }
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

    // Any interaction with the canvas invalidates the frame. This keeps every
    // gesture path (2D transform drags, hover frames, marquee, wheel zoom)
    // painting at event rate without each handler calling requestRender().
    const invalidateOnInteraction = () => {
      this.renderRequested = true;
    };
    const interactionEvents = [
      'pointerdown',
      'pointermove',
      'pointerup',
      'pointercancel',
      'wheel',
      'dragover',
      'drop',
    ] as const;
    const interactionTarget = this.renderer.domElement;
    for (const eventName of interactionEvents) {
      interactionTarget.addEventListener(eventName, invalidateOnInteraction, {
        capture: true,
        passive: true,
      });
    }
    this.disposers.push(() => {
      for (const eventName of interactionEvents) {
        interactionTarget.removeEventListener(eventName, invalidateOnInteraction, {
          capture: true,
        });
      }
    });

    // All `new THREE.TextureLoader()` call sites share the default manager, so
    // this repaints the viewport as soon as texture data arrives instead of
    // leaving the new texture waiting for the idle heartbeat.
    THREE.DefaultLoadingManager.onLoad = () => {
      this.requestRender();
    };

    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(VIEWPORT_BACKGROUND_COLOR, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = this.shouldEnableRendererShadowMap();
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    // Create scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(VIEWPORT_BACKGROUND_COLOR);

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
      this.orthographicControls.addEventListener('change', this.invalidateOnControlsChange);
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
      this.requestRender();
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

  /** Delegates to {@link ViewportScreenshotter.captureScreenshot}. */
  captureScreenshot(options: CanvasScreenshotOptions = {}): CanvasScreenshot | null {
    return this.screenshotter.captureScreenshot(options);
  }

  /** Delegates to {@link ViewportScreenshotter.captureFramedScreenshot}. */
  captureFramedScreenshot(opts: {
    maxSize?: number;
    frame: 'all' | 'selection' | 'node';
    nodeId?: string;
    isolate?: boolean;
    paddingMultiplier?: number;
  }): CanvasScreenshot | { error: string } | null {
    return this.screenshotter.captureFramedScreenshot(opts);
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
      if (getComputedStyle(host).position === 'static') {
        host.style.position = 'relative';
      }
      try {
        host.appendChild(this.canvas);
      } catch {
        // ignore
      }
      this.selection2DHud.attach();
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
        this.transformControls.addEventListener('change', this.invalidateOnControlsChange);

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
    const nextNavigationMode = appState.ui.navigationMode;
    const is2DMode = nextNavigationMode === '2d';
    const entered2DMode = this.lastNavigationMode !== nextNavigationMode && is2DMode;

    this.setOrbitEnabled(!is2DMode);
    if (this.orthographicControls) {
      // Disable orthographic controls entirely in 2D mode.
      // We handle pan/zoom gestures manually in EditorTabComponent and call pan2D/zoom2D.
      // Keeping it enabled would cause it to intercept and swallow wheel/pointer events
      // via internal event.stopPropagation(), preventing the UI components from
      // receiving them for our custom gesture handling.
      this.orthographicControls.enabled = false;

      // Ensure damping is off if we were using it, though it shouldn't matter if disabled
      this.orthographicControls.enableZoom = false;
      this.orthographicControls.enablePan = false;
    }

    if (entered2DMode) {
      this.restoreZoomFromState();
      this.requestRender();
    }

    this.lastNavigationMode = nextNavigationMode;
  }

  private hasMeasuredViewport(): boolean {
    return this.viewportSize.width > 0 && this.viewportSize.height > 0;
  }

  /**
   * Capabilities of the active scene (whether it holds 2D and/or 3D content),
   * cached and recomputed only when the active scene or its node data changes.
   */
  private getSceneLayerCapabilities(): SceneLayerCapabilities {
    const sceneId = appState.scenes.activeSceneId;
    const signal = appState.scenes.nodeDataChangeSignal;
    if (
      sceneId !== this.cachedLayerCapabilitiesSceneId ||
      signal !== this.cachedLayerCapabilitiesSignal
    ) {
      this.cachedLayerCapabilities = deriveSceneLayerCapabilities(
        this.sceneManager.getActiveSceneGraph()
      );
      this.cachedLayerCapabilitiesSceneId = sceneId;
      this.cachedLayerCapabilitiesSignal = signal;
    }
    return this.cachedLayerCapabilities;
  }

  /**
   * Effective 2D-layer visibility: the user's toggle AND the scene actually
   * having 2D content. A 3D-only scene never paints (or hit-tests) the 2D band.
   */
  private isLayer2DVisible(): boolean {
    return appState.ui.showLayer2D && this.getSceneLayerCapabilities().has2D;
  }

  /**
   * Effective 3D-layer visibility: the user's toggle AND the scene actually
   * having 3D content. A 2D-only scene never paints the (empty) 3D band or grid.
   */
  private isLayer3DVisible(): boolean {
    return appState.ui.showLayer3D && this.getSceneLayerCapabilities().has3D;
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
    this.orbitControls.addEventListener('change', this.invalidateOnControlsChange);
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
    this.transformControls.addEventListener('change', this.invalidateOnControlsChange);

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
    this.resetOrbitInternalState();
    this.setOrbitEnabled(false);
    if (this.orthographicControls) {
      this.orthographicControls.enabled = false;
    }
  }

  end2DInteraction(): void {
    this.resetOrbitInternalState();
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

    this.apply3DFraming(box, THREE_D_FRAME_ALL_PADDING_MULTIPLIER);
  }

  /**
   * Position the active 3D camera (perspective or editor-orthographic) so `bounds`
   * fills the viewport with a margin. The current view DIRECTION is preserved
   * (Unity/Godot "frame" behavior) — only distance/zoom and the orbit target move —
   * so framing never disorients the user by snapping to a fixed angle. Use
   * {@link zoomDefault} to reset to the canonical 3/4 view.
   */
  private apply3DFraming(
    bounds: THREE.Box3,
    paddingMultiplier = THREE_D_FRAME_SELECTED_PADDING_MULTIPLIER
  ): void {
    if (!this.camera || !this.orbitControls) return;

    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const sphereRadius = Math.max(size.length() / 2, MIN_WORLD_BOUNDS_SIZE);

    // Preserve the current view direction; fall back to the default diagonal only
    // when the camera sits exactly on its target.
    const direction = resolvePreservedViewDirection(this.camera.position, this.orbitControls.target);

    if (this.camera instanceof THREE.PerspectiveCamera) {
      const distance = computePerspectiveFitDistance(
        sphereRadius,
        paddingMultiplier,
        this.camera.fov,
        this.camera.aspect,
        this.camera.near
      );
      this.camera.position.copy(center).add(direction.multiplyScalar(distance));
    } else {
      const distance = Math.max(
        this.camera.position.clone().sub(this.orbitControls.target).length(),
        10
      );
      this.camera.position.copy(center).add(direction.multiplyScalar(distance));

      this.camera.zoom = computeOrtho3DFitZoom(
        size.x,
        size.y,
        paddingMultiplier,
        this.viewportSize.width,
        this.viewportSize.height,
        EDITOR_ORTHOGRAPHIC_FRUSTUM_HEIGHT
      );
      this.camera.updateProjectionMatrix();
    }

    this.camera.lookAt(center);
    this.orbitControls.target.copy(center);
    this.orbitControls.update();
    this.requestRender();
  }

  /**
   * Zoom the active viewport camera by a multiplicative factor.
   * `factor > 1` zooms in, `factor < 1` zooms out. Works in both 2D and 3D modes.
   */
  zoomBy(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) {
      return;
    }

    if (appState.ui.navigationMode === '2d') {
      this.zoom2D(factor);
      return;
    }

    if (!this.camera || !this.orbitControls) return;

    if (this.camera instanceof THREE.PerspectiveCamera) {
      // Dolly the camera toward/away from the orbit target.
      const target = this.orbitControls.target;
      const offset = this.camera.position.clone().sub(target);
      offset.multiplyScalar(1 / factor);
      this.camera.position.copy(target).add(offset);
    } else {
      this.camera.zoom = Math.max(0.1, this.camera.zoom * factor);
      this.camera.updateProjectionMatrix();
    }

    this.orbitControls.update();
    this.requestRender();
  }

  /**
   * Frame (fit + center the camera on) the currently selected node(s). With
   * nothing selected, falls back to {@link zoomAll} so the F key stays useful.
   * This is the persistent, human-facing "Frame Selected" navigation: it switches
   * the navigation mode when the selection lives in the other dimension.
   */
  frameSelected(): void {
    const nodes = this.resolveSelectedFrameNodes();
    if (nodes.length === 0) {
      this.zoomAll();
      return;
    }
    const framed = this.frameNodes(nodes, { persist: true, switchNavigationMode: true });
    if (!framed) {
      this.zoomAll();
    }
  }

  /**
   * Frame a single node addressed by id (scene-tree double-click / context menu).
   * Returns false when the id resolves to nothing frameable.
   */
  frameNodeById(nodeId: string, opts: FrameNodesOptions = {}): boolean {
    const node = this.sceneManager.getActiveSceneGraph()?.nodeMap.get(nodeId);
    if (!(node instanceof NodeBase)) return false;
    return this.frameNodes([node], opts);
  }

  /**
   * Aim the active camera so `nodes` (and their descendants) fill the viewport.
   * Handles both 2D (orthographic) and 3D (perspective/ortho) content, choosing
   * the dimension that matches the current navigation mode when the set is mixed.
   * Returns false when nothing frameable was resolved (caller may fall back).
   */
  frameNodes(nodes: readonly NodeBase[], opts: FrameNodesOptions = {}): boolean {
    const computed = this.computeFramingBounds(nodes);
    if (!computed) return false;
    const { bounds, dim } = computed;
    const persist = opts.persist ?? true;

    if (opts.switchNavigationMode && appState.ui.navigationMode !== dim) {
      this.switchNavigationModeSync(dim);
    }

    if (dim === '2d') {
      this.apply2DFraming(bounds, opts.paddingMultiplier ?? TWO_D_FIT_PADDING_MULTIPLIER, persist);
    } else {
      this.apply3DFraming(
        bounds,
        opts.paddingMultiplier ?? THREE_D_FRAME_SELECTED_PADDING_MULTIPLIER
      );
    }
    return true;
  }

  /** Selected nodes (or the hovered node as a fallback), resolved from the active scene graph. */
  private resolveSelectedFrameNodes(): NodeBase[] {
    const sceneGraph = this.sceneManager.getActiveSceneGraph();
    if (!sceneGraph) return [];
    const ids = appState.selection.nodeIds.length
      ? appState.selection.nodeIds
      : appState.selection.primaryNodeId
        ? [appState.selection.primaryNodeId]
        : [];
    const nodes: NodeBase[] = [];
    for (const id of ids) {
      const node = sceneGraph.nodeMap.get(id);
      if (node instanceof NodeBase) nodes.push(node);
    }
    return nodes;
  }

  /**
   * Compute the world-space framing box for a set of nodes plus their descendants,
   * and decide which dimension (2D/3D) to frame. Prefers the set matching the
   * active navigation mode; falls back to the other when the current mode has no
   * matching content.
   *
   * Visibility rule: the explicitly-passed targets always count (you can navigate
   * to a hidden node), but HIDDEN DESCENDANTS are excluded — otherwise an unused
   * alternate skin parked at the origin (a common 2D pattern: several weapon-barrel
   * variants under one pivot, one visible at a time) inflates the box to span the
   * whole scene. This matches `collect2DContentBounds` (used by Frame All).
   *
   * Degenerate results (empty group / pivot, camera, light) fall back to a fixed
   * box around the first target's world position.
   */
  private computeFramingBounds(
    nodes: readonly NodeBase[]
  ): { bounds: THREE.Box3; dim: '2d' | '3d' } | null {
    // Flatten to (node, isTarget), keeping targets distinct from descendants.
    const flat: { node: NodeBase; isTarget: boolean }[] = [];
    const collect = (node: NodeBase, isTarget: boolean): void => {
      flat.push({ node, isTarget });
      for (const child of node.children) {
        if (child instanceof NodeBase) collect(child, false);
      }
    };
    for (const node of nodes) collect(node, true);

    const has2d = flat.some(e => e.node instanceof Node2D);
    const has3d = flat.some(e => e.node instanceof Node3D);
    const mode2d = appState.ui.navigationMode === '2d';
    let dim: '2d' | '3d';
    if (mode2d && has2d) dim = '2d';
    else if (!mode2d && has3d) dim = '3d';
    else if (has2d) dim = '2d';
    else if (has3d) dim = '3d';
    else return null;

    // A descendant counts only when visible in the hierarchy; a target always does.
    const includes = (entry: { node: NodeBase; isTarget: boolean }): boolean =>
      entry.isTarget || this.isVisibleInHierarchy(entry.node);

    const bounds = new THREE.Box3();
    if (dim === '2d') {
      // Per-node world bounds so hidden descendants can be filtered out individually.
      for (const entry of flat) {
        if (!(entry.node instanceof Node2D) || !includes(entry)) continue;
        const nodeBounds = this.getNodeOnlyBounds(entry.node);
        if (!this.isDegenerateBounds(nodeBounds)) bounds.union(nodeBounds);
      }
    } else {
      // 3D: box each passed target's subtree (setFromObject already spans descendants).
      for (const node of nodes) {
        const nodeBounds = new THREE.Box3().setFromObject(node);
        if (!nodeBounds.isEmpty()) bounds.union(nodeBounds);
      }
    }

    if (bounds.isEmpty() || this.isDegenerateBounds(bounds)) {
      const anchor = new THREE.Vector3();
      nodes[0].getWorldPosition(anchor);
      bounds.copy(
        computeFallbackFramingBounds(
          anchor,
          dim,
          FRAME_FALLBACK_HALF_EXTENT_2D,
          FRAME_FALLBACK_HALF_EXTENT_3D
        )
      );
    }

    return { bounds, dim };
  }

  /**
   * Switch navigation mode and apply its side effects synchronously. The Valtio
   * subscription that normally runs {@link syncNavigationMode} fires on a later
   * microtask — and on entering 2D it calls restoreZoomFromState(), which would
   * clobber a frame applied in the same tick. Running it now (which advances
   * `lastNavigationMode`) makes that deferred call a no-op, so the frame survives.
   */
  private switchNavigationModeSync(mode: '2d' | '3d'): void {
    if (appState.ui.navigationMode === mode) return;
    appState.ui.navigationMode = mode;
    this.syncNavigationMode();
  }

  private getTarget2DZoomForBounds(
    bounds: THREE.Box3,
    paddingMultiplier = TWO_D_FIT_PADDING_MULTIPLIER
  ): number {
    if (!this.orthographicCamera) {
      return 1;
    }

    return computeOrtho2DFitZoom(
      bounds.getSize(new THREE.Vector3()),
      paddingMultiplier,
      this.orthographicCamera.left,
      this.orthographicCamera.right,
      this.orthographicCamera.top,
      this.orthographicCamera.bottom
    );
  }

  private getDefault2DViewState(): { center: THREE.Vector3; zoom: number } {
    const viewportBaseBounds = this.getViewportBaseBounds();

    return {
      center: viewportBaseBounds.getCenter(new THREE.Vector3()),
      zoom: this.getTarget2DZoomForBounds(
        viewportBaseBounds,
        TWO_D_DEFAULT_VIEW_PADDING_MULTIPLIER
      ),
    };
  }

  private reset2DView(): void {
    if (!this.orthographicCamera) {
      return;
    }

    const { center, zoom } = this.getDefault2DViewState();

    this.cancelPanMomentum();
    this.panVelocity.x = 0;
    this.panVelocity.y = 0;

    this.orthographicCamera.position.set(center.x, center.y, DEFAULT_2D_CAMERA_Z);
    this.orthographicCamera.zoom = zoom;
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

    this.apply2DFraming(contentBounds, TWO_D_FIT_PADDING_MULTIPLIER, true);
  }

  /**
   * Center + zoom the orthographic (2D) camera on `bounds` with a margin. When
   * `persist` is true this is a user-facing navigation (fling cancelled, per-scene
   * zoom saved, gizmos refreshed); when false it is a transient move for an
   * off-screen capture that must NOT touch `saveZoomToState` (which would corrupt
   * the scene's remembered 2D camera) or momentum.
   */
  private apply2DFraming(bounds: THREE.Box3, paddingMultiplier: number, persist: boolean): void {
    if (!this.orthographicCamera) return;

    const center = bounds.getCenter(new THREE.Vector3());
    const targetZoom = this.getTarget2DZoomForBounds(bounds, paddingMultiplier);

    if (persist) {
      this.cancelPanMomentum();
      this.panVelocity.x = 0;
      this.panVelocity.y = 0;
    }

    this.orthographicCamera.position.set(center.x, center.y, DEFAULT_2D_CAMERA_Z);
    this.orthographicCamera.zoom = targetZoom;
    this.orthographicCamera.updateProjectionMatrix();

    if (this.orthographicControls) {
      this.orthographicControls.target.set(center.x, center.y, 0);
      this.orthographicControls.update();
    }

    if (persist) {
      this.sync2DServiceFrameThickness();
      if (this.selection2DOverlay) {
        this.refreshGizmoPositions();
      }
      this.saveZoomToState();
    }
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
    return (
      node instanceof Camera3D || node instanceof VirtualCamera3D || this.isExplicitLightNode(node)
    );
  }

  private shouldKeepSelectedNodeIcon(node: Node3D): boolean {
    return (
      node instanceof Camera3D || node instanceof VirtualCamera3D || this.isExplicitLightNode(node)
    );
  }

  resize(width: number, height: number): void {
    if (!this.renderer || !this.camera) return;

    const hadMeasuredViewport = this.hasMeasuredViewport();

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
    this.selection2DHud.update();

    if (!hadMeasuredViewport && appState.scenes.activeSceneId) {
      this.restoreZoomFromState();
    }

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

    if (animationName === null) {
      // Repaint once so the model visibly returns to its bind pose now that
      // the continuous preview loop is no longer running.
      this.requestRender();
      return;
    }

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
    this.requestRender();
  }

  private get2DVisualRoot(nodeId: string): THREE.Group | undefined {
    return this.proxyRegistry.getVisualRoot(nodeId);
  }

  /** Delegates to the 2D proxy registry (see {@link Viewport2DProxyRegistry.assignRenderOrder}). */
  private assign2DVisualRenderOrder(rootNodes: readonly NodeBase[]): void {
    this.proxyRegistry.assignRenderOrder(rootNodes);
  }

  /**
   * Re-apply the project's 2D texture filtering mode to every live 2D proxy
   * texture. Called when the project setting changes so the crisp/smoothed look
   * updates immediately without reloading textures. 3D textures are untouched.
   */
  reapply2DTextureFiltering(): void {
    this.proxyRegistry.reapplyTextureFiltering();
  }

  /**
   * First active PostProcess node in the active scene graph, or null. Editors
   * the same node instance the inspector mutates, so property/keyframe edits are
   * reflected on the next requested frame.
   */
  private findActivePostProcessNode(): PostProcess | null {
    const sceneGraph = this.sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      return null;
    }
    const stack: NodeBase[] = [...sceneGraph.rootNodes];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        continue;
      }
      if (node instanceof PostProcess && node.isActive()) {
        return node;
      }
      for (const child of node.children) {
        if (child instanceof NodeBase) {
          stack.push(child);
        }
      }
    }
    return null;
  }

  /** Last-applied baked-AO suppression state (avoids re-walking every frame). */
  private lastAOSuppress: boolean | null = null;

  /**
   * Resolve the scene's AO mode (from its PostProcess node) and suppress or
   * restore baked aoMaps on all GeometryMesh nodes accordingly. Non-baked modes
   * (realtime SSAO, off) suppress baked so it doesn't double with SSAO. Walks
   * only when the decision changes.
   */
  private applyAOModeSuppression(): void {
    const graph = this.sceneManager.getActiveSceneGraph();
    if (!graph) {
      return;
    }
    let post: PostProcess | null = null;
    const meshes: GeometryMesh[] = [];
    const stack: NodeBase[] = [...graph.rootNodes];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        continue;
      }
      if (node instanceof PostProcess && !post) {
        post = node;
      } else if (node instanceof GeometryMesh) {
        meshes.push(node);
      }
      for (const child of node.children) {
        if (child instanceof NodeBase) {
          stack.push(child);
        }
      }
    }
    const suppress = post ? post.getResolvedAOMode() !== 'baked' : false;
    if (suppress === this.lastAOSuppress) {
      return;
    }
    this.lastAOSuppress = suppress;
    for (const mesh of meshes) {
      mesh.setAOSuppressed(suppress);
    }
  }

  /**
   * Manually trigger a single frame render. Useful when the main loop
   * is paused but we still want to update the visual state (e.g. on resize).
   */
  /**
   * Mark the viewport dirty so the render loop paints a frame on the next
   * animation frame. When the loop is not running (paused, window unfocused,
   * or a hidden tab where rAF never fires), the frame is rendered
   * synchronously instead so on-demand consumers (resize, collab updates,
   * agent-driven edits in a background tab) still get a fresh canvas.
   */
  requestRender(): void {
    this.renderRequested = true;
    if (this.animationId === undefined) {
      this.renderFrame();
    }
  }

  private renderFrame(): void {
    if (this.isRenderingFrame) return;
    this.isRenderingFrame = true;
    this.renderRequested = false;
    this.lastRenderedAt = performance.now();
    // Resolve the previous frame's GPU timer before opening a new one (only one
    // TIME_ELAPSED query can be in flight at a time).
    this.gpuTimer.resolve();
    const gpuStarted = this.gpuTimer.beginFrame();
    const cpuStart = performance.now();
    try {
      this.renderFrameBody();
    } finally {
      this.gpuTimer.recordCpuMs(performance.now() - cpuStart);
      this.gpuTimer.endFrame(gpuStarted);
      this.isRenderingFrame = false;
    }
  }

  /**
   * Latest viewport render cost, for the status-bar tab-load readout. Polls any
   * pending GPU timer so the value keeps updating even while the on-demand loop
   * is idle (no new frames). `gpuMs` is null when timer queries are unsupported.
   */
  getViewportPerfSample(): ViewportPerfSample {
    return this.gpuTimer.getSample();
  }

  private renderFrameBody(): void {
    if (!this.renderer || !this.scene || !this.camera) return;

    // Advance animation mixers
    this.animationTimer.update();
    const delta = Math.min(this.animationTimer.getDelta(), MAX_PREVIEW_DELTA_S);
    for (const mixer of this.animationMixers.values()) {
      mixer.update(delta);
    }

    this.previewTicker.tickParticles(delta);
    this.previewTicker.tickComponents(delta);

    // Update controls once before rendering if they exist
    const is2DMode = appState.ui.navigationMode === '2d';
    if (is2DMode) {
      this.orthographicControls?.update();
    } else {
      this.orbitControls?.update();
    }

    this.syncSprite3DBillboarding(this.camera);

    // Render main scene with perspective camera (3D layer and gizmos).
    //
    // When an active PostProcess node exists, the 3D band is routed through an
    // EffectComposer. Editor scope (Phase 1): only the 3D band is post-processed
    // — gizmos and the 2D overlay draw clean on top, so bright selection frames
    // never bloom. (Full editor 2D post is a follow-up that moves 2D adornments
    // to their own clean layer.)
    // AO-mode cascade (scene tier): when the PostProcess node resolves to a
    // non-baked mode (realtime SSAO / off), suppress baked aoMaps so they don't
    // stack with SSAO. Cheap: only re-walks when the decision flips.
    this.applyAOModeSuppression();

    const postNode = this.findActivePostProcessNode();
    const canPost = this.isLayer3DVisible() && !!postNode;

    if (canPost) {
      if (!this.postFx) {
        this.postFx = new PostProcessingPipeline(this.renderer);
      }
      this.postFx.ensureLoading();
    } else if (this.postFx) {
      this.postFx.dispose();
      this.postFx = null;
    }

    if (canPost && this.postFx && this.postFx.isReady() && postNode && this.orthographicCamera) {
      // Post the 3D band only: mask gizmos out of the composer's render, then
      // draw them clean afterward. affect2D is forced off here — the editor's 2D
      // overlay (below) always draws clean.
      const savedMask = this.camera.layers.mask;
      this.camera.layers.disableAll();
      this.camera.layers.enable(LAYER_3D);

      this.postFx.render(this.scene, this.camera, this.orthographicCamera, {
        ...postNode.getConfig(),
        affect2D: false,
      });

      // Restore, then draw gizmos (LAYER_GIZMOS only) over the post-processed frame.
      // Skipped entirely for a clean framed capture.
      if (!this.suppressGizmosForCapture) {
        this.camera.layers.mask = savedMask;
        this.camera.layers.disableAll();
        this.camera.layers.enable(LAYER_GIZMOS);
        // Null the scene background first: three's WebGLBackground force-clears the
        // framebuffer when scene.background is a Color, even with autoClear=false —
        // which would wipe the composited frame the composer just drew.
        const savedGizmoBg = this.scene.background;
        this.scene.background = null;
        this.renderer.autoClear = false;
        this.renderer.render(this.scene, this.camera);
        this.scene.background = savedGizmoBg;
      }
      this.camera.layers.mask = savedMask;
    } else if (this.isLayer3DVisible()) {
      this.renderer.autoClear = true;
      const savedMask = this.camera.layers.mask;
      if (this.suppressGizmosForCapture) {
        this.camera.layers.disable(LAYER_GIZMOS);
      }
      this.renderer.render(this.scene, this.camera);
      this.camera.layers.mask = savedMask;
    } else {
      this.renderer.autoClear = true;
      this.renderer.clear();
    }

    // Render 2D layer with orthographic camera if enabled
    if (this.isLayer2DVisible() && this.orthographicCamera) {
      // Draw order for 2D scene content follows the scene-graph hierarchy.
      // The editor draws proxy visuals rather than the runtime nodes, so the
      // hierarchy-driven order must be assigned to the proxy meshes directly.
      const sceneGraph = this.sceneManager.getActiveSceneGraph();
      if (sceneGraph) {
        this.assign2DVisualRenderOrder(sceneGraph.rootNodes);
      }

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

    // Keep the 2D selection HUD badges glued to the object as the camera moves.
    // Runs after controls.update() + the render passes so it reads the current
    // camera. On-demand only: no repaint (idle) means no reposition, and the
    // guards inside skip it whenever no 2D selection badge is shown.
    if (appState.ui.navigationMode === '2d' && this.selection2DOverlay) {
      this.selection2DHud.reposition();
    }
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

  getViewportBaseBounds(): THREE.Box3 {
    const viewportBaseSize = this.getProjectViewportBaseSize();
    const halfWidth = viewportBaseSize.width / 2;
    const halfHeight = viewportBaseSize.height / 2;
    return new THREE.Box3(
      new THREE.Vector3(-halfWidth, -halfHeight, 0),
      new THREE.Vector3(halfWidth, halfHeight, 0)
    );
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
    const thickness = getFrameThicknessWorldPx(zoom);

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

    for (const frame of this.marqueePreview2DFrames.values()) {
      const width = frame.userData.frameWidth as number | undefined;
      const height = frame.userData.frameHeight as number | undefined;
      if (typeof width === 'number' && typeof height === 'number') {
        this.updateRectFrameEdges(frame, width, height, thickness);
      }
    }

    for (const visualRoot of this.proxyRegistry.group2DVisuals.values()) {
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

    for (const visualRoot of this.proxyRegistry.sprite2DVisuals.values()) {
      const sizeGroup = visualRoot.userData.sizeGroup as THREE.Group | undefined;
      const anchorMarker = visualRoot.userData.anchorMarker as THREE.Group | undefined;
      if (!sizeGroup || !anchorMarker) {
        continue;
      }

      this.proxyRegistry.updateSprite2DAnchorMarker(
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

    this.selection2DHud.update();
  }

  private createBaseViewportFrame(width: number, height: number): THREE.Group {
    const thickness = getFrameThicknessWorldPx(1);

    // Create a group to hold all border meshes
    const frame = new THREE.Group();
    frame.layers.set(LAYER_2D);
    frame.renderOrder = 950;
    frame.userData.isBaseViewportFrame = true;

    // Top border
    const topGeometry = new THREE.PlaneGeometry(1, 1);
    const topMaterial = new THREE.MeshBasicMaterial({
      color: EDITOR_ACCENT_COLOR,
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
      color: EDITOR_ACCENT_COLOR,
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
      color: EDITOR_ACCENT_COLOR,
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
      color: EDITOR_ACCENT_COLOR,
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

    this.baseViewportFrame.visible = this.isLayer2DVisible();
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
          const visualRoot = this.proxyRegistry.group2DVisuals.get(node.nodeId);
          if (visualRoot) {
            this.proxyRegistry.apply2DVisualTransform(node, visualRoot);
            const sizeGroup = visualRoot.userData.sizeGroup as THREE.Object3D | undefined;
            if (sizeGroup) {
              sizeGroup.scale.set(node.width, node.height, 1);
            }
            this.proxyRegistry.apply2DVisualOpacity(node, visualRoot);
          }
        } else if (node instanceof AnimatedSprite2D) {
          const visualRoot = this.proxyRegistry.animatedSprite2DVisuals.get(node.nodeId);
          if (visualRoot) {
            this.proxyRegistry.syncAnimatedSprite2DVisual(node, visualRoot);
          }
        } else if (node instanceof TiledSprite2D) {
          const visualRoot = this.proxyRegistry.tiledSprite2DVisuals.get(node.nodeId);
          if (visualRoot) {
            this.proxyRegistry.syncTiledSprite2DVisual(node, visualRoot);
          }
        } else if (node instanceof Sprite2D) {
          const visualRoot = this.proxyRegistry.sprite2DVisuals.get(node.nodeId);
          if (visualRoot) {
            this.proxyRegistry.apply2DVisualTransform(node, visualRoot);
            const sizeGroup = visualRoot.userData.sizeGroup as THREE.Object3D | undefined;
            if (sizeGroup) {
              sizeGroup.scale.set(node.width ?? 64, node.height ?? 64, 1);
            }
            this.proxyRegistry.apply2DVisualOpacity(node, visualRoot);
          }
        } else if (node instanceof ColorRect2D) {
          const visualRoot = this.proxyRegistry.colorRect2DVisuals.get(node.nodeId);
          if (visualRoot) {
            this.proxyRegistry.apply2DVisualTransform(node, visualRoot);
            const sizeGroup = visualRoot.userData.sizeGroup as THREE.Object3D | undefined;
            if (sizeGroup) {
              sizeGroup.scale.set(node.width, node.height, 1);
            }
            this.proxyRegistry.applyColorRect2DColor(node, visualRoot);
            this.proxyRegistry.apply2DVisualOpacity(node, visualRoot);
          }
        } else if (node instanceof UIControl2D) {
          const visualRoot = this.proxyRegistry.uiControl2DVisuals.get(node.nodeId);
          if (visualRoot) {
            this.proxyRegistry.apply2DVisualTransform(node, visualRoot);
            const sizeGroup = visualRoot.userData.sizeGroup as THREE.Object3D | undefined;
            if (sizeGroup) {
              const { width, height } = this.proxyRegistry.getUIControlDimensions(node);
              sizeGroup.scale.set(width, height, 1);
            }
            this.proxyRegistry.apply2DVisualOpacity(node, visualRoot);
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

  resolve2DAssetDropPosition(screenX: number, screenY: number): THREE.Vector2 | null {
    const worldPoint = this.screenToWorld2D(screenX, screenY);
    if (!worldPoint) {
      return null;
    }

    return new THREE.Vector2(worldPoint.x, worldPoint.y);
  }

  resolve3DAssetDropPosition(
    screenX: number,
    screenY: number,
    objectSize?: THREE.Vector3 | null
  ): THREE.Vector3 | null {
    if (!this.camera) {
      return null;
    }

    const ndc = this.toNdc(screenX, screenY);
    if (!ndc) {
      return this.resolve3DAssetDropFallback(objectSize);
    }

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);

    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const intersection = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(plane, intersection)) {
      return intersection;
    }

    return this.resolve3DAssetDropFallback(objectSize);
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

    appState.scenes.navigation2DCameraStates[sceneId] = {
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

    const cameraState = appState.scenes.navigation2DCameraStates[sceneId];
    if (!cameraState) {
      this.reset2DView();
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
        this.renderRequested = true;
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

    const layer2DEnabled = this.isLayer2DVisible() && Boolean(this.orthographicCamera);
    const layer3DEnabled = this.isLayer3DVisible() && Boolean(this.camera) && !is2DMode;

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

  getSelectable2DNodeIdsInScreenRect(
    startX: number,
    startY: number,
    endX: number,
    endY: number
  ): string[] {
    if (!this.orthographicCamera || !this.isLayer2DVisible()) {
      return [];
    }

    const activeSceneId = appState.scenes.activeSceneId;
    if (!activeSceneId) {
      return [];
    }

    const sceneGraph = this.sceneManager.getSceneGraph(activeSceneId);
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

  set2DMarqueePreviewNodeIds(nodeIds: string[]): boolean {
    if (!this.scene) {
      return false;
    }

    const activeSceneId = appState.scenes.activeSceneId;
    if (!activeSceneId) {
      return this.clear2DMarqueePreview();
    }

    const sceneGraph = this.sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      return this.clear2DMarqueePreview();
    }

    const nextNodeIds = Array.from(
      new Set(
        nodeIds.filter(
          (nodeId): nodeId is string => typeof nodeId === 'string' && nodeId.length > 0
        )
      )
    );
    const nextNodeIdSet = new Set(nextNodeIds);
    let changed = false;

    for (const [nodeId, frame] of this.marqueePreview2DFrames) {
      if (!nextNodeIdSet.has(nodeId)) {
        this.dispose2DPreviewFrame(frame);
        this.marqueePreview2DFrames.delete(nodeId);
        changed = true;
      }
    }

    for (const nodeId of nextNodeIds) {
      if (this.marqueePreview2DFrames.has(nodeId)) {
        continue;
      }

      const node = sceneGraph.nodeMap.get(nodeId);
      if (
        !(node instanceof Node2D) ||
        Boolean(node.properties.locked) ||
        !this.isVisibleInHierarchy(node) ||
        !this.get2DVisual(node)
      ) {
        continue;
      }

      const frame = this.create2DHoverPreviewFrame(
        this.getNodeOnlyBounds(node),
        MARQUEE_PREVIEW_2D_COLOR
      );
      frame.userData.isMarqueePreview = true;
      this.scene.add(frame);
      this.marqueePreview2DFrames.set(nodeId, frame);
      changed = true;
    }

    return changed;
  }

  private raycastNodeIcon(screenX: number, screenY: number): string | null {
    if (!this.camera || this.nodeIcons.size === 0 || !this.isLayer3DVisible()) {
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
    if (!this.camera || this.targetGizmos.size === 0 || !this.isLayer3DVisible()) {
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
    if (!this.orthographicCamera || !this.isLayer2DVisible()) {
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
      ...this.proxyRegistry.animatedSprite2DVisuals.values(),
      ...this.proxyRegistry.sprite2DVisuals.values(),
      ...this.proxyRegistry.colorRect2DVisuals.values(),
      ...this.proxyRegistry.tiledSprite2DVisuals.values(),
      ...this.proxyRegistry.uiControl2DVisuals.values(),
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

    const activeSceneId = appState.scenes.activeSceneId;
    if (!activeSceneId) {
      return null;
    }

    const sceneGraph = this.sceneManager.getSceneGraph(activeSceneId);
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
      if (Boolean(node.properties.locked)) {
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
    const projectedCorners = this.getNodeOnlyWorldCorners(node)
      .map(corner => this.projectWorldToOverlay(corner))
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

    if (Boolean(node.properties.locked) || !this.isVisibleInHierarchy(node)) {
      return false;
    }

    return Boolean(this.get2DVisual(node));
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

      if (node instanceof GeometryMesh) {
        this.syncGeometryMeshMap(node);
      }
    } else if (node instanceof Group2D) {
      const visualRoot = this.proxyRegistry.group2DVisuals.get(node.nodeId);
      if (visualRoot) {
        this.proxyRegistry.apply2DVisualTransform(node, visualRoot);
        const sizeGroup = visualRoot.userData.sizeGroup as THREE.Object3D | undefined;
        if (sizeGroup) {
          sizeGroup.scale.set(node.width, node.height, 1);
        }
        visualRoot.visible = node.visible;
        this.proxyRegistry.apply2DVisualOpacity(node, visualRoot);
      }
    } else if (node instanceof AnimatedSprite2D) {
      const visualRoot = this.proxyRegistry.animatedSprite2DVisuals.get(node.nodeId);
      if (visualRoot) {
        this.proxyRegistry.syncAnimatedSprite2DVisual(node, visualRoot);
      }
    } else if (node instanceof TiledSprite2D) {
      const visualRoot = this.proxyRegistry.tiledSprite2DVisuals.get(node.nodeId);
      if (visualRoot) {
        this.proxyRegistry.syncTiledSprite2DVisual(node, visualRoot);
      }
    } else if (node instanceof Sprite2D) {
      const visualRoot = this.proxyRegistry.sprite2DVisuals.get(node.nodeId);
      if (visualRoot) {
        this.proxyRegistry.apply2DVisualTransform(node, visualRoot);
        const sizeGroup = visualRoot.userData.sizeGroup as THREE.Object3D | undefined;
        if (sizeGroup) {
          // Use natural dimensions if width/height are undefined (first load)
          const w = node.width ?? node.originalWidth ?? 64;
          const h = node.height ?? node.originalHeight ?? 64;
          sizeGroup.scale.set(w, h, 1);
        }

        const mesh = visualRoot.userData.spriteMesh as THREE.Mesh | undefined;
        if (mesh) {
          const anchor = this.proxyRegistry.getSprite2DAnchor(node);
          mesh.position.set(0.5 - anchor.x, 0.5 - anchor.y, 0);
        }

        const anchorMarker = visualRoot.userData.anchorMarker as THREE.Group | undefined;
        if (anchorMarker) {
          anchorMarker.position.set(0, 0, 0.01);
          // Keep the pivot marker in sync with selection here too, so a freshly
          // (re)built visual for an already-selected node shows its marker
          // without waiting for the next selection change.
          anchorMarker.visible = appState.selection.nodeIds.includes(node.nodeId);

          if (sizeGroup) {
            this.proxyRegistry.updateSprite2DAnchorMarker(
              anchorMarker,
              Math.abs(sizeGroup.scale.x),
              Math.abs(sizeGroup.scale.y),
              getFrameThicknessWorldPx(this.orthographicCamera?.zoom ?? 1)
            );
          }
        }

        if (mesh && mesh.material instanceof THREE.MeshBasicMaterial) {
          // Effective = localized (textureKey via the preview locale) else authored.
          const currentTexturePath = node.getEffectiveTexturePath() ?? null;
          const previousTexturePath = (visualRoot.userData.texturePath as string | null) ?? null;
          if (currentTexturePath !== previousTexturePath) {
            mesh.material.map = null;
            mesh.material.needsUpdate = true;
            this.proxyRegistry.applyTextureToSprite2DMaterial(node, mesh.material);
            visualRoot.userData.texturePath = currentTexturePath;
          }
          // Honor a programmatic UV crop (node.textureRegion). A live script
          // appearance override, when active, is re-applied on top each preview
          // frame (flushComponentAppearanceOverrides), so skip here to avoid
          // fighting it.
          if (mesh.material.map && !this.previewTicker.hasOverride(node.nodeId)) {
            applyTextureRegionToTexture(mesh.material.map, node.textureRegion ?? null);
          }
        }

        this.proxyRegistry.apply2DVisualOpacity(node, visualRoot);
      }
    } else if (node instanceof ColorRect2D) {
      const visualRoot = this.proxyRegistry.colorRect2DVisuals.get(node.nodeId);
      if (visualRoot) {
        this.proxyRegistry.apply2DVisualTransform(node, visualRoot);
        const sizeGroup = visualRoot.userData.sizeGroup as THREE.Object3D | undefined;
        if (sizeGroup) {
          sizeGroup.scale.set(node.width, node.height, 1);
        }
        visualRoot.visible = node.visible;
        this.proxyRegistry.applyColorRect2DColor(node, visualRoot);
        this.proxyRegistry.apply2DVisualOpacity(node, visualRoot);
      }
    } else if (node instanceof UIControl2D) {
      const visualRoot = this.proxyRegistry.uiControl2DVisuals.get(node.nodeId);
      if (visualRoot) {
        this.proxyRegistry.apply2DVisualTransform(node, visualRoot);

        const sizeGroup = visualRoot.userData.sizeGroup as THREE.Object3D | undefined;
        if (sizeGroup) {
          const { width, height } = this.proxyRegistry.getUIControlDimensions(node);
          sizeGroup.scale.set(width, height, 1);
        }

        const mesh = visualRoot.userData.controlMesh as THREE.Mesh | undefined;
        if (mesh && mesh.material instanceof THREE.MeshBasicMaterial) {
          mesh.material.userData.baseOpacity = node instanceof Label2D ? 0 : 1;
          mesh.material.color.setHex(this.proxyRegistry.getUIControlDefaultColor(node));

          const currentTexturePath = this.proxyRegistry.getUIControlSkinTextureUrl(node);
          const previousTexturePath = (visualRoot.userData.texturePath as string | null) ?? null;
          if (currentTexturePath !== previousTexturePath) {
            mesh.material.map = null;
            mesh.material.needsUpdate = true;
            this.proxyRegistry.applyTextureTo2DMaterial(node, mesh.material);
            visualRoot.userData.texturePath = currentTexturePath;
          }
        }

        this.proxyRegistry.updateUIControlLabelVisual(visualRoot, node);
        this.proxyRegistry.apply2DVisualOpacity(node, visualRoot);
      }
    }

    if (node instanceof Node2D && this.selection2DOverlay?.nodeIds.includes(node.nodeId)) {
      this.refreshGizmoPositions();
    }
  }

  /**
   * Repaint every localized proxy after the preview locale or a locale table
   * changed. Label text comes from `node.getDisplayText()` and sprite/skin
   * textures from `getEffectiveTexturePath()`/`getEffectiveStateTexturePath()`,
   * all of which resolve through the active (editor-preview) localization
   * instance — so re-running the standard per-node visual sync picks up the new
   * translation / localized texture (the sync compares effective texture paths
   * and reloads only on change). Then forces a paint. Called from the
   * localization operations; a no-op when nothing is localized.
   */
  refreshLocalizedLabels(): void {
    const graph = this.sceneManager.getActiveSceneGraph();
    if (!graph) return;
    for (const nodeId of this.proxyRegistry.uiControl2DVisuals.keys()) {
      const node = graph.nodeMap.get(nodeId);
      if (node instanceof UIControl2D) {
        this.updateNodeTransform(node);
      }
    }
    for (const nodeId of this.proxyRegistry.sprite2DVisuals.keys()) {
      const node = graph.nodeMap.get(nodeId);
      if (node instanceof Sprite2D && node.textureKey) {
        this.updateNodeTransform(node);
      }
    }
    this.requestRender();
  }

  updateNodeVisibility(node: NodeBase): void {
    if (node instanceof Group2D) {
      const visualRoot = this.proxyRegistry.group2DVisuals.get(node.nodeId);
      if (visualRoot) {
        visualRoot.visible = node.visible;
      }
    } else if (node instanceof AnimatedSprite2D) {
      const visualRoot = this.proxyRegistry.animatedSprite2DVisuals.get(node.nodeId);
      if (visualRoot) {
        visualRoot.visible = node.visible;
      }
    } else if (node instanceof TiledSprite2D) {
      const visualRoot = this.proxyRegistry.tiledSprite2DVisuals.get(node.nodeId);
      if (visualRoot) {
        visualRoot.visible = node.visible;
      }
    } else if (node instanceof Sprite2D) {
      const visualRoot = this.proxyRegistry.sprite2DVisuals.get(node.nodeId);
      if (visualRoot) {
        visualRoot.visible = node.visible;
      }
    } else if (node instanceof ColorRect2D) {
      const visualRoot = this.proxyRegistry.colorRect2DVisuals.get(node.nodeId);
      if (visualRoot) {
        visualRoot.visible = node.visible;
      }
    } else if (node instanceof UIControl2D) {
      const visualRoot = this.proxyRegistry.uiControl2DVisuals.get(node.nodeId);
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
    this.proxyRegistry.updateSprite2DAnchorMarkerVisibility();

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
      (nodeToAttach instanceof Camera3D ||
        nodeToAttach instanceof DirectionalLightNode ||
        nodeToAttach instanceof SpotLightNode);

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

      // Proxies are about to be rebuilt with default (un-cropped) materials, and
      // nodeIds may be recycled — drop any stale editor appearance overrides.
      this.previewTicker.resetOverrides();

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
      for (const visual of this.proxyRegistry.group2DVisuals.values()) {
        if (visual.parent) {
          visual.parent.remove(visual);
        }
        this.disposeObject3D(visual);
      }
      this.proxyRegistry.group2DVisuals.clear();

      for (const visual of this.proxyRegistry.animatedSprite2DVisuals.values()) {
        if (visual.parent) {
          visual.parent.remove(visual);
        }
        this.proxyRegistry.disposeAnimatedSprite2DTexture(visual);
        this.disposeObject3D(visual);
      }
      this.proxyRegistry.animatedSprite2DVisuals.clear();

      for (const visual of this.proxyRegistry.sprite2DVisuals.values()) {
        if (visual.parent) {
          visual.parent.remove(visual);
        }
        this.disposeObject3D(visual);
      }
      this.proxyRegistry.sprite2DVisuals.clear();

      for (const visual of this.proxyRegistry.colorRect2DVisuals.values()) {
        if (visual.parent) {
          visual.parent.remove(visual);
        }
        this.disposeObject3D(visual);
      }
      this.proxyRegistry.colorRect2DVisuals.clear();

      for (const visual of this.proxyRegistry.tiledSprite2DVisuals.values()) {
        if (visual.parent) {
          visual.parent.remove(visual);
        }
        this.disposeObject3D(visual);
      }
      this.proxyRegistry.tiledSprite2DVisuals.clear();
      this.sprite3DTexturePaths.clear();
      this.particles3DTexturePaths.clear();
      this.geometryMeshMapPaths.clear();

      for (const visual of this.proxyRegistry.uiControl2DVisuals.values()) {
        if (visual.parent) {
          visual.parent.remove(visual);
        }
        this.disposeObject3D(visual);
      }
      this.proxyRegistry.uiControl2DVisuals.clear();
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

      // Restore 2D overlay camera whenever the scene changes once viewport sizing is known.
      if (this.hasMeasuredViewport()) {
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

    if (node instanceof GeometryMesh) {
      this.syncGeometryMeshMap(node);
    }

    let current2DVisualRoot = parent2DVisualRoot;

    if (node instanceof Group2D) {
      const visualRoot = this.proxyRegistry.createGroup2DVisual(node);
      this.proxyRegistry.group2DVisuals.set(node.nodeId, visualRoot);

      const parent = parent2DVisualRoot ?? this.scene;
      parent.add(visualRoot);
      current2DVisualRoot = visualRoot;
    } else if (node instanceof AnimatedSprite2D) {
      const visualRoot = this.proxyRegistry.createAnimatedSprite2DVisual(node);
      this.proxyRegistry.animatedSprite2DVisuals.set(node.nodeId, visualRoot);

      const parent = parent2DVisualRoot ?? this.scene;
      parent.add(visualRoot);
      current2DVisualRoot = visualRoot;
    } else if (node instanceof Sprite2D) {
      const visualRoot = this.proxyRegistry.createSprite2DVisual(node);
      this.proxyRegistry.sprite2DVisuals.set(node.nodeId, visualRoot);

      const parent = parent2DVisualRoot ?? this.scene;
      parent.add(visualRoot);
      current2DVisualRoot = visualRoot;
    } else if (node instanceof ColorRect2D) {
      const visualRoot = this.proxyRegistry.createColorRect2DVisual(node);
      this.proxyRegistry.colorRect2DVisuals.set(node.nodeId, visualRoot);

      const parent = parent2DVisualRoot ?? this.scene;
      parent.add(visualRoot);
      current2DVisualRoot = visualRoot;
    } else if (node instanceof TiledSprite2D) {
      const visualRoot = this.proxyRegistry.createTiledSprite2DVisual(node);
      this.proxyRegistry.tiledSprite2DVisuals.set(node.nodeId, visualRoot);

      const parent = parent2DVisualRoot ?? this.scene;
      parent.add(visualRoot);
      current2DVisualRoot = visualRoot;
    } else if (node instanceof UIControl2D) {
      const visualRoot = this.proxyRegistry.createUIControl2DVisual(node);
      this.proxyRegistry.uiControl2DVisuals.set(node.nodeId, visualRoot);

      const parent = parent2DVisualRoot ?? this.scene;
      parent.add(visualRoot);
      current2DVisualRoot = visualRoot;
    }

    for (const child of node.children) {
      this.processNodeForRendering(child, current2DVisualRoot);
    }
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
        this.isLayer3DVisible() &&
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

  private getTargetNodeForObject(
    object: THREE.Object3D
  ): Camera3D | DirectionalLightNode | SpotLightNode | null {
    const parentNodeId = object.userData.parentNodeId;
    if (typeof parentNodeId !== 'string') {
      return null;
    }

    const sceneGraph = this.sceneManager.getActiveSceneGraph();
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
    const isActive = this.activeTargetNodeId === nodeId;
    gizmo.traverse(child => {
      if (child.userData.isTargetOutline) {
        child.visible = isActive;
      }
    });
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

  private syncSprite3DBillboarding(camera: THREE.Camera): void {
    const sceneGraph = this.sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      return;
    }

    const cameraQuaternion = camera.getWorldQuaternion(new THREE.Quaternion());
    const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
    const visit = (nodes: NodeBase[]) => {
      for (const node of nodes) {
        if (node instanceof Sprite3D) {
          node.applyBillboard(cameraQuaternion);
        } else if (node instanceof Particles3D) {
          // Camera position drives trail ribbons; world-space compensation latches here too.
          node.syncRenderState(cameraQuaternion, cameraPosition);
        }
        if (node.children.length > 0) {
          visit(node.children);
        }
      }
    };

    visit(sceneGraph.rootNodes);
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
              configureSpriteTexture(texture);
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
          configureSpriteTexture(texture);
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
              configureSpriteTexture(texture);
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
          configureSpriteTexture(texture);
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

  /**
   * Load & assign a GeometryMesh's albedo map in the editor viewport when its
   * res:// path changes (the runtime node only tracks the path; the loader does
   * this at scene-load / play time). 3D textures keep mipmaps, so — unlike the
   * 2D sprite path — we do NOT run it through configureSpriteTexture; setMap
   * forces the colour space and leaves mipmapping on.
   */
  private syncGeometryMeshMap(node: GeometryMesh): void {
    const currentMapPath = node.mapSrc || null;
    const previousMapPath = this.geometryMeshMapPaths.get(node.nodeId) ?? null;
    if (currentMapPath === previousMapPath) {
      return;
    }

    this.geometryMeshMapPaths.set(node.nodeId, currentMapPath);
    if (!currentMapPath) {
      node.setMap(null);
      this.requestRender();
      return;
    }

    const textureLoader = new THREE.TextureLoader();
    void (async () => {
      try {
        const blob = await this.resourceManager.readBlob(currentMapPath);
        const blobUrl = URL.createObjectURL(blob);
        textureLoader.load(
          blobUrl,
          texture => {
            try {
              node.setMap(texture);
              this.requestRender();
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
        const schemeMatch = /^([a-z]+[a-z0-9+.-]*):\/\//i.exec(currentMapPath);
        const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : '';
        if (scheme === 'http' || scheme === 'https' || scheme === '') {
          const texture = textureLoader.load(currentMapPath, undefined, undefined, () => {
            console.warn('[ViewportRenderer] Failed to load GeometryMesh map', currentMapPath);
          });
          node.setMap(texture);
          this.requestRender();
          return;
        }
      }

      console.warn('[ViewportRenderer] Skipping GeometryMesh map load for scheme', currentMapPath);
    })();
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
      this.selection2DHud.hide();
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
    this.selection2DHud.hide();
    console.debug('[ViewportRenderer] cleared 2D overlay');
  }

  /**
   * Get bounds for a single 2D node, NOT including its descendants.
   * Uses the node's own size/transform rather than recursively computing from children.
   */
  getNode2DBounds(node: Node2D): THREE.Box3 {
    return this.getNodeOnlyBounds(node);
  }

  /**
   * A node's own (node-local, pre-matrixWorld) corner points, anchor-aware per node type. Public so
   * geometry operations (e.g. Group2D fit-to-contents) can measure nodes without duplicating the
   * per-type size logic.
   */
  getNodeOnlyLocalCorners(node: Node2D): THREE.Vector3[] {
    let corners: THREE.Vector3[];

    if (node instanceof Sprite2D || node instanceof TiledSprite2D) {
      // Account for the anchor/pivot offset: the visual mesh is shifted from the
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
      } else if (node instanceof ColorRect2D) {
        halfWidth = node.width / 2;
        halfHeight = node.height / 2;
      } else if (node instanceof UIControl2D) {
        const { width, height } = this.proxyRegistry.getUIControlDimensions(node);
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

    return corners;
  }

  private getNodeOnlyWorldCorners(node: Node2D): THREE.Vector3[] {
    node.updateWorldMatrix(true, false);
    return this.getNodeOnlyLocalCorners(node).map(corner => corner.applyMatrix4(node.matrixWorld));
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

  private getSelection2DOverlayGeometry(
    nodeIds: string[],
    sceneGraph: SceneGraph,
    combinedBounds: THREE.Box3
  ): {
    centerWorld: THREE.Vector3;
    localBounds: THREE.Box3;
    worldRotationZ: number;
  } {
    const centerWorld = combinedBounds.getCenter(new THREE.Vector3());
    const localBounds = combinedBounds.clone().translate(centerWorld.clone().multiplyScalar(-1));

    if (nodeIds.length !== 1) {
      return { centerWorld, localBounds, worldRotationZ: 0 };
    }

    const node = sceneGraph.nodeMap.get(nodeIds[0]);
    if (!(node instanceof Node2D)) {
      return { centerWorld, localBounds, worldRotationZ: 0 };
    }

    const worldQuaternion = node.getWorldQuaternion(new THREE.Quaternion());
    const worldRotationZ = new THREE.Euler().setFromQuaternion(worldQuaternion, 'XYZ').z;
    const worldCorners = this.getNodeOnlyWorldCorners(node);
    if (worldCorners.length === 0) {
      return { centerWorld, localBounds, worldRotationZ };
    }

    const orientedCenterWorld = worldCorners
      .reduce((sum, corner) => sum.add(corner), new THREE.Vector3())
      .multiplyScalar(1 / worldCorners.length);
    const orientedLocalBounds = new THREE.Box3();

    for (const corner of worldCorners) {
      const localCorner = this.rotateVectorZ(
        corner.clone().sub(orientedCenterWorld),
        -worldRotationZ
      );
      orientedLocalBounds.expandByPoint(localCorner);
    }

    return {
      centerWorld: orientedCenterWorld,
      localBounds: orientedLocalBounds,
      worldRotationZ,
    };
  }

  private getNodeOnlyBounds(node: Node2D): THREE.Box3 {
    const bounds = new THREE.Box3();

    // Transform corners to world space and expand bounds
    for (const corner of this.getNodeOnlyWorldCorners(node)) {
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

    const overlayGeometry = this.getSelection2DOverlayGeometry(
      node2DIds,
      sceneGraph,
      combinedBounds
    );
    console.debug('[ViewportRenderer] update2DOverlay: creating overlay', {
      node2DIds,
      center: overlayGeometry.centerWorld,
      combinedBounds,
      worldRotationZ: overlayGeometry.worldRotationZ,
    });

    this.clear2DSelectionOverlay();

    const frame = this.create2DFrame(overlayGeometry.localBounds);
    const handles = this.create2DHandles(overlayGeometry.localBounds);
    const group = new THREE.Group();
    group.add(frame, ...handles);
    group.position.copy(overlayGeometry.centerWorld);
    group.rotation.set(0, 0, overlayGeometry.worldRotationZ);
    group.renderOrder = 1000;
    group.layers.set(1);
    this.scene.add(group);

    this.selection2DOverlay = {
      group,
      handles,
      frame,
      nodeIds: node2DIds,
      combinedBounds,
      centerWorld: overlayGeometry.centerWorld,
      localBounds: overlayGeometry.localBounds,
      worldRotationZ: overlayGeometry.worldRotationZ,
      rotationHandle: handles.find(h => h.userData?.handleType === 'rotate'),
    };

    // Apply zoom compensation immediately so handles have the correct screen-space size.
    this.refreshGizmoPositions();
    this.selection2DHud.update();
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

    const overlayGeometry = this.getSelection2DOverlayGeometry(
      this.selection2DOverlay.nodeIds,
      sceneGraph,
      combinedBounds
    );
    this.selection2DOverlay.combinedBounds.copy(combinedBounds);
    this.selection2DOverlay.centerWorld.copy(overlayGeometry.centerWorld);
    if (!this.selection2DOverlay.localBounds) {
      this.selection2DOverlay.localBounds = new THREE.Box3();
    }
    this.selection2DOverlay.localBounds.copy(overlayGeometry.localBounds);
    this.selection2DOverlay.worldRotationZ = overlayGeometry.worldRotationZ;
    this.sync2DServiceFrameThickness();
  }

  private projectWorldToOverlay(world: THREE.Vector3): { x: number; y: number } | null {
    if (!this.orthographicCamera || this.viewportSize.width <= 0 || this.viewportSize.height <= 0) {
      return null;
    }

    const projected = world.clone().project(this.orthographicCamera);
    return {
      x: ((projected.x + 1) / 2) * this.viewportSize.width,
      y: ((1 - projected.y) / 2) * this.viewportSize.height,
    };
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
   * Resolve the node a click/hover should target from a raw hit leaf, applying
   * the Figma-style isolation scope (`appState.selection.focusNodeId`). Shared
   * with the click path (editor-tab) via {@link resolveViewportClick} so hover
   * highlights exactly what a click would select. Returns `null` if nothing
   * resolves or the candidate is not a live node.
   */
  private resolveScoped2DCandidateNode(leafId: string, deep: boolean): NodeBase | null {
    const activeSceneId = appState.scenes.activeSceneId;
    if (!activeSceneId) {
      return null;
    }
    const sceneGraph = this.sceneManager.getSceneGraph(activeSceneId);
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

  /**
   * Update 2D hover preview frame based on pointer position.
   * Shows a preview frame around the 2D node under the cursor.
   * Group2D nodes show in a different color.
   * Returns true if the hover state changed.
   */
  update2DHoverPreview(
    screenX: number,
    screenY: number,
    options: { deep?: boolean } = {}
  ): boolean {
    // Don't show hover preview during active transform or if selection overlay is being interacted with
    if (this.active2DTransform) {
      return this.clear2DHoverPreview();
    }

    // Only real resize/rotate handles suppress hover. The 'move' body zone no
    // longer does, so nodes painted in front of the current selection stay
    // hoverable (and clickable) even inside its manipulator frame.
    const handleType = this.get2DHandleAt(screenX, screenY);
    if (handleType !== 'idle' && handleType !== 'move') {
      return this.clear2DHoverPreview();
    }

    // Raycast to the raw frontmost leaf, then resolve what a click would select
    // (given the isolation scope + deep modifier) so hover matches the click.
    const leaf = this.raycast2D(screenX, screenY);
    if (!leaf) {
      return this.clear2DHoverPreview();
    }

    const hit = this.resolveScoped2DCandidateNode(leaf.nodeId, Boolean(options.deep));
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

    this.dispose2DPreviewFrame(this.hoverPreview2D.frame);

    this.hoverPreview2D = undefined;
    return true;
  }

  clear2DMarqueePreview(): boolean {
    if (this.marqueePreview2DFrames.size === 0) {
      return false;
    }

    for (const frame of this.marqueePreview2DFrames.values()) {
      this.dispose2DPreviewFrame(frame);
    }
    this.marqueePreview2DFrames.clear();
    return true;
  }

  private dispose2DPreviewFrame(frame: THREE.Group | undefined): void {
    if (!frame) {
      return;
    }

    if (this.scene) {
      this.scene.remove(frame);
    }

    frame.traverse(obj => {
      if (obj instanceof THREE.Mesh && obj.geometry) {
        obj.geometry.dispose();
        if (obj.material instanceof THREE.Material) {
          obj.material.dispose();
        }
      }
    });
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

    const thickness = getFrameThicknessWorldPx(1);

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
      // Reflect the correct HUD state from the first frame: move hides it,
      // resize keeps the live size badge, rotate shows the live angle badge.
      this.selection2DHud.update();
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
      }
    }
    // A container resize proportionally scales its descendants (in TransformTool2d) — repaint all 2D
    // proxies once per frame so the child visuals track the drag. `childStartStates` is populated
    // (scale gesture only) for any container with eligible children, Group2D or a sprite parenting
    // other 2D nodes alike.
    const resizingContainer = (this.active2DTransform.childStartStates?.size ?? 0) > 0;
    if (resizingContainer) {
      this.syncAll2DVisuals();
    }
  }

  async complete2DTransform(): Promise<void> {
    if (!this.active2DTransform) {
      return;
    }

    const { nodeIds, startStates, childStartStates, handle } = this.active2DTransform;
    const sceneGraph = this.sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      this.active2DTransform = undefined;
      this.end2DInteraction();
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
      await this.operationService.invokeAndPush(new Transform2DBatchOperation({ plans, label }));
    }

    const savedNodeIds = [...nodeIds];
    // Clear active handle visual feedback before clearing the transform
    this.transformTool2d.clearActiveHandle(this.selection2DOverlay);
    this.active2DTransform = undefined;
    this.end2DInteraction();
    this.update2DSelectionOverlayForNodes(savedNodeIds);
    this.requestRender();
    console.debug('[ViewportRenderer] complete 2D transform', { nodeIds });
  }

  /**
   * Move all currently-selected 2D nodes by (dx, dy) in world units. Backs the
   * arrow-key nudge commands. The whole move is a single, undoable history entry
   * (even across a multi-node selection) and refreshes the selection overlay.
   *
   * @returns true if at least one node moved.
   */
  async nudgeSelected2DNodes(dx: number, dy: number): Promise<boolean> {
    if (dx === 0 && dy === 0) {
      return false;
    }

    const sceneGraph = this.sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      return false;
    }

    const nodeIds = appState.selection.nodeIds.filter(
      id => sceneGraph.nodeMap.get(id) instanceof Node2D
    );
    if (nodeIds.length === 0) {
      return false;
    }

    const pushed = await this.operationService.invokeAndPush(
      new Nudge2DNodesOperation({ dx, dy, nodeIds })
    );

    this.update2DSelectionOverlayForNodes(nodeIds);
    this.requestRender();
    return pushed;
  }

  private toNdc(screenX: number, screenY: number): THREE.Vector2 | null {
    const { width, height } = this.viewportSize;
    if (width <= 0 || height <= 0) return null;
    return new THREE.Vector2((screenX / width) * 2 - 1, -(screenY / height) * 2 + 1);
  }

  private resolve3DAssetDropFallback(objectSize?: THREE.Vector3 | null): THREE.Vector3 | null {
    if (!this.camera) {
      return null;
    }

    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    if (forward.lengthSq() === 0) {
      forward.set(0, 0, -1);
    }
    forward.normalize();

    if (this.camera instanceof THREE.PerspectiveCamera) {
      const maxDim = Math.max(objectSize?.x ?? 1, objectSize?.y ?? 1, objectSize?.z ?? 1, 0.001);
      const fov = MathUtils.degToRad(this.camera.fov);
      const distance = Math.max((maxDim * 1.5) / Math.tan(fov / 2), this.camera.near + maxDim, 1);

      return this.camera.position.clone().add(forward.multiplyScalar(distance));
    }

    const orbitDistance = this.orbitControls
      ? this.camera.position.distanceTo(this.orbitControls.target)
      : Math.max(objectSize?.length() ?? 1, 10);

    return this.camera.position.clone().add(forward.multiplyScalar(Math.max(orbitDistance, 1)));
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
      return this.proxyRegistry.group2DVisuals.get(node.nodeId);
    }
    if (node instanceof AnimatedSprite2D) {
      return this.proxyRegistry.animatedSprite2DVisuals.get(node.nodeId);
    }
    if (node instanceof TiledSprite2D) {
      return this.proxyRegistry.tiledSprite2DVisuals.get(node.nodeId);
    }
    if (node instanceof Sprite2D) {
      return this.proxyRegistry.sprite2DVisuals.get(node.nodeId);
    }
    if (node instanceof ColorRect2D) {
      return this.proxyRegistry.colorRect2DVisuals.get(node.nodeId);
    }
    if (node instanceof UIControl2D) {
      return this.proxyRegistry.uiControl2DVisuals.get(node.nodeId);
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
      this.renderLoopTick();
    };

    this.isPaused = false;
    this.renderRequested = true;
    render();
  }

  /**
   * One iteration of the rAF loop. Skips all render work while the viewport
   * is idle so a backgrounded/untouched editor doesn't burn CPU/GPU at 60fps;
   * the idle heartbeat still paints an occasional frame as a safety net for
   * changes that never called requestRender().
   */
  private renderLoopTick(): void {
    if (
      !this.renderRequested &&
      !this.hasContinuousPreviewWork() &&
      performance.now() - this.lastRenderedAt < IDLE_RENDER_INTERVAL_MS
    ) {
      return;
    }

    this.renderFrame();
  }

  /**
   * True while an editor-side preview is animating and therefore needs a
   * fresh frame every tick (animation clip preview, particle preview, or a
   * script component with an editor preview ticker). The particle/component
   * counts are refreshed by their tickers on every rendered frame.
   */
  private hasContinuousPreviewWork(): boolean {
    return this.previewAnimationActions.size > 0 || this.previewTicker.hasActivePreview();
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

    this.previewTicker.resetOverrides();

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

    // Dispose post-processing composer (render targets)
    this.postFx?.dispose();
    this.postFx = null;

    // Dispose Three.js resources
    this.selectionBoxes.forEach(box => {
      box.geometry.dispose();
      if (box.material instanceof THREE.Material) {
        box.material.dispose();
      }
    });
    this.selectionBoxes.clear();

    for (const visual of this.proxyRegistry.group2DVisuals.values()) {
      this.disposeObject3D(visual);
    }
    this.proxyRegistry.group2DVisuals.clear();

    for (const visual of this.proxyRegistry.animatedSprite2DVisuals.values()) {
      this.proxyRegistry.disposeAnimatedSprite2DTexture(visual);
      this.disposeObject3D(visual);
    }
    this.proxyRegistry.animatedSprite2DVisuals.clear();

    for (const visual of this.proxyRegistry.sprite2DVisuals.values()) {
      this.disposeObject3D(visual);
    }
    this.proxyRegistry.sprite2DVisuals.clear();

    for (const visual of this.proxyRegistry.colorRect2DVisuals.values()) {
      this.disposeObject3D(visual);
    }
    this.proxyRegistry.colorRect2DVisuals.clear();

    for (const visual of this.proxyRegistry.tiledSprite2DVisuals.values()) {
      this.disposeObject3D(visual);
    }
    this.proxyRegistry.tiledSprite2DVisuals.clear();
    this.sprite3DTexturePaths.clear();
    this.particles3DTexturePaths.clear();
    this.geometryMeshMapPaths.clear();

    for (const visual of this.proxyRegistry.uiControl2DVisuals.values()) {
      this.disposeObject3D(visual);
    }
    this.proxyRegistry.uiControl2DVisuals.clear();
    this.clearNodeIcons();

    this.clear2DSelectionOverlay();
    this.clear2DHoverPreview();
    this.clear2DMarqueePreview();

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
    this.selection2DHud.dispose();

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
