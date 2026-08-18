import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { appState } from '@/state';
import { AiImageSettingsService } from '@/services/image-gen/AiImageSettingsService';
import { ImageGenProviderRegistry } from '@/services/image-gen/ImageGenProviderRegistry';
import {
  ImageGenError,
  modelPickerLabel,
  type AspectRatio,
} from '@/services/image-gen/ImageGenTypes';
import { DEFAULT_SVG_SPRITE_SIZE } from '@/services/image-gen/SvgLlmImageProvider';
import { MAX_SPRITE_SIZE, MIN_SPRITE_SIZE, clampSpriteSize } from '@/services/image-gen/svg-render';
import {
  GenerationHistoryService,
  type GenerationRecord,
} from '@/services/image-gen/GenerationHistoryService';
import {
  ImageEditTargetService,
  type ImageEditTargetSnapshot,
} from '@/services/image-gen/ImageEditTargetService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { EditorSettingsService } from '@/services/editor/EditorSettingsService';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { IconService, IconSize } from '@/services/editor/IconService';
import { AssetLibraryService } from '@/services/library/AssetLibraryService';
import { getDroppedAssetResourcePath, hasAssetDragData } from '@/ui/shared/asset-drag-drop';
import { setGenerationDragData } from '@/ui/shared/asset-drag-drop';
import './generate-panel.ts.css';

interface ReferenceItem {
  id: string;
  mimeType: string;
  blob: Blob;
  objectUrl: string;
  label: string;
}

/**
 * A generated image with nowhere to go: no editor is bound (or the bound canvas
 * stands in for a frame it cannot write back to yet), so the panel keeps it and
 * offers the original Asset Generator endings — save into the project, open it in
 * the Sprite Editor, or download it.
 */
interface PendingResult {
  blob: Blob;
  mimeType: string;
  objectUrl: string;
  prompt: string;
  width?: number;
  height?: number;
  /** Vector source, for results a vector provider authored — shown, copyable, and re-sent on edit. */
  svgSource?: string;
}

/**
 * The dockable "Generate" panel (§9.8). Everything that used to be the Sprite
 * Editor's right-hand AI rail — references, prompt, provider/model + key popover,
 * the Generate button and the generation history — lives here instead, because
 * none of it is per-editor-tab state: the history, the API key and the selected
 * model outlive any one document.
 *
 * It is general-purpose, not a Sprite Editor accessory. With an editor registered
 * through {@link ImageEditTargetService} a generation lands on that editor's
 * canvas; with none it lands in this panel's own result block, which is the
 * behaviour the standalone Asset Generator always had.
 */
@customElement('pix3-generate-panel')
export class GeneratePanel extends ComponentBase {
  @inject(ImageGenProviderRegistry)
  private readonly providers!: ImageGenProviderRegistry;

  @inject(AiImageSettingsService)
  private readonly aiSettings!: AiImageSettingsService;

  @inject(GenerationHistoryService)
  private readonly history!: GenerationHistoryService;

  @inject(ImageEditTargetService)
  private readonly imageEditTargets!: ImageEditTargetService;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(EditorSettingsService)
  private readonly editorSettings!: EditorSettingsService;

  @inject(EditorTabService)
  private readonly editorTabs!: EditorTabService;

  @inject(AssetLibraryService)
  private readonly assetLibrary!: AssetLibraryService;

  @inject(IconService)
  private readonly icons!: IconService;

  @state() private prompt = '';
  @state() private providerId = '';
  @state() private modelId = '';
  @state() private aspectRatio: AspectRatio = 'Auto';
  @state() private imageSize = '1K';
  @state() private quality = '';
  @state() private transparentBackground = false;
  /** Exact output size, used instead of aspect/size for providers that honour one. */
  @state() private outputWidth = DEFAULT_SVG_SPRITE_SIZE;
  @state() private outputHeight = DEFAULT_SVG_SPRITE_SIZE;
  @state() private lockRatio = true;
  /**
   * "Ready to generate", not literally "a key is stored" — a provider that borrows the agent's LLM
   * credentials (`requiresApiKey: false`) reports readiness instead, and never shows a key prompt.
   */
  @state() private keyConfigured = false;
  @state() private references: ReferenceItem[] = [];
  @state() private generating = false;
  @state() private generateError: string | null = null;
  @state() private historyRecords: GenerationRecord[] = [];
  @state() private apiKeyPopoverOpen = false;
  @state() private apiKeyInput = '';
  @state() private apiKeyBusy = false;
  @state() private apiKeyMessage: string | null = null;
  @state() private isDragActive = false;
  /** Snapshot of the editor this panel is bound to, or null when none is active. */
  @state() private targetSnapshot: ImageEditTargetSnapshot | null = null;
  @state() private result: PendingResult | null = null;
  @state() private saveName = '';
  @state() private saveMessage: string | null = null;
  @state() private saveError: string | null = null;
  @state() private sourceViewerOpen = false;
  @state() private sourceCopied = false;
  /** Whether the next Generate edits the current result's SVG source instead of drawing afresh. */
  @state() private editSource = false;

  private readonly ownedUrls = new Set<string>();
  private readonly historyUrls = new Map<string, string>();
  private abortController: AbortController | null = null;
  private disposeHistorySubscription?: () => void;
  private disposeAiSettingsSubscription?: () => void;
  private disposeTargetSubscription?: () => void;
  private pasteHandler?: (event: ClipboardEvent) => void;
  /**
   * Set by "Open in Sprite Editor": the shell registers itself asynchronously, so
   * the image is handed over from the target subscription once it arrives.
   */
  private pendingHandoff: PendingResult | null = null;

  private readonly onDocPointerDown = (event: PointerEvent): void => {
    if (!this.apiKeyPopoverOpen) {
      return;
    }
    const wrap = this.querySelector('.gp-key-wrap');
    if (wrap && !wrap.contains(event.target as Node)) {
      this.apiKeyPopoverOpen = false;
    }
  };

