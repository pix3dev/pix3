import {
  Camera,
  Clock,
  Scene,
  OrthographicCamera,
  Color,
  Quaternion,
  Raycaster,
  Vector2,
  type Object3D,
} from 'three';
import { SceneManager } from './SceneManager';
import { RuntimeRenderer } from './RuntimeRenderer';
import { InputService } from './InputService';
import { SceneService } from './SceneService';
import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { Camera3D } from '../nodes/3D/Camera3D';
import { NodeBase } from '../nodes/NodeBase';
import { Node2D } from '../nodes/Node2D';
import { Sprite3D } from '../nodes/3D/Sprite3D';
import { AnimatedSprite3D } from '../nodes/3D/AnimatedSprite3D';
import { Particles3D } from '../nodes/3D/Particles3D';
import { InstancedMesh3D } from '../nodes/3D/InstancedMesh3D';
import { AudioPlayer } from '../nodes/AudioPlayer';
import { LAYER_3D, LAYER_2D } from '../constants';
import { ECSService } from './ECSService';
import type { SceneRaycastHit } from './raycast';
import type { RuntimeRendererStatsSnapshot } from './RuntimeRenderer';

export interface SceneRunnerFrameSample {
  readonly dt: number;
  readonly elapsedTime: number;
  readonly frameNumber: number;
  readonly logicMs: number;
  readonly renderMs: number;
  readonly totalFrameMs: number;
  readonly rendererStats: RuntimeRendererStatsSnapshot;
}

