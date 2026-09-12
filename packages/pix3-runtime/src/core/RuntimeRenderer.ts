import { WebGLRenderer, Scene, Camera, PCFShadowMap } from 'three';

export interface RuntimeRendererOptions {
  antialias?: boolean;
  pixelRatio?: number;
  clearColor?: string;
  shadows?: boolean;
}

export interface RuntimeRendererStatsSnapshot {
  readonly calls: number;
  readonly triangles: number;
  readonly points: number;
  readonly lines: number;
  readonly geometries: number;
  readonly textures: number;
  /**
   * Linked WebGL programs (`renderer.info.programs.length`). Tracked because
   * linking a *new* program blocks the main thread synchronously — measured at
   * 50-76 ms inside `gl.getProgramInfoLog` the first time a material is drawn —
   * so a count that grows mid-gameplay predicts a stall the frame-time series
   * can only show after the fact. Read via three's own `info`; nothing here
   * patches the WebGL prototypes.
   */
  readonly programs: number;
}

export class RuntimeRenderer {
  private renderer: WebGLRenderer;
  private canvas: HTMLCanvasElement;
  private resizeObserver: ResizeObserver | null = null;

  constructor(options: RuntimeRendererOptions = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';

    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      antialias: options.antialias ?? true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.info.autoReset = false;

    this.renderer.setPixelRatio(options.pixelRatio ?? window.devicePixelRatio);
    this.renderer.setClearColor(options.clearColor ?? '#000000');
    this.renderer.localClippingEnabled = true;

    if (options.shadows) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = PCFShadowMap;
    }
  }

  get domElement(): HTMLCanvasElement {
    return this.canvas;
  }

  /** The underlying three.js renderer — needed to build a post-processing
   * `EffectComposer` (see {@link ./PostProcessingPipeline}). */
  getWebGLRenderer(): WebGLRenderer {
    return this.renderer;
  }

  attachToDocument(containerId: string = 'app'): void {
    const container = document.getElementById(containerId);
    if (!(container instanceof HTMLElement)) {
      throw new Error(`Missing #${containerId} container`);
    }

    this.attach(container);
  }

  /**
   * Mount the canvas into `container`. Re-entrant on purpose: calling it again with a different
   * element MOVES the live canvas (and with it the WebGL context, so the running game survives the
   * move) instead of leaving a second, orphaned observer behind. The editor uses that to hand a
   * running game between the Studio Game tab and the Vibe stage without restarting it.
   */
  attach(container: HTMLElement): void {
    this.resizeObserver?.disconnect();
    container.appendChild(this.canvas);
    this.resize();

    // Auto-resize observer
    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
    });
    this.resizeObserver.observe(container);
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    if (parent) {
      const width = parent.clientWidth;
      const height = parent.clientHeight;

      this.renderer.setSize(width, height, false);

      // Note: Camera aspect ratio update is responsibility of the SceneRunner or Camera system
    }
  }

  render(scene: Scene, camera: Camera): void {
    this.renderer.render(scene, camera);
  }

  beginStatsFrame(): void {
    this.renderer.info.reset();
  }

  getStatsSnapshot(): RuntimeRendererStatsSnapshot {
    return {
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      points: this.renderer.info.render.points,
      lines: this.renderer.info.render.lines,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      // `info.programs` is nullable in three's typings (null before the first
      // render), hence the guard rather than a bare `.length`.
      programs: this.renderer.info.programs?.length ?? 0,
    };
  }

  setAutoClear(autoClear: boolean): void {
    this.renderer.autoClear = autoClear;
  }

  clear(): void {
    this.renderer.clear();
  }

  clearDepth(): void {
    this.renderer.clearDepth();
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.renderer.dispose();
    this.canvas.remove();
  }
}
