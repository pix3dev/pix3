import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { appState } from '@/state';
import { subscribe } from 'valtio/vanilla';
import { AiImageSettingsService } from '@/services/AiImageSettingsService';
import { ImageGenProviderRegistry } from '@/services/image-gen/ImageGenProviderRegistry';
import { ImageGenError, type AspectRatio } from '@/services/image-gen/ImageGenTypes';
import {
  GenerationHistoryService,
  type GenerationRecord,
} from '@/services/GenerationHistoryService';
import {
  BackgroundRemovalService,
  type BgRemovalEngine,
  type BgRemovalProgress,
  type BgRemovalQuality,
} from '@/services/BackgroundRemovalService';
import { ProjectStorageService } from '@/services/ProjectStorageService';
import { EditorSettingsService } from '@/services/EditorSettingsService';
import { CommandDispatcher } from '@/services/CommandDispatcher';
import { CreateSprite2DCommand } from '@/features/scene/CreateSprite2DCommand';
import {
  getDroppedAssetResourcePath,
  hasAssetDragData,
  toProjectResourcePath,
} from '@/ui/shared/asset-drag-drop';
import './asset-generator-panel.ts.css';

const EMPTY_RESOURCE_ID = 'asset-generator://new';

interface ReferenceItem {
  id: string;
  mimeType: string;
  blob: Blob;
  objectUrl: string;
  label: string;
}

type CurrentSource = 'file' | 'generated' | 'bg-removed';

interface CurrentImage {
  blob: Blob;
  mimeType: string;
  objectUrl: string;
  source: CurrentSource;
  width?: number;
  height?: number;
}

@customElement('pix3-asset-generator-panel')
export class AssetGeneratorPanel extends ComponentBase {
  @inject(ImageGenProviderRegistry)
  private readonly providers!: ImageGenProviderRegistry;

  @inject(AiImageSettingsService)
  private readonly aiSettings!: AiImageSettingsService;

  @inject(GenerationHistoryService)
  private readonly history!: GenerationHistoryService;

  @inject(BackgroundRemovalService)
  private readonly bgRemoval!: BackgroundRemovalService;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(EditorSettingsService)
  private readonly editorSettings!: EditorSettingsService;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @property({ type: String, reflect: true, attribute: 'tab-id' })
  tabId = '';

  @state() private boundImagePath: string | null = null;
  @state() private prompt = '';
  @state() private providerId = '';
  @state() private modelId = '';
  @state() private aspectRatio: AspectRatio = 'Auto';
  @state() private imageSize = '1K';
  @state() private keyConfigured = false;
  @state() private references: ReferenceItem[] = [];
  @state() private current: CurrentImage | null = null;
  @state() private generating = false;
  @state() private generateError: string | null = null;
  @state() private bgBusy = false;
  @state() private bgEngine: BgRemovalEngine = 'imgly';
  @state() private bgQuality: BgRemovalQuality = 'balanced';
  @state() private bgProgress: BgRemovalProgress | null = null;
  @state() private bgError: string | null = null;
  @state() private historyRecords: GenerationRecord[] = [];
  @state() private saveName = '';
  @state() private saveMessage: string | null = null;
  @state() private saveError: string | null = null;
  @state() private isDragActive = false;
  @state() private apiKeyPopoverOpen = false;
  @state() private apiKeyInput = '';
  @state() private apiKeyBusy = false;
  @state() private apiKeyMessage: string | null = null;

