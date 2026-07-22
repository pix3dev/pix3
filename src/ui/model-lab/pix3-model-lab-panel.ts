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
import { Model3DGenService } from '@/services/model-gen/Model3DGenService';
import {
  Model3DGenSettingsService,
  type ModelLabPreferences,
} from '@/services/model-gen/Model3DGenSettingsService';
import { LlmProviderRegistry } from '@/services/llm/LlmProviderRegistry';
import { LlmModelCatalogService } from '@/services/llm/LlmModelCatalogService';
import { formatPricingHint, type ReasoningEffort } from '@/services/llm/LlmTypes';
import { AddModelCommand } from '@/features/scene/AddModelCommand';
import { TEST_MODELS, buildTestModel } from '@/services/model-gen/test-models';
import type {
  ComplexityHint,
  ModelGenState,
  ModelGenStatus,
} from '@/services/model-gen/model-gen-types';
import { appState } from '@/state';
import './pix3-model-lab-panel.ts.css';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type LabTab = 'generate' | 'settings';

/** A reference image staged for generation. `dataUrl` drives the thumbnail; `base64` is prefix-free. */
interface StagedReference {
  mimeType: string;
  base64: string;
  dataUrl: string;
}

const DEFAULT_SAVE_FOLDER = 'models';

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
};

const DEFAULT_PREFS: ModelLabPreferences = {
  codegenProviderId: '',
  codegenModelId: '',
  visionProviderId: '',
  visionModelId: '',
  reasoningEffortByModel: {},
  scoreThreshold: 0.7,
  maxIterationsPerPass: 3,
  mode: 'quality',
  saveFolder: DEFAULT_SAVE_FOLDER,
};

/** Map a pipeline status to a compact chip label + tone class. */
function statusChip(status: ModelGenStatus): { label: string; tone: string } {
  switch (status) {
    case 'idle':
      return { label: 'Idle', tone: 'idle' };
    case 'intake':
      return { label: 'Intake', tone: 'busy' };
    case 'assessing':
      return { label: 'Assessing', tone: 'busy' };
    case 'speccing':
      return { label: 'Speccing', tone: 'busy' };
    case 'building':
      return { label: 'Building', tone: 'busy' };
    case 'compiling':
      return { label: 'Compiling', tone: 'busy' };
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

/**
 * Model Lab — Phase 2 panel.
 *
 * A two-tab (Generate · Settings) editor panel over the headless {@link Model3DGenService} pipeline.
 * The Generate tab stages a reference image (drop / pick / paste), an optional prompt, and a
 * complexity hint, then drives an intake → assess → spec → factory → compile job whose every state
 * emission streams into a live pipeline monitor. Each successful compile bumps `modelRevision`; the
 * panel hot-swaps the fresh `THREE.Group` into its OWN preview viewport (the same
 * dispose → add → frame path the test-model palette uses), making it the Save GLB / Add-to-scene
 * target. The Settings tab exposes the codegen + vision model pickers and loop knobs backed by
 * {@link Model3DGenSettingsService}.
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

  @inject(Model3DGenSettingsService)
  private readonly settings!: Model3DGenSettingsService;

  @inject(LlmProviderRegistry)
  private readonly providers!: LlmProviderRegistry;

  @inject(LlmModelCatalogService)
  private readonly catalog!: LlmModelCatalogService;

  @property({ type: String, reflect: true, attribute: 'tab-id' })
  tabId = '';

  @state() private activeTab: LabTab = 'generate';

  // -- generation inputs -----------------------------------------------------
  @state() private reference: StagedReference | null = null;
  @state() private prompt = '';
  @state() private complexity: ComplexityHint = 'moderate';
  @state() private isDragOver = false;

  // -- mirrored service state ------------------------------------------------
  @state() private gen: ModelGenState = DEFAULT_GEN_STATE;
  @state() private prefs: ModelLabPreferences = DEFAULT_PREFS;
  @state() private refreshingProviderId: string | null = null;

  // -- test-model palette + save ---------------------------------------------
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

  private readonly disposers: Array<() => void> = [];
  private lastModelRevision = 0;
  private lastLogCount = 0;
  private saveFolderSeeded = false;

  connectedCallback(): void {
    super.connectedCallback();
    this.disposers.push(this.genService.subscribe(state => this.onGenState(state)));
    this.disposers.push(this.settings.subscribe(prefs => this.onPrefs(prefs)));
    this.disposers.push(this.catalog.subscribe(() => this.requestUpdate()));
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
    if (this.gen.log.length !== this.lastLogCount) {
      this.lastLogCount = this.gen.log.length;
      const log = this.querySelector<HTMLElement>('.ml-log');
      if (log) {
        log.scrollTop = log.scrollHeight;
      }
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

      ${this.renderMonitor()} ${this.renderSaveGroup()} ${this.renderTestModels()}
    `;
  }

  private renderMonitor() {
    const gen = this.gen;
    if (gen.status === 'idle' && gen.log.length === 0) {
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
          void this.setReferenceFromFile(file);
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

  private onGenState(state: ModelGenState): void {
    this.gen = state;
    if (state.modelRevision !== this.lastModelRevision) {
      this.lastModelRevision = state.modelRevision;
      this.swapInGeneratedModel();
    }
  }

  private onPrefs(prefs: ModelLabPreferences): void {
    this.prefs = prefs;
    if (!this.saveFolderSeeded) {
      this.saveFolder = prefs.saveFolder;
      this.saveFolderSeeded = true;
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
