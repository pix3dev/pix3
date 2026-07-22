import { ComponentBase, customElement, html, property, state } from '@/fw';
import { resolveProjectStorageService } from '@/services/project/ProjectStorageService';
import {
  ACESFilmicToneMapping,
  AmbientLight,
  DirectionalLight,
  Group,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  createCenteredPreviewRoot,
  disposeObject3DResources,
  framePerspectiveCameraToObject,
  loadGltfFromBlob,
} from '@/services/assets/GltfBlobLoader';
import './model-asset-preview.ts.css';

type InteractivePreviewState = 'idle' | 'loading' | 'ready' | 'error';

@customElement('pix3-model-asset-preview')
export class ModelAssetPreview extends ComponentBase {
  private readonly storage = resolveProjectStorageService();

  @property({ type: String })
  resourcePath: string = '';

  @property({ type: String })
  assetName: string = '3D asset';

  @property({ type: String })
  fallbackImageUrl: string = '';

  @property({ type: String })
  thumbnailStatus: string = 'idle';

  @state()
  private previewState: InteractivePreviewState = 'idle';

  @state()
  private isRendererAvailable =
    typeof WebGLRenderingContext !== 'undefined' || typeof WebGL2RenderingContext !== 'undefined';

  private canvas?: HTMLCanvasElement;
  private previewRoot?: Group;
  private scene?: Scene;
  private camera?: PerspectiveCamera;
  private renderer?: WebGLRenderer;
  private controls?: OrbitControls;
  private resizeObserver?: ResizeObserver;
  private currentAssetRoot?: Group;
  private currentAssetCleanup?: () => void;
  private frameHandle?: number;
  private loadVersion = 0;
  private renderRequested = true;

  connectedCallback(): void {
    super.connectedCallback();
  }

  disconnectedCallback(): void {
    this.loadVersion += 1;
    this.stopRenderLoop();
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.disposeCurrentAsset();
    this.controls?.dispose();
    this.controls = undefined;
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer = undefined;
    this.scene = undefined;
    this.camera = undefined;
    this.previewRoot = undefined;
    super.disconnectedCallback();
  }

  protected firstUpdated(): void {
    this.canvas = this.querySelector<HTMLCanvasElement>('.model-asset-preview-canvas') ?? undefined;
    if (!this.isRendererAvailable) {
      return;
    }

    this.initializeRenderer();
    if (this.isRendererAvailable) {
      void this.loadModel();
    }
  }