  private disposeTabsSubscription?: () => void;
  private disposeHistorySubscription?: () => void;
  private disposeAiSettingsSubscription?: () => void;
  private abortController: AbortController | null = null;
  private readonly onDocPointerDown = (event: PointerEvent): void => {
    if (!this.apiKeyPopoverOpen) {
      return;
    }
    const wrap = this.querySelector('.ag-key-wrap');
    if (wrap && !wrap.contains(event.target as Node)) {
      this.apiKeyPopoverOpen = false;
    }
  };
  private readonly onDocKeyDown = (event: KeyboardEvent): void => {
    if (this.apiKeyPopoverOpen && event.key === 'Escape') {
      this.apiKeyPopoverOpen = false;
    }
  };
  private readonly ownedUrls = new Set<string>();
  private readonly historyUrls = new Map<string, string>();
  private pasteHandler?: (event: ClipboardEvent) => void;
  private syncedResourceId: string | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeTabsSubscription = subscribe(appState.tabs, () => this.syncFromTabState());
    this.disposeHistorySubscription = this.history.subscribe(() => void this.reloadHistory());
    this.disposeAiSettingsSubscription = this.aiSettings.subscribe(() => this.loadPreferences());
    this.pasteHandler = (event: ClipboardEvent) => this.onPaste(event);
    this.addEventListener('paste', this.pasteHandler);
    window.addEventListener('pointerdown', this.onDocPointerDown, true);
    window.addEventListener('keydown', this.onDocKeyDown);
    // On a Golden Layout re-dock the same instance is disconnected then reconnected; its blobs
    // survive but their object URLs were revoked on disconnect, so re-mint them.
    this.rehydrateObjectUrls();
    this.syncFromTabState();
    void this.reloadHistory();
  }

  disconnectedCallback(): void {
    this.disposeTabsSubscription?.();
    this.disposeTabsSubscription = undefined;
    this.disposeHistorySubscription?.();
    this.disposeHistorySubscription = undefined;
    this.disposeAiSettingsSubscription?.();
    this.disposeAiSettingsSubscription = undefined;
    if (this.pasteHandler) {
      this.removeEventListener('paste', this.pasteHandler);
      this.pasteHandler = undefined;
    }
    window.removeEventListener('pointerdown', this.onDocPointerDown, true);
    window.removeEventListener('keydown', this.onDocKeyDown);
    this.abortController?.abort();
    this.abortController = null;
    this.revokeAllUrls();
    // Force a full re-sync (and bound-image reload) if this instance is reconnected.
    this.syncedResourceId = null;
    super.disconnectedCallback();
  }

  /** Re-mint object URLs from retained blobs after a disconnect revoked the previous ones. */
  private rehydrateObjectUrls(): void {
    if (this.current) {
      this.current = {
        ...this.current,
        objectUrl: this.trackUrl(URL.createObjectURL(this.current.blob)),
      };
    }
    if (this.references.length > 0) {
      this.references = this.references.map(reference => ({
        ...reference,
        objectUrl: this.trackUrl(URL.createObjectURL(reference.blob)),
      }));
    }
  }

  protected updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has('tabId')) {
      this.syncFromTabState();
    }
  }

  // -- tab / preferences sync ------------------------------------------------

  private syncFromTabState(): void {
    const tab = appState.tabs.tabs.find(t => t.id === this.tabId);
    const resourceId = tab?.resourceId ?? null;
    if (resourceId === this.syncedResourceId) {
      return;
    }
    this.syncedResourceId = resourceId;

    this.loadPreferences();

    const isBound = Boolean(resourceId) && resourceId !== EMPTY_RESOURCE_ID;
    this.boundImagePath = isBound ? resourceId : null;
    if (isBound && resourceId) {
      void this.loadBoundImage(resourceId);
    }
  }

  private loadPreferences(): void {
    const prefs = this.aiSettings.getPreferences();
    const provider = this.aiSettings.getSelectedProvider();
    this.providerId = provider?.id ?? prefs.selectedProviderId;
    this.modelId = this.aiSettings.getSelectedModelId(this.providerId) ?? '';
    const model = provider?.getModel(this.modelId);
    this.aspectRatio = prefs.defaultAspectRatio;
    this.imageSize = model?.capabilities.imageSizes.includes(prefs.defaultImageSize)
      ? prefs.defaultImageSize
      : (model?.capabilities.imageSizes[0] ?? '1K');
    this.bgEngine = prefs.bgRemovalEngine;
    this.bgQuality = prefs.bgRemovalQuality;
    void this.refreshKeyStatus();
  }

  private async refreshKeyStatus(): Promise<void> {
    if (!this.providerId) {
      this.keyConfigured = false;
      return;
    }
    try {
      this.keyConfigured = await this.aiSettings.hasApiKey(this.providerId);
    } catch {
      this.keyConfigured = false;
    }
  }

  private async loadBoundImage(resourceId: string): Promise<void> {
    try {
      const blob = await this.storage.readBlob(resourceId);
      const objectUrl = this.trackUrl(URL.createObjectURL(blob));
      const size = await readImageSize(objectUrl);
      this.setCurrent({
        blob,
        mimeType: blob.type || 'image/png',
        objectUrl,
        source: 'file',
        width: size?.width,
        height: size?.height,
      });
      this.saveName = deriveSaveName(this.prompt, resourceId, blob.type || 'image/png');
    } catch (error) {
      console.warn('[AssetGenerator] Failed to load bound image', error);
    }
  }

  // -- rendering -------------------------------------------------------------

  protected render() {
    return html`
      <section
        class="asset-generator ${this.isDragActive ? 'is-drag-active' : ''}"
        @dragover=${this.onDragOver}
        @dragleave=${this.onDragLeave}
        @drop=${this.onDrop}
      >
        ${this.renderToolbar()}
        <div class="ag-workspace">
          ${this.renderSidebar()}
          <main class="ag-main">${this.renderStage()} ${this.renderActions()}</main>
        </div>
        ${this.renderHistory()}
        ${this.isDragActive
          ? html`<div class="ag-drop-overlay">Drop image to add as reference</div>`
          : null}
      </section>
    `;
  }

  private renderToolbar() {
    const provider = this.providers.get(this.providerId);
    const model = provider?.getModel(this.modelId);
    return html`
      <header class="ag-toolbar">
        <div class="ag-title">Asset Generator</div>
        <button
          class="ag-model-readout"
          title="Open AI provider settings"
          @click=${this.openSettings}
        >
          <span>${provider?.label ?? 'No provider'}</span>
          <span class="ag-model-readout-sep">·</span>
          <span>${model?.label ?? (this.modelId || 'no model')}</span>
          <span class="ag-gear">⚙</span>
        </button>
        <div class="ag-toolbar-spacer"></div>
        <button
          class="ag-model-readout"
          title="Background-removal engine — change in Editor Settings"
          @click=${this.openSettings}
        >
          BG: ${this.bgEngine === 'imgly' ? 'imgly' : `BiRefNet · ${this.bgQuality}`}
        </button>
        <button
          class="ag-toolbar-button"
          @click=${this.onRemoveBackground}
          ?disabled=${!this.current || this.bgBusy}
        >
          ${this.bgBusy ? 'Removing…' : 'Remove background'}
        </button>
      </header>
    `;
  }

  private renderSidebar() {
    const provider = this.providers.get(this.providerId);
    const model = provider?.getModel(this.modelId);
    const caps = model?.capabilities;
    const models = provider?.models ?? [];
    const canGenerate =
      this.keyConfigured && this.prompt.trim().length > 0 && !this.generating && Boolean(model);

    return html`
      <aside class="ag-sidebar">
        ${this.renderReferences(caps?.maxReferenceImages ?? 0)}

        <div class="ag-prompt-box">
          <textarea
            class="ag-prompt"
            rows="3"
            placeholder="Describe the image… Ctrl+Enter to generate."
            .value=${this.prompt}
            @input=${this.onPromptInput}
            @keydown=${this.onPromptKeyDown}
          ></textarea>
          <div class="ag-prompt-toolbar">
            <div class="ag-key-wrap">
              <button
                class="ag-key-button ${this.keyConfigured ? 'is-connected' : ''}"
                title=${this.keyConfigured
                  ? 'API key connected — quick settings'
                  : 'Connect API key & quick settings'}
                @click=${this.toggleApiKeyPopover}
              >
                🔑
              </button>
              ${this.apiKeyPopoverOpen ? this.renderKeyPopover(provider) : null}
            </div>
            <select class="ag-model-select" title="Model" @change=${this.onPanelModelChange}>
              ${models.map(
                item =>
                  html`<option value=${item.id} ?selected=${item.id === this.modelId}>
                    ${item.label}
                  </option>`
              )}
            </select>
            <div class="ag-prompt-spacer"></div>
            ${this.generating
              ? html`<button class="ag-cancel-button" @click=${this.onCancelGenerate}>
                  Cancel
                </button>`
              : null}
            <button class="ag-generate-button" ?disabled=${!canGenerate} @click=${this.onGenerate}>
              ${this.generating ? 'Generating…' : 'Generate'}
            </button>
          </div>
        </div>
        ${this.generateError ? html`<div class="ag-error">${this.generateError}</div>` : null}
      </aside>
    `;
  }

  private renderKeyPopover(provider: ReturnType<ImageGenProviderRegistry['get']>) {
    const providers = this.providers.list();
    const caps = provider?.getModel(this.modelId)?.capabilities;
    const helpUrl = provider?.apiKeyHelpUrl;
    return html`
      <div class="ag-key-popover" @click=${(e: Event) => e.stopPropagation()}>
        <div class="ag-popover-title">Quick settings</div>

        <label class="ag-field">
          <span class="ag-field-label">Provider</span>
          <select @change=${this.onPanelProviderChange}>
            ${providers.map(
              item =>
                html`<option value=${item.id} ?selected=${item.id === this.providerId}>
                  ${item.label}
                </option>`
            )}
          </select>
        </label>

        <div class="ag-key-status-row">
          <span class="ag-field-label">API key</span>
          <span class="ag-key-status ${this.keyConfigured ? 'is-set' : 'is-unset'}">
            ${this.keyConfigured ? 'Connected' : 'Not set'}
          </span>
        </div>
        <div class="ag-key-row">
          <input
            type="password"
            autocomplete="off"
            placeholder=${this.keyConfigured ? '•••••••• stored' : 'Paste API key'}
            .value=${this.apiKeyInput}
            @input=${this.onApiKeyInput}
            @keydown=${this.onKeyInputKeyDown}
          />
          <button
            class="ag-key-save"
            ?disabled=${!this.apiKeyInput.trim() || this.apiKeyBusy}
            @click=${this.onSaveApiKey}
          >
            Save
          </button>
          ${this.keyConfigured
            ? html`<button
                class="ag-key-clear"
                ?disabled=${this.apiKeyBusy}
                @click=${this.onClearApiKey}
              >
                Clear
              </button>`
            : null}
        </div>
        <div class="ag-popover-hint">
          ${this.apiKeyMessage
            ? this.apiKeyMessage
            : html`Stored encrypted in this
              browser.${helpUrl
                ? html` <a href=${helpUrl} target="_blank" rel="noreferrer">Get a key</a>.`
                : ''}`}
        </div>

        <div class="ag-field-row">
          <label class="ag-field">
            <span class="ag-field-label">Aspect</span>
            <select @change=${this.onAspectChange}>
              ${(caps?.aspectRatios ?? ['Auto']).map(
                ratio =>
                  html`<option value=${ratio} ?selected=${ratio === this.aspectRatio}>
                    ${ratio}
                  </option>`
              )}
            </select>
          </label>
          <label class="ag-field">
            <span class="ag-field-label">Size</span>
            <select @change=${this.onSizeChange}>
              ${(caps?.imageSizes ?? ['1K']).map(
                size =>
                  html`<option value=${size} ?selected=${size === this.imageSize}>${size}</option>`
              )}
            </select>
          </label>
        </div>

        <button class="ag-link-button" @click=${this.openFullSettings}>Open full settings…</button>
      </div>
    `;
  }

  private renderReferences(maxReferences: number) {
    if (maxReferences <= 0) {
      return null;
    }
    return html`
      <div class="ag-references">
        <div class="ag-references-head">
          <span class="ag-field-label"
            >References (${this.references.length}/${maxReferences})</span
          >
          <button class="ag-link-button" @click=${this.onAddReferenceFromDisk}>+ Add</button>
        </div>
        <div class="ag-reference-grid">
          ${this.references.map(
            reference => html`
              <div class="ag-reference" title=${reference.label}>
                <img src=${reference.objectUrl} alt=${reference.label} />
                <button
                  class="ag-reference-remove"
                  title="Remove reference"
                  @click=${() => this.removeReference(reference.id)}
                >
                  ✕
                </button>
              </div>
            `
          )}
        </div>
        <div class="ag-references-hint">Drag assets here, paste from clipboard, or click Add.</div>
      </div>
    `;
  }

  private renderStage() {
    return html`
      <div class="ag-stage">
        ${this.current
          ? html`<img class="ag-stage-image" src=${this.current.objectUrl} alt="Generated image" />`
          : html`<div class="ag-empty">
              <div class="ag-empty-title">Nothing here yet</div>
              <div class="ag-empty-body">
                Enter a prompt and press Generate, or open an image asset to edit it.
              </div>
            </div>`}
        ${this.bgBusy ? html`<div class="ag-progress">${this.renderBgProgress()}</div>` : null}
      </div>
      ${this.bgError ? html`<div class="ag-error ag-stage-error">${this.bgError}</div>` : null}
    `;
  }

  private renderBgProgress() {
    const progress = this.bgProgress;
    const pct =
      typeof progress?.progress === 'number' ? ` ${Math.round(progress.progress * 100)}%` : '';
    const label = !progress
      ? 'Preparing…'
      : progress.phase === 'downloading'
        ? `Downloading model…${pct}`
        : progress.phase === 'loading'
          ? `Loading model…${pct}`
          : 'Removing background…';
    return html`<div class="ag-progress-inner"><span class="ag-spinner"></span>${label}</div>`;
  }

  private renderActions() {
    if (!this.current) {
      return null;
    }
    const projectReady = appState.project.status === 'ready';
    return html`
      <div class="ag-actions">
        <div class="ag-save-row">
          <input
            class="ag-save-name"
            type="text"
            placeholder="folder/name.png"
            .value=${this.saveName}
            @input=${this.onSaveNameInput}
          />
          <button
            class="ag-action-button"
            ?disabled=${!projectReady || !this.saveName.trim()}
            @click=${this.onSaveToProject}
          >
            Save to project
          </button>
        </div>
        <div class="ag-action-buttons">
          <button
            class="ag-action-button"
            ?disabled=${!projectReady || !this.saveName.trim()}
            @click=${this.onInsertSprite}
          >
            Insert as Sprite2D
          </button>
          ${this.boundImagePath
            ? html`<button
                class="ag-action-button"
                ?disabled=${!projectReady}
                @click=${this.onOverwriteOriginal}
              >
                Overwrite original
              </button>`
            : null}
          <button class="ag-action-button" @click=${this.onDownload}>Download</button>
        </div>
        ${this.saveMessage ? html`<div class="ag-success">${this.saveMessage}</div>` : null}
        ${this.saveError ? html`<div class="ag-error">${this.saveError}</div>` : null}
        ${projectReady ? null : html`<div class="ag-hint">Open a project to save into it.</div>`}
      </div>
    `;
  }

  private renderHistory() {
    if (this.historyRecords.length === 0) {
      return null;
    }
    return html`
      <footer class="ag-history">
        <div class="ag-history-head">
          <span class="ag-field-label">History (${this.historyRecords.length})</span>
          <button class="ag-link-button" @click=${this.onClearHistory}>Clear</button>
        </div>
        <div class="ag-history-strip">
          ${this.historyRecords.map(record => {
            const url = this.historyUrls.get(record.id);
            return html`
              <div class="ag-history-card" title=${record.prompt}>
                <button class="ag-history-thumb" @click=${() => this.useHistoryRecord(record)}>
                  ${url ? html`<img src=${url} alt=${record.prompt} />` : null}
                </button>
                <button
                  class="ag-history-delete"
                  title="Delete from history"
                  @click=${() => this.deleteHistoryRecord(record.id)}
                >
                  ✕
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

  private openFullSettings(): void {
    this.apiKeyPopoverOpen = false;
    void this.editorSettings.showSettings();
  }

  private onPanelProviderChange(event: Event): void {
    const providerId = (event.target as HTMLSelectElement).value;
    this.providerId = providerId;
    this.aiSettings.updatePreferences({ selectedProviderId: providerId });
    this.apiKeyInput = '';
    this.apiKeyMessage = null;
    // loadPreferences (via the aiSettings subscription) refreshes model + key status.
  }

  private onPanelModelChange(event: Event): void {
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

  private onSaveNameInput(event: Event): void {
    this.saveName = (event.target as HTMLInputElement).value;
    this.saveMessage = null;
    this.saveError = null;
  }

  private openSettings(): void {
    void this.editorSettings.showSettings();
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
      (hasAssetDragData(event.dataTransfer) || this.hasFiles(event.dataTransfer))
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
    if (!dataTransfer) {
      return;
    }
    if (!hasAssetDragData(dataTransfer) && !this.hasFiles(dataTransfer)) {
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

  private hasFiles(dataTransfer: DataTransfer): boolean {
    return Array.from(dataTransfer.types ?? []).includes('Files');
  }

  private async addReferenceFromProject(resourcePath: string): Promise<void> {
    try {
      const blob = await this.storage.readBlob(resourcePath);
      const label = resourcePath.split('/').pop() ?? resourcePath;
      this.addReferenceBlob(blob, label);
    } catch (error) {
      console.warn('[AssetGenerator] Failed to read dropped asset', error);
    }
  }

  private addReferenceBlob(blob: Blob, label: string): void {
    const objectUrl = this.trackUrl(URL.createObjectURL(blob));
    const reference: ReferenceItem = {
      id: makeId(),
      mimeType: blob.type || 'image/png',
      blob,
      objectUrl,
      label,
    };
    this.references = [...this.references, reference];
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
      const apiKey = await this.aiSettings.getApiKey(this.providerId);
      if (!apiKey) {
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
          signal: this.abortController.signal,
        },
        { apiKey, modelId: this.modelId }
      );

      const image = result.images[0];
      if (!image) {
        this.generateError = 'The provider returned no image.';
        return;
      }

      const blob = base64ToBlob(image.data, image.mimeType);
      const objectUrl = this.trackUrl(URL.createObjectURL(blob));
      const size = await readImageSize(objectUrl);
      this.setCurrent({
        blob,
        mimeType: image.mimeType,
        objectUrl,
        source: 'generated',
        width: size?.width,
        height: size?.height,
      });
      this.saveName = deriveSaveName(this.prompt, this.boundImagePath, image.mimeType);

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

  // -- background removal ----------------------------------------------------

  private async onRemoveBackground(): Promise<void> {
    if (!this.current) {
      return;
    }
    this.bgBusy = true;
    this.bgError = null;
    this.bgProgress = null;
    const sourceBlob = this.current.blob;

    try {
      const output = await this.bgRemoval.removeBackground(sourceBlob, {
        engine: this.bgEngine,
        quality: this.bgQuality,
        onProgress: progress => {
          this.bgProgress = progress;
        },
      });
      const objectUrl = this.trackUrl(URL.createObjectURL(output));
      const size = await readImageSize(objectUrl);
      this.setCurrent({
        blob: output,
        mimeType: 'image/png',
        objectUrl,
        source: 'bg-removed',
        width: size?.width,
        height: size?.height,
      });
      // Background-removed output is transparent PNG — force a .png name so alpha is preserved.
      this.saveName = setImageExt(
        `${stripImageExt(normalizeRelativePath(this.saveName) || 'cutout')}-nobg`,
        'png'
      );
    } catch (error) {
      this.bgError = `Background removal failed: ${describeError(error)}`;
    } finally {
      this.bgBusy = false;
      this.bgProgress = null;
    }
  }

  // -- result actions --------------------------------------------------------

  private async onSaveToProject(): Promise<string | null> {
    if (!this.current) {
      return null;
    }
    const relativePath = ensureImageExt(
      normalizeRelativePath(this.saveName),
      this.current.mimeType
    );
    if (!relativePath) {
      this.saveError = 'Enter a file name.';
      return null;
    }
    this.saveError = null;
    this.saveMessage = null;
    try {
      await this.ensureParentDirectory(relativePath);
      const buffer = await this.current.blob.arrayBuffer();
      await this.storage.writeBinaryFile(relativePath, buffer);
      this.saveMessage = `Saved to ${relativePath}`;
      return relativePath;
    } catch (error) {
      this.saveError = `Save failed: ${describeError(error)}`;
      return null;
    }
  }

  private async onInsertSprite(): Promise<void> {
    const savedPath = await this.onSaveToProject();
    if (!savedPath) {
      return;
    }
    try {
      const texturePath = toProjectResourcePath(savedPath);
      const didMutate = await this.commandDispatcher.execute(
        new CreateSprite2DCommand({
          texturePath,
          spriteName: deriveNodeName(savedPath),
        })
      );
      this.saveMessage = didMutate
        ? `Inserted Sprite2D from ${savedPath}`
        : 'Could not insert Sprite2D — open a 2D scene first.';
    } catch (error) {
      this.saveError = `Insert failed: ${describeError(error)}`;
    }
  }

  private async onOverwriteOriginal(): Promise<void> {
    if (!this.current || !this.boundImagePath) {
      return;
    }
    this.saveError = null;
    this.saveMessage = null;
    try {
      const buffer = await this.current.blob.arrayBuffer();
      await this.storage.writeBinaryFile(this.boundImagePath, buffer);
      this.saveMessage = `Overwrote ${this.boundImagePath}`;
    } catch (error) {
      this.saveError = `Overwrite failed: ${describeError(error)}`;
    }
  }

  private onDownload(): void {
    if (!this.current) {
      return;
    }
    const anchor = document.createElement('a');
    anchor.href = this.current.objectUrl;
    anchor.download = ensureImageExt(
      normalizeRelativePath(this.saveName) || 'generated',
      this.current.mimeType
    )
      .split('/')
      .pop()!;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  // -- history ---------------------------------------------------------------

  private async reloadHistory(): Promise<void> {
    let records: GenerationRecord[] = [];
    try {
      records = await this.history.list();
    } catch (error) {
      console.warn('[AssetGenerator] Failed to load history', error);
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
    this.historyRecords = records;
  }

  private useHistoryRecord(record: GenerationRecord): void {
    const objectUrl = this.trackUrl(URL.createObjectURL(record.blob));
    this.setCurrent({
      blob: record.blob,
      mimeType: record.mimeType,
      objectUrl,
      source: 'generated',
      width: record.width,
      height: record.height,
    });
    this.prompt = record.prompt;
    if (record.aspectRatio) {
      this.aspectRatio = record.aspectRatio as AspectRatio;
    }
    if (record.imageSize) {
      this.imageSize = record.imageSize;
    }
    this.saveName = deriveSaveName(record.prompt, this.boundImagePath, record.mimeType);
  }

  private async deleteHistoryRecord(id: string): Promise<void> {
    await this.history.delete(id);
    // reloadHistory runs via the history subscription.
  }

  private async onClearHistory(): Promise<void> {
    await this.history.clear();
  }

  // -- helpers ---------------------------------------------------------------

  private setCurrent(next: CurrentImage): void {
    const previous = this.current;
    this.current = next;
    if (previous && previous.objectUrl !== next.objectUrl) {
      this.revokeUrl(previous.objectUrl);
    }
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

const stripImageExt = (path: string): string => path.replace(IMAGE_EXT_RE, '');

/** Append a mime-derived extension only when the path doesn't already carry an image extension. */
const ensureImageExt = (path: string, mimeType: string): string => {
  if (!path) {
    return path;
  }
  return IMAGE_EXT_RE.test(path) ? path : `${path}.${extForMime(mimeType)}`;
};

/** Force a specific extension (used for background-removed output, which must stay PNG). */
const setImageExt = (path: string, ext: string): string => `${stripImageExt(path)}.${ext}`;

const deriveSaveName = (prompt: string, boundPath: string | null, mimeType: string): string => {
  const base = slugify(prompt) || 'generated';
  if (boundPath) {
    const relative = normalizeRelativePath(boundPath);
    const slashIndex = relative.lastIndexOf('/');
    const folder = slashIndex >= 0 ? relative.slice(0, slashIndex) : '';
    return ensureImageExt(folder ? `${folder}/${base}` : base, mimeType);
  }
  return ensureImageExt(`generated/${base}`, mimeType);
};

const deriveNodeName = (path: string): string => {
  const fileName = path.split('/').pop() ?? 'Sprite2D';
  const dotIndex = fileName.lastIndexOf('.');
  const base = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  return base || 'Sprite2D';
};

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
    'pix3-asset-generator-panel': AssetGeneratorPanel;
  }
}
