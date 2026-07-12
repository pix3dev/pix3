import { ServiceContainer, injectable, inject } from '@/fw/di';
import {
  Box3,
  Color,
  MathUtils,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Camera,
  type Mesh,
} from 'three';
import {
  AnimatedSprite3D,
  Node2D,
  SceneManager,
  Sprite3D,
  assign2DRenderOrder,
  type SceneGraph,
} from '@pix3/runtime';
import { appState } from '@/state';
import { toProjectResourcePath } from '@/ui/shared/asset-drag-drop';

/** Long edge of the generated thumbnail, in device-independent pixels. */
const THUMBNAIL_MAX_SIZE = 320;
/** Floor for the short edge so extreme aspect ratios stay legible. */
const THUMBNAIL_MIN_SIZE = 56;
/** Fraction of the frustum the framed content should occupy. */
const CONTENT_FILL_RATIO = 0.9;
/** Extra breathing room around auto-framed 2D content bounds. */
const CONTENT_2D_PADDING = 1.08;

// Editor render layers (kept in sync with the runtime constants; also mirrored
// locally in ViewportRenderService). LAYER_2D content self-stamps in Node2D's
// constructor, LAYER_3D (0) is the three.js default for everything else.
const LAYER_3D = 0;
const LAYER_2D = 1;

const DEFAULT_DESIGN_WIDTH = 1920;
const DEFAULT_DESIGN_HEIGHT = 1080;
/** Runtime SceneRunner's default scene background — matched for scene thumbnails. */
const SCENE_BACKGROUND = '#202020';

interface Pipeline {
  canvas: HTMLCanvasElement;
  renderer: WebGLRenderer;
}

/**
 * Renders a one-shot thumbnail for a `.pix3scene` / `.pix3prefab` file by
 * parsing it into an isolated runtime graph and drawing a single frame to an
 * offscreen WebGL canvas — the scene/prefab counterpart of
 * {@link ../services/ThumbnailGenerator.ThumbnailGenerator} (which handles glTF
 * models).
 *
 * The graph is built through the DI {@link SceneManager} (whose `parseScene` is
 * side-effect-free on the manager), so it resolves the same project files and
 * textures the editor uses. Textures come from the shared `AssetLoader` cache;
 * disposing the parsed graph afterwards is safe because `Material.dispose()`
 * never disposes its textures (see `NodeBase.disposeResources`), so the live
 * editor scene keeps its cached textures intact.
 *
 * Scripts are never executed: `NodeBase.tick()` would fire `onStart`/`onUpdate`
 * against unset `scene`/`input` services, so transforms and 2D anchored layout
 * are applied directly instead.
 */
@injectable()
export class SceneThumbnailGenerator {
  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  private pipeline: Pipeline | null = null;
  private readonly scratchQuaternion = new Quaternion();

  /**
   * Parse `blob` (scene/prefab YAML) and render a webp data URL thumbnail.
   * `filePath` is the project-relative path (e.g. `src/assets/scenes/main.pix3scene`).
   */
  public async generate(blob: Blob, filePath: string): Promise<string> {
    const text = await blob.text();
    const resourcePath = toProjectResourcePath(filePath);
    const graph = await this.sceneManager.parseScene(text, { filePath: resourcePath });
    const isPrefab = /\.pix3prefab$/i.test(filePath);

    try {
      return this.renderGraph(graph, isPrefab);
    } finally {
      for (const root of graph.rootNodes) {
        root.dispose();
      }
    }
  }

  public dispose(): void {
    if (!this.pipeline) {
      return;
    }
    this.pipeline.renderer.dispose();
    this.pipeline.renderer.forceContextLoss();
    this.pipeline = null;
  }

