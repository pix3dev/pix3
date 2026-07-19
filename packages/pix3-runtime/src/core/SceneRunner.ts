import {
  Camera,
  Clock,
  Scene,
  OrthographicCamera,
  Color,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
  type Object3D,
} from 'three';
import { SceneManager } from './SceneManager';
import { RuntimeRenderer } from './RuntimeRenderer';
import { InputService } from './InputService';
import { SceneService, type FrameProfilerActivity } from './SceneService';
import { AudioService, type ActiveAudioPlaybackSnapshot } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { Camera3D } from '../nodes/3D/Camera3D';
import { NodeBase } from '../nodes/NodeBase';
import { Node2D } from '../nodes/Node2D';
import { Camera2D, findActiveCamera2D } from '../nodes/2D/Camera2D';
import { Sprite3D } from '../nodes/3D/Sprite3D';
import { AnimatedSprite3D } from '../nodes/3D/AnimatedSprite3D';
import { Particles3D } from '../nodes/3D/Particles3D';
import { InstancedMesh3D } from '../nodes/3D/InstancedMesh3D';
import { AudioPlayer } from '../nodes/AudioPlayer';
import { PostProcess } from '../nodes/PostProcess';
import { GeometryMesh } from '../nodes/3D/GeometryMesh';
import { PostProcessingPipeline } from './PostProcessingPipeline';
import { LAYER_3D, LAYER_2D, LAYER_2D_OVERLAY } from '../constants';
import { assign2DRenderOrder } from './render-order-2d';
import { assign2DLayers } from './assign-2d-layers';
import { Batch2DSystem, type Batch2DStats, type OrderedMesh2D } from './batch-2d';
import { LocalizationService } from './localization/LocalizationService';
import type { LocalizationConfig } from './localization/localization-types';
import { setActiveLocalization, getActiveLocalization } from './localization/active-localization';
import { applyLocaleToTree } from './localization/apply-locale-to-tree';
import { ECSService } from './ECSService';
import type { SceneRaycastHit } from './raycast';
import type { RuntimeRendererStatsSnapshot } from './RuntimeRenderer';
import {
  registerRuntimeSceneRoot,
  registerRuntimeLivePropertySink,
  isPhysicsDebugEnabled,
  isDirectionAxesEnabled,
  reportScriptError,
  describeThrown,
} from './game-debug';
import { PhysicsDebugOverlay } from './physics-debug-overlay';
import { DirectionAxesOverlay } from './direction-axes-overlay';
import { worldToCanvasLogical, worldToCanvasThroughCamera } from './world-to-canvas';
import { getNodePropertySchema } from '../fw/property-schema-utils';
import { GameTime } from './GameTime';
import { playable } from './PlayableSdk';

/**
 * Below this slow-mo base scale the audio mixer blends to the `'muffled'`
 * snapshot. Compared against `gameTime.baseScale` (hitstop-independent) so an
 * 80 ms micro-freeze never touches the filter.
 */
const SLOWMO_MUFFLE_THRESHOLD = 0.999;

export interface SceneRunnerFrameSample {
  readonly dt: number;
  readonly elapsedTime: number;
  readonly frameNumber: number;
  readonly logicMs: number;
  readonly renderMs: number;
  readonly totalFrameMs: number;
  readonly rendererStats: RuntimeRendererStatsSnapshot;
  readonly profilerActivities?: readonly FrameProfilerActivity[];
  readonly activeAudioPlaybacks?: readonly ActiveAudioPlaybackSnapshot[];
}

type SceneRunnerFrameListener = (sample: SceneRunnerFrameSample) => void;

/**
 * Normalize a scene path to the res://-relative form used as a resource key:
 * back-slashes → forward, a leading `res://` stripped, leading slashes trimmed.
 * No extension is appended — callers pass the full `.pix3scene` path.
 */
function normalizeScenePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^res:\/\//i, '')
    .replace(/^\/+/, '');
}

export class SceneRunner {
  private readonly sceneManager: SceneManager;
  private readonly renderer: RuntimeRenderer;
  private readonly assetLoader: AssetLoader;
  private readonly inputService: InputService;
  private readonly sceneService: SceneService;
  private readonly ecsService: ECSService;
  private readonly audioService: AudioService;
  private readonly resourceManager: ResourceManager;
  private readonly clock: Clock;
  /** Global time-scale controller (hitstop / slow-mo); scales gameplay dt. */
  private readonly gameTime = new GameTime();
  /** True while the mixer is in the slow-mo `'muffled'` snapshot (edge-triggered). */
  private audioMuffled = false;
  private readonly raycaster = new Raycaster();
  private readonly raycastPointer = new Vector2();
  private animationFrameId: number | null = null;
  private isRunning: boolean = false;
  private fixedTimeAccumulator = 0;
  private elapsedTime = 0;
  private frameNumber = 0;

  private scene: Scene;
  private activeCamera: Camera3D | null = null;
  /** Highest-priority visible Camera2D driving the 2D ortho pass (null = identity). */
  private activeCamera2D: Camera2D | null = null;
  private readonly scratchShake2D = new Vector2();
  private orthographicCamera: OrthographicCamera;
  /** Fixed overlay camera for CanvasLayer2D content (identity, LAYER_2D_OVERLAY,
   * never Camera2D-driven); rendered after post-processing. */
  private overlayCamera: OrthographicCamera;
  /** True this frame when the scene contains a CanvasLayer2D boundary — gates
   * the extra overlay render/raycast passes. */
  private overlay2DActive = false;
  private viewportSize = { width: 0, height: 0 };
  /** Canvas CSS size maintained by a ResizeObserver so the render loop never
   * queries `clientWidth`/`clientHeight` per frame — those force a synchronous
   * reflow of the host document whenever anything invalidated layout that frame
   * (in-editor that's practically every frame while HUD panels update). */
  private canvasCssSize: { width: number; height: number } | null = null;
  private canvasSizeObserver: ResizeObserver | null = null;
  private observedCanvas: HTMLCanvasElement | null = null;
  /** Adaptive logical camera dimensions computed from viewportBaseSize + viewport aspect. */
  private logicalCameraSize = { width: 1, height: 1 };
  private readonly rootLayoutAuthoredSize: { width: number; height: number };
  private readonly frameListeners = new Set<SceneRunnerFrameListener>();
  private currentFrameProfilerActivities: FrameProfilerActivity[] = [];
  /** Lazily created collider wireframe overlay (only while physics debug is on). */
  private physicsDebugOverlay: PhysicsDebugOverlay | null = null;
  /** Lazily created direction-axis gizmo overlay (only while axes debug is on). */
  private directionAxesOverlay: DirectionAxesOverlay | null = null;
  /** Lazily created post-processing composer (only while a PostProcess node is
   * active). Null when no effects are enabled — then the plain two-pass path runs. */
  private postFx: PostProcessingPipeline | null = null;
  /** Phase-3 2D quad batcher (only while enabled). Rebuilt from a fresh scene. */
  private batch2D: Batch2DSystem | null = null;
  private batch2DEnabled = false;

  /** Play-mode localization: its own instance so a game `setLocale` never leaks
   *  into the editor preview. Created in `runGraph`, torn down in `stop()`. */
  private localization: LocalizationService | null = null;
  /** The active-localization pointer that was live before we started (the editor
   *  preview instance in-editor, or null in exports) — restored on `stop()`. */
  private previousActiveLocalization: LocalizationService | null = null;
  private localizationUnsub: (() => void) | null = null;
  /** Config injected by the host before `startScene` (from the project manifest);
   *  null = no localization block ⇒ an inert default instance. */
  private localizationConfig: LocalizationConfig | null = null;
  /** Locale to seed the play instance with (editor's current preview locale), so
   *  "preview ru → Play" starts in ru; null ⇒ config's `defaultLocale`. */
  private seedLocale: string | null = null;
  /** Reused per-frame collector for the render-order walk → batcher input. */
  private readonly ordered2DBuffer: OrderedMesh2D[] = [];

