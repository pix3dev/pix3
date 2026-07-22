import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import {
  ACESFilmicToneMapping,
  AmbientLight,
  DirectionalLight,
  GridHelper,
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
  disposeObject3DResources,
  framePerspectiveCameraToObject,
} from '@/services/assets/GltfBlobLoader';
import { IconService, IconSize } from '@/services/editor/IconService';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { Model3DExportService } from '@/services/model-gen/Model3DExportService';
import { AddModelCommand } from '@/features/scene/AddModelCommand';
import { TEST_MODELS, buildTestModel } from '@/services/model-gen/test-models';
import { appState } from '@/state';
import './pix3-model-lab-panel.ts.css';

const DEFAULT_SAVE_FOLDER = 'assets/models';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Model Lab — Phase 1 scaffold.
 *
 * This panel proves the whole non-LLM chain the AI pipeline will plug into: build a `THREE.Group`
 * (here from a small palette of hardcoded procedural test models), preview it live in an owned
 * WebGL viewport, export it to a self-contained `.glb`, save it into the project, and add it to
 * the active scene as a `MeshInstance`. The AI-driven generation (reference → spec → factory →
 * render-review loop) replaces the test-model palette in later phases; the preview, export, and
 * save plumbing stay.
 */
@customElement('pix3-model-lab-panel')
export class ModelLabPanel extends ComponentBase {
  @inject(IconService)
  private readonly icons!: IconService;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(Model3DExportService)
  private readonly exporter!: Model3DExportService;

  @property({ type: String, reflect: true, attribute: 'tab-id' })
  tabId = '';

  @state() private selectedModelId: string = TEST_MODELS[0].id;
  @state() private saveName = 'test-model';
  @state() private saveFolder = DEFAULT_SAVE_FOLDER;
  @state() private saveState: SaveState = 'idle';
  @state() private statusMessage = '';
  @state() private lastSavedPath: string | null = null;
  @state() private isRendererAvailable =
    typeof WebGLRenderingContext !== 'undefined' || typeof WebGL2RenderingContext !== 'undefined';

  private canvas?: HTMLCanvasElement;
  private scene?: Scene;
  private camera?: PerspectiveCamera;
  private renderer?: WebGLRenderer;
  private controls?: OrbitControls;
  private resizeObserver?: ResizeObserver;
  private previewRoot?: Group;
  private currentModel?: Group;
  private frameHandle?: number;
  private renderRequested = true;

  disconnectedCallback(): void {
    this.stopRenderLoop();
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.disposeCurrentModel();
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
    this.canvas = this.querySelector<HTMLCanvasElement>('.model-lab-canvas') ?? undefined;
    if (!this.isRendererAvailable) {
      return;
    }
    this.initializeRenderer();
    if (this.isRendererAvailable) {
      this.buildModel(this.selectedModelId);
    }
  }

