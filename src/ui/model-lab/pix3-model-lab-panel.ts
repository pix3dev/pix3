import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import {
  ACESFilmicToneMapping,
  AmbientLight,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  type Object3D,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { SceneManager } from '@pix3/runtime';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  disposeObject3DResources,
  framePerspectiveCameraToObject,
} from '@/services/assets/GltfBlobLoader';
import { IconService, IconSize } from '@/services/editor/IconService';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { Model3DExportService } from '@/services/model-gen/Model3DExportService';
import { Model3DGenService } from '@/services/model-gen/Model3DGenService';
import { Scene3DGenService } from '@/services/model-gen/scene/Scene3DGenService';
import {
  Model3DGenHistoryService,
  type ModelGenRecord,
} from '@/services/model-gen/Model3DGenHistoryService';
import {
  Model3DGenSettingsService,
  type ModelLabPreferences,
} from '@/services/model-gen/Model3DGenSettingsService';
import { blobToBase64 } from '@/services/image-gen/image-ops';
import { LlmProviderRegistry } from '@/services/llm/LlmProviderRegistry';
import { LlmModelCatalogService } from '@/services/llm/LlmModelCatalogService';
import { formatPricingHint, type ReasoningEffort } from '@/services/llm/LlmTypes';
import { AddModelCommand } from '@/features/scene/AddModelCommand';
import { TEST_MODELS, buildTestModel } from '@/services/model-gen/test-models';
import type {
  ComplexityHint,
  LlmUsageAggregate,
  ModelGenLogEntry,
  ModelGenState,
  ModelGenStatus,
  PassRecord,
  PassStatus,
  PendingReview,
  ReferenceImageInput,
} from '@/services/model-gen/model-gen-types';
import type {
  SceneGenState,
  SceneGenStatus,
} from '@/services/model-gen/scene/scene-gen-types';
import type { PaletteGap } from '@/services/model-gen/scene/LevelSpec';
import { appState } from '@/state';
import './pix3-model-lab-panel.ts.css';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type LabTab = 'generate' | 'settings';
type GenLane = 'model' | 'scene';

/** A reference image staged for generation. `dataUrl` drives the thumbnail; `base64` is prefix-free. */
interface StagedReference {
  mimeType: string;
  base64: string;
  dataUrl: string;
}

/**
 * The subset of pipeline state the shared monitor renders. Both {@link ModelGenState} and
 * {@link SceneGenState} are assignable to it (their `status` unions differ, but every other field
 * these views read is identical), so the monitor / pass list / comparison sheet / review card are
 * lane-agnostic — driven by whichever lane is active.
 */
interface MonitorView {
  status: ModelGenStatus | SceneGenStatus;
  stageLabel: string;
  log: readonly ModelGenLogEntry[];
  passes: readonly PassRecord[];
  currentPassId: string | null;
  pendingReview: PendingReview | null;
  usage: LlmUsageAggregate;
  error: string | null;
}

/** The review-gate contract shared by both lane services (accept / retry / stop). */
interface ReviewDecider {
  decideReview(decision: 'accept' | 'retry' | 'stop'): void;
}

const DEFAULT_SAVE_FOLDER = 'models';
const DEFAULT_SCENE_SAVE_FOLDER = 'scenes';

const DEFAULT_GEN_STATE: ModelGenState = {
  status: 'idle',
  stageLabel: '',
  log: [],
  assessment: null,
  spec: null,
  factoryCode: null,
  modelRevision: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, calls: 0 },
  error: null,
  canGenerate: true,
  passes: [],
  currentPassId: null,
  pendingReview: null,
};

const DEFAULT_PREFS: ModelLabPreferences = {
  codegenProviderId: '',
  codegenModelId: '',
  visionProviderId: '',
  visionModelId: '',
  reasoningEffortByModel: {},
  scoreThreshold: 0.7,
  maxIterationsPerPass: 3,
  pauseForReview: false,
  mode: 'quality',
  saveFolder: DEFAULT_SAVE_FOLDER,
  sceneSaveFolder: DEFAULT_SCENE_SAVE_FOLDER,
};

const DEFAULT_SCENE_GEN_STATE: SceneGenState = {
  status: 'idle',
  stageLabel: '',
  log: [],
  levelSpec: null,
  sceneYaml: null,
  passes: [],
  currentPassId: null,
  pendingReview: null,
  inventory: null,
  sceneRevision: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, calls: 0 },
  error: null,
  canGenerate: true,
  savedPath: null,
};

/** Map a pipeline status (either lane) to a compact chip label + tone class. */
function statusChip(status: ModelGenStatus | SceneGenStatus): { label: string; tone: string } {
  switch (status) {
    case 'idle':
      return { label: 'Idle', tone: 'idle' };
    case 'intake':
      return { label: 'Intake', tone: 'busy' };
    case 'assessing':
      return { label: 'Assessing', tone: 'busy' };
    case 'inventory':
      return { label: 'Inventory', tone: 'busy' };
    case 'speccing':
      return { label: 'Speccing', tone: 'busy' };
    case 'building':
      return { label: 'Building', tone: 'busy' };
    case 'validating':
      return { label: 'Validating', tone: 'busy' };
    case 'compiling':
      return { label: 'Compiling', tone: 'busy' };
    case 'rendering':
      return { label: 'Rendering', tone: 'busy' };
    case 'reviewing':
      return { label: 'Reviewing', tone: 'busy' };
    case 'done':
      return { label: 'Done', tone: 'ok' };
    case 'error':
      return { label: 'Error', tone: 'error' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'warn' };
    default:
      return { label: status, tone: 'idle' };
  }
}

/** Map a pass lifecycle status to an IconService glyph name + tone class + spin flag. */
function passVisual(status: PassStatus): { icon: string; tone: string; spin: boolean } {
  switch (status) {
    case 'running':
    case 'reviewing':
      return { icon: 'loader', tone: 'accent', spin: true };
    case 'passed':
      return { icon: 'check-circle', tone: 'ok', spin: false };
    case 'failed':
      return { icon: 'x-circle', tone: 'danger', spin: false };
    case 'skipped':
      return { icon: 'minus-circle', tone: 'muted', spin: false };
    case 'pending':
    default:
      return { icon: 'circle', tone: 'muted', spin: false };
  }
}

/** A vision fidelity score in [0,1] is "ok" (green) at/above a rough bar, else "warn" (amber). */
function scoreTone(score: number): 'ok' | 'warn' {
  return score >= 0.7 ? 'ok' : 'warn';
}