  private readonly onDocKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.apiKeyPopoverOpen) {
      this.apiKeyPopoverOpen = false;
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeHistorySubscription = this.history.subscribe(() => void this.reloadHistory());
    this.disposeAiSettingsSubscription = this.aiSettings.subscribe(() => this.loadPreferences());
    this.disposeTargetSubscription = this.imageEditTargets.subscribe(snapshot => {
      this.targetSnapshot = snapshot.targetSnapshot;
      this.flushPendingHandoff();
    });
    this.pasteHandler = (event: ClipboardEvent) => this.onPaste(event);
    this.addEventListener('paste', this.pasteHandler);
    window.addEventListener('pointerdown', this.onDocPointerDown, true);
    window.addEventListener('keydown', this.onDocKeyDown);
    // Golden Layout destroys and recreates a panel on dock/undock; the retained
    // blobs survive but their object URLs were revoked on disconnect.
    this.rehydrateObjectUrls();
    void this.reloadHistory();
  }

  disconnectedCallback(): void {
    this.disposeHistorySubscription?.();
    this.disposeHistorySubscription = undefined;
    this.disposeAiSettingsSubscription?.();
    this.disposeAiSettingsSubscription = undefined;
    this.disposeTargetSubscription?.();
    this.disposeTargetSubscription = undefined;
    if (this.pasteHandler) {
      this.removeEventListener('paste', this.pasteHandler);
      this.pasteHandler = undefined;
    }
    window.removeEventListener('pointerdown', this.onDocPointerDown, true);
    window.removeEventListener('keydown', this.onDocKeyDown);
    this.abortController?.abort();
    this.abortController = null;
    this.revokeAllUrls();
    super.disconnectedCallback();
  }

  /** Re-mint object URLs from retained blobs after a disconnect revoked the previous ones. */
  private rehydrateObjectUrls(): void {
    if (this.references.length > 0) {
      this.references = this.references.map(reference => ({
        ...reference,
        objectUrl: this.trackUrl(URL.createObjectURL(reference.blob)),
      }));
    }
    if (this.result) {
      this.result = {
        ...this.result,
        objectUrl: this.trackUrl(URL.createObjectURL(this.result.blob)),
      };
    }
    // History thumbnails are re-minted by `reloadHistory`, which the caller runs
    // right after this — `revokeAllUrls` emptied `historyUrls` on disconnect.
  }

  // -- preferences -----------------------------------------------------------

  private loadPreferences(): void {
    const prefs = this.aiSettings.getPreferences();
    const provider = this.aiSettings.getSelectedProvider();
    this.providerId = provider?.id ?? prefs.selectedProviderId;
    this.modelId = this.aiSettings.getSelectedModelId(this.providerId) ?? '';
    const model = provider?.getModel(this.modelId);
    this.aspectRatio = prefs.defaultAspectRatio;
    const sizes = model?.capabilities.imageSizes ?? [];
    // Prefer the stored size, then 1K, and only then the first advertised size — a model whose
    // cheapest tier leads the list (Gemini's '512px') must not silently become the default.
    this.imageSize = sizes.includes(prefs.defaultImageSize)
      ? prefs.defaultImageSize
      : (sizes.find(size => size === '1K') ?? sizes[0] ?? '1K');
    const qualities = model?.capabilities.qualities ?? [];
    this.quality =
      prefs.defaultQuality && qualities.includes(prefs.defaultQuality)
        ? prefs.defaultQuality
        : (qualities.find(q => q === 'medium') ?? qualities[0] ?? '');
    this.transparentBackground =
      Boolean(model?.capabilities.supportsTransparency) && prefs.transparentBackground;
    this.outputWidth = clampSpriteSize(prefs.defaultExactWidth, DEFAULT_SVG_SPRITE_SIZE);
    this.outputHeight = clampSpriteSize(prefs.defaultExactHeight, DEFAULT_SVG_SPRITE_SIZE);
    void this.refreshKeyStatus();
  }

  /** True when the selected provider owns an API key (raster providers) rather than borrowing one. */
  private get keyRequired(): boolean {
    return this.providers.get(this.providerId)?.requiresApiKey !== false;
  }

  /** True when the selected model takes exact pixel dimensions instead of an aspect ratio. */
  private get exactSize(): boolean {
    return Boolean(
      this.providers.get(this.providerId)?.getModel(this.modelId)?.capabilities.supportsExactSize
    );
  }

  private async refreshKeyStatus(): Promise<void> {
    const provider = this.providers.get(this.providerId);
    if (!provider) {
      this.keyConfigured = false;
      return;
    }
    try {
      // For a provider with no key of its own, "is a key stored?" is the wrong question — it would
      // answer no forever and gate off a lane the user already configured in Agent settings.
      this.keyConfigured =
        provider.requiresApiKey === false
          ? ((await provider.isAvailable?.()) ?? true)
          : await this.aiSettings.hasApiKey(this.providerId);
    } catch {
      this.keyConfigured = false;
    }
  }

  // -- target binding --------------------------------------------------------

  /**
   * Whether a generated image can be pushed straight onto the bound editor's
   * canvas. A frame-bound canvas only takes one when it says it can write it back
   * into the frame (§9.5); otherwise the result falls through to this panel's own
   * save block rather than being dropped on the next frame click.
   */
  private get canApplyToTarget(): boolean {
    const snapshot = this.targetSnapshot;
    if (!snapshot) {
      return false;
    }
    return !snapshot.boundFrameTexturePath || snapshot.acceptsFrameWriteBack;
  }

  /**
   * Whether a stored generation can be pasted straight into the frame the bound
   * editor has selected (§9.11.5). Stricter than {@link canApplyToTarget}: a plain
   * image canvas already takes history entries through the thumbnail itself, so
   * the extra action only earns its place when there *is* a frame behind it.
   */
  private get canApplyToFrame(): boolean {
    return this.canApplyToTarget && Boolean(this.targetSnapshot?.boundFrameTexturePath);
  }

  /** Hand `image` to the bound editor, or keep it here when there is nowhere to put it. */
  private deliver(image: PendingResult): void {
    if (
      this.canApplyToTarget &&
      this.imageEditTargets.applyGeneratedImage({
        blob: image.blob,
        mimeType: image.mimeType,
        prompt: image.prompt,
        width: image.width,
        height: image.height,
      })
    ) {
      this.setResult(null);
      return;
    }
    this.setResult(image);
    this.saveName = deriveSaveName(image.prompt, image.mimeType);
  }

  /** The "Open in Sprite Editor" handoff: apply as soon as a target registers. */
  private flushPendingHandoff(): void {
    const pending = this.pendingHandoff;
    if (!pending || !this.canApplyToTarget) {
      return;
    }
    this.pendingHandoff = null;
    this.deliver(pending);
  }

  // -- rendering -------------------------------------------------------------

  protected render() {
    const model = this.providers.get(this.providerId)?.getModel(this.modelId);
    const maxReferences = model?.capabilities.maxReferenceImages ?? 0;

    return html`
      <section
        class="generate-panel ${this.isDragActive ? 'is-drag-active' : ''}"
        @dragover=${this.onDragOver}
        @dragleave=${this.onDragLeave}
        @drop=${this.onDrop}
      >
        ${this.renderHead()}
        <div class="gp-body">
          ${this.renderReferences(maxReferences)} ${this.renderSizeRow()} ${this.renderPromptBar()}
          ${this.renderResult()} ${this.renderHistory()}
        </div>
        ${this.isDragActive
          ? html`<div class="gp-drop-overlay">Drop image to add as reference</div>`
          : null}
      </section>
    `;
  }

  private renderHead() {
    const snapshot = this.targetSnapshot;
    const destination = !snapshot
      ? 'No image editor open — results are saved from here.'
      : this.canApplyToTarget
        ? snapshot.boundFrameTexturePath
          ? `Results go into the selected frame of ${snapshot.label}`
          : `Results go to ${snapshot.label}`
        : `${snapshot.label} cannot take a generated frame right now — results stay here.`;

    return html`
      <header class="gp-head">
        <span class="gp-head-title">
          ${this.icons.getIcon('sparkles', IconSize.SMALL)}
          <span>Generate</span>
        </span>
        <button
          class="gp-icon-button"
          type="button"
          title="AI generation settings"
          aria-label="AI generation settings"
          @click=${this.openFullSettings}
        >
          ${this.icons.getIcon('settings', IconSize.SMALL)}
        </button>
        <div class="gp-target ${snapshot ? 'is-bound' : ''}" title=${destination}>
          ${destination}
        </div>
      </header>
    `;
  }

  private renderReferences(maxReferences: number) {
    if (maxReferences <= 0) {
      return null;
    }
    return html`
      <div class="gp-references">
        <div class="gp-references-head">
          <span class="gp-field-label"
            >References (${this.references.length}/${maxReferences})</span
          >
          <button class="gp-link-button" @click=${this.onAddReferenceFromDisk}>+ Add</button>
        </div>
        <div class="gp-reference-grid">
          ${this.references.map(
            reference => html`
              <div class="gp-reference" title=${reference.label}>
                <img src=${reference.objectUrl} alt=${reference.label} />
                <button
                  class="gp-reference-remove"
                  title="Remove reference"
                  aria-label=${`Remove reference ${reference.label}`}
                  @click=${() => this.removeReference(reference.id)}
                >
                  ${this.icons.getIcon('x', 12)}
                </button>
              </div>
            `
          )}
        </div>
        <div class="gp-hint">Drag assets here, paste from clipboard, or click Add.</div>
      </div>
    `;
  }

  /**
   * Exact W×H, for providers that can actually deliver it. It sits in the panel body rather than
   * behind the settings popover because it is the *point* of such a provider — "96×32 and I get
   * 96×32" is the reason to pick it over a raster model, and a control nobody finds is a promise
   * nobody collects.
   */
  private renderSizeRow() {
    if (!this.exactSize) {
      return null;
    }
    return html`
      <div class="gp-size-row">
        <span class="gp-field-label">Size</span>
        <input
          class="gp-size-input"
          type="number"
          min=${MIN_SPRITE_SIZE}
          max=${MAX_SPRITE_SIZE}
          step="1"
          aria-label="Output width in pixels"
          .value=${String(this.outputWidth)}
          @change=${this.onWidthChange}
        />
        <span class="gp-size-times">×</span>
        <input
          class="gp-size-input"
          type="number"
          min=${MIN_SPRITE_SIZE}
          max=${MAX_SPRITE_SIZE}
          step="1"
          aria-label="Output height in pixels"
          .value=${String(this.outputHeight)}
          @change=${this.onHeightChange}
        />
        <button
          class="gp-size-lock ${this.lockRatio ? 'is-locked' : ''}"
          type="button"
          title=${this.lockRatio
            ? 'Square: height follows width'
            : 'Width and height are independent'}
          aria-label="Lock output aspect ratio"
          aria-pressed=${this.lockRatio ? 'true' : 'false'}
          @click=${this.onToggleLockRatio}
        >
          ${this.icons.getIcon(this.lockRatio ? 'lock' : 'unlock', 12)}
        </button>
        <div class="gp-spacer"></div>
        ${SIZE_PRESETS.map(
          preset => html`
            <button
              class="gp-size-preset ${this.outputWidth === preset && this.outputHeight === preset
                ? 'is-active'
                : ''}"
              type="button"
              title=${`${preset}×${preset}`}
              @click=${() => this.applySizePreset(preset)}
            >
              ${preset}
            </button>
          `
        )}
      </div>
    `;
  }

  private renderPromptBar() {
    const provider = this.providers.get(this.providerId);
    const model = provider?.getModel(this.modelId);
    const models = provider?.models ?? [];
    const canGenerate =
      this.keyConfigured && this.prompt.trim().length > 0 && !this.generating && Boolean(model);

    return html`
      <div class="gp-prompt-bar">
        ${this.generateError ? html`<div class="gp-error">${this.generateError}</div>` : null}
        <div class="gp-prompt-box">
          <textarea
            class="gp-prompt"
            rows="2"
            aria-label="Prompt"
            placeholder="Describe the image… Ctrl+Enter to generate."
            .value=${this.prompt}
            @input=${this.onPromptInput}
            @keydown=${this.onPromptKeyDown}
          ></textarea>
          <div class="gp-prompt-toolbar">
            <div class="gp-key-wrap">
              <button
                class="gp-key-button ${this.keyConfigured ? 'is-connected' : ''}"
                title=${!this.keyRequired
                  ? 'Quick settings — this provider uses the agent’s LLM, no key needed'
                  : this.keyConfigured
                    ? 'API key connected — quick settings'
                    : 'Connect API key & quick settings'}
                aria-label=${this.keyRequired
                  ? 'API key and quick settings'
                  : 'Quick generation settings'}
                @click=${this.toggleApiKeyPopover}
              >
                ${this.icons.getIcon(this.keyRequired ? 'key' : 'sliders', IconSize.SMALL)}
              </button>
              ${this.apiKeyPopoverOpen ? this.renderKeyPopover(provider) : null}
            </div>
            <select class="gp-model-select" title="Model" @change=${this.onModelChange}>
              ${models.map(
                item =>
                  html`<option value=${item.id} ?selected=${item.id === this.modelId}>
                    ${modelPickerLabel(item)}
                  </option>`
              )}
            </select>
            <div class="gp-spacer"></div>
            ${this.generating
              ? html`<button class="gp-cancel-button" @click=${this.onCancelGenerate}>
                  Cancel
                </button>`
              : null}
            <button class="gp-generate-button" ?disabled=${!canGenerate} @click=${this.onGenerate}>
              ${this.generating ? 'Generating…' : 'Generate'}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  /** The API-key block, for providers that own a key. */
  private renderKeyRows(helpUrl: string | undefined) {
    return html`
      <div class="gp-key-status-row">
        <span class="gp-field-label">API key</span>
        <span class="gp-key-status ${this.keyConfigured ? 'is-set' : 'is-unset'}">
          ${this.keyConfigured ? 'Connected' : 'Not set'}
        </span>
      </div>
      <div class="gp-key-row">
        <input
          type="password"
          autocomplete="off"
          aria-label="API key"
          placeholder=${this.keyConfigured ? '•••••••• stored' : 'Paste API key'}
          .value=${this.apiKeyInput}
          @input=${this.onApiKeyInput}
          @keydown=${this.onKeyInputKeyDown}
        />
        <button
          class="gp-key-save"
          ?disabled=${!this.apiKeyInput.trim() || this.apiKeyBusy}
          @click=${this.onSaveApiKey}
        >
          Save
        </button>
        ${this.keyConfigured
          ? html`<button
              class="gp-key-clear"
              ?disabled=${this.apiKeyBusy}
              @click=${this.onClearApiKey}
            >
              Clear
            </button>`
          : null}
      </div>
      <div class="gp-popover-hint">
        ${this.apiKeyMessage
          ? this.apiKeyMessage
          : html`Stored encrypted in this
            browser.${helpUrl
              ? html` <a href=${helpUrl} target="_blank" rel="noreferrer">Get a key</a>.`
              : ''}`}
      </div>
    `;
  }

  /**
   * For a provider with no key of its own (`svg-llm` draws with the agent's model). Asking for a key
   * here would be a nag for something nothing reads; what the user needs instead is the one hint the
   * chat already gives when no model is reachable.
   */
  private renderBorrowedCredentialRow() {
    return html`
      <div class="gp-key-status-row">
        <span class="gp-field-label">Model access</span>
        <span class="gp-key-status ${this.keyConfigured ? 'is-set' : 'is-unset'}">
          ${this.keyConfigured ? 'Agent LLM ready' : 'No LLM configured'}
        </span>
      </div>
      <div class="gp-popover-hint">
        ${this.keyConfigured
          ? html`Draws with the Agent chat’s model — no separate key.`
          : html`Configure a provider in Agent settings first.`}
        <button class="gp-link-button" @click=${this.openAgentSettings}>
          Open Agent settings…
        </button>
      </div>
    `;
  }

  private renderKeyPopover(provider: ReturnType<ImageGenProviderRegistry['get']>) {
    const providers = this.providers.list();
    const caps = provider?.getModel(this.modelId)?.capabilities;
    const helpUrl = provider?.apiKeyHelpUrl;
    return html`
      <div class="gp-key-popover" @click=${(e: Event) => e.stopPropagation()}>
        <div class="gp-popover-title">Quick settings</div>

        <label class="gp-field">
          <span class="gp-field-label">Provider</span>
          <select @change=${this.onProviderChange}>
            ${providers.map(
              item =>
                html`<option value=${item.id} ?selected=${item.id === this.providerId}>
                  ${item.label}
                </option>`
            )}
          </select>
        </label>

        ${this.keyRequired ? this.renderKeyRows(helpUrl) : this.renderBorrowedCredentialRow()}

        <div class="gp-field-row">
          ${caps?.supportsExactSize
            ? null
            : html`<label class="gp-field">
                <span class="gp-field-label">Aspect</span>
                <select @change=${this.onAspectChange}>
                  ${(caps?.aspectRatios ?? ['Auto']).map(
                    ratio =>
                      html`<option value=${ratio} ?selected=${ratio === this.aspectRatio}>
                        ${ratio}
                      </option>`
                  )}
                </select>
              </label>`}
          ${caps && caps.imageSizes.length > 0
            ? html`<label class="gp-field">
                <span class="gp-field-label">Size</span>
                <select @change=${this.onSizeChange}>
                  ${caps.imageSizes.map(
                    size =>
                      html`<option value=${size} ?selected=${size === this.imageSize}>
                        ${size}
                      </option>`
                  )}
                </select>
              </label>`
            : null}
          ${caps && caps.qualities && caps.qualities.length > 0
            ? html`<label class="gp-field">
                <span class="gp-field-label">Quality</span>
                <select @change=${this.onQualityChange}>
                  ${caps.qualities.map(
                    q => html`<option value=${q} ?selected=${q === this.quality}>${q}</option>`
                  )}
                </select>
              </label>`
            : null}
        </div>

        ${caps?.supportsTransparency
          ? html`<label class="gp-toggle-field">
              <input
                type="checkbox"
                .checked=${this.transparentBackground}
                @change=${this.onTransparentChange}
              />
              <span>Transparent background (alpha) — no bg-removal needed</span>
            </label>`
          : null}

        <button class="gp-link-button" @click=${this.openFullSettings}>Open full settings…</button>
      </div>
    `;
  }

  /**
   * The standalone ending: with no canvas to push to, the result gets the Asset
   * Generator's own actions rather than being lost between two panels.
   */
  private renderResult() {
    const result = this.result;
    if (!result) {
      return null;
    }
    const projectReady = appState.project.status === 'ready';
    return html`
      <div class="gp-result">
        <div class="gp-result-row">
          <img class="gp-result-thumb" src=${result.objectUrl} alt="Generated image" />
          <div class="gp-result-meta">
            <span class="gp-field-label">
              Result
              ${result.svgSource
                ? html`<span
                    class="gp-badge"
                    title="Baked from vector source — real alpha, exact size"
                    >SVG</span
                  >`
                : null}
            </span>
            <span class="gp-hint">
              ${result.width && result.height ? `${result.width}×${result.height}` : 'Ready'}
            </span>
          </div>
        </div>
        ${this.renderSourceViewer(result)}
        <input
          class="gp-result-name"
          type="text"
          aria-label="File name"
          placeholder="folder/name.png"
          .value=${this.saveName}
          @input=${this.onSaveNameInput}
        />
        <div class="gp-result-actions">
          <button
            class="gp-action-button"
            ?disabled=${!projectReady || !this.saveName.trim()}
            @click=${this.onSaveToProject}
          >
            Save to project
          </button>
          <button
            class="gp-action-button"
            ?disabled=${!this.saveName.trim() || !this.assetLibrary.isUserScopeSupported()}
            @click=${this.onSaveToLibrary}
          >
            Save to Library
          </button>
          <button class="gp-action-button" @click=${this.onOpenInSpriteEditor}>
            Open in Sprite Editor
          </button>
          <button class="gp-action-button" @click=${this.onDownload}>Download</button>
        </div>
        ${this.saveMessage ? html`<div class="gp-success">${this.saveMessage}</div>` : null}
        ${this.saveError ? html`<div class="gp-error">${this.saveError}</div>` : null}
        ${projectReady ? null : html`<div class="gp-hint">Open a project to save into it.</div>`}
      </div>
    `;
  }

  /**
   * The vector source behind a baked result, read-only with a copy button. It earns its place
   * because this asset *is* code: seeing it is how a user learns the sprite can be edited by asking
   * for a change instead of re-rolling, and copying it is the escape hatch into a real vector editor.
   */
  private renderSourceViewer(result: PendingResult) {
    const source = result.svgSource;
    if (!source) {
      return null;
    }
    return html`
      <div class="gp-source">
        <label class="gp-toggle-field">
          <input type="checkbox" .checked=${this.editSource} @change=${this.onEditSourceChange} />
          <span>Edit this SVG on the next Generate (instead of drawing a new one)</span>
        </label>
        <div class="gp-source-head">
          <button
            class="gp-source-toggle"
            type="button"
            aria-expanded=${this.sourceViewerOpen ? 'true' : 'false'}
            @click=${this.onToggleSourceViewer}
          >
            ${this.icons.getIcon(this.sourceViewerOpen ? 'chevron-down' : 'chevron-right', 12)}
            <span>SVG source (${source.length} chars)</span>
          </button>
          <button
            class="gp-link-button"
            type="button"
            @click=${() => void this.onCopySource(source)}
          >
            ${this.sourceCopied ? 'Copied' : 'Copy'}
          </button>
        </div>
        ${this.sourceViewerOpen
          ? html`<pre class="gp-source-code" tabindex="0">${source}</pre>`
          : null}
      </div>
    `;
  }

  private renderHistory() {
    if (this.historyRecords.length === 0) {
      return null;
    }
    const applyLabel = this.canApplyToTarget ? 'Apply to canvas' : 'Use this image';
    const canApplyToFrame = this.canApplyToFrame;
    const frameApplyLabel = canApplyToFrame
      ? 'Apply to current frame'
      : 'No frame is bound — select a frame in the Sprite Editor';
    return html`
      <footer class="gp-history">
        <div class="gp-history-head">
          <span class="gp-field-label">History (${this.historyRecords.length})</span>
          <span class="gp-history-hint">Drag a thumbnail to the Asset Browser to save it.</span>
          <button class="gp-link-button" @click=${this.onClearHistory}>Clear</button>
        </div>
        <div class="gp-history-strip">
          ${this.historyRecords.map(record => {
            const url = this.historyUrls.get(record.id);
            return html`
              <div class="gp-history-card" title=${record.prompt}>
                <button
                  class="gp-history-thumb"
                  draggable="true"
                  title=${applyLabel}
                  aria-label=${`${applyLabel}: ${record.prompt}`}
                  @click=${() => this.useHistoryRecord(record)}
                  @dragstart=${(event: DragEvent) => this.onHistoryDragStart(event, record)}
                >
                  ${url ? html`<img src=${url} alt=${record.prompt} draggable="false" />` : null}
                </button>
                <button
                  class="gp-history-apply"
                  title=${frameApplyLabel}
                  aria-label=${`${frameApplyLabel}: ${record.prompt}`}
                  ?disabled=${!canApplyToFrame}
                  @click=${() => void this.applyHistoryRecordToFrame(record)}
                >
                  ${this.icons.getIcon('check', 12)}
                </button>
                <button
                  class="gp-history-delete"
                  title="Delete from history"
                  aria-label="Delete from history"
                  @click=${() => this.deleteHistoryRecord(record.id)}
                >
                  ${this.icons.getIcon('x', 12)}
                </button>
              </div>
            `;
          })}
        </div>
      </footer>
    `;
  }

  // -- input handlers --------------------------------------------------------

  private onPromptInput(event: Event): void {
    this.prompt = (event.target as HTMLTextAreaElement).value;
  }

  private onPromptKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void this.onGenerate();
    }
  }

  private toggleApiKeyPopover(): void {
    this.apiKeyPopoverOpen = !this.apiKeyPopoverOpen;
    if (this.apiKeyPopoverOpen) {
      this.apiKeyInput = '';
      this.apiKeyMessage = null;
    }
  }

  private openFullSettings = (): void => {
    this.apiKeyPopoverOpen = false;
    void this.editorSettings.showSettings('images');
  };

  /** Where the credentials for a borrowed-LLM provider actually live. */
  private openAgentSettings = (): void => {
    this.apiKeyPopoverOpen = false;
    void this.editorSettings.showSettings('agent').then(() => this.refreshKeyStatus());
  };

  private onWidthChange(event: Event): void {
    const value = clampSpriteSize(
      Number((event.target as HTMLInputElement).value),
      this.outputWidth
    );
    this.outputWidth = value;
    if (this.lockRatio) {
      this.outputHeight = value;
    }
    this.persistOutputSize();
  }

  private onHeightChange(event: Event): void {
    const value = clampSpriteSize(
      Number((event.target as HTMLInputElement).value),
      this.outputHeight
    );
    this.outputHeight = value;
    if (this.lockRatio) {
      this.outputWidth = value;
    }
    this.persistOutputSize();
  }

  private onToggleLockRatio(): void {
    this.lockRatio = !this.lockRatio;
    if (this.lockRatio && this.outputHeight !== this.outputWidth) {
      this.outputHeight = this.outputWidth;
      this.persistOutputSize();
    }
  }

  private applySizePreset(size: number): void {
    this.outputWidth = size;
    this.outputHeight = size;
    this.persistOutputSize();
  }

  private persistOutputSize(): void {
    this.aiSettings.updatePreferences({
      defaultExactWidth: this.outputWidth,
      defaultExactHeight: this.outputHeight,
    });
  }

  private onProviderChange(event: Event): void {
    const providerId = (event.target as HTMLSelectElement).value;
    this.providerId = providerId;
    this.aiSettings.updatePreferences({ selectedProviderId: providerId });
    this.apiKeyInput = '';
    this.apiKeyMessage = null;
    // loadPreferences (via the aiSettings subscription) refreshes model + key status.
  }

  private onModelChange(event: Event): void {
    const modelId = (event.target as HTMLSelectElement).value;
    this.modelId = modelId;
    this.aiSettings.updatePreferences({ modelByProvider: { [this.providerId]: modelId } });
  }

  private onApiKeyInput(event: Event): void {
    this.apiKeyInput = (event.target as HTMLInputElement).value;
    this.apiKeyMessage = null;
  }

  private onKeyInputKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.onSaveApiKey();
    }
  }

  private async onSaveApiKey(): Promise<void> {
    const key = this.apiKeyInput.trim();
    if (!key || !this.providerId) {
      return;
    }
    this.apiKeyBusy = true;
    try {
      await this.aiSettings.setApiKey(this.providerId, key);
      this.keyConfigured = true;
      this.apiKeyInput = '';
      this.apiKeyMessage = 'API key saved.';
    } catch (error) {
      this.apiKeyMessage = `Failed to save key: ${describeError(error)}`;
    } finally {
      this.apiKeyBusy = false;
    }
  }

  private async onClearApiKey(): Promise<void> {
    if (!this.providerId) {
      return;
    }
    this.apiKeyBusy = true;
    try {
      await this.aiSettings.clearApiKey(this.providerId);
      this.keyConfigured = false;
      this.apiKeyInput = '';
      this.apiKeyMessage = 'API key removed.';
    } catch (error) {
      this.apiKeyMessage = `Failed to remove key: ${describeError(error)}`;
    } finally {
      this.apiKeyBusy = false;
    }
  }

  private onAspectChange(event: Event): void {
    this.aspectRatio = (event.target as HTMLSelectElement).value as AspectRatio;
    this.aiSettings.updatePreferences({ defaultAspectRatio: this.aspectRatio });
  }

  private onSizeChange(event: Event): void {
    this.imageSize = (event.target as HTMLSelectElement).value;
    this.aiSettings.updatePreferences({ defaultImageSize: this.imageSize });
  }

  private onQualityChange(event: Event): void {
    this.quality = (event.target as HTMLSelectElement).value;
    this.aiSettings.updatePreferences({ defaultQuality: this.quality });
  }

  private onTransparentChange(event: Event): void {
    this.transparentBackground = (event.target as HTMLInputElement).checked;
    this.aiSettings.updatePreferences({ transparentBackground: this.transparentBackground });
  }

  private onToggleSourceViewer(): void {
    this.sourceViewerOpen = !this.sourceViewerOpen;
  }

  private onEditSourceChange(event: Event): void {
    this.editSource = (event.target as HTMLInputElement).checked;
  }

  private async onCopySource(source: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(source);
      this.sourceCopied = true;
      window.setTimeout(() => {
        this.sourceCopied = false;
      }, 1500);
    } catch (error) {
      this.saveError = `Could not copy the SVG source: ${describeError(error)}`;
    }
  }

  private onSaveNameInput(event: Event): void {
    this.saveName = (event.target as HTMLInputElement).value;
    this.saveMessage = null;
    this.saveError = null;
  }

  // -- references ------------------------------------------------------------

  private async onAddReferenceFromDisk(): Promise<void> {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      files.forEach(file => this.addReferenceBlob(file, file.name));
    });
    input.click();
  }

  private onPaste(event: ClipboardEvent): void {
    const items = Array.from(event.clipboardData?.items ?? []);
    let handled = false;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          this.addReferenceBlob(file, file.name || 'pasted-image');
          handled = true;
        }
      }
    }
    if (handled) {
      event.preventDefault();
    }
  }

  private onDragOver(event: DragEvent): void {
    if (
      event.dataTransfer &&
      (hasAssetDragData(event.dataTransfer) || hasFiles(event.dataTransfer))
    ) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      this.isDragActive = true;
    }
  }

  private onDragLeave(event: DragEvent): void {
    // Only clear when leaving the panel entirely.
    if (event.relatedTarget && this.contains(event.relatedTarget as Node)) {
      return;
    }
    this.isDragActive = false;
  }

  private onDrop(event: DragEvent): void {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer || (!hasAssetDragData(dataTransfer) && !hasFiles(dataTransfer))) {
      return;
    }
    event.preventDefault();
    this.isDragActive = false;

    const files = Array.from(dataTransfer.files ?? []).filter(file =>
      file.type.startsWith('image/')
    );
    if (files.length > 0) {
      files.forEach(file => this.addReferenceBlob(file, file.name));
      return;
    }

    const resourcePath = getDroppedAssetResourcePath(dataTransfer);
    if (resourcePath) {
      void this.addReferenceFromProject(resourcePath);
    }
  }

  private async addReferenceFromProject(resourcePath: string): Promise<void> {
    try {
      const blob = await this.storage.readBlob(resourcePath);
      const label = resourcePath.split('/').pop() ?? resourcePath;
      this.addReferenceBlob(blob, label);
    } catch (error) {
      console.warn('[GeneratePanel] Failed to read dropped asset', error);
    }
  }

  private addReferenceBlob(blob: Blob, label: string): void {
    const objectUrl = this.trackUrl(URL.createObjectURL(blob));
    this.references = [
      ...this.references,
      { id: makeId(), mimeType: blob.type || 'image/png', blob, objectUrl, label },
    ];
  }

  private removeReference(id: string): void {
    const reference = this.references.find(item => item.id === id);
    if (reference) {
      this.revokeUrl(reference.objectUrl);
    }
    this.references = this.references.filter(item => item.id !== id);
  }

  // -- generation ------------------------------------------------------------

  private async onGenerate(): Promise<void> {
    const provider = this.providers.get(this.providerId);
    const model = provider?.getModel(this.modelId);
    if (!provider || !model) {
      this.generateError = 'Select a provider and model in settings first.';
      return;
    }

    this.generateError = null;
    this.saveMessage = null;
    this.saveError = null;
    this.generating = true;
    this.abortController = new AbortController();

    try {
      // A provider that borrows the agent's LLM credentials has no key here; asking for one would
      // block a lane that is already configured in Agent settings.
      const keyRequired = provider.requiresApiKey !== false;
      const apiKey = keyRequired ? await this.aiSettings.getApiKey(this.providerId) : '';
      if (keyRequired && !apiKey) {
        this.keyConfigured = false;
        this.generateError = 'No API key configured for this provider.';
        return;
      }

      const caps = model.capabilities;
      const references = caps.supportsReferenceImages
        ? await Promise.all(
            this.references.slice(0, caps.maxReferenceImages).map(async reference => ({
              mimeType: reference.mimeType,
              data: await blobToBase64(reference.blob),
            }))
          )
        : [];

      const result = await provider.generate(
        {
          prompt: this.prompt.trim(),
          references,
          aspectRatio: caps.aspectRatios.includes(this.aspectRatio) ? this.aspectRatio : undefined,
          imageSize: caps.imageSizes.includes(this.imageSize) ? this.imageSize : undefined,
          quality: caps.qualities?.includes(this.quality) ? this.quality : undefined,
          background:
            caps.supportsTransparency && this.transparentBackground ? 'transparent' : undefined,
          ...(caps.supportsExactSize
            ? {
                width: this.outputWidth,
                height: this.outputHeight,
                // With "Edit this SVG" armed, the next Generate is a source edit rather than a
                // fresh draw: "make the outline thicker" keeps everything it did not ask to
                // change, which a re-roll cannot promise. Opt-in, because a new prompt typed over
                // an old result is much more often a new sprite than an edit of that one.
                svgSource: this.editSource ? this.result?.svgSource : undefined,
              }
            : {}),
          signal: this.abortController.signal,
        },
        { apiKey: apiKey ?? '', modelId: this.modelId }
      );

      const image = result.images[0];
      if (!image) {
        this.generateError = 'The provider returned no image.';
        return;
      }

      const blob = base64ToBlob(image.data, image.mimeType);
      const objectUrl = this.trackUrl(URL.createObjectURL(blob));
      const size = await readImageSize(objectUrl);
      this.deliver({
        blob,
        mimeType: image.mimeType,
        objectUrl,
        prompt: this.prompt.trim(),
        width: size?.width,
        height: size?.height,
        svgSource: image.svgSource,
      });

      await this.history.add({
        providerId: this.providerId,
        modelId: this.modelId,
        prompt: this.prompt.trim(),
        aspectRatio: this.aspectRatio,
        imageSize: this.imageSize,
        mimeType: image.mimeType,
        blob,
        width: size?.width,
        height: size?.height,
        svgSource: image.svgSource,
      });
    } catch (error) {
      this.generateError = describeError(error);
    } finally {
      this.generating = false;
      this.abortController = null;
    }
  }

  private onCancelGenerate(): void {
    this.abortController?.abort();
  }

  // -- result actions --------------------------------------------------------

  private async onSaveToProject(): Promise<string | null> {
    const result = this.result;
    if (!result) {
      return null;
    }
    const relativePath = ensureImageExt(normalizeRelativePath(this.saveName), result.mimeType);
    if (!relativePath) {
      this.saveError = 'Enter a file name.';
      return null;
    }
    this.saveError = null;
    this.saveMessage = null;
    try {
      await this.ensureParentDirectory(relativePath);
      await this.storage.writeBinaryFile(relativePath, await result.blob.arrayBuffer());
      this.saveMessage = `Saved to ${relativePath}`;
      return relativePath;
    } catch (error) {
      this.saveError = `Save failed: ${describeError(error)}`;
      return null;
    }
  }

  /** Personal Asset Library (editor-level; no project needed) — a one-file `image` bundle. */
  private async onSaveToLibrary(): Promise<void> {
    const result = this.result;
    if (!result) {
      return;
    }
    const fileName = ensureImageExt(normalizeRelativePath(this.saveName), result.mimeType)
      .split('/')
      .pop();
    if (!fileName) {
      this.saveError = 'Enter a file name.';
      return;
    }
    const name = fileName.replace(/\.[^.]+$/, '') || 'Generated image';
    this.saveError = null;
    this.saveMessage = null;
    try {
      const slug = await this.assetLibrary.suggestSlug(name);
      await this.assetLibrary.putUserItem({
        manifest: {
          id: crypto.randomUUID(),
          slug,
          name,
          type: 'image',
          tags: ['generated'],
          description: result.prompt || undefined,
          preview: fileName,
          entry: fileName,
          files: [fileName],
          source: 'generated',
          createdAt: 0,
          updatedAt: 0,
        },
        files: new Map<string, Blob>([[fileName, result.blob]]),
      });
      this.saveMessage = `Saved "${name}" to your library.`;
    } catch (error) {
      this.saveError = `Save to Library failed: ${describeError(error)}`;
    }
  }

  /**
   * Open (or focus) the Sprite Editor and hand the result to it. The shell
   * registers itself asynchronously, so the image is parked in `pendingHandoff`
   * and delivered from the target subscription.
   */
  private async onOpenInSpriteEditor(): Promise<void> {
    const result = this.result;
    if (!result) {
      return;
    }
    this.pendingHandoff = result;
    try {
      await this.editorTabs.focusOrOpenSpriteEditor();
    } catch (error) {
      this.pendingHandoff = null;
      this.saveError = `Could not open the Sprite Editor: ${describeError(error)}`;
      return;
    }
    this.flushPendingHandoff();
  }

  private async onDownload(): Promise<void> {
    const result = this.result;
    if (!result) {
      return;
    }
    const url = URL.createObjectURL(result.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download =
      ensureImageExt(normalizeRelativePath(this.saveName) || 'generated', result.mimeType)
        .split('/')
        .pop() ?? 'generated.png';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  private async ensureParentDirectory(relativePath: string): Promise<void> {
    const segments = relativePath.split('/');
    segments.pop();
    let accumulated = '';
    for (const segment of segments) {
      if (!segment) {
        continue;
      }
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      try {
        await this.storage.createDirectory(accumulated);
      } catch {
        // directory likely already exists
      }
    }
  }

  // -- history ---------------------------------------------------------------

  private async reloadHistory(): Promise<void> {
    let records: GenerationRecord[] = [];
    try {
      records = await this.history.list();
    } catch (error) {
      console.warn('[GeneratePanel] Failed to load history', error);
    }
    const nextIds = new Set(records.map(record => record.id));
    for (const [id, url] of this.historyUrls) {
      if (!nextIds.has(id)) {
        URL.revokeObjectURL(url);
        this.historyUrls.delete(id);
      }
    }
    for (const record of records) {
      if (!this.historyUrls.has(record.id)) {
        this.historyUrls.set(record.id, URL.createObjectURL(record.blob));
      }
    }
    // Copied, never assigned by reference: the thumbnails read their `src` from
    // `historyUrls`, which is a plain Map Lit cannot observe. After a re-dock the
    // records are identical but every URL was re-minted, so an identity-equal
    // array would leave the DOM pointing at revoked blobs.
    this.historyRecords = [...records];
  }

  /** Apply a stored generation to the bound canvas, or bring it back as the result. */
  private useHistoryRecord(record: GenerationRecord): void {
    this.prompt = record.prompt;
    if (record.aspectRatio) {
      this.aspectRatio = record.aspectRatio as AspectRatio;
    }
    if (record.imageSize) {
      this.imageSize = record.imageSize;
    }
    this.deliver({
      blob: record.blob,
      mimeType: record.mimeType,
      objectUrl: this.trackUrl(URL.createObjectURL(record.blob)),
      prompt: record.prompt,
      width: record.width,
      height: record.height,
      svgSource: record.svgSource,
    });
  }

  /**
   * Paste a stored generation into the bound editor's selected frame (§9.11.5).
   * Deliberately the very same `applyGeneratedImage` call the fresh-generation
   * path makes, so a size mismatch opens the Sprite Editor's place mode here too
   * without this action knowing anything about it. Unlike the thumbnail click it
   * does not adopt the record's prompt/aspect ratio: this is a paste, not a
   * "continue from here".
   */
  private async applyHistoryRecordToFrame(record: GenerationRecord): Promise<void> {
    if (!this.canApplyToFrame) {
      return;
    }

    // Re-read through the service so the freshest stored copy is what lands in
    // the frame; the strip's own record still carries the blob, so a failed or
    // missing read is not a reason to drop the paste.
    let stored: GenerationRecord | undefined;
    try {
      stored = await this.history.get(record.id);
    } catch (error) {
      console.warn('[GeneratePanel] Failed to read the generation to apply', error);
    }
    const source = stored ?? record;

    // Awaiting the read gave the user time to click elsewhere.
    if (!this.canApplyToFrame) {
      return;
    }

    this.imageEditTargets.applyGeneratedImage({
      blob: source.blob,
      mimeType: source.mimeType,
      prompt: source.prompt,
      width: source.width,
      height: source.height,
    });
  }

  private onHistoryDragStart(event: DragEvent, record: GenerationRecord): void {
    if (!event.dataTransfer) {
      return;
    }
    const suggestedName = ensureImageExt(slugify(record.prompt) || 'generated', record.mimeType);
    setGenerationDragData(event.dataTransfer, { id: record.id, suggestedName });
  }

  private async deleteHistoryRecord(id: string): Promise<void> {
    await this.history.delete(id);
    // reloadHistory runs via the history subscription.
  }

  private async onClearHistory(): Promise<void> {
    await this.history.clear();
  }

  // -- helpers ---------------------------------------------------------------

  private setResult(next: PendingResult | null): void {
    const previous = this.result;
    this.result = next;
    if (previous && previous.objectUrl !== next?.objectUrl) {
      this.revokeUrl(previous.objectUrl);
    }
    // Source-bound UI belongs to whichever result is on screen; a new one starts fresh.
    this.sourceViewerOpen = false;
    this.sourceCopied = false;
    this.editSource = false;
    if (!next) {
      this.saveMessage = null;
      this.saveError = null;
    }
  }

  private trackUrl(url: string): string {
    this.ownedUrls.add(url);
    return url;
  }

  private revokeUrl(url: string): void {
    if (this.ownedUrls.has(url)) {
      URL.revokeObjectURL(url);
      this.ownedUrls.delete(url);
    }
  }

  private revokeAllUrls(): void {
    for (const url of this.ownedUrls) {
      URL.revokeObjectURL(url);
    }
    this.ownedUrls.clear();
    for (const url of this.historyUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this.historyUrls.clear();
  }
}

// -- module-level utilities --------------------------------------------------

/** One-click sizes for exact-size providers — the powers of two game sprites actually ship at. */
const SIZE_PRESETS: readonly number[] = [64, 128, 256, 512];

const hasFiles = (dataTransfer: DataTransfer): boolean =>
  Array.from(dataTransfer.types ?? []).includes('Files');

const makeId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ref-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
};

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });

const base64ToBlob = (base64: string, mimeType: string): Blob => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
};

const readImageSize = (objectUrl: string): Promise<{ width: number; height: number } | null> =>
  new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(null);
    image.src = objectUrl;
  });

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

const normalizeRelativePath = (path: string): string =>
  path
    .trim()
    .replace(/^res:\/\//, '')
    .replace(/\\+/g, '/')
    .replace(/^\/+/, '');

const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;

const extForMime = (mimeType: string): string =>
  mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';

/** Append a mime-derived extension only when the path doesn't already carry an image extension. */
const ensureImageExt = (path: string, mimeType: string): string => {
  if (!path) {
    return path;
  }
  return IMAGE_EXT_RE.test(path) ? path : `${path}.${extForMime(mimeType)}`;
};

/**
 * Images live under the project-root `sprites/` folder (flat project layout); the
 * `generated/` bucket keeps AI output out of the hand-curated sprites.
 */
const deriveSaveName = (prompt: string, mimeType: string): string =>
  ensureImageExt(`sprites/generated/${slugify(prompt) || 'generated'}`, mimeType);

const describeError = (error: unknown): string => {
  if (error instanceof ImageGenError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown error';
};

declare global {
  interface HTMLElementTagNameMap {
    'pix3-generate-panel': GeneratePanel;
  }
}