  protected render() {
    return html`
      <div class="model-lab">
        <aside class="model-lab-sidebar">
          <header class="model-lab-header">
            <span class="model-lab-header-icon">${this.icons.getIcon('box', IconSize.MEDIUM)}</span>
            <div>
              <h2>Model Lab</h2>
              <p class="model-lab-subtitle">3D asset generator · scaffold</p>
            </div>
          </header>

          <p class="model-lab-note">
            Phase 1 scaffold. Pick a procedural test model to prove the preview → GLB export → save
            → add-to-scene chain. AI generation from a reference image replaces this palette in a
            later phase.
          </p>

          <section class="model-lab-section">
            <h3>Test model</h3>
            <div class="model-lab-palette" role="listbox" aria-label="Test models">
              ${TEST_MODELS.map(
                model => html`
                  <button
                    type="button"
                    role="option"
                    aria-selected=${this.selectedModelId === model.id}
                    class="model-lab-palette-item ${this.selectedModelId === model.id
                      ? 'is-selected'
                      : ''}"
                    @click=${() => this.onSelectModel(model.id)}
                  >
                    ${model.label}
                  </button>
                `
              )}
            </div>
          </section>

          <section class="model-lab-section">
            <h3>Save to project</h3>
            <label class="model-lab-field">
              <span>Folder</span>
              <input
                type="text"
                .value=${this.saveFolder}
                @input=${(e: Event) => (this.saveFolder = (e.target as HTMLInputElement).value)}
                spellcheck="false"
              />
            </label>
            <label class="model-lab-field">
              <span>Name</span>
              <input
                type="text"
                .value=${this.saveName}
                @input=${(e: Event) => (this.saveName = (e.target as HTMLInputElement).value)}
                spellcheck="false"
              />
            </label>
            <div class="model-lab-actions">
              <button
                type="button"
                class="model-lab-button is-primary"
                ?disabled=${this.saveState === 'saving' || !this.isRendererAvailable}
                @click=${() => void this.onSave()}
              >
                ${this.saveState === 'saving' ? 'Saving…' : 'Save GLB'}
              </button>
              <button
                type="button"
                class="model-lab-button"
                ?disabled=${!this.lastSavedPath || appState.project.status !== 'ready'}
                @click=${() => void this.onAddToScene()}
              >
                Add to scene
              </button>
            </div>
            ${this.statusMessage
              ? html`<p
                  class="model-lab-status ${this.saveState === 'error' ? 'is-error' : 'is-ok'}"
                  aria-live="polite"
                >
                  ${this.statusMessage}
                </p>`
              : null}
          </section>
        </aside>

        <div class="model-lab-viewport checker-bg">
          <canvas class="model-lab-canvas" aria-label="Model preview"></canvas>
          ${this.isRendererAvailable
            ? html`<div class="model-lab-hint">
                Drag to orbit · Scroll to zoom · Right drag to pan
              </div>`
            : html`<div class="model-lab-overlay">
                Interactive preview is unavailable in this environment.
              </div>`}
        </div>
      </div>
    `;
  }

  private onSelectModel(id: string): void {
    if (id === this.selectedModelId) {
      return;
    }
    this.selectedModelId = id;
    this.saveName = id;
    this.lastSavedPath = null;
    this.saveState = 'idle';
    this.statusMessage = '';
    this.buildModel(id);
  }

  private buildModel(id: string): void {
    if (!this.scene || !this.camera || !this.previewRoot) {
      return;
    }
    this.disposeCurrentModel();
    const model = buildTestModel(id);
    this.previewRoot.add(model);
    this.previewRoot.updateMatrixWorld(true);
    const framing = framePerspectiveCameraToObject(this.camera, model);
    this.controls?.target.set(0, framing.focusTargetY, 0);
    this.controls?.update();
    this.currentModel = model;
    this.renderRequested = true;
  }

  private async onSave(): Promise<void> {
    if (!this.currentModel) {
      return;
    }
    if (appState.project.status !== 'ready') {
      this.saveState = 'error';
      this.statusMessage = 'Open a project before saving.';
      return;
    }
    const folder = this.saveFolder.trim().replace(/^\/+|\/+$/g, '');
    const name = this.saveName.trim();
    if (!name) {
      this.saveState = 'error';
      this.statusMessage = 'A file name is required.';
      return;
    }
    this.saveState = 'saving';
    this.statusMessage = '';
    try {
      const path = folder ? `${folder}/${name}` : name;
      const result = await this.exporter.saveGlb(this.currentModel, path);
      this.lastSavedPath = result.path;
      this.saveState = 'saved';
      this.statusMessage = `Saved ${result.path} (${formatBytes(result.bytes)}).`;
    } catch (error) {
      this.saveState = 'error';
      this.statusMessage = error instanceof Error ? error.message : 'Failed to save the model.';
    }
  }

  private async onAddToScene(): Promise<void> {
    if (!this.lastSavedPath) {
      return;
    }
    try {
      await this.commandDispatcher.execute(
        new AddModelCommand({ modelPath: `res://${this.lastSavedPath}` })
      );
      this.statusMessage = `Added ${this.lastSavedPath} to the active scene.`;
      this.saveState = 'saved';
    } catch (error) {
      this.saveState = 'error';
      this.statusMessage =
        error instanceof Error ? error.message : 'Failed to add the model to the scene.';
    }
  }

  private initializeRenderer(): void {
    if (!this.canvas || this.renderer) {
      return;
    }
    try {
      this.renderer = new WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.outputColorSpace = SRGBColorSpace;
      this.renderer.toneMapping = ACESFilmicToneMapping;

      this.scene = new Scene();
      this.camera = new PerspectiveCamera(35, 1, 0.01, 1000);
      this.previewRoot = new Group();
      this.scene.add(this.previewRoot);

      this.scene.add(new AmbientLight(0xffffff, 0.55));
      const hemisphere = new HemisphereLight(0xf7fbff, 0x2a3138, 1.1);
      hemisphere.position.set(0, 1, 0);
      this.scene.add(hemisphere);
      const keyLight = new DirectionalLight(0xffffff, 1.45);
      keyLight.position.set(4, 7, 5);
      this.scene.add(keyLight);

      const grid = new GridHelper(10, 20, 0x3a3f47, 0x24272d);
      this.scene.add(grid);

      this.controls = new OrbitControls(this.camera, this.canvas);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      this.controls.target.copy(new Vector3(0, 0.5, 0));
      this.controls.addEventListener('change', () => {
        this.renderRequested = true;
      });
      this.controls.update();

      this.resizeObserver = new ResizeObserver(() => this.resizeRenderer());
      this.resizeObserver.observe(this);
      this.resizeRenderer();
      this.startRenderLoop();
    } catch (error) {
      console.warn('[ModelLabPanel] Failed to initialize WebGL preview.', error);
      this.isRendererAvailable = false;
    }
  }

  private disposeCurrentModel(): void {
    if (this.currentModel && this.previewRoot) {
      this.previewRoot.remove(this.currentModel);
      disposeObject3DResources(this.currentModel);
      this.renderer?.renderLists.dispose();
    }
    this.currentModel = undefined;
    this.renderRequested = true;
  }

  private resizeRenderer(): void {
    if (!this.renderer || !this.camera) {
      return;
    }
    const viewport = this.querySelector<HTMLElement>('.model-lab-viewport');
    const rect = (viewport ?? this).getBoundingClientRect();
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
      if (!this.renderer || !this.scene || !this.camera || !this.renderRequested) {
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
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-model-lab-panel': ModelLabPanel;
  }
}