/** Render a [0,1] score as a whole-percent badge label. */
function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/**
 * Model Lab — Phase 3 panel.
 *
 * A two-tab (Generate · Settings) editor panel over the headless {@link Model3DGenService} pipeline.
 * The Generate tab stages a reference image (drop / pick / paste), an optional prompt, and a
 * complexity hint, then drives an intake → assess → spec → factory → compile job whose every state
 * emission streams into a live pipeline monitor. Phase 3 makes that job a **pass-gated review loop**:
 * each locked pass (blockout → structure → form → material → …) builds, renders a
 * reference|render comparison sheet, and is vision-scored; the monitor surfaces the per-pass status
 * list, the latest comparison sheet, and — when `pauseForReview` is on — a manual review card that
 * steers the loop via {@link Model3DGenService.decideReview} (Accept / Retry / Stop). Each successful
 * compile bumps `modelRevision`; the panel hot-swaps the fresh `THREE.Group` into its OWN preview
 * viewport (the same dispose → add → frame path the test-model palette uses), making it the
 * Save GLB / Add-to-scene target. The Settings tab exposes the codegen + vision model pickers, the
 * review pause toggle + score threshold, and loop knobs backed by {@link Model3DGenSettingsService}.
 *
 * The owned `WebGLRenderer` + on-demand render loop from Phase 1 is preserved verbatim; the service
 * never disposes a Group it hands out, so this panel owns disposal via {@link disposeCurrentModel}.
 */
@customElement('pix3-model-lab-panel')
export class ModelLabPanel extends ComponentBase {
  @inject(IconService)
  private readonly icons!: IconService;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(Model3DExportService)
  private readonly exporter!: Model3DExportService;

  @inject(Model3DGenService)
  private readonly genService!: Model3DGenService;

  @inject(Scene3DGenService)
  private readonly sceneGenService!: Scene3DGenService;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(EditorTabService)
  private readonly editorTabs!: EditorTabService;

  @inject(Model3DGenHistoryService)
  private readonly history!: Model3DGenHistoryService;

  @inject(Model3DGenSettingsService)
  private readonly settings!: Model3DGenSettingsService;

  @inject(LlmProviderRegistry)
  private readonly providers!: LlmProviderRegistry;

  @inject(LlmModelCatalogService)
  private readonly catalog!: LlmModelCatalogService;

  @property({ type: String, reflect: true, attribute: 'tab-id' })
  tabId = '';

  @state() private activeTab: LabTab = 'generate';
  @state() private activeLane: GenLane = 'model';

  // -- model-lane generation inputs ------------------------------------------
  @state() private reference: StagedReference | null = null;
  @state() private prompt = '';
  @state() private complexity: ComplexityHint = 'moderate';
  @state() private isDragOver = false;

  // -- scene-lane generation inputs ------------------------------------------
  @state() private brief = '';
  @state() private sceneReferences: StagedReference[] = [];
  /** Optional `res://`/project path to an existing `.pix3scene` to EDIT instead of authoring fresh. */
  @state() private sceneBasePath = '';

  // -- mirrored service state ------------------------------------------------
  @state() private gen: ModelGenState = DEFAULT_GEN_STATE;
  @state() private sceneGen: SceneGenState = DEFAULT_SCENE_GEN_STATE;
  @state() private prefs: ModelLabPreferences = DEFAULT_PREFS;
  @state() private refreshingProviderId: string | null = null;

  // -- job history -----------------------------------------------------------
  @state() private historyRecords: ModelGenRecord[] = [];
  /** Record id → object URL for its thumbnail; revoked on reload + disconnect. */
  private readonly historyUrls = new Map<string, string>();

  // -- test-model palette + save ---------------------------------------------
  @state() private selectedModelId: string = TEST_MODELS[0].id;
  @state() private saveName = 'test-model';
  @state() private saveFolder = DEFAULT_SAVE_FOLDER;
  @state() private saveState: SaveState = 'idle';
  @state() private statusMessage = '';
  @state() private lastSavedPath: string | null = null;

  // -- scene-lane save -------------------------------------------------------
  @state() private sceneSaveName = 'level';
  @state() private sceneSaveFolder = DEFAULT_SCENE_SAVE_FOLDER;
  @state() private sceneSaveState: SaveState = 'idle';
  @state() private sceneStatusMessage = '';
  @state() private sceneSavedPath: string | null = null;

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
  /** The scene-lane preview roots — remove-only on clear (they reference AssetLoader-cached resources). */
  private currentSceneRoots: Object3D[] = [];
  private frameHandle?: number;
  private renderRequested = true;

  private readonly disposers: Array<() => void> = [];
  private lastModelRevision = 0;
  private lastSceneRevision = 0;
  private lastLogCount = 0;
  private saveFolderSeeded = false;
  private sceneSaveFolderSeeded = false;

  connectedCallback(): void {
    super.connectedCallback();
    this.disposers.push(this.genService.subscribe(state => this.onGenState(state)));
    this.disposers.push(this.sceneGenService.subscribe(state => this.onSceneGenState(state)));
    this.disposers.push(this.settings.subscribe(prefs => this.onPrefs(prefs)));
    this.disposers.push(this.catalog.subscribe(() => this.requestUpdate()));
    if (Model3DGenHistoryService.isSupported()) {
      this.disposers.push(this.history.subscribe(() => void this.reloadHistory()));
      void this.reloadHistory();
    }
    this.addEventListener('paste', this.onPaste);
  }