  protected updated(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has('resourcePath')) {
      if (!this.resourcePath) {
        this.loadVersion += 1;
        this.disposeCurrentAsset();
        this.previewState = 'idle';
        return;
      }

      if (this.renderer) {
        void this.loadModel();
      }
    }
  }

  protected render() {
    const statusMessage = this.getStatusMessage();
    const showOverlay = !this.isRendererAvailable || this.previewState !== 'ready';
    const showSpinner = this.previewState === 'loading';

    return html`
      <div
        class="model-asset-preview checker-bg ${this.previewState === 'ready' ? 'is-ready' : ''}"
      >
        <canvas
          class="model-asset-preview-canvas"
          aria-label=${`${this.assetName} preview`}
        ></canvas>
        ${showOverlay
          ? html`
              <div class="model-asset-preview-overlay" aria-live="polite">
                ${this.fallbackImageUrl
                  ? html`<img
                      class="model-asset-preview-fallback"
                      src=${this.fallbackImageUrl}
                      alt=${`${this.assetName} thumbnail`}
                    />`
                  : html`
                      <div class="model-asset-preview-placeholder" aria-hidden="true">
                        <span class="model-asset-preview-cube"></span>
                      </div>
                    `}
                ${showSpinner
                  ? html`<span class="model-asset-preview-spinner" aria-hidden="true"></span>`
                  : null}
                <span class="model-asset-preview-status">${statusMessage}</span>
              </div>
            `
          : null}
        <div class="model-asset-preview-hint">
          Drag to orbit · Scroll to zoom · Right drag to pan
        </div>
      </div>
    `;
  }

  private initializeRenderer(): void {
    if (!this.canvas || this.renderer) {
      return;
    }

    try {
      this.renderer = new WebGLRenderer({
        canvas: this.canvas,
        alpha: true,
        antialias: true,
      });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.outputColorSpace = SRGBColorSpace;
      this.renderer.toneMapping = ACESFilmicToneMapping;

      this.scene = new Scene();
      this.camera = new PerspectiveCamera(35, 1, 0.01, 1000);
      this.previewRoot = new Group();
      this.scene.add(this.previewRoot);
      this.scene.add(new AmbientLight(0xffffff, 0.55));

      const hemisphereLight = new HemisphereLight(0xf7fbff, 0x2a3138, 1.1);
      hemisphereLight.position.set(0, 1, 0);
      this.scene.add(hemisphereLight);

      const keyLight = new DirectionalLight(0xffffff, 1.45);
      keyLight.position.set(4, 7, 5);
      this.scene.add(keyLight);

      this.controls = new OrbitControls(this.camera, this.canvas);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      this.controls.enableZoom = true;
      this.controls.enablePan = true;
      this.controls.target.copy(new Vector3(0, 0, 0));
      this.controls.addEventListener('change', () => {
        this.renderRequested = true;
      });
      this.controls.update();

      this.resizeObserver = new ResizeObserver(() => this.resizeRenderer());
      this.resizeObserver.observe(this);
      this.resizeRenderer();
      this.startRenderLoop();
    } catch (error) {
      console.warn('[ModelAssetPreview] Failed to initialize WebGL preview.', error);
      this.isRendererAvailable = false;
      this.previewState = 'error';
    }
  }

  private async loadModel(): Promise<void> {
    if (!this.resourcePath) {
      this.previewState = 'idle';
      return;
    }

    const version = ++this.loadVersion;
    this.previewState = 'loading';
    this.disposeCurrentAsset();

    if (!this.renderer || !this.camera || !this.previewRoot) {
      return;
    }

    try {
      const blob = await this.storage.readBlob(this.resourcePath);
      const { gltf, cleanup } = await loadGltfFromBlob({
        blob,
        sourcePath: this.resourcePath,
        readBlob: path => this.storage.readBlob(path),
      });
      const previewRoot = createCenteredPreviewRoot(gltf.scene);

      if (version !== this.loadVersion) {
        cleanup();
        disposeObject3DResources(previewRoot);
        return;
      }

      this.previewRoot.add(previewRoot);
      this.previewRoot.updateMatrixWorld(true);

      const framing = framePerspectiveCameraToObject(this.camera, previewRoot);
      this.controls?.target.set(0, framing.focusTargetY, 0);
      this.controls?.update();

      this.currentAssetRoot = previewRoot;
      this.currentAssetCleanup = cleanup;
      this.previewState = 'ready';
      this.renderRequested = true;
    } catch (error) {
      if (version !== this.loadVersion) {
        return;
      }

      console.warn('[ModelAssetPreview] Failed to load 3D asset preview.', error);
      this.previewState = 'error';
    }
  }

  private disposeCurrentAsset(): void {
    if (this.currentAssetRoot && this.previewRoot) {
      this.previewRoot.remove(this.currentAssetRoot);
    }

    this.currentAssetCleanup?.();

    if (this.currentAssetRoot) {
      disposeObject3DResources(this.currentAssetRoot);
      this.renderer?.renderLists.dispose();
    }

    this.currentAssetRoot = undefined;
    this.currentAssetCleanup = undefined;
    this.renderRequested = true;
  }

  private resizeRenderer(): void {
    if (!this.renderer || !this.camera) {
      return;
    }

    const rect = this.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));

    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderRequested = true;
  }

  private startRenderLoop(): void {
    if (this.frameHandle !== undefined) {
      return;
    }

    const renderFrame = () => {
      this.frameHandle = requestAnimationFrame(renderFrame);
      if (!this.renderer || !this.scene || !this.camera) {
        return;
      }

      // Render on demand only: OrbitControls fires 'change' while the user
      // interacts (and while damping settles), which re-marks the frame
      // dirty. An idle preview costs no CPU/GPU.
      if (!this.renderRequested) {
        return;
      }
      this.renderRequested = false;

      this.controls?.update();
      this.renderer.render(this.scene, this.camera);
    };

    this.frameHandle = requestAnimationFrame(renderFrame);
  }

  private stopRenderLoop(): void {
    if (this.frameHandle === undefined) {
      return;
    }

    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = undefined;
  }

  private getStatusMessage(): string {
    if (!this.isRendererAvailable) {
      return 'Interactive preview is unavailable in this environment.';
    }

    if (this.previewState === 'loading') {
      return 'Loading interactive 3D preview...';
    }

    if (this.previewState === 'error') {
      return this.thumbnailStatus === 'ready'
        ? 'Interactive preview unavailable. Showing cached thumbnail.'
        : 'Unable to render this 3D asset preview.';
    }

    return 'Interactive preview ready.';
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-model-asset-preview': ModelAssetPreview;
  }
}
