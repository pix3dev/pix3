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
}

export class RuntimeRenderer {
  private renderer: WebGLRenderer;
  private canvas: HTMLCanvasElement;

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

    if (options.shadows) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = PCFShadowMap;
    }
  }

  get domElement(): HTMLCanvasElement {
    return this.canvas;
  }

  attachToDocument(containerId: string = 'app'): void {
    const container = document.getElementById(containerId);
    if (!(container instanceof HTMLElement)) {
      throw new Error(`Missing #${containerId} container`);
    }

    this.attach(container);
  }

  attach(container: HTMLElement): void {
    container.appendChild(this.canvas);
    this.resize();

    // Auto-resize observer
    const resizeObserver = new ResizeObserver(() => {
      this.resize();
    });
    resizeObserver.observe(container);
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
    this.renderer.dispose();
    this.canvas.remove();
  }
}