  disconnectedCallback(): void {
    this.removeEventListener('paste', this.onPaste);
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
    this.stopRenderLoop();
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    for (const url of this.historyUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this.historyUrls.clear();
    this.disposeCurrentModel();
    this.clearSceneRoots();
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
    if (!this.isRendererAvailable) {
      return;
    }
    // Prefer a model the pipeline already produced (panel reopened after a job); else a test model.
    if (this.genService.getModel()) {
      this.swapInGeneratedModel();
    } else {
      this.buildModel(this.selectedModelId);
    }
  }

  protected updated(): void {
    const logLength = this.activeMonitor().log.length;
    if (logLength !== this.lastLogCount) {
      this.lastLogCount = logLength;
      const log = this.querySelector<HTMLElement>('.ml-log');
      if (log) {
        log.scrollTop = log.scrollHeight;
      }
    }
  }

  /** The pipeline state driving the shared monitor — the currently-selected lane's. */
  private activeMonitor(): MonitorView {
    return this.activeLane === 'scene' ? this.sceneGen : this.gen;
  }

  private activeDecider(): ReviewDecider {
    return this.activeLane === 'scene' ? this.sceneGenService : this.genService;
  }

  protected render() {
    return html`
      <div class="model-lab">
        <aside class="model-lab-sidebar">
          <header class="model-lab-header">
            <span class="model-lab-header-icon">${this.icons.getIcon('box', IconSize.MEDIUM)}</span>
            <div>
              <h2>Model Lab</h2>
              <p class="model-lab-subtitle">3D asset generator</p>
            </div>
          </header>

          <nav class="ml-tabs" role="tablist" aria-label="Model Lab tabs">
            <button
              type="button"
              role="tab"
              aria-selected=${this.activeTab === 'generate'}
              class="ml-tab ${this.activeTab === 'generate' ? 'is-active' : ''}"
              @click=${() => (this.activeTab = 'generate')}
            >
              Generate
            </button>
            <button
              type="button"
              role="tab"
              aria-selected=${this.activeTab === 'settings'}
              class="ml-tab ${this.activeTab === 'settings' ? 'is-active' : ''}"
              @click=${() => (this.activeTab = 'settings')}
            >
              Settings
            </button>
          </nav>

          ${this.activeTab === 'generate' ? this.renderGenerateTab() : this.renderSettingsTab()}
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

  // -- Generate tab ----------------------------------------------------------

  private renderGenerateTab() {
    return html`
      ${this.renderLaneSwitch()}
      ${this.activeLane === 'model' ? this.renderModelInputs() : this.renderSceneInputs()}
      ${this.renderMonitor(this.activeMonitor(), this.activeDecider())}
      ${this.activeLane === 'scene' ? this.renderPaletteGaps() : null}
      ${this.activeLane === 'model' ? this.renderSaveGroup() : this.renderSceneSaveGroup()}
      ${this.activeLane === 'model'
        ? html`${this.renderHistory()} ${this.renderTestModels()}`
        : null}
    `;
  }

  /** The Model | Scene lane selector at the top of the Generate tab. */
  private renderLaneSwitch() {
    return html`
      <div class="ml-lane-switch" role="group" aria-label="Generation lane">
        <button
          type="button"
          class="ml-lane ${this.activeLane === 'model' ? 'is-active' : ''}"
          aria-pressed=${this.activeLane === 'model'}
          @click=${() => this.setLane('model')}
        >
          Model
        </button>
        <button
          type="button"
          class="ml-lane ${this.activeLane === 'scene' ? 'is-active' : ''}"
          aria-pressed=${this.activeLane === 'scene'}
          @click=${() => this.setLane('scene')}
        >
          Scene
        </button>
      </div>
    `;
  }

  private renderModelInputs() {
    const running = !this.gen.canGenerate;
    return html`
      <section class="model-lab-section">
        <h3>Reference image</h3>
        <div
          class="ml-dropzone ${this.isDragOver ? 'is-dragover' : ''}"
          @dragover=${this.onDragOver}
          @dragleave=${this.onDragLeave}
          @drop=${this.onDrop}
        >
          ${this.reference
            ? html`<div class="ml-thumb">
                <img src=${this.reference.dataUrl} alt="Reference" />
                <button
                  type="button"
                  class="ml-thumb-remove"
                  aria-label="Remove reference image"
                  @click=${() => this.clearReference()}
                >
                  ${this.icons.getIcon('x', IconSize.SMALL)}
                </button>
              </div>`
            : html`<div class="ml-dropzone-empty">
                <span class="ml-dropzone-icon">${this.icons.getIcon('image', IconSize.LARGE)}</span>
                <p>Drop an image, paste, or</p>
                <button
                  type="button"
                  class="model-lab-button"
                  @click=${() => this.querySelector<HTMLInputElement>('.ml-file-input')?.click()}
                >
                  Choose file…
                </button>
              </div>`}
        </div>
        <input
          type="file"
          accept="image/*"
          class="ml-file-input"
          hidden
          @change=${this.onPickFile}
        />
        <p class="ml-coming-soon">Picking from project assets and 2D-gen history is coming soon.</p>
      </section>

      <section class="model-lab-section">
        <h3>Prompt <span class="ml-optional">optional</span></h3>
        <textarea
          class="ml-textarea"
          rows="3"
          placeholder="Intent or notes (e.g. low-poly wooden crate)"
          spellcheck="false"
          .value=${this.prompt}
          @input=${(e: Event) => (this.prompt = (e.target as HTMLTextAreaElement).value)}
        ></textarea>
      </section>

      <section class="model-lab-section">
        <h3>Complexity</h3>
        <select
          class="ml-select"
          .value=${this.complexity}
          @change=${(e: Event) =>
            (this.complexity = (e.target as HTMLSelectElement).value as ComplexityHint)}
        >
          <option value="simple">Simple</option>
          <option value="moderate">Moderate</option>
          <option value="complex">Complex</option>
        </select>
      </section>

      <section class="model-lab-section">
        ${running
          ? html`<button
              type="button"
              class="model-lab-button is-danger with-icon"
              @click=${() => this.onStop()}
            >
              <span>${this.icons.getIcon('stop-circle', IconSize.SMALL)}</span> Stop
            </button>`
          : html`<button
              type="button"
              class="model-lab-button is-primary with-icon"
              ?disabled=${!this.reference}
              @click=${() => this.onGenerate()}
            >
              <span>${this.icons.getIcon('zap', IconSize.SMALL)}</span> Generate
            </button>`}
        ${!running && !this.reference
          ? html`<p class="model-lab-status is-ok">Add a reference image to generate.</p>`
          : null}
      </section>
    `;
  }

  // -- Scene lane inputs -----------------------------------------------------

  private renderSceneInputs() {
    const running = !this.sceneGen.canGenerate;
    const briefEmpty = !this.brief.trim();
    const inventory = this.sceneGen.inventory;
    return html`
      <section class="model-lab-section">
        <h3>Brief</h3>
        <textarea
          class="ml-textarea"
          rows="4"
          placeholder="a desert canyon arena with a central shrine, top-down camera…"
          spellcheck="false"
          .value=${this.brief}
          @input=${(e: Event) => (this.brief = (e.target as HTMLTextAreaElement).value)}
        ></textarea>
      </section>

      <section class="model-lab-section">
        <h3>Edit existing scene <span class="ml-optional">optional</span></h3>
        <input
          type="text"
          class="ml-input"
          placeholder="res://scenes/level1.pix3scene"
          spellcheck="false"
          .value=${this.sceneBasePath}
          @input=${(e: Event) => (this.sceneBasePath = (e.target as HTMLInputElement).value)}
        />
        <p class="ml-field-note">
          Leave empty to author a new level; set a path to dress/light an existing scene.
        </p>
      </section>

      <section class="model-lab-section">
        <h3>Reference images <span class="ml-optional">optional</span></h3>
        <div
          class="ml-ref-strip ${this.isDragOver ? 'is-dragover' : ''}"
          @dragover=${this.onDragOver}
          @dragleave=${this.onDragLeave}
          @drop=${this.onSceneDrop}
        >
          ${this.sceneReferences.map(
            (ref, index) => html`
              <div class="ml-ref-thumb">
                <img src=${ref.dataUrl} alt=${`Reference ${index + 1}`} />
                <button
                  type="button"
                  class="ml-thumb-remove"
                  aria-label="Remove reference image ${index + 1}"
                  @click=${() => this.removeSceneReference(index)}
                >
                  ${this.icons.getIcon('x', IconSize.SMALL)}
                </button>
              </div>
            `
          )}
          <button
            type="button"
            class="ml-ref-add"
            aria-label="Add reference image"
            @click=${() => this.querySelector<HTMLInputElement>('.ml-scene-file-input')?.click()}
          >
            ${this.icons.getIcon('image', IconSize.MEDIUM)}
            <span>Add</span>
          </button>
        </div>
        <input
          type="file"
          accept="image/*"
          class="ml-scene-file-input"
          hidden
          multiple
          @change=${this.onPickSceneFiles}
        />
      </section>

      ${inventory
        ? html`<p class="ml-field-note">
            Palette: ${inventory.counts.model} models · ${inventory.counts.prefab} prefabs ·
            ${inventory.counts.texture} textures
          </p>`
        : null}

      <section class="model-lab-section">
        ${running
          ? html`<button
              type="button"
              class="model-lab-button is-danger with-icon"
              @click=${() => this.onStopScene()}
            >
              <span>${this.icons.getIcon('stop-circle', IconSize.SMALL)}</span> Stop
            </button>`
          : html`<button
              type="button"
              class="model-lab-button is-primary with-icon"
              ?disabled=${briefEmpty}
              @click=${() => this.onGenerateScene()}
            >
              <span>${this.icons.getIcon('zap', IconSize.SMALL)}</span> Generate
            </button>`}
        ${!running && briefEmpty
          ? html`<p class="model-lab-status is-ok">Describe the scene to generate.</p>`
          : null}
      </section>
    `;
  }

  /**
   * Advisory card (scene lane only): assets the brief implies that the project palette lacks. Each
   * carries a ready-to-use model-lane prompt; the button hands it off to the model lane so the user
   * can generate the missing asset, then dress the scene with it.
   */
  private renderPaletteGaps() {
    const gaps = this.sceneGen.levelSpec?.paletteGaps;
    if (!gaps || gaps.length === 0) {
      return null;
    }
    return html`
      <section class="model-lab-section">
        <h3>Palette gaps</h3>
        <div class="ml-gaps">
          <p class="ml-gaps-intro">The brief calls for assets not in your project:</p>
          <ul class="ml-gaps-list" aria-label="Palette gaps">
            ${gaps.map(
              gap => html`<li class="ml-gap">
                <span class="ml-gap-need" title=${gap.need}>${gap.need}</span>
                <button
                  type="button"
                  class="model-lab-button with-icon"
                  @click=${() => this.onFillGapInModelLane(gap)}
                >
                  <span>${this.icons.getIcon('box', IconSize.SMALL)}</span> Generate in Model lane
                </button>
              </li>`
            )}
          </ul>
        </div>
      </section>
    `;
  }

  /**
   * Hand a palette gap to the model lane: seed the model-lane prompt, switch lanes (reusing
   * {@link setLane} so the preview swaps correctly), then scroll the reference dropzone into view so
   * the user knows to add a reference image.
   */
  private onFillGapInModelLane(gap: PaletteGap): void {
    this.prompt = gap.suggestedPrompt;
    this.setLane('model');
    void this.updateComplete.then(() => {
      this.querySelector('.ml-dropzone')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  // -- Shared pipeline monitor -----------------------------------------------

  private renderMonitor(gen: MonitorView, decider: ReviewDecider) {
    if (
      gen.status === 'idle' &&
      gen.log.length === 0 &&
      gen.passes.length === 0 &&
      !gen.pendingReview
    ) {
      return null;
    }
    const chip = statusChip(gen.status);
    return html`
      <section class="model-lab-section">
        <h3>Pipeline</h3>
        <div class="ml-status-row">
          <span class="ml-chip ml-chip--${chip.tone}">${chip.label}</span>
          ${gen.stageLabel ? html`<span class="ml-stage">${gen.stageLabel}</span>` : null}
        </div>
        ${gen.error ? html`<p class="ml-error" role="alert">${gen.error}</p>` : null}
        ${this.renderReviewCard(gen, decider)} ${this.renderPassList(gen)}
        ${this.renderComparisonSheet(gen)}
        ${gen.log.length
          ? html`<div class="ml-log" role="log" aria-live="polite">
              ${gen.log.map(
                entry =>
                  html`<div class="ml-log-line ml-log-line--${entry.level}">${entry.text}</div>`
              )}
            </div>`
          : null}
        ${gen.usage.calls > 0
          ? html`<p class="ml-usage">
              ${gen.usage.calls} calls · in ${gen.usage.inputTokens} / out ${gen.usage.outputTokens}
              tok
            </p>`
          : null}
      </section>
    `;
  }

  /** Compact vertical list of the current job's passes with status glyph + score badge. */
  private renderPassList(gen: MonitorView) {
    const { passes, currentPassId } = gen;
    if (passes.length === 0) {
      return null;
    }
    return html`
      <ul class="ml-pass-list" aria-label="Build passes">
        ${passes.map(pass => {
          const visual = passVisual(pass.status);
          return html`<li class="ml-pass ${pass.id === currentPassId ? 'is-current' : ''}">
            <span
              class="ml-pass-icon ml-pass-icon--${visual.tone} ${visual.spin ? 'is-running' : ''}"
            >
              ${this.icons.getIcon(visual.icon, IconSize.SMALL)}
            </span>
            <div class="ml-pass-body">
              <div class="ml-pass-head">
                <span class="ml-pass-label">${pass.label}</span>
                ${pass.score != null
                  ? html`<span class="ml-score ml-score--${scoreTone(pass.score)}"
                      >${formatScore(pass.score)}</span
                    >`
                  : null}
              </div>
              ${pass.rationale
                ? html`<p class="ml-pass-rationale" title=${pass.rationale}>${pass.rationale}</p>`
                : null}
            </div>
          </li>`;
        })}
      </ul>
    `;
  }

  /** The current (or last) pass's reference|render comparison sheet, when one exists. */
  private renderComparisonSheet(gen: MonitorView) {
    const { passes, currentPassId } = gen;
    const sheetPass =
      passes.find(pass => pass.id === currentPassId && pass.sheetDataUrl) ??
      [...passes].reverse().find(pass => pass.sheetDataUrl);
    if (!sheetPass || !sheetPass.sheetDataUrl) {
      return null;
    }
    return html`
      <figure class="ml-sheet">
        <img src=${sheetPass.sheetDataUrl} alt="Reference vs render comparison for ${sheetPass.label}" />
        <figcaption class="ml-sheet-caption">
          ${sheetPass.label}${sheetPass.score != null ? html` · ${formatScore(sheetPass.score)}` : null}
        </figcaption>
      </figure>
    `;
  }

  /** The manual review gate — only rendered while a decision is awaited. Routes to the active lane. */
  private renderReviewCard(gen: MonitorView, decider: ReviewDecider) {
    const review = gen.pendingReview;
    if (!review) {
      return null;
    }
    const passLabel = gen.passes.find(pass => pass.id === review.passId)?.label ?? review.passId;
    return html`
      <div class="ml-review" role="group" aria-label="Manual review">
        <div class="ml-review-head">
          <span class="ml-review-title">Review · ${passLabel}</span>
          <span class="ml-score ml-score--${scoreTone(review.score)}">${formatScore(review.score)}</span>
        </div>
        <p class="ml-review-suggested">Suggested: <strong>${review.decision}</strong></p>
        ${review.rationale ? html`<p class="ml-review-rationale">${review.rationale}</p>` : null}
        <figure class="ml-sheet">
          <img src=${review.sheetDataUrl} alt="Reference vs render comparison for ${passLabel}" />
        </figure>
        <div class="ml-review-actions">
          <button
            type="button"
            class="model-lab-button is-primary with-icon"
            @click=${() => decider.decideReview('accept')}
          >
            <span>${this.icons.getIcon('check', IconSize.SMALL)}</span> Accept
          </button>
          <button
            type="button"
            class="model-lab-button with-icon"
            @click=${() => decider.decideReview('retry')}
          >
            <span>${this.icons.getIcon('refresh-cw', IconSize.SMALL)}</span> Retry
          </button>
          <button
            type="button"
            class="model-lab-button is-danger with-icon"
            @click=${() => decider.decideReview('stop')}
          >
            <span>${this.icons.getIcon('stop-circle', IconSize.SMALL)}</span> Stop
          </button>
        </div>
      </div>
    `;
  }

  private renderSaveGroup() {
    return html`
      <section class="model-lab-section">
        <h3>Save to project</h3>
        <label class="model-lab-field">
          <span>Folder</span>
          <input
            type="text"
            .value=${this.saveFolder}
            @input=${(e: Event) => {
              this.saveFolder = (e.target as HTMLInputElement).value;
              this.saveFolderSeeded = true;
            }}
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
    `;
  }

  /** Scene-lane save group: writes a `.pix3scene` document and opens it in an editor tab. */
  private renderSceneSaveGroup() {
    const hasScene = this.sceneGen.sceneYaml != null;
    return html`
      <section class="model-lab-section">
        <h3>Save to project</h3>
        <label class="model-lab-field">
          <span>Folder</span>
          <input
            type="text"
            .value=${this.sceneSaveFolder}
            @input=${(e: Event) => {
              this.sceneSaveFolder = (e.target as HTMLInputElement).value;
              this.sceneSaveFolderSeeded = true;
            }}
            spellcheck="false"
          />
        </label>
        <label class="model-lab-field">
          <span>Name</span>
          <input
            type="text"
            .value=${this.sceneSaveName}
            @input=${(e: Event) => (this.sceneSaveName = (e.target as HTMLInputElement).value)}
            spellcheck="false"
          />
        </label>
        <div class="model-lab-actions">
          <button
            type="button"
            class="model-lab-button is-primary"
            ?disabled=${this.sceneSaveState === 'saving' || !hasScene}
            @click=${() => void this.onSaveScene()}
          >
            ${this.sceneSaveState === 'saving' ? 'Saving…' : 'Save scene'}
          </button>
          <button
            type="button"
            class="model-lab-button"
            ?disabled=${!this.sceneSavedPath || appState.project.status !== 'ready'}
            @click=${() => void this.onOpenScene()}
          >
            Open in editor
          </button>
        </div>
        ${this.sceneStatusMessage
          ? html`<p
              class="model-lab-status ${this.sceneSaveState === 'error' ? 'is-error' : 'is-ok'}"
              aria-live="polite"
            >
              ${this.sceneStatusMessage}
            </p>`
          : null}
      </section>
    `;
  }

  private renderTestModels() {
    return html`
      <details class="ml-test-models">
        <summary>Test models</summary>
        <p class="ml-test-models-note">
          Procedural fixtures — prove the preview → GLB export → save chain without an API key.
        </p>
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
      </details>
    `;
  }

  // -- Job history -----------------------------------------------------------

  /** Past generation jobs, browseable to reopen (rebuild) or regenerate without re-paying codegen. */
  private renderHistory() {
    if (this.historyRecords.length === 0) {
      return null;
    }
    const busy = !this.gen.canGenerate;
    return html`
      <details class="ml-history">
        <summary>History (${this.historyRecords.length})</summary>
        <div class="ml-history-head">
          <p class="ml-history-note">Reopen a build or regenerate it from its saved spec.</p>
          <button type="button" class="ml-history-clear" @click=${() => this.onClearHistory()}>
            Clear all
          </button>
        </div>
        <ul class="ml-history-list" aria-label="Generation history">
          ${this.historyRecords.map(record => this.renderHistoryRow(record, busy))}
        </ul>
      </details>
    `;
  }

  private renderHistoryRow(record: ModelGenRecord, busy: boolean) {
    const url = this.historyUrls.get(record.id);
    const label = record.objectClass || 'model';
    return html`
      <li class="ml-history-row">
        <span class="ml-history-thumb">
          ${url
            ? html`<img src=${url} alt=${`Preview of ${label}`} />`
            : html`<span class="ml-history-thumb-placeholder"
                >${this.icons.getIcon('box', IconSize.SMALL)}</span
              >`}
        </span>
        <div class="ml-history-body">
          <div class="ml-history-title-row">
            <span class="ml-history-title" title=${label}>${label}</span>
            ${record.finalScore != null
              ? html`<span class="ml-score ml-score--${scoreTone(record.finalScore)}"
                  >${formatScore(record.finalScore)}</span
                >`
              : null}
          </div>
          <span class="ml-history-date">${formatShortDate(record.createdAt)}</span>
        </div>
        <div class="ml-history-actions">
          <button
            type="button"
            class="ml-icon-button"
            title="Open in preview"
            aria-label="Open ${label} in preview"
            ?disabled=${busy}
            @click=${() => void this.onOpenHistory(record.id)}
          >
            ${this.icons.getIcon('eye', IconSize.SMALL)}
          </button>
          <button
            type="button"
            class="ml-icon-button"
            title="Regenerate from saved spec"
            aria-label="Regenerate ${label}"
            ?disabled=${busy}
            @click=${() => void this.onRegenerateHistory(record.id)}
          >
            ${this.icons.getIcon('refresh-cw', IconSize.SMALL)}
          </button>
          <button
            type="button"
            class="ml-icon-button"
            title="Delete from history"
            aria-label="Delete ${label} from history"
            @click=${() => void this.onDeleteHistory(record.id)}
          >
            ${this.icons.getIcon('trash-2', IconSize.SMALL)}
          </button>
        </div>
      </li>
    `;
  }

  /**
   * Reconcile object URLs with the current record set (revoking any no longer present, minting one
   * per record with a stored thumbnail), then publish the list. Best-effort: an IndexedDB read
   * failure just leaves the previous list in place.
   */
  private async reloadHistory(): Promise<void> {
    if (!Model3DGenHistoryService.isSupported()) {
      return;
    }
    let records: ModelGenRecord[];
    try {
      records = await this.history.list();
    } catch {
      return;
    }
    const liveIds = new Set(records.map(record => record.id));
    for (const [id, url] of [...this.historyUrls]) {
      if (!liveIds.has(id)) {
        URL.revokeObjectURL(url);
        this.historyUrls.delete(id);
      }
    }
    for (const record of records) {
      if (this.historyUrls.has(record.id)) {
        continue;
      }
      const blob = record.thumb ?? record.referenceThumb;
      if (blob) {
        this.historyUrls.set(record.id, URL.createObjectURL(blob));
      }
    }
    this.historyRecords = records;
  }

  /** Rebuild the saved factory into the preview (the service bumps `modelRevision` → hot-swap). */
  private async onOpenHistory(id: string): Promise<void> {
    const record = await this.history.get(id);
    if (!record) {
      return;
    }
    await this.genService.rebuildFromCode(record.factoryCode);
    // `swapInGeneratedModel` (fired by the revision bump) defaulted the name to "model" — restore
    // the record's object class here, after the swap has already run.
    this.saveName = slugify(record.objectClass || 'model');
  }

  /** Re-run the pass loop from a saved spec (with its reference image when one was kept). */
  private async onRegenerateHistory(id: string): Promise<void> {
    const record = await this.history.get(id);
    if (!record) {
      return;
    }
    let referenceImage: ReferenceImageInput | null = null;
    if (record.referenceThumb) {
      const base64 = await blobToBase64(record.referenceThumb);
      referenceImage = { mimeType: record.referenceThumb.type || 'image/png', base64 };
    }
    await this.genService.generateFromSpec(record.spec, {
      referenceImage,
      mode: record.mode,
      prompt: record.prompt,
      complexity: record.complexity,
    });
  }

  private async onDeleteHistory(id: string): Promise<void> {
    await this.history.delete(id);
  }

  private onClearHistory(): void {
    void this.history.clear();
  }

  // -- Settings tab ----------------------------------------------------------

  private renderSettingsTab() {
    return html`
      <section class="model-lab-section">
        <h3>Codegen model</h3>
        <p class="ml-field-note">Writes the sculpt spec and factory code.</p>
        ${this.renderModelSlot('codegen')}
      </section>

      <section class="model-lab-section">
        <h3>Vision model</h3>
        <p class="ml-field-note">Analyzes the reference image.</p>
        ${this.renderModelSlot('vision')}
      </section>

      <section class="model-lab-section">
        <h3>Loop</h3>
        <label class="model-lab-field">
          <span>Mode</span>
          <select
            class="ml-select"
            .value=${this.prefs.mode}
            @change=${(e: Event) =>
              this.settings.updatePreferences({
                mode: (e.target as HTMLSelectElement).value as ModelLabPreferences['mode'],
              })}
          >
            <option value="fast">Fast (fewer passes)</option>
            <option value="quality">Quality (full pipeline)</option>
          </select>
        </label>
        <label class="model-lab-field">
          <span>Iterations per pass</span>
          <input
            type="number"
            min="1"
            max="20"
            step="1"
            .value=${String(this.prefs.maxIterationsPerPass)}
            @change=${(e: Event) => this.onIterationsChange(e)}
          />
        </label>
        <label class="ml-check">
          <input
            type="checkbox"
            .checked=${this.prefs.pauseForReview}
            @change=${(e: Event) =>
              this.settings.updatePreferences({
                pauseForReview: (e.target as HTMLInputElement).checked,
              })}
          />
          <span>Pause for manual review</span>
        </label>
        <p class="ml-field-note">
          When on, the pipeline pauses after each pass so you can Accept / Retry / Stop.
        </p>
        <label class="model-lab-field">
          <span>Vision score threshold</span>
          <input
            type="number"
            min="0"
            max="1"
            step="0.05"
            .value=${String(this.prefs.scoreThreshold)}
            @change=${(e: Event) => this.onThresholdChange(e)}
          />
        </label>
        <label class="model-lab-field">
          <span>Default save folder</span>
          <input
            type="text"
            spellcheck="false"
            .value=${this.prefs.saveFolder}
            @change=${(e: Event) =>
              this.settings.updatePreferences({
                saveFolder: (e.target as HTMLInputElement).value.trim() || DEFAULT_SAVE_FOLDER,
              })}
          />
        </label>
        <label class="model-lab-field">
          <span>Default scene folder</span>
          <input
            type="text"
            spellcheck="false"
            .value=${this.prefs.sceneSaveFolder ?? DEFAULT_SCENE_SAVE_FOLDER}
            @change=${(e: Event) =>
              this.settings.updatePreferences({
                sceneSaveFolder:
                  (e.target as HTMLInputElement).value.trim() || DEFAULT_SCENE_SAVE_FOLDER,
              })}
          />
        </label>
      </section>

      <p class="model-lab-note">
        API keys are managed per provider in the Agent / editor settings, not here. An empty
        provider selection uses the Agent's configured model automatically.
      </p>
    `;
  }

  private renderModelSlot(slot: 'codegen' | 'vision') {
    const providerId = slot === 'codegen' ? this.prefs.codegenProviderId : this.prefs.visionProviderId;
    const modelId = slot === 'codegen' ? this.prefs.codegenModelId : this.prefs.visionModelId;
    const withReasoning = slot === 'codegen';
    const providers = this.providers.list().filter(provider => !provider.hidden);
    const models = providerId ? this.catalog.getModels(providerId) : [];
    const canRefresh = providerId ? this.catalog.supportsRefresh(providerId) : false;
    const isRefreshing = this.refreshingProviderId === providerId;
    const selectedModel = providerId && modelId ? this.catalog.getModel(providerId, modelId) : undefined;
    const efforts = withReasoning ? selectedModel?.capabilities.reasoningEfforts ?? [] : [];
    const currentEffort =
      withReasoning && providerId && modelId
        ? this.settings.getReasoningEffort(providerId, modelId) ?? ''
        : '';

    return html`
      <label class="model-lab-field">
        <span>Provider</span>
        <select class="ml-select" @change=${(e: Event) => this.onProviderChange(slot, e)}>
          <option value="" ?selected=${!providerId}>Auto (use Agent's model)</option>
          ${providers.map(
            provider =>
              html`<option value=${provider.id} ?selected=${provider.id === providerId}>
                ${provider.label}
              </option>`
          )}
        </select>
      </label>

      ${providerId
        ? html`<label class="model-lab-field">
            <span>Model</span>
            <div class="ml-model-row">
              <select class="ml-select" @change=${(e: Event) => this.onModelChange(slot, e)}>
                <option value="" ?selected=${!modelId}>Auto</option>
                ${models.map(model => {
                  const hint = formatPricingHint(model.pricing);
                  return html`<option value=${model.id} ?selected=${model.id === modelId}>
                    ${model.label}${hint ? ` · ${hint}` : ''}
                  </option>`;
                })}
              </select>
              ${canRefresh
                ? html`<button
                    type="button"
                    class="ml-icon-button ${isRefreshing ? 'is-busy' : ''}"
                    title="Fetch the provider's current model list"
                    aria-label="Refresh model list"
                    ?disabled=${isRefreshing}
                    @click=${() => void this.refreshModels(providerId)}
                  >
                    ${this.icons.getIcon('refresh-cw', IconSize.SMALL)}
                  </button>`
                : null}
            </div>
          </label>`
        : null}
      ${withReasoning && providerId && modelId && efforts.length
        ? html`<label class="model-lab-field">
            <span>Reasoning effort</span>
            <select
              class="ml-select"
              @change=${(e: Event) => this.onReasoningChange(providerId, modelId, e)}
            >
              <option value="" ?selected=${!currentEffort}>Default</option>
              ${efforts.map(
                effort =>
                  html`<option value=${effort} ?selected=${effort === currentEffort}>
                    ${effort.charAt(0).toUpperCase() + effort.slice(1)}
                  </option>`
              )}
            </select>
          </label>`
        : null}
    `;
  }

  // -- settings handlers -----------------------------------------------------

  private onProviderChange(slot: 'codegen' | 'vision', event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (slot === 'codegen') {
      this.settings.updatePreferences({ codegenProviderId: value, codegenModelId: '' });
    } else {
      this.settings.updatePreferences({ visionProviderId: value, visionModelId: '' });
    }
  }

  private onModelChange(slot: 'codegen' | 'vision', event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (slot === 'codegen') {
      this.settings.updatePreferences({ codegenModelId: value });
    } else {
      this.settings.updatePreferences({ visionModelId: value });
    }
  }

  private onReasoningChange(providerId: string, modelId: string, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.settings.setReasoningEffort(providerId, modelId, value ? (value as ReasoningEffort) : undefined);
  }

  private onIterationsChange(event: Event): void {
    const raw = Number.parseInt((event.target as HTMLInputElement).value, 10);
    if (!Number.isFinite(raw) || raw < 1) {
      return;
    }
    this.settings.updatePreferences({ maxIterationsPerPass: Math.min(raw, 20) });
  }

  private onThresholdChange(event: Event): void {
    const raw = Number.parseFloat((event.target as HTMLInputElement).value);
    if (!Number.isFinite(raw)) {
      return;
    }
    this.settings.updatePreferences({ scoreThreshold: Math.min(Math.max(raw, 0), 1) });
  }

  private async refreshModels(providerId: string): Promise<void> {
    this.refreshingProviderId = providerId;
    try {
      await this.catalog.refresh(providerId);
    } catch {
      // Best-effort — the cached/static list stays in place; the catalog subscription re-renders.
    } finally {
      this.refreshingProviderId = null;
    }
  }

  // -- reference image -------------------------------------------------------

  private onDragOver = (event: DragEvent): void => {
    event.preventDefault();
    this.isDragOver = true;
  };

  private onDragLeave = (): void => {
    this.isDragOver = false;
  };

  private onDrop = (event: DragEvent): void => {
    event.preventDefault();
    this.isDragOver = false;
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      void this.setReferenceFromFile(file);
    }
  };

  private onPaste = (event: ClipboardEvent): void => {
    if (this.activeTab !== 'generate') {
      return;
    }
    const items = event.clipboardData?.items;
    if (!items) {
      return;
    }
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          if (this.activeLane === 'scene') {
            void this.addSceneReference(file);
          } else {
            void this.setReferenceFromFile(file);
          }
          return;
        }
      }
    }
  };

  private onPickFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      void this.setReferenceFromFile(file);
    }
    input.value = '';
  }

  private async setReferenceFromFile(file: File): Promise<void> {
    if (!file.type.startsWith('image/')) {
      this.statusMessage = 'Please choose an image file.';
      this.saveState = 'error';
      return;
    }
    try {
      const dataUrl = await readAsDataUrl(file);
      const comma = dataUrl.indexOf(',');
      const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
      this.reference = { mimeType: file.type, base64, dataUrl };
    } catch {
      this.statusMessage = 'Failed to read the image file.';
      this.saveState = 'error';
    }
  }

  private clearReference(): void {
    this.reference = null;
  }

  // -- scene-lane reference images -------------------------------------------

  private onSceneDrop = (event: DragEvent): void => {
    event.preventDefault();
    this.isDragOver = false;
    const files = event.dataTransfer?.files;
    if (files) {
      for (const file of files) {
        void this.addSceneReference(file);
      }
    }
  };

  private onPickSceneFiles(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (files) {
      for (const file of files) {
        void this.addSceneReference(file);
      }
    }
    input.value = '';
  }

  private async addSceneReference(file: File): Promise<void> {
    if (!file.type.startsWith('image/')) {
      this.sceneStatusMessage = 'Please choose an image file.';
      this.sceneSaveState = 'error';
      return;
    }
    try {
      const dataUrl = await readAsDataUrl(file);
      const comma = dataUrl.indexOf(',');
      const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
      this.sceneReferences = [...this.sceneReferences, { mimeType: file.type, base64, dataUrl }];
    } catch {
      this.sceneStatusMessage = 'Failed to read the image file.';
      this.sceneSaveState = 'error';
    }
  }

  private removeSceneReference(index: number): void {
    this.sceneReferences = this.sceneReferences.filter((_, i) => i !== index);
  }

  // -- generation ------------------------------------------------------------

  private onGenerate(): void {
    if (!this.reference) {
      return;
    }
    void this.genService.generate({
      referenceImage: { mimeType: this.reference.mimeType, base64: this.reference.base64 },
      prompt: this.prompt.trim() || undefined,
      complexity: this.complexity,
      mode: this.prefs.mode,
    });
  }

  private onStop(): void {
    this.genService.cancel();
  }

  private onGenerateScene(): void {
    const brief = this.brief.trim();
    if (!brief) {
      return;
    }
    void this.sceneGenService.generate({
      brief,
      referenceImages: this.sceneReferences.map(ref => ({
        mimeType: ref.mimeType,
        base64: ref.base64,
      })),
      mode: this.prefs.mode,
      baseScenePath: this.sceneBasePath.trim() || undefined,
    });
  }

  private onStopScene(): void {
    this.sceneGenService.cancel();
  }

  private onGenState(state: ModelGenState): void {
    this.gen = state;
    if (state.modelRevision !== this.lastModelRevision) {
      this.lastModelRevision = state.modelRevision;
      // Only hot-swap when the model lane owns the viewport.
      if (this.activeLane === 'model') {
        this.swapInGeneratedModel();
      }
    }
  }

  private onSceneGenState(state: SceneGenState): void {
    this.sceneGen = state;
    if (state.sceneRevision !== this.lastSceneRevision) {
      this.lastSceneRevision = state.sceneRevision;
      // Only hot-swap when the scene lane owns the viewport.
      if (this.activeLane === 'scene') {
        void this.swapInGeneratedScene();
      }
    }
  }

  private onPrefs(prefs: ModelLabPreferences): void {
    this.prefs = prefs;
    if (!this.saveFolderSeeded) {
      this.saveFolder = prefs.saveFolder;
      this.saveFolderSeeded = true;
    }
    if (!this.sceneSaveFolderSeeded) {
      this.sceneSaveFolder = prefs.sceneSaveFolder ?? DEFAULT_SCENE_SAVE_FOLDER;
      this.sceneSaveFolderSeeded = true;
    }
  }

  /** Switch the active generation lane; hand the viewport to the incoming lane's preview. */
  private setLane(lane: GenLane): void {
    if (lane === this.activeLane) {
      return;
    }
    this.activeLane = lane;
    if (lane === 'scene') {
      // Leaving the model lane: free its panel-owned Group, then show the scene (if any).
      this.disposeCurrentModel();
      void this.swapInGeneratedScene();
    } else {
      // Leaving the scene lane: remove (not dispose) its roots, then restore the model preview.
      this.clearSceneRoots();
      if (this.genService.getModel()) {
        this.swapInGeneratedModel();
      } else {
        this.buildModel(this.selectedModelId || TEST_MODELS[0].id);
      }
    }
  }

  /** Swap the pipeline's latest Group into the preview (same path as {@link buildModel}). */
  private swapInGeneratedModel(): void {
    if (!this.scene || !this.camera || !this.previewRoot) {
      return;
    }
    const group = this.genService.getModel();
    if (!group) {
      return;
    }
    this.disposeCurrentModel();
    this.previewRoot.add(group);
    this.previewRoot.updateMatrixWorld(true);
    const framing = framePerspectiveCameraToObject(this.camera, group);
    this.controls?.target.set(0, framing.focusTargetY, 0);
    this.controls?.update();
    this.currentModel = group;
    this.selectedModelId = '';
    this.saveName = slugify(this.gen.assessment?.objectClass ?? 'model');
    this.lastSavedPath = null;
    this.saveState = 'idle';
    this.renderRequested = true;
  }

  /**
   * Parse the latest scene YAML and swap its roots into the preview. Async (parse), so it re-checks
   * `previewRoot` after the await in case the panel was disconnected meanwhile. Scene nodes reference
   * AssetLoader-cached geometry/materials, so clearing is remove-only — never `disposeObject3DResources`.
   */
  private async swapInGeneratedScene(): Promise<void> {
    if (!this.scene || !this.camera || !this.previewRoot) {
      return;
    }
    const yaml = this.sceneGenService.getSceneYaml();
    if (!yaml) {
      return;
    }
    let rootNodes: Object3D[];
    try {
      const graph = await this.sceneManager.parseScene(yaml);
      rootNodes = graph.rootNodes;
    } catch (error) {
      console.warn('[ModelLabPanel] Failed to parse the generated scene.', error);
      return;
    }
    // The parse is async — bail if the panel was torn down (or lanes switched) while it ran.
    if (!this.previewRoot || !this.camera || this.activeLane !== 'scene') {
      return;
    }
    this.clearSceneRoots();
    // `previewRoot` holds only content (grid + lights live on `scene`), so add the roots directly
    // and frame the camera to the whole container.
    for (const root of rootNodes) {
      this.previewRoot.add(root);
    }
    this.currentSceneRoots = rootNodes;
    this.previewRoot.updateMatrixWorld(true);
    const framing = framePerspectiveCameraToObject(this.camera, this.previewRoot);
    this.controls?.target.set(0, framing.focusTargetY, 0);
    this.controls?.update();
    this.sceneSavedPath = null;
    this.sceneSaveState = 'idle';
    this.renderRequested = true;
  }

  // -- test-model palette + save --------------------------------------------

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
      // A generated model carries a spec + factory to persist alongside the GLB; a test-model has
      // neither, so pass no artifacts and only the GLB is written.
      const artifacts =
        this.gen.spec || this.gen.factoryCode
          ? { spec: this.gen.spec, factoryCode: this.gen.factoryCode }
          : undefined;
      const result = await this.exporter.saveModel(this.currentModel, path, artifacts);
      this.lastSavedPath = result.path;
      this.saveState = 'saved';
      const extras: string[] = [];
      if (result.sculptPath) {
        extras.push('spec');
      }
      if (result.factoryPath) {
        extras.push('factory');
      }
      const suffix = extras.length ? ` (+ ${extras.join(', ')})` : '';
      this.statusMessage = `Saved ${result.path}${suffix} (${formatBytes(result.bytes)}).`;
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

  // -- scene-lane save -------------------------------------------------------

  private async onSaveScene(): Promise<void> {
    if (appState.project.status !== 'ready') {
      this.sceneSaveState = 'error';
      this.sceneStatusMessage = 'Open a project before saving.';
      return;
    }
    if (!this.sceneGenService.getSceneYaml()) {
      this.sceneSaveState = 'error';
      this.sceneStatusMessage = 'Generate a scene before saving.';
      return;
    }
    const folder = this.sceneSaveFolder.trim().replace(/^\/+|\/+$/g, '');
    const name = this.sceneSaveName.trim();
    if (!name) {
      this.sceneSaveState = 'error';
      this.sceneStatusMessage = 'A file name is required.';
      return;
    }
    this.sceneSaveState = 'saving';
    this.sceneStatusMessage = '';
    try {
      const path = folder ? `${folder}/${name}` : name;
      const result = await this.sceneGenService.saveScene(path);
      this.sceneSavedPath = result.path;
      this.sceneSaveState = 'saved';
      this.sceneStatusMessage = `Saved ${result.path}.`;
    } catch (error) {
      this.sceneSaveState = 'error';
      this.sceneStatusMessage =
        error instanceof Error ? error.message : 'Failed to save the scene.';
    }
  }

  private async onOpenScene(): Promise<void> {
    if (!this.sceneSavedPath) {
      return;
    }
    try {
      await this.editorTabs.focusOrOpenScene(`res://${this.sceneSavedPath}`);
      this.sceneStatusMessage = `Opened ${this.sceneSavedPath} in the editor.`;
      this.sceneSaveState = 'saved';
    } catch (error) {
      this.sceneSaveState = 'error';
      this.sceneStatusMessage =
        error instanceof Error ? error.message : 'Failed to open the scene in the editor.';
    }
  }

  // -- renderer lifecycle (Phase 1, preserved) -------------------------------

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

  /**
   * Detach the scene-lane preview roots WITHOUT disposing their GPU resources — they are shared,
   * AssetLoader-cached geometry/materials/textures that other views may still reference.
   */
  private clearSceneRoots(): void {
    if (this.currentSceneRoots.length && this.previewRoot) {
      for (const root of this.currentSceneRoots) {
        this.previewRoot.remove(root);
      }
      this.renderer?.renderLists.dispose();
    }
    this.currentSceneRoots = [];
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

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'model';
}

/** Compact relative-ish date for a history row: "just now", "3h ago", "5d ago", else a short date. */
function formatShortDate(timestamp: number): string {
  const deltaMs = Date.now() - timestamp;
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