  constructor(
    sceneManager: SceneManager,
    renderer: RuntimeRenderer,
    audioService: AudioService,
    assetLoader: AssetLoader,
    rootLayoutAuthoredSize: { width: number; height: number } = { width: 1920, height: 1080 }
  ) {
    this.sceneManager = sceneManager;
    this.renderer = renderer;
    this.assetLoader = assetLoader;
    this.inputService = new InputService();
    this.sceneService = new SceneService();
    this.ecsService = new ECSService();
    this.audioService = audioService;
    this.resourceManager = assetLoader.getResourceManager();
    this.clock = new Clock();
    this.scene = new Scene();
    this.rootLayoutAuthoredSize = {
      width: Math.max(1, rootLayoutAuthoredSize.width),
      height: Math.max(1, rootLayoutAuthoredSize.height),
    };
    // Default background
    this.scene.background = new Color('#202020');

    // Setup 2D Camera
    // Initial size 1x1, will be resized immediately
    this.orthographicCamera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.orthographicCamera.position.z = 100;
    this.orthographicCamera.layers.disableAll();
    this.orthographicCamera.layers.enable(LAYER_2D);

    // Fixed overlay camera (CanvasLayer2D): tracks the main frustum size but
    // stays at identity position/zoom — never driven by Camera2D — and sees
    // only the overlay layer. Rendered clean, after the post-processing pass.
    this.overlayCamera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.overlayCamera.position.z = 100;
    this.overlayCamera.layers.disableAll();
    this.overlayCamera.layers.enable(LAYER_2D_OVERLAY);

    this.bindSceneServiceDelegate();
  }

  /**
   * Enable/disable the Phase-3 2D quad batcher for this runner. Set before
   * `startScene`. When off, the 2D pass is byte-identical to the pre-batching
   * path (source meshes render individually).
   */
  setBatching2DEnabled(enabled: boolean): void {
    this.batch2DEnabled = enabled;
    if (!enabled && this.batch2D) {
      this.batch2D.dispose();
      this.batch2D = null;
    }
  }

  /** Current batcher stats for the last frame, or null when batching is off. */
  getBatch2DStats(): Batch2DStats | null {
    return this.batch2D ? this.batch2D.stats : null;
  }

  /**
   * Configure play-mode localization. Call before `startScene`. `config` comes
   * from the project manifest's `localization` block (null = no localization);
   * `seedLocale` is the editor's current preview locale so play starts in it
   * (omit in exports to start in `config.defaultLocale`). The generated export
   * bootstrap instead `await`s `setLocale(defaultLocale)` before start (no seed).
   */
  setLocalizationConfig(config: LocalizationConfig | null, seedLocale?: string | null): void {
    this.localizationConfig = config;
    this.seedLocale = seedLocale ?? null;
  }

  /**
   * Start running a specific scene.
   * Clears the current scene, loads the new one, and starts the loop.
   */
  private runtimeGraph: import('./SceneManager').SceneGraph | null = null;

  async startScene(sceneId: string): Promise<void> {
    const sourceGraph = this.sceneManager.getSceneGraph(sceneId);
    if (!sourceGraph) {
      console.warn(`[SceneRunner] Scene "${sceneId}" not found.`);
      return;
    }

    // CLONE: Serialize and parse to create an isolated runtime graph. Done
    // BEFORE stopping (runGraph stops) so a clone failure never kills a running
    // scene — matters for changeScene(), harmless for the initial start.
    let clone: import('./SceneManager').SceneGraph;
    try {
      const serialized = this.sceneManager.serializeScene(sourceGraph);
      clone = await this.sceneManager.parseScene(serialized);
    } catch (err) {
      console.error('[SceneRunner] Failed to clone scene for runtime:', err);
      // Surface to the caller (the editor's GamePlaySessionService wraps this in
      // a try/catch that reports the failure); previously this returned silently,
      // leaving the Game tab stuck on "Preparing runtime preview".
      throw err;
    }

    this.runGraph(clone);
  }

  /**
   * Read a `.pix3scene` by path (res:// prefix optional), parse it, and swap the
   * running scene to it. Used by `SceneService.changeScene`. Parsing goes
   * through `sceneManager.parseScene`, which is a pure passthrough — it does NOT
   * register the graph in the (editor-shared) SceneManager, so the target lives
   * only in this runner's `runtimeGraph`. Throws (leaving the old scene running)
   * if the file is missing or the YAML is invalid.
   */
  async loadAndStartScene(path: string): Promise<void> {
    const filePath = normalizeScenePath(path);
    const text = await this.resourceManager.readText(`res://${filePath}`);
    const graph = await this.sceneManager.parseScene(text, { filePath });
    this.runGraph(graph);
  }

  /** Monotonic id source for runtime-spawned prefab instances. */
  private spawnCounter = 0;

  /**
   * Spawn a prefab scene into the RUNNING graph (Godot `instantiate()` +
   * `add_child()` in one call). The subtree gets unique runtime ids, inherits
   * `input`/`scene` from the parent (so component `onStart` fires on the next
   * tick), and honors `initiallyVisible`. Default parent is the first scene
   * root node; despawn with `node.dispose()`.
   */
  async instantiatePrefab(path: string, parent?: NodeBase | null): Promise<NodeBase> {
    if (!this.isRunning || !this.runtimeGraph) {
      throw new Error('[SceneRunner] instantiatePrefab requires a running scene.');
    }
    this.spawnCounter += 1;
    const instanceId = `spawn-${this.spawnCounter}`;
    const node = await this.sceneManager.instantiatePrefab(path, instanceId);

    const target = parent ?? this.runtimeGraph.rootNodes[0] ?? null;
    if (!target) {
      node.dispose();
      throw new Error('[SceneRunner] instantiatePrefab: no parent node available.');
    }
    target.adoptChild(node);
    this.applyInitialVisibility([node]);
    return node;
  }