  private renderGraph(graph: SceneGraph, isPrefab: boolean): string {
    if (graph.rootNodes.length === 0) {
      throw new Error('Scene has no root nodes to render.');
    }

    const scene = new Scene();
    for (const root of graph.rootNodes) {
      scene.add(root);
    }

    // Scenes anchor their 2D content to the project design frame first, so
    // anchored elements land at their final positions before we measure the
    // content bounds. Prefabs are laid out by their eventual parent, so they
    // keep their authored local positions.
    if (!isPrefab) {
      const design = this.getDesignSize();
      for (const root of graph.rootNodes) {
        if (root instanceof Node2D) {
          root.applyAnchoredLayoutRecursive(design, design);
        }
      }
    }
    assign2DRenderOrder(graph.rootNodes);
    scene.updateMatrixWorld(true);

    const bounds3D = this.collectLayerBounds(scene, LAYER_3D);
    const bounds2D = this.collectLayerBounds(scene, LAYER_2D);

    if (!bounds3D && !bounds2D) {
      throw new Error('Scene has no renderable content.');
    }

    // ── Framing ─────────────────────────────────────────────────────────────
    // Always frame to the actual content bounds — the same "fit everything"
    // behaviour as the viewport's Show All button — so the tile is filled by the
    // scene/prefab instead of the (often mostly-empty) design frame.
    let aspect: number;
    let camera3D: Camera | null = null;
    let camera2D: OrthographicCamera | null = null;

    if (bounds2D) {
      const framed = this.buildFittedOrthographicCamera(bounds2D);
      camera2D = framed.camera;
      aspect = framed.aspect;
      // Any 3D content sits behind the 2D pass, framed to its own bounds so it
      // reads as a backdrop rather than dictating the tile aspect.
      if (bounds3D) {
        camera3D = this.buildFramedPerspectiveCamera(bounds3D, aspect);
      }
    } else {
      // Pure 3D content — square tile, framed like a model thumbnail.
      aspect = 1;
      camera3D = this.buildFramedPerspectiveCamera(bounds3D, aspect);
    }

    const { width, height } = this.resolveCanvasSize(aspect);
    const pipeline = this.ensurePipeline();
    pipeline.renderer.setSize(width, height, false);

    // Scenes get the opaque play-view background; prefabs stay transparent so
    // the content floats over the panel tile.
    const opaqueBackground = !isPrefab;
    scene.background = opaqueBackground ? new Color(SCENE_BACKGROUND) : null;
    pipeline.renderer.setClearColor(
      opaqueBackground ? SCENE_BACKGROUND : 0x000000,
      opaqueBackground ? 1 : 0
    );

    // Pass 1 — 3D (or a plain background clear when there is no 3D content).
    pipeline.renderer.autoClear = true;
    if (camera3D) {
      this.applyBillboards(scene, camera3D);
      pipeline.renderer.render(scene, camera3D);
    } else {
      pipeline.renderer.clear();
    }

    // Pass 2 — 2D overlay, drawn over the 3D pass without repainting background.
    if (camera2D) {
      const savedBackground = scene.background;
      scene.background = null;
      pipeline.renderer.autoClear = false;
      pipeline.renderer.clearDepth();
      pipeline.renderer.render(scene, camera2D);
      scene.background = savedBackground;
    }

    return this.exportCanvas(pipeline.canvas);
  }

  private getDesignSize(): { width: number; height: number } {
    const size = appState.project.manifest?.viewportBaseSize;
    return {
      width: Math.max(1, size?.width ?? DEFAULT_DESIGN_WIDTH),
      height: Math.max(1, size?.height ?? DEFAULT_DESIGN_HEIGHT),
    };
  }

  /** Union bounds of every visible geometry-bearing object on `layer`, or null. */
  private collectLayerBounds(scene: Scene, layer: number): Box3 | null {
    const box = new Box3();
    let found = false;
    scene.traverse(object => {
      const mesh = object as Mesh;
      if (!mesh.geometry || !object.visible || !object.layers.isEnabled(layer)) {
        return;
      }
      box.expandByObject(object);
      found = true;
    });
    if (!found || box.isEmpty()) {
      return null;
    }
    const size = box.getSize(new Vector3());
    if (!Number.isFinite(size.x) || !Number.isFinite(size.y) || !Number.isFinite(size.z)) {
      return null;
    }
    return box;
  }