type SceneRunnerFrameListener = (sample: SceneRunnerFrameSample) => void;

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
  private readonly raycaster = new Raycaster();
  private readonly raycastPointer = new Vector2();
  private animationFrameId: number | null = null;
  private isRunning: boolean = false;
  private fixedTimeAccumulator = 0;
  private elapsedTime = 0;
  private frameNumber = 0;

  private scene: Scene;
  private activeCamera: Camera3D | null = null;
  private orthographicCamera: OrthographicCamera;
  private viewportSize = { width: 0, height: 0 };
  /** Adaptive logical camera dimensions computed from viewportBaseSize + viewport aspect. */
  private logicalCameraSize = { width: 1, height: 1 };
  private readonly rootLayoutAuthoredSize: { width: number; height: number };
  private readonly frameListeners = new Set<SceneRunnerFrameListener>();

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

    this.bindSceneServiceDelegate();
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

    this.stop();
    this.bindSceneServiceDelegate();

    // Ensure fade overlay is positioned over the correct canvas
    this.sceneService.attachCanvas(this.renderer.domElement);

    // Setup scene
    this.scene.clear();
    this.activeCamera = null;

    // CLONE: Serialize and parse to create an isolated runtime graph
    try {
      const serialized = this.sceneManager.serializeScene(sourceGraph);
      this.runtimeGraph = await this.sceneManager.parseScene(serialized);
    } catch (err) {
      console.error('[SceneRunner] Failed to clone scene for runtime:', err);
      return;
    }

    // Add root nodes to the THREE.Scene
    for (const node of this.runtimeGraph.rootNodes) {
      // Inject InputService
      node.input = this.inputService;
      // Inject SceneService
      node.scene = this.sceneService;
      this.scene.add(node);
    }

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

    this.ecsService.beginScene(this.sceneService, this.inputService);

    // Initial tick to update transforms before render
    this.updateNodes(0);
    this.flushInstancedNodes();

    this.isRunning = true;
    this.clock.start();
    this.tick();
  }

  private isPaused: boolean = false;

  stop(): void {
    this.isRunning = false;
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

    // Clear the runtime scene to release resources
    if (this.runtimeGraph) {
      for (const rootNode of this.runtimeGraph.rootNodes) {
        this.stopAudioPlayers(rootNode);
      }

      this.audioService.stopAll();

      // Clear delegate to prevent any pending async calls from restarting audio/loading
      this.sceneService.setDelegate(null);

      // Remove nodes from the THREE scene (optional, as scene.clear() might be called next start)
      // But good for cleanup
      this.scene.clear();
      this.runtimeGraph = null;
    }

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

  private tick = (): void => {
    if (!this.isRunning || this.isPaused) return;

    const dt = this.clock.getDelta();
    const logicStart = performance.now();

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
    this.updateNodes(dt);
    this.flushInstancedNodes();
    const logicMs = performance.now() - logicStart;
    const renderStart = performance.now();
    this.render();
    const renderMs = performance.now() - renderStart;
    this.notifyFrameListeners({
      dt,
      elapsedTime: this.elapsedTime,
      frameNumber: this.frameNumber,
      logicMs,
      renderMs,
      totalFrameMs: logicMs + renderMs,
      rendererStats: this.renderer.getStatsSnapshot(),
    });

    this.animationFrameId = requestAnimationFrame(this.tick);
  };

  subscribeFrameStats(listener: SceneRunnerFrameListener): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  private updateNodes(dt: number): void {
    const graph = this.runtimeGraph;
    if (graph) {
      for (const node of graph.rootNodes) {
        node.tick(dt);
      }
    }
  }

  private render(): void {
    const canvas = this.renderer.domElement;
    // Use CSS (logical) pixel dimensions for display-independent scaling so that
    // the camera coordinate space is consistent regardless of device pixel ratio.
    const cssWidth = canvas.clientWidth > 0 ? canvas.clientWidth : canvas.width;
    const cssHeight = canvas.clientHeight > 0 ? canvas.clientHeight : canvas.height;

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
      }
    }

    this.reflowRoot2DNodes();

    // Notify scripts of viewport change AFTER camera matrices are updated so that
    // pin/projection-based scripts (e.g. PinToNodeBehavior) project with correct matrices.
    if (viewportChanged) {
      this.sceneService.setViewportSize(cssWidth, cssHeight);
    }

    // 2. Render Passes

    // Pass 1: 3D
    if (this.activeCamera) {
      this.updateBillboardSprites(this.runtimeGraph?.rootNodes ?? [], this.activeCamera.camera);
      this.renderer.setAutoClear(true);
      this.renderer.render(this.scene, this.activeCamera.camera);
    } else {
      this.renderer.setAutoClear(true);
      this.renderer.clear();
    }

    // Pass 2: 2D Overlay
    // We need to clear depth but keep color
    this.renderer.setAutoClear(false);
    this.renderer.clearDepth();

    // Save background to prevent clearing it
    const savedBg = this.scene.background;
    this.scene.background = null;

    this.renderer.render(this.scene, this.orthographicCamera);

    // Restore
    this.scene.background = savedBg;
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

  private bindSceneServiceDelegate(): void {
    const runner = this;
    this.sceneService.setDelegate({
      getActiveCameraNode(): Camera3D | null {
        return runner.activeCamera;
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
      getAudioService(): AudioService {
        return runner.audioService;
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
      raycastViewport(normalizedX: number, normalizedY: number): SceneRaycastHit | null {
        return runner.raycastViewport(normalizedX, normalizedY);
      },
    });
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

    const uiHit = this.raycastWithCamera(normalizedX, normalizedY, this.orthographicCamera, LAYER_2D);
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

  private updateBillboardSprites(nodes: NodeBase[], camera: Camera): void {
    const cameraQuaternion = camera.getWorldQuaternion(new Quaternion());
    for (const node of nodes) {
      if (
        node instanceof Sprite3D ||
        node instanceof AnimatedSprite3D ||
        node instanceof Particles3D
      ) {
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
  }

  private stopAudioPlayers(node: NodeBase): void {
    if (node instanceof AudioPlayer) {
      node.stop();
    }

    for (const child of node.children) {
      this.stopAudioPlayers(child);
    }
  }

  private notifyFrameListeners(sample: SceneRunnerFrameSample): void {
    for (const listener of this.frameListeners) {
      listener(sample);
    }
  }
}