  /**
   * Take exclusive ownership of `graph` and run it, stopping whatever ran
   * before. The graph MUST be runner-private (a fresh clone or a fresh parse) —
   * it is disposed on the next `stop()`, so never pass a graph still registered
   * in the SceneManager or referenced by the editor.
   */
  private runGraph(graph: import('./SceneManager').SceneGraph): void {
    this.stop();
    this.bindSceneServiceDelegate();
    playable.reset();

    // Ensure fade overlay is positioned over the correct canvas
    this.sceneService.attachCanvas(this.renderer.domElement);

    // Setup scene
    this.scene.clear();
    this.activeCamera = null;
    this.activeCamera2D = null;
    // Fresh error de-dup per scene so an identical message from the previous
    // scene doesn't suppress the first occurrence here.
    this.lastTickErrorMessage = null;

    this.runtimeGraph = graph;

    // Add root nodes to the THREE.Scene
    for (const node of this.runtimeGraph.rootNodes) {
      // Inject InputService
      node.input = this.inputService;
      // Inject SceneService
      node.scene = this.sceneService;
      this.scene.add(node);
    }

    // Expose the live runtime scene root for dev tooling (the editor debug
    // bridge / Runtime panel). This is the *running clone*, not the authored
    // graph — the only place spawned objects (droppables, clusters) live.
    registerRuntimeSceneRoot(this.scene);

    // Let inspector/debug property edits hot-reload into this running clone
    // (P0.5). The sink is cleared in stop() so edits fall back to no-op in
    // edit mode.
    registerRuntimeLivePropertySink((nodeId, propertyPath, value) =>
      this.applyLivePropertyUpdate(nodeId, propertyPath, value)
    );

    this.applyInitialVisibility(this.runtimeGraph.rootNodes);

    // Attach InputService to renderer
    this.inputService.attach(this.renderer.domElement);

    // Find the first camera to use
    this.activeCamera = this.findActiveCamera(this.runtimeGraph.rootNodes);

    if (this.activeCamera) {
      // Ensure 3D camera only sees 3D layer
      this.activeCamera.camera.layers.disableAll();
      this.activeCamera.camera.layers.enable(LAYER_3D);
    }

    // Reset viewport tracking so render() recomputes logicalCameraSize on the first tick.
    this.viewportSize = { width: 0, height: 0 };
    this.logicalCameraSize = { width: 1, height: 1 };
    this.fixedTimeAccumulator = 0;
    this.elapsedTime = 0;
    this.frameNumber = 0;
    this.gameTime.reset();
    this.audioMuffled = false;

    // Localization: create a play-mode instance (isolated from the editor
    // preview), activate it, and subscribe live re-render before the first tick
    // so scripts' onStart already resolve `this.scene.localization` correctly.
    this.setupLocalization(this.runtimeGraph.rootNodes);

    this.ecsService.beginScene(this.sceneService, this.inputService);

    // Initial tick to update transforms before render
    this.updateNodes(0);
    this.flushInstancedNodes();

    this.isRunning = true;
    this.clock.start();
    this.tick();
  }

  /**
   * Stand up the play-mode {@link LocalizationService}: configure it from the
   * injected manifest block (or an inert `en` default), point it at the runtime
   * ResourceManager for lazy table loads, stash the previously-active pointer
   * (the editor preview instance), activate this one, and subscribe live
   * re-render. Seeds the editor's preview locale so "preview ru → Play" starts
   * in ru; the table load is async, so the tree is re-walked once it lands.
   */
  private setupLocalization(roots: readonly NodeBase[]): void {
    const service = new LocalizationService();
    service.configure(this.localizationConfig ?? { defaultLocale: 'en' });
    service.attachResources(this.resourceManager);

    this.previousActiveLocalization = getActiveLocalization();
    this.localization = service;
    setActiveLocalization(service);

    // Re-render keyed labels whenever the locale switches or a table is injected.
    this.localizationUnsub = service.onChange(() => {
      if (this.runtimeGraph) applyLocaleToTree(this.runtimeGraph.rootNodes);
    });

    const seed = this.seedLocale ?? this.localizationConfig?.defaultLocale ?? 'en';
    // setLocale loads the table lazily; kick a re-walk when it resolves so a
    // seeded non-default locale paints (fire-and-forget — runGraph is sync).
    void service
      .setLocale(seed)
      .then(() => {
        if (this.localization === service && this.runtimeGraph) {
          applyLocaleToTree(this.runtimeGraph.rootNodes);
        }
      })
      .catch(() => {
        /* setLocale never throws (keeps an empty table on load failure) */
      });

    // Initial pass for keys already resolvable (fallback locale / injected tables).
    applyLocaleToTree(roots);
  }

  /** Tear down play-mode localization and restore the editor preview pointer.
   *  Safe to call when localization was never set up (all guards are null-safe). */
  private teardownLocalization(): void {
    if (this.localizationUnsub) {
      this.localizationUnsub();
      this.localizationUnsub = null;
    }
    if (this.localization) {
      // Restore whatever was active before play (editor preview, or null in exports).
      setActiveLocalization(this.previousActiveLocalization);
      this.localization.dispose();
      this.localization = null;
    }
    this.previousActiveLocalization = null;
  }

  private isPaused: boolean = false;

  stop(): void {
    this.isRunning = false;
    // Tear down any active cutscene FIRST — while the graph is still live — so
    // its player.stop() targets real nodes and its rAF handles, letterbox DOM,
    // skip listeners and input lock are all released before we detach scripts
    // and dispose the graph below (D9).
    this.sceneService.cancelActiveCutscene();
    // Restore the editor preview localization pointer and dispose the play
    // instance BEFORE the graph is torn down — runs on every stop (incl. abnormal).
    this.teardownLocalization();
    registerRuntimeSceneRoot(null);
    registerRuntimeLivePropertySink(null);
    if (this.physicsDebugOverlay) {
      this.physicsDebugOverlay.dispose();
      this.physicsDebugOverlay = null;
    }
    if (this.directionAxesOverlay) {
      this.directionAxesOverlay.dispose();
      this.directionAxesOverlay = null;
    }
    if (this.postFx) {
      this.postFx.dispose();
      this.postFx = null;
    }
    if (this.batch2D) {
      // The Group lives in this.scene, which runGraph clears — dispose so the
      // next scene gets a fresh batcher (no stale pool/suppressed material refs).
      this.batch2D.dispose();
      this.batch2D = null;
    }
    this.clock.stop();
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    this.ecsService.endScene();
    this.ecsService.clear();
    this.fixedTimeAccumulator = 0;
    this.elapsedTime = 0;
    this.frameNumber = 0;
    this.isPaused = false;
    this.gameTime.reset();
    this.currentFrameProfilerActivities = [];
    // Reset the AO-suppression memo so the NEXT scene always re-applies its
    // resolved suppression to its GeometryMesh nodes. Without this, a scene that
    // resolves the same suppress value as the previous one would skip the walk
    // (applyAOModeSuppression short-circuits on an unchanged value) and its
    // meshes would never get setAOSuppressed — baked AO + SSAO would stack.
    this.lastAOSuppress = null;

    // Drain any pending queue_free requests so the static queue never carries
    // node references across play sessions.
    NodeBase.flushFreeQueue();

    // Clear the runtime scene to release resources
    if (this.runtimeGraph) {
      for (const rootNode of this.runtimeGraph.rootNodes) {
        this.detachScripts(rootNode);
        this.stopAudioPlayers(rootNode);
      }

      this.audioService.stopAll();
      // Restore bus volumes + snapshot so a muffled/quiet mixer never leaks into
      // editor audio previews (the AudioService is a DI singleton shared with
      // AnimationTimelinePreviewService).
      this.audioService.resetBuses();
      this.audioMuffled = false;

      // Clear delegate to prevent any pending async calls from restarting audio/loading
      this.sceneService.setDelegate(null);

      // Remove nodes from the THREE scene (optional, as scene.clear() might be called next start)
      // But good for cleanup
      this.scene.clear();

      // Dispose the runtime graph's GPU resources. This graph is an isolated clone
      // built per startScene() (serialize + re-parse), so its nodes are NOT shared
      // with the editor's authored graph — disposing here is safe and prevents a
      // full-scene geometry/material/texture leak on every play/stop cycle.
      for (const rootNode of this.runtimeGraph.rootNodes) {
        rootNode.dispose();
      }
      this.runtimeGraph = null;
    }

    this.activeCamera2D = null;
    this.overlay2DActive = false;
    this.orthographicCamera.position.set(0, 0, 100);
    if (this.orthographicCamera.zoom !== 1) {
      this.orthographicCamera.zoom = 1;
      this.orthographicCamera.updateProjectionMatrix();
    }

    this.canvasSizeObserver?.disconnect();
    this.canvasSizeObserver = null;
    this.observedCanvas = null;
    this.canvasCssSize = null;

    this.inputService.detach();
  }