  /** Perspective camera orbit-framed to `bounds` (like a model thumbnail). */
  private buildFramedPerspectiveCamera(bounds: Box3 | null, aspect: number): Camera {
    const camera = new PerspectiveCamera(40, aspect, 0.01, 1000);
    camera.layers.disableAll();
    camera.layers.enable(LAYER_3D);

    const box = bounds ?? new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const maxSize = Math.max(size.x, size.y, size.z, 0.25);
    const verticalFov = MathUtils.degToRad(camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
    const distanceForHeight = size.y / (2 * Math.tan(verticalFov / 2) * CONTENT_FILL_RATIO);
    const distanceForWidth = size.x / (2 * Math.tan(horizontalFov / 2) * CONTENT_FILL_RATIO);
    const distance = Math.max(distanceForHeight, distanceForWidth, maxSize * 1.35) + size.z * 0.35;

    camera.position.set(
      center.x + distance * 0.72,
      center.y + distance * 0.42,
      center.z + distance * 0.96
    );
    camera.near = Math.max(distance / 100, 0.01);
    camera.far = Math.max(distance * 12, 10);
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    return camera;
  }

  /** Ortho camera fitted to 2D content bounds; also yields the matching aspect. */
  private buildFittedOrthographicCamera(bounds: Box3): {
    camera: OrthographicCamera;
    aspect: number;
  } {
    const size = bounds.getSize(new Vector3());
    const center = bounds.getCenter(new Vector3());
    const width = Math.max(size.x, 1);
    const height = Math.max(size.y, 1);
    const halfW = (width / 2) * CONTENT_2D_PADDING;
    const halfH = (height / 2) * CONTENT_2D_PADDING;

    const camera = new OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 1000);
    camera.position.set(center.x, center.y, 100);
    camera.layers.disableAll();
    camera.layers.enable(LAYER_2D);
    camera.updateProjectionMatrix();
    return { camera, aspect: width / height };
  }

  private applyBillboards(scene: Scene, camera: Camera): void {
    const cameraQuaternion = camera.getWorldQuaternion(this.scratchQuaternion);
    scene.traverse(object => {
      if (object instanceof Sprite3D || object instanceof AnimatedSprite3D) {
        object.applyBillboard(cameraQuaternion);
      }
    });
  }

  private resolveCanvasSize(aspect: number): { width: number; height: number } {
    const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
    if (safeAspect >= 1) {
      return {
        width: THUMBNAIL_MAX_SIZE,
        height: Math.max(THUMBNAIL_MIN_SIZE, Math.round(THUMBNAIL_MAX_SIZE / safeAspect)),
      };
    }
    return {
      width: Math.max(THUMBNAIL_MIN_SIZE, Math.round(THUMBNAIL_MAX_SIZE * safeAspect)),
      height: THUMBNAIL_MAX_SIZE,
    };
  }

  private ensurePipeline(): Pipeline {
    if (this.pipeline) {
      return this.pipeline;
    }
    if (typeof document === 'undefined') {
      throw new Error('Scene thumbnail generation requires a browser document context.');
    }

    const canvas = document.createElement('canvas');
    const renderer = new WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(1);
    // Match RuntimeRenderer: sRGB output, no tone mapping — so UI colors read
    // exactly as they do in the play view (ACES would darken flat 2D content).
    renderer.outputColorSpace = SRGBColorSpace;

    this.pipeline = { canvas, renderer };
    return this.pipeline;
  }

  private exportCanvas(canvas: HTMLCanvasElement): string {
    return canvas.toDataURL('image/webp', 0.92);
  }
}

export function resolveSceneThumbnailGenerator(): SceneThumbnailGenerator {
  const container = ServiceContainer.getInstance();
  return container.getService<SceneThumbnailGenerator>(
    container.getOrCreateToken(SceneThumbnailGenerator)
  );
}