  pause(): void {
    if (!this.isRunning || this.isPaused) return;
    this.isPaused = true;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  resume(): void {
    if (!this.isRunning || !this.isPaused) return;
    this.isPaused = false;
    // Consume the time elapsed during pause so the next tick gets a fresh delta.
    this.clock.getDelta();
    this.tick();
  }

  /** True while the loop is halted by {@link pause} (focus loss / host request). */
  get paused(): boolean {
    return this.isPaused;
  }

  /** True while a scene is loaded and the loop is (or can be) ticking. */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Paint one frame synchronously without advancing game time. For screenshot
   * capture: the WebGL drawing buffer is cleared after compositing
   * (`preserveDrawingBuffer` is off), so pixels must be read in the same task as
   * a render — and a paused / hidden runner has no rAF loop painting at all.
   * Returns false when nothing is running (nothing to paint).
   */
  renderOnce(): boolean {
    if (!this.isRunning) {
      return false;
    }
    this.render();
    return true;
  }

  /**
   * Look up a node of the *running clone* by its authored nodeId (ids survive the
   * serialize→parse clone one-to-one). For automation/inspection tooling — the
   * returned node is live; do not mutate it outside the property-sink path.
   */
  getLiveNodeById(id: string): NodeBase | null {
    return this.findNodeById(id);
  }

  /** Root nodes of the running clone (empty when nothing is running). */
  getLiveRootNodes(): readonly NodeBase[] {
    return this.runtimeGraph?.rootNodes ?? [];
  }

  /**
   * Case-insensitive exact-name lookup over the running clone (first match in
   * DFS order). Convenience for automation that targets nodes the way a user
   * talks about them ("PlayButton") rather than by id.
   */
  findLiveNodeByName(name: string): NodeBase | null {
    const needle = name.toLowerCase();
    const stack: NodeBase[] = [...(this.runtimeGraph?.rootNodes ?? [])];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      if (node.name.toLowerCase() === needle) {
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

  /**
   * Project a live node's world position to canvas backing-store pixels — where
   * a synthetic pointer event must land to hit that node. Exact inverse of the
   * pointer→world mapping the runtime's own hit-tests use (`Node2D.pointerToWorld`):
   * 2D nodes go through the Camera2D-driven ortho camera (pan/zoom-correct),
   * overlay-band (CanvasLayer2D) nodes use the identity logical mapping, and 3D
   * nodes project through the active perspective camera. Null when nothing is
   * running, the canvas has no size yet, or the point is unprojectable.
   */
  projectNodeToCanvas(node: NodeBase): { x: number; y: number } | null {
    const world = node.getWorldPosition(SceneRunner.scratchProject);
    if (node instanceof Node2D) {
      return this.projectWorldPointToCanvas(world.x, world.y, {
        overlay: this.isInOverlayBand(node),
      });
    }
    if (!this.activeCamera) {
      return null;
    }
    return worldToCanvasThroughCamera(world, this.activeCamera.camera, this.canvasBackingSize());
  }

  /**
   * Project a 2D world point (the same coordinate space node `position`
   * properties use) to canvas backing-store pixels. `overlay: true` selects the
   * fixed CanvasLayer2D mapping (identity camera) instead of the Camera2D view.
   */
  projectWorldPointToCanvas(
    x: number,
    y: number,
    opts?: { overlay?: boolean }
  ): { x: number; y: number } | null {
    const canvasSize = this.canvasBackingSize();
    if (!opts?.overlay && this.orthographicCamera) {
      SceneRunner.scratchProject.set(x, y, 0);
      return worldToCanvasThroughCamera(
        SceneRunner.scratchProject,
        this.orthographicCamera,
        canvasSize
      );
    }
    return worldToCanvasLogical(x, y, this.logicalCameraSize, canvasSize);
  }

  private static readonly scratchProject = new Vector3();

  private canvasBackingSize(): { width: number; height: number } {
    const canvas = this.renderer.domElement;
    return { width: canvas.width, height: canvas.height };
  }

  /** True when the node or an ancestor is a CanvasLayer2D (fixed overlay band). */
  private isInOverlayBand(node: Node2D): boolean {
    let current: NodeBase | null = node;
    let guard = 0;
    while (current && guard++ < 128) {
      if (current instanceof Node2D && current.isCanvasLayer) {
        return true;
      }
      current = current.parent instanceof NodeBase ? current.parent : null;
    }
    return false;
  }

  private tick = (): void => {
    if (!this.isRunning || this.isPaused) return;

    const rawDt = this.clock.getDelta();
    // Advance the time-scale controller on the REAL delta (so hitstop / slow-mo
    // can expire even while the game is frozen), then scale gameplay dt by it.
    // Gameplay (ECS, node ticks, scripts, keyframe clips, fixed-step physics)
    // all run off `dt`; render() below is unscaled so a frozen frame still paints.
    this.gameTime.advance(rawDt);

    // Auto-muffle audio while in slow motion. Reads baseScale (NOT scale) so a
    // hitstop freeze — which forces scale to 0 — doesn't pump the filter. Guarded
    // so only a state change issues one AudioParam ramp, never per-frame.
    const muffled = this.gameTime.baseScale < SLOWMO_MUFFLE_THRESHOLD;
    if (muffled !== this.audioMuffled) {
      this.audioMuffled = muffled;
      this.audioService.applySnapshot(muffled ? 'muffled' : 'default');
    }

    const dt = rawDt * this.gameTime.scale;
    const logicStart = performance.now();
    this.currentFrameProfilerActivities = [];

    this.inputService.beginFrame();
    this.frameNumber += 1;
    this.elapsedTime += dt;
    this.fixedTimeAccumulator += dt;

    this.runFixedUpdates();

    const alpha =
      this.ecsService.fixedTimeStep > 0
        ? Math.min(this.fixedTimeAccumulator / this.ecsService.fixedTimeStep, 1)
        : 0;
    this.ecsService.setFrameMetrics(this.elapsedTime, this.frameNumber);
    this.ecsService.setInterpolationAlpha(alpha);
    this.ecsService.update(dt, alpha);

    this.renderer.beginStatsFrame();
    this.updateGameLogicSafe(dt);
    this.flushInstancedNodes();
    const logicMs = performance.now() - logicStart;
    const renderStart = performance.now();
    this.render();
    const renderMs = performance.now() - renderStart;
    this.notifyFrameListeners({
      // Report the real (unscaled) delta so FPS stays accurate during slow-mo /
      // hitstop; `elapsedTime` accumulates scaled game time.
      dt: rawDt,
      elapsedTime: this.elapsedTime,
      frameNumber: this.frameNumber,
      logicMs,
      renderMs,
      totalFrameMs: logicMs + renderMs,
      rendererStats: this.renderer.getStatsSnapshot(),
      profilerActivities: this.getFrameProfilerActivitiesSnapshot(),
      activeAudioPlaybacks: this.getActiveAudioPlaybackSnapshot(),
    });

    this.animationFrameId = requestAnimationFrame(this.tick);
  };

  subscribeFrameStats(listener: SceneRunnerFrameListener): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  /** De-duped last error surfaced from the per-frame game-logic pass. */
  private lastTickErrorMessage: string | null = null;

  /**
   * Run the per-frame node tick with a hard error boundary. Individual script
   * hooks already isolate themselves (NodeBase.runComponentHook), so this is the
   * belt-and-braces guard for anything else that throws in the update pass — a
   * single throw must never prevent `requestAnimationFrame` from rescheduling
   * and freezing the game. Duplicate consecutive messages are reported once.
   */
  private updateGameLogicSafe(dt: number): void {
    try {
      this.updateNodes(dt);
      this.lastTickErrorMessage = null;
    } catch (thrown) {
      const { message, stack } = describeThrown(thrown);
      if (message !== this.lastTickErrorMessage) {
        this.lastTickErrorMessage = message;
        console.error('[SceneRunner] Error during game update:', thrown);
        reportScriptError({ phase: 'tick', message, stack });
      }
    }
  }

  /**
   * Keep {@link canvasCssSize} in sync with the canvas's CSS box. Re-observes
   * when the host swaps the canvas element. The observer fires once immediately
   * on `observe()`, so the fallback clientWidth read in {@link render} only
   * happens for the first frame(s) after (re)attach.
   */
  private observeCanvasSize(canvas: HTMLCanvasElement): void {
    if (this.observedCanvas === canvas && this.canvasSizeObserver !== null) {
      return;
    }
    this.canvasSizeObserver?.disconnect();
    this.canvasSizeObserver = null;
    this.observedCanvas = canvas;
    this.canvasCssSize = null;
    if (typeof ResizeObserver === 'undefined') {
      return; // per-frame clientWidth fallback (tests / exotic hosts)
    }
    this.canvasSizeObserver = new ResizeObserver(entries => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (rect) {
        // Round to whole CSS px to match clientWidth semantics.
        this.canvasCssSize = { width: Math.round(rect.width), height: Math.round(rect.height) };
      }
    });
    this.canvasSizeObserver.observe(canvas);
  }

  private updateNodes(dt: number): void {
    const graph = this.runtimeGraph;
    if (graph) {
      for (const node of graph.rootNodes) {
        node.tick(dt);
      }
    }
    // Safe deferred removal (Godot queue_free): dispose nodes queued during the
    // tick pass now that tree iteration is over, before this frame renders.
    NodeBase.flushFreeQueue();
  }

  private render(): void {
    const canvas = this.renderer.domElement;
    this.observeCanvasSize(canvas);
    // Use CSS (logical) pixel dimensions for display-independent scaling so that
    // the camera coordinate space is consistent regardless of device pixel ratio.
    // Prefer the observer-maintained cache; fall back to a (layout-forcing)
    // clientWidth read only until the observer has delivered its first size, or
    // in environments without ResizeObserver.
    const cached = this.canvasCssSize;
    const cssWidth =
      cached && cached.width > 0
        ? cached.width
        : canvas.clientWidth > 0
          ? canvas.clientWidth
          : canvas.width;
    const cssHeight =
      cached && cached.height > 0
        ? cached.height
        : canvas.clientHeight > 0
          ? canvas.clientHeight
          : canvas.height;

    // 0. Handle Resizing
    // Track whether viewport changed so we can notify scripts AFTER cameras are updated.
    const viewportChanged =
      this.viewportSize.width !== cssWidth || this.viewportSize.height !== cssHeight;

    if (viewportChanged) {
      this.viewportSize.width = cssWidth;
      this.viewportSize.height = cssHeight;

      // Compute adaptive logical camera dimensions (Expand / Match-Min mode)
      // from the authored project viewport size.
      const baseW = this.rootLayoutAuthoredSize.width;
      const baseH = this.rootLayoutAuthoredSize.height;

      const baseAspect = baseW / baseH;
      const viewportAspect = cssWidth / cssHeight;
      let cameraWidth = baseW;
      let cameraHeight = baseH;
      if (viewportAspect >= baseAspect) {
        cameraHeight = baseH;
        cameraWidth = cameraHeight * viewportAspect;
      } else {
        cameraWidth = baseW;
        cameraHeight = cameraWidth / viewportAspect;
      }

      this.logicalCameraSize = { width: cameraWidth, height: cameraHeight };
    }

    // 1. Update Cameras

    // 3D Camera
    if (!this.activeCamera) {
      const graph = this.runtimeGraph;
      if (graph) {
        this.activeCamera = this.findActiveCamera(graph.rootNodes);
        if (this.activeCamera) {
          // Ensure 3D camera only sees 3D layer
          this.activeCamera.camera.layers.disableAll();
          this.activeCamera.camera.layers.enable(LAYER_3D);
        } else {
          // console.warn('[SceneRunner] No active camera found in scene.');
        }
      }
    }

    if (this.activeCamera) {
      const aspect = cssWidth / cssHeight;
      this.activeCamera.updateAspectRatio(aspect);
    }

    // 2D Camera - use the adaptive logical camera dimensions so the ortho camera
    // coordinate space matches the authored design resolution with expand-mode scaling.
    if (this.orthographicCamera) {
      const halfW = this.logicalCameraSize.width / 2;
      const halfH = this.logicalCameraSize.height / 2;

      if (
        this.orthographicCamera.left !== -halfW ||
        this.orthographicCamera.right !== halfW ||
        this.orthographicCamera.top !== halfH ||
        this.orthographicCamera.bottom !== -halfH
      ) {
        this.orthographicCamera.left = -halfW;
        this.orthographicCamera.right = halfW;
        this.orthographicCamera.top = halfH;
        this.orthographicCamera.bottom = -halfH;
        this.orthographicCamera.updateProjectionMatrix();

        // The overlay camera mirrors the frustum size (so HUD anchoring matches)
        // but stays at identity position/zoom — the Camera2D apply below never
        // touches it, keeping CanvasLayer2D content pinned.
        this.overlayCamera.left = -halfW;
        this.overlayCamera.right = halfW;
        this.overlayCamera.top = halfH;
        this.overlayCamera.bottom = -halfH;
        this.overlayCamera.updateProjectionMatrix();
      }

      // Drive the 2D pass from the active Camera2D (pan / zoom / limits / shake).
      // Solve already ran this frame in updateNodes(dt); here we only apply the
      // cached framing. No Camera2D → identity view (position (0,0), zoom 1), so
      // camera-less 2D scenes render exactly as before.
      this.activeCamera2D = findActiveCamera2D(this.runtimeGraph?.rootNodes ?? []);
      let viewX = 0;
      let viewY = 0;
      let viewZoom = 1;
      if (this.activeCamera2D) {
        const view = this.activeCamera2D.computeView(this.logicalCameraSize);
        this.activeCamera2D.getShakeOffset(this.scratchShake2D);
        viewX = view.x + this.scratchShake2D.x;
        viewY = view.y + this.scratchShake2D.y;
        viewZoom = view.zoom;
      }
      this.orthographicCamera.position.x = viewX;
      this.orthographicCamera.position.y = viewY;
      if (this.orthographicCamera.zoom !== viewZoom) {
        this.orthographicCamera.zoom = viewZoom;
        this.orthographicCamera.updateProjectionMatrix();
      }
    }

    this.reflowRoot2DNodes();

    // Notify scripts of viewport change AFTER camera matrices are updated so that
    // pin/projection-based scripts (e.g. PinToNodeBehavior) project with correct matrices.
    if (viewportChanged) {
      this.sceneService.setViewportSize(cssWidth, cssHeight);
    }

    // 2. Render Passes
    //
    // Two paths share the same layer-separated scene: a plain two-pass path
    // (3D then 2D overlay) and a post-processing path that routes bands through
    // an EffectComposer. The composer path only engages when an active
    // PostProcess node exists AND its module has finished loading; until then
    // we fall back to the plain path so the first frames never stall.
    // AO-mode cascade (scene tier): suppress baked aoMaps when the scene's
    // PostProcess node resolves to a non-baked mode (realtime SSAO / off), so
    // baked + SSAO never stack. Walks only when the decision flips.
    this.applyAOModeSuppression();

    const postNode = this.findActivePostProcessNode();
    const postConfig = postNode ? postNode.getConfig() : null;
    // The composer needs at least one band: a 3D camera, or 2D content routed
    // through post (`affect2D`). Pure-2D scenes (playable ads) have no Camera3D
    // but still post the 2D layer as the composer's base band.
    const canPostProcess = !!postConfig && (!!this.activeCamera || postConfig.affect2D);

    if (canPostProcess) {
      if (!this.postFx) {
        this.postFx = new PostProcessingPipeline(this.renderer.getWebGLRenderer());
      }
      this.postFx.ensureLoading();
    } else if (this.postFx) {
      // No active PostProcess node anymore — free the composer's render targets.
      this.postFx.dispose();
      this.postFx = null;
    }

    const usingComposer = canPostProcess && !!this.postFx && this.postFx.isReady();

    if (usingComposer && postConfig && this.postFx) {
      const camera3D = this.activeCamera?.camera ?? null;
      if (camera3D) {
        this.updateBillboardSprites(this.runtimeGraph?.rootNodes ?? [], camera3D);
      }

      // Composer renders the 3D band (if any) and — when affect2D or there is no
      // 3D camera — the 2D content band, applies the effect stack, outputs to canvas.
      this.postFx.render(this.scene, camera3D, this.orthographicCamera, postConfig);

      // Physics debug overlay draws after post (debug-only; needs a 3D camera).
      if (camera3D && isPhysicsDebugEnabled()) {
        if (!this.physicsDebugOverlay) {
          this.physicsDebugOverlay = new PhysicsDebugOverlay();
        }
        this.renderer.setAutoClear(false);
        this.physicsDebugOverlay.render(this.renderer, camera3D);
      }

      // Direction-axis gizmos for 3D nodes — before the 2D layer so UI stays on top.
      if (camera3D) {
        this.renderDirectionAxes('node3d', camera3D);
      }

      // When a 3D scene opts 2D out of post, the 2D layer was NOT rendered inside
      // the composer — draw it clean on top. (With no 3D camera, 2D is already the
      // composer's base band, so nothing to add here.)
      if (!postConfig.affect2D && camera3D) {
        this.renderScene2D();
      }

      // Direction-axis gizmos for 2D nodes — over the 2D content in all sub-cases
      // (whether it was the composer's base band or drawn clean above).
      this.renderDirectionAxes('node2d', this.orthographicCamera);
    } else {
      // ── Plain two-pass path ────────────────────────────────────────────────

      // Pass 1: 3D
      if (this.activeCamera) {
        this.updateBillboardSprites(this.runtimeGraph?.rootNodes ?? [], this.activeCamera.camera);
        this.renderer.setAutoClear(true);
        this.renderer.render(this.scene, this.activeCamera.camera);
      } else {
        this.renderer.setAutoClear(true);
        this.renderer.clear();
      }

      // Pass 1.5: Physics collider debug overlay (world-space wireframes drawn on
      // top of the 3D pass). Pull-based: the running game publishes its collider
      // geometry via registerPhysicsDebugSource; this only renders when the editor
      // has toggled it on. Drawn before the 2D overlay so UI stays on top.
      if (this.activeCamera && isPhysicsDebugEnabled()) {
        if (!this.physicsDebugOverlay) {
          this.physicsDebugOverlay = new PhysicsDebugOverlay();
        }
        this.renderer.setAutoClear(false);
        this.physicsDebugOverlay.render(this.renderer, this.activeCamera.camera);
      }

      // Pass 1.6: Direction-axis gizmos for 3D nodes — before the 2D pass so UI
      // stays on top of the world-space gizmos.
      if (this.activeCamera) {
        this.renderDirectionAxes('node3d', this.activeCamera.camera);
      }

      // Pass 2: 2D Overlay
      this.renderScene2D();

      // Pass 2.5: Direction-axis gizmos for 2D nodes — over the 2D content.
      this.renderDirectionAxes('node2d', this.orthographicCamera);
    }

    // Final pass: fixed HUD overlay (CanvasLayer2D). Drawn last in BOTH paths so
    // it sits above the post-processed frame; its layer mask kept it out of the
    // composer, so it is never bloomed/vignetted. Gated so overlay-free scenes
    // keep their original two passes.
    if (this.overlay2DActive) {
      this.renderOverlay2D();
    }
  }

  /**
   * Draw per-node local-axis gizmos for one layer (debug-only). Gated on the
   * global axes flag the editor's toggle writes; lazily builds the overlay on
   * first use so scenes that never enable it pay nothing. `camera` must be the
   * one the matching content pass used so world-space endpoints line up.
   */
  private renderDirectionAxes(kind: 'node2d' | 'node3d', camera: Camera): void {
    if (!isDirectionAxesEnabled()) {
      return;
    }
    if (!this.directionAxesOverlay) {
      this.directionAxesOverlay = new DirectionAxesOverlay();
    }
    this.renderer.setAutoClear(false);
    this.directionAxesOverlay.render(
      this.renderer,
      camera,
      this.runtimeGraph?.rootNodes ?? [],
      kind
    );
  }

  /** Draw the 2D content band over the current color buffer (clear depth, keep
   * color, don't repaint the scene background). Shared by both render paths. */
  private renderScene2D(): void {
    this.renderer.setAutoClear(false);
    this.renderer.clearDepth();

    const savedBg = this.scene.background;
    this.scene.background = null;

    this.renderer.render(this.scene, this.orthographicCamera);

    this.scene.background = savedBg;
  }

  /** Draw the fixed-HUD overlay band (LAYER_2D_OVERLAY, identity overlay camera)
   * clean over everything — post-processed or plain. Mirrors renderScene2D. */
  private renderOverlay2D(): void {
    this.renderer.setAutoClear(false);
    this.renderer.clearDepth();

    const savedBg = this.scene.background;
    this.scene.background = null;

    this.renderer.render(this.scene, this.overlayCamera);

    this.scene.background = savedBg;
  }

  /** Last-applied baked-AO suppression state (avoids re-walking every frame). */
  private lastAOSuppress: boolean | null = null;

  /**
   * AO-mode cascade: resolve the scene's AO mode from its PostProcess node and
   * suppress (or restore) baked aoMaps on all GeometryMesh nodes. Non-baked
   * modes (realtime SSAO / off) suppress baked so it doesn't stack with SSAO.
   * Only re-walks the graph when the decision changes.
   */
  private applyAOModeSuppression(): void {
    const graph = this.runtimeGraph;
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
        stack.push(child);
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

  /** First active PostProcess node in the running graph, or null. */
  private findActivePostProcessNode(): PostProcess | null {
    const graph = this.runtimeGraph;
    if (!graph) {
      return null;
    }
    const stack: NodeBase[] = [...graph.rootNodes];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        continue;
      }
      if (node instanceof PostProcess && node.isActive()) {
        return node;
      }
      for (const child of node.children) {
        stack.push(child);
      }
    }
    return null;
  }

  private findActiveCamera(nodes: NodeBase[]): Camera3D | null {
    for (const node of nodes) {
      if (node instanceof Camera3D && node.visible) {
        // Simple check: first visible camera is active
        return node;
      }
      if (node.children && node.children.length > 0) {
        // Recurse - need to cast children to NodeBase[] effectively
        const childNodes = node.children.filter((c): c is NodeBase => c instanceof NodeBase);
        const cam = this.findActiveCamera(childNodes);
        if (cam) return cam;
      }
    }
    return null;
  }

  private findNodeById(id: string): NodeBase | null {
    if (!this.runtimeGraph) return null;
    for (const node of this.runtimeGraph.rootNodes) {
      const found = node.findById(id);
      if (found) return found;
    }
    return null;
  }

  /**
   * Hot-reload a single property edit onto the *running clone* (P0.5). The clone
   * is an isolated serialize→parse copy of the authored graph, so `nodeId`s match
   * one-to-one; we apply the edit through the same property-schema `setValue`
   * mechanism the loader uses, then mirror the 2D authored-rect capture / anchored
   * reflow that the editor's `UpdateObjectPropertyOperation` performs, so anchored
   * layout does not revert the change on the next frame. Returns `true` when the
   * property was found and applied. The next render (every frame) shows the change.
   */
  applyLivePropertyUpdate(nodeId: string, propertyPath: string, value: unknown): boolean {
    if (!this.isRunning || !this.runtimeGraph) {
      return false;
    }

    const node = this.findNodeById(nodeId);
    if (!node) {
      return false;
    }

    const schema = getNodePropertySchema(node);
    const propDef = schema.properties.find(p => p.name === propertyPath);
    if (!propDef) {
      // Defensive fallback for runtime/editor schema drift, mirroring the
      // authored operation's opacity special-case.
      if (propertyPath === 'opacity' && node instanceof Node2D) {
        const next = Number(value);
        if (!Number.isFinite(next)) {
          return false;
        }
        node.opacity = Math.max(0, Math.min(1, next));
        return true;
      }
      return false;
    }

    propDef.setValue(node, value);
    this.afterLivePropertyApplied(node, propertyPath);
    return true;
  }

  /**
   * Mirrors {@link UpdateObjectPropertyOperation}'s `afterNodePropertyApplied`
   * for the running clone: re-capture the authored layout rect for
   * position/size edits and reflow anchored children of resized containers so
   * the per-frame anchored layout keeps the edited value instead of reverting.
   */
  private afterLivePropertyApplied(node: NodeBase, propertyPath: string): void {
    if (!(node instanceof Node2D)) {
      return;
    }

    if (['position', 'width', 'height', 'size', 'radius'].includes(propertyPath)) {
      node.captureAuthoredLayoutRectFromCurrent();
    }

    if (
      ['width', 'height', 'size', 'radius', 'resolutionPreset'].includes(propertyPath) &&
      node.isContainer
    ) {
      node.reflowAnchoredChildren();
      this.captureAnchoredDescendantRects(node);
    }
  }

  private captureAnchoredDescendantRects(parent: NodeBase): void {
    for (const child of parent.children) {
      if (child instanceof Node2D) {
        child.captureAuthoredLayoutRectFromCurrent();
      }
      if (child instanceof NodeBase) {
        this.captureAnchoredDescendantRects(child);
      }
    }
  }

  private bindSceneServiceDelegate(): void {
    const runner = this;
    this.sceneService.setDelegate({
      getActiveCameraNode(): Camera3D | null {
        return runner.activeCamera;
      },
      getActiveCamera2DNode(): Camera2D | null {
        return runner.activeCamera2D;
      },
      getInputService(): InputService {
        return runner.inputService;
      },
      getUICamera(): Camera | null {
        return runner.orthographicCamera;
      },
      getLogicalCameraSize(): { width: number; height: number } {
        return { ...runner.logicalCameraSize };
      },
      setActiveCameraNode(camera: Camera3D | null): void {
        runner.activeCamera = camera;
      },
      findNodeById(id: string): NodeBase | null {
        return runner.findNodeById(id);
      },
      getRootNodes(): NodeBase[] {
        return runner.runtimeGraph?.rootNodes ?? [];
      },
      getAudioService(): AudioService {
        return runner.audioService;
      },
      getLocalizationService(): LocalizationService | null {
        return runner.localization;
      },
      getAssetLoader(): AssetLoader {
        return runner.assetLoader;
      },
      getResourceManager(): ResourceManager {
        return runner.resourceManager;
      },
      getECSService(): ECSService | null {
        return runner.runtimeGraph ? runner.ecsService : null;
      },
      getGameTime(): GameTime {
        return runner.gameTime;
      },
      raycastViewport(normalizedX: number, normalizedY: number): SceneRaycastHit | null {
        return runner.raycastViewport(normalizedX, normalizedY);
      },
      reportFrameProfilerActivities(activities: readonly FrameProfilerActivity[]): void {
        runner.reportFrameProfilerActivities(activities);
      },
      loadAndStartScene(path: string): Promise<void> {
        return runner.loadAndStartScene(path);
      },
      instantiatePrefab(path: string, parent?: NodeBase | null): Promise<NodeBase> {
        return runner.instantiatePrefab(path, parent);
      },
    });
  }

  private reportFrameProfilerActivities(activities: readonly FrameProfilerActivity[]): void {
    this.currentFrameProfilerActivities = this.normalizeFrameProfilerActivities(activities);
  }

  private getFrameProfilerActivitiesSnapshot(): readonly FrameProfilerActivity[] | undefined {
    if (this.currentFrameProfilerActivities.length === 0) {
      return undefined;
    }

    return this.currentFrameProfilerActivities.map(activity => ({ ...activity }));
  }

  private getActiveAudioPlaybackSnapshot(): readonly ActiveAudioPlaybackSnapshot[] | undefined {
    const snapshot = this.audioService.getActivePlaybackSnapshot();
    return snapshot.length > 0 ? snapshot : undefined;
  }

  private normalizeFrameProfilerActivities(
    activities: readonly FrameProfilerActivity[]
  ): FrameProfilerActivity[] {
    const normalized: FrameProfilerActivity[] = [];

    for (const activity of activities) {
      const label = typeof activity.label === 'string' ? activity.label.trim() : '';
      if (!label) {
        continue;
      }

      const selfTimeMs = this.normalizeFrameProfilerValue(activity.selfTimeMs);
      if (selfTimeMs === null) {
        continue;
      }

      const totalTimeMs = this.normalizeFrameProfilerValue(activity.totalTimeMs);
      normalized.push(
        totalTimeMs === null
          ? { label, selfTimeMs }
          : {
              label,
              selfTimeMs,
              totalTimeMs: Math.max(totalTimeMs, selfTimeMs),
            }
      );
    }

    return normalized;
  }

  private normalizeFrameProfilerValue(value: number | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return null;
    }

    return value;
  }

  private runFixedUpdates(): void {
    const fixedTimeStep = this.ecsService.fixedTimeStep;
    if (fixedTimeStep <= 0 || this.fixedTimeAccumulator < fixedTimeStep) {
      return;
    }

    let executedSteps = 0;
    let simulatedTime = this.elapsedTime - this.fixedTimeAccumulator;

    while (
      this.fixedTimeAccumulator >= fixedTimeStep &&
      executedSteps < this.ecsService.maxFixedStepsPerFrame
    ) {
      this.fixedTimeAccumulator -= fixedTimeStep;
      simulatedTime += fixedTimeStep;
      this.ecsService.setFrameMetrics(simulatedTime, this.frameNumber);
      this.ecsService.fixedUpdate(fixedTimeStep);
      executedSteps += 1;
    }

    if (executedSteps === this.ecsService.maxFixedStepsPerFrame) {
      this.fixedTimeAccumulator = Math.min(this.fixedTimeAccumulator, fixedTimeStep);
    }
  }

  private flushInstancedNodes(): void {
    const graph = this.runtimeGraph;
    if (!graph) {
      return;
    }

    const stack = [...graph.rootNodes];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        continue;
      }

      if (node instanceof InstancedMesh3D) {
        node.flush();
      }

      for (const child of node.children) {
        if (child instanceof NodeBase) {
          stack.push(child);
        }
      }
    }
  }

  private raycastViewport(normalizedX: number, normalizedY: number): SceneRaycastHit | null {
    if (!this.runtimeGraph) {
      return null;
    }

    // Overlay band (CanvasLayer2D) is topmost — pick it first.
    if (this.overlay2DActive) {
      const overlayHit = this.raycastWithCamera(
        normalizedX,
        normalizedY,
        this.overlayCamera,
        LAYER_2D_OVERLAY
      );
      if (overlayHit) {
        return overlayHit;
      }
    }

    const uiHit = this.raycastWithCamera(
      normalizedX,
      normalizedY,
      this.orthographicCamera,
      LAYER_2D
    );
    if (uiHit) {
      return uiHit;
    }

    if (!this.activeCamera) {
      return null;
    }

    return this.raycastWithCamera(normalizedX, normalizedY, this.activeCamera.camera, LAYER_3D);
  }

  private raycastWithCamera(
    normalizedX: number,
    normalizedY: number,
    camera: Camera,
    layer: number
  ): SceneRaycastHit | null {
    this.raycastPointer.set(normalizedX, normalizedY);
    this.raycaster.layers.set(layer);
    this.raycaster.setFromCamera(this.raycastPointer, camera);

    const intersections = this.raycaster.intersectObjects(this.scene.children, true);
    for (const intersection of intersections) {
      // Three.js' Raycaster intentionally ignores Object3D.visible, but for
      // input/picking a hidden node (or one nested under a hidden ancestor —
      // e.g. a closed shop panel) must not intercept the ray.
      if (!this.isObjectVisibleInHierarchy(intersection.object)) {
        continue;
      }

      const node = this.resolveNodeFromObject(intersection.object);
      if (!node) {
        continue;
      }

      return {
        node,
        distance: intersection.distance,
        point: intersection.point.clone(),
        object: intersection.object,
        instanceId:
          typeof intersection.instanceId === 'number' ? intersection.instanceId : undefined,
      };
    }

    return null;
  }

  private resolveNodeFromObject(object: Object3D): NodeBase | null {
    let current: Object3D | null = object;

    while (current) {
      if (current instanceof NodeBase) {
        return current;
      }
      current = current.parent;
    }

    return null;
  }

  /**
   * True only if the object and every ancestor up to the scene root are visible.
   * Mirrors how WebGLRenderer skips an invisible subtree, which Raycaster does not.
   */
  private isObjectVisibleInHierarchy(object: Object3D): boolean {
    let current: Object3D | null = object;

    while (current) {
      if (!current.visible) {
        return false;
      }
      current = current.parent;
    }

    return true;
  }

  private updateBillboardSprites(nodes: NodeBase[], camera: Camera): void {
    const cameraQuaternion = camera.getWorldQuaternion(new Quaternion());
    const cameraPosition = camera.getWorldPosition(new Vector3());
    for (const node of nodes) {
      if (node instanceof Particles3D) {
        // Particles3D also needs the camera position (trails) and latches
        // world-space compensation each rendered frame.
        node.syncRenderState(cameraQuaternion, cameraPosition);
      } else if (node instanceof Sprite3D || node instanceof AnimatedSprite3D) {
        node.applyBillboard(cameraQuaternion);
      }
      if (node.children.length > 0) {
        this.updateBillboardSprites(node.children, camera);
      }
    }
  }

  private applyInitialVisibility(nodes: NodeBase[]): void {
    for (const node of nodes) {
      const initialVisibility = this.readInitialVisibility(node);
      if (initialVisibility !== undefined) {
        node.visible = initialVisibility;
        node.properties.visible = initialVisibility;
      }

      const childNodes = node.children.filter(
        (child): child is NodeBase => child instanceof NodeBase
      );
      if (childNodes.length > 0) {
        this.applyInitialVisibility(childNodes);
      }
    }
  }

  private readInitialVisibility(node: NodeBase): boolean | undefined {
    const properties = node.properties as Record<string, unknown> | undefined;
    const direct = properties?.initiallyVisible;
    const legacySnakeCase = properties?.initially_visible;
    const userDataProps = (node.userData.properties as Record<string, unknown> | undefined)
      ?.initiallyVisible;

    return (
      this.toBooleanLike(direct) ??
      this.toBooleanLike(legacySnakeCase) ??
      this.toBooleanLike(userDataProps)
    );
  }

  private toBooleanLike(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') {
        return true;
      }
      if (normalized === 'false') {
        return false;
      }
      return undefined;
    }

    return undefined;
  }

  private reflowRoot2DNodes(): void {
    if (!this.runtimeGraph) {
      return;
    }

    const currentRootSize = {
      width: Math.max(1, this.logicalCameraSize.width),
      height: Math.max(1, this.logicalCameraSize.height),
    };

    for (const node of this.runtimeGraph.rootNodes) {
      if (node instanceof Node2D) {
        node.applyAnchoredLayoutRecursive(currentRootSize, this.rootLayoutAuthoredSize);
      }
    }

    // Route CanvasLayer2D subtrees to the fixed overlay band (and everything
    // else to the main 2D band). Also tells us whether the overlay passes are
    // needed this frame.
    this.overlay2DActive = assign2DLayers(this.runtimeGraph.rootNodes);

    // Draw order for the 2D overlay pass follows the scene-graph hierarchy.
    if (this.batch2DEnabled) {
      if (!this.batch2D) {
        this.batch2D = new Batch2DSystem(this.scene);
      }
      const ordered = this.ordered2DBuffer;
      ordered.length = 0;
      // Single DFS: stamp renderOrder AND collect the ordered mesh list.
      assign2DRenderOrder(this.runtimeGraph.rootNodes, (mesh, order, overlay, visible) => {
        if ((mesh as { isMesh?: boolean }).isMesh) {
          ordered.push({ mesh: mesh as OrderedMesh2D['mesh'], order, overlay, visible });
        }
      });
      // World matrices must be current before the batcher reads matrixWorld to
      // stamp quad corners (the render pass would otherwise be the first update).
      this.scene.updateMatrixWorld(true);
      this.batch2D.update(ordered);
    } else {
      assign2DRenderOrder(this.runtimeGraph.rootNodes);
    }
  }

  private stopAudioPlayers(node: NodeBase): void {
    if (node instanceof AudioPlayer) {
      node.stop();
    }

    for (const child of node.children) {
      this.stopAudioPlayers(child);
    }
  }

  private detachScripts(node: NodeBase): void {
    for (const component of node.components) {
      if (component.onDetach) {
        try {
          component.onDetach();
        } catch (error) {
          console.error('[SceneRunner] Component onDetach failed during stop()', {
            componentId: component.id,
            nodeId: node.nodeId,
            error,
          });
        }
      }

      if (component.resetStartedState) {
        component.resetStartedState();
      } else {
        component._started = false;
      }
    }

    for (const child of node.children) {
      if (child instanceof NodeBase) {
        this.detachScripts(child);
      }
    }
  }

  private notifyFrameListeners(sample: SceneRunnerFrameSample): void {
    for (const listener of this.frameListeners) {
      listener(sample);
    }
  }
}
