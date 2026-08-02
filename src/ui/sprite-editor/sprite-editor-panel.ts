import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { createRef, ref } from 'lit/directives/ref.js';
import { appState } from '@/state';
import { subscribe } from 'valtio/vanilla';
import { AiImageSettingsService } from '@/services/image-gen/AiImageSettingsService';
import { ImageGenProviderRegistry } from '@/services/image-gen/ImageGenProviderRegistry';
import { ImageGenError, type AspectRatio } from '@/services/image-gen/ImageGenTypes';
import {
  GenerationHistoryService,
  type GenerationRecord,
} from '@/services/image-gen/GenerationHistoryService';
import {
  BackgroundRemovalService,
  type BgRemovalEngine,
  type BgRemovalProgress,
  type BgRemovalQuality,
} from '@/services/bg-removal/BackgroundRemovalService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { EditorSettingsService } from '@/services/editor/EditorSettingsService';
import { IconService, IconSize } from '@/services/editor/IconService';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { AssetLibraryService } from '@/services/library/AssetLibraryService';
import { AnimationAutoSliceDialogService } from '@/services/animation/AnimationAutoSliceDialogService';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { CreateSprite2DCommand } from '@/features/scene/CreateSprite2DCommand';
import { CreateAnimationAssetCommand } from '@/features/scene/CreateAnimationAssetCommand';
import {
  buildAnimationFrameResourcePath,
  buildManagedSpriteAssetPath,
  getAnimationAssetDirectory,
  deriveAnimationAssetStem,
} from '@/features/scene/animation-asset-utils';
import { normalizeAnimationResource } from '@pix3/runtime';
import {
  getDroppedAssetResourcePath,
  hasAssetDragData,
  setGenerationDragData,
  toProjectResourcePath,
} from '@/ui/shared/asset-drag-drop';
import {
  StageZoomPanController,
  type StagePoint,
  type StageViewport,
} from '@/ui/shared/stage-zoom-pan';
import {
  applyCropDrag,
  clampToImage,
  cropRectToPixels,
  describeCropRect,
  initialCropRect,
  isApplicableCropRect,
  type CropDragState,
  type CropRect,
  type ImageSize,
} from './crop-geometry';
import {
  flipImageBlob,
  readBlobSize,
  resizeImageBlob,
  rotateImageBlob,
  scaledDimensions,
  sliceImageBlob,
  type FlipAxis,
} from '@/services/image-gen/image-ops';
import './sprite-editor-panel.ts.css';

/** Longest-edge downscale presets offered in the save popover (px); 0 = keep original size. */
const SAVE_SIZE_PRESETS: readonly number[] = [1024, 512, 256, 128, 64];

const EMPTY_RESOURCE_ID = 'sprite-editor://new';

/** Screen-pixel margin left around the image when the stage fits it to the viewport. */
const STAGE_FIT_PADDING = 16;

/** Above this zoom the working image is drawn with hard pixel edges, like the animation stage. */
const PIXELATED_ZOOM_THRESHOLD = 2;

const CROP_HANDLES: ReadonlyArray<{ pos: string; edges: string }> = [
  { pos: 'nw', edges: 'nw' },
  { pos: 'n', edges: 'n' },
  { pos: 'ne', edges: 'ne' },
  { pos: 'e', edges: 'e' },
  { pos: 'se', edges: 'se' },
  { pos: 's', edges: 's' },
  { pos: 'sw', edges: 'sw' },
  { pos: 'w', edges: 'w' },
];

interface ReferenceItem {
  id: string;
  mimeType: string;
  blob: Blob;
  objectUrl: string;
  label: string;
}

type CurrentSource = 'file' | 'generated' | 'bg-removed' | 'cropped' | 'rotated' | 'flipped';

interface CurrentImage {
  blob: Blob;
  mimeType: string;
  objectUrl: string;
  source: CurrentSource;
  width?: number;
  height?: number;
}

@customElement('pix3-sprite-editor-panel')
export class SpriteEditorPanel extends ComponentBase {
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

  @inject(AssetLibraryService)
  private readonly assetLibrary!: AssetLibraryService;

  @inject(IconService)
  private readonly icons!: IconService;

  @inject(AnimationAutoSliceDialogService)
  private readonly sliceDialog!: AnimationAutoSliceDialogService;

  @inject(EditorTabService)
  private readonly editorTabs!: EditorTabService;

  @property({ type: String, reflect: true, attribute: 'tab-id' })
  tabId = '';

  @state() private boundImagePath: string | null = null;
  @state() private prompt = '';
  @state() private providerId = '';
  @state() private modelId = '';
  @state() private aspectRatio: AspectRatio = 'Auto';
  @state() private imageSize = '1K';
  @state() private quality = '';
  @state() private transparentBackground = false;
  @state() private keyConfigured = false;
  @state() private references: ReferenceItem[] = [];
  @state() private current: CurrentImage | null = null;
  @state() private generating = false;
  @state() private generateError: string | null = null;
  @state() private bgBusy = false;
  @state() private bgEngine: BgRemovalEngine = 'imgly';
  @state() private bgQuality: BgRemovalQuality = 'balanced';
  @state() private bgFillHoles = true;
  @state() private bgProgress: BgRemovalProgress | null = null;
  @state() private bgError: string | null = null;
  @state() private historyRecords: GenerationRecord[] = [];
  @state() private saveName = '';
  @state() private saveMessage: string | null = null;
  @state() private saveError: string | null = null;
  /** Longest-edge downscale cap applied at save time (px); 0 = keep original size. */
  @state() private saveMaxSize = 0;
  /** True while the user is entering a custom (non-preset) save size. */
  @state() private saveSizeCustom = false;
  @state() private isDragActive = false;
  @state() private savePopoverOpen = false;
  @state() private apiKeyPopoverOpen = false;
  @state() private apiKeyInput = '';
  @state() private apiKeyBusy = false;
  @state() private apiKeyMessage: string | null = null;
  @state() private cropMode = false;
  @state() private cropRect: CropRect | null = null;
  /** True while a rotate/flip transform is re-encoding the current image. */
  @state() private transformBusy = false;
  /** True while a slice / create-animation run is writing frame files. */
  @state() private sliceBusy = false;
  /** Outcome of the last slice / create-animation run, shown under the toolbar. */
  @state() private sliceStatus: { text: string; isError: boolean } | null = null;
  /** Grid the slice dialog opens with; remembered per panel instance. */
  private sliceColumns = 4;
  private sliceRows = 1;

  private readonly stageRef = createRef<HTMLDivElement>();
  private readonly stageImageRef = createRef<HTMLImageElement>();
  private cropDrag: CropDragState | null = null;

  /**
   * Zoom/pan of the canvas. Shared with the animation editor's frame stage so
   * both surfaces agree on wheel-zoom-to-cursor and pan feel (`src/ui/shared/`),
   * and — more importantly — on one coordinate model: the content element is
   * *sized* by zoom with the pan applied as a transform, so overlay geometry is
   * plain image pixels scaled by `zoom`.
   */
  private readonly stageView = new StageZoomPanController({
    minZoom: 0.1,
    maxZoom: 16,
    onChange: () => this.requestUpdate(),
  });

  /**
   * True once the user has zoomed or panned by hand. Until then the stage keeps
   * refitting the image on resize, which is how the old object-fit stage behaved.
   */
  private hasUserAdjustedView = false;
  /** Set when a new working image arrives; consumed by the next `load` event. */
  private pendingStageFit = false;
  private stageResizeObserver: ResizeObserver | null = null;

  private disposeTabsSubscription?: () => void;
  private disposeHistorySubscription?: () => void;
  private disposeAiSettingsSubscription?: () => void;
  private abortController: AbortController | null = null;
  private readonly onDocPointerDown = (event: PointerEvent): void => {
    if (this.apiKeyPopoverOpen) {
      const wrap = this.querySelector('.ag-key-wrap');
      if (wrap && !wrap.contains(event.target as Node)) {
        this.apiKeyPopoverOpen = false;
      }
    }
    if (this.savePopoverOpen) {
      const wrap = this.querySelector('.ag-save-wrap');
      if (wrap && !wrap.contains(event.target as Node)) {
        this.savePopoverOpen = false;
      }
    }
  };
  private readonly onDocKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') {
      return;
    }
    if (this.apiKeyPopoverOpen) {
      this.apiKeyPopoverOpen = false;
    }
    if (this.savePopoverOpen) {
      this.savePopoverOpen = false;
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
    this.stageResizeObserver?.disconnect();
    this.stageResizeObserver = null;
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
    // Re-established on every update rather than in `firstUpdated`: a Golden Layout
    // re-dock disconnects the observer but never fires `firstUpdated` again.
    this.observeStageResize();
    if (changed.has('cropMode') && this.cropMode && !this.cropRect) {
      // The stage image may still be decoding on a fresh mount; give it a frame.
      requestAnimationFrame(() => this.initCropRect());
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
    const qualities = model?.capabilities.qualities ?? [];
    this.quality =
      prefs.defaultQuality && qualities.includes(prefs.defaultQuality)
        ? prefs.defaultQuality
        : (qualities.find(q => q === 'medium') ?? qualities[0] ?? '');
    this.transparentBackground =
      Boolean(model?.capabilities.supportsTransparency) && prefs.transparentBackground;
    this.saveMaxSize = prefs.defaultSaveMaxSize;
    this.saveSizeCustom =
      prefs.defaultSaveMaxSize > 0 && !SAVE_SIZE_PRESETS.includes(prefs.defaultSaveMaxSize);
    this.bgEngine = prefs.bgRemovalEngine;
    this.bgQuality = prefs.bgRemovalQuality;
    this.bgFillHoles = prefs.bgFillHoles;
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
      console.warn('[SpriteEditor] Failed to load bound image', error);
    }
  }

  // -- rendering -------------------------------------------------------------

  protected render() {
    return html`
      <section
        class="sprite-editor ${this.isDragActive ? 'is-drag-active' : ''}"
        @dragover=${this.onDragOver}
        @dragleave=${this.onDragLeave}
        @drop=${this.onDrop}
      >
        ${this.renderToolbar()} ${this.renderSliceStatus()}
        <div class="ag-workspace">
          ${this.renderSidebar()}
          <main class="ag-main">${this.renderStage()}</main>
        </div>
        ${this.renderPromptBar()} ${this.renderHistory()}
        ${this.isDragActive
          ? html`<div class="ag-drop-overlay">Drop image to add as reference</div>`
          : null}
      </section>
    `;
  }

  private renderToolbar() {
    return html`
      <header class="ag-toolbar">
        <div class="ag-title">Sprite Editor</div>
        <button
          class="ag-icon-button"
          title="AI generation settings"
          aria-label="AI generation settings"
          @click=${this.openSettings}
        >
          ${this.icons.getIcon('settings', IconSize.SMALL)}
        </button>
        <div class="ag-toolbar-spacer"></div>
        <button
          class="ag-toolbar-button ${this.cropMode ? 'is-active' : ''}"
          title="Select a region and crop the image"
          @click=${this.onToggleCrop}
          ?disabled=${!this.current || this.bgBusy || this.generating}
        >
          ${this.icons.getIcon('crop', IconSize.SMALL)} Crop
        </button>
        <button
          class="ag-toolbar-button"
          @click=${this.onRemoveBackground}
          ?disabled=${!this.current || this.bgBusy || this.cropMode}
        >
          ${this.bgBusy ? 'Removing…' : 'Remove background'}
        </button>
        <button
          class="ag-icon-button"
          title="Rotate 90° clockwise"
          aria-label="Rotate 90° clockwise"
          @click=${this.onRotate}
          ?disabled=${!this.current ||
          this.bgBusy ||
          this.cropMode ||
          this.generating ||
          this.transformBusy}
        >
          ${this.icons.getIcon('rotate-cw', IconSize.SMALL)}
        </button>
        <button
          class="ag-icon-button"
          title="Flip horizontally"
          aria-label="Flip horizontally"
          @click=${this.onFlipHorizontal}
          ?disabled=${!this.current ||
          this.bgBusy ||
          this.cropMode ||
          this.generating ||
          this.transformBusy}
        >
          ${this.icons.getIcon('flip-horizontal', IconSize.SMALL)}
        </button>
        <button
          class="ag-icon-button"
          title="Flip vertically"
          aria-label="Flip vertically"
          @click=${this.onFlipVertical}
          ?disabled=${!this.current ||
          this.bgBusy ||
          this.cropMode ||
          this.generating ||
          this.transformBusy}
        >
          ${this.icons.getIcon('flip-vertical', IconSize.SMALL)}
        </button>
        ${this.renderSpritesheetActions()} ${this.renderZoomActions()} ${this.renderSaveMenu()}
      </header>
    `;
  }

  /** Stage zoom affordances — the same trio (and icons) the animation stage carries. */
  private renderZoomActions() {
    const disabled = !this.current;
    return html`
      <span class="ag-toolbar-separator" aria-hidden="true"></span>
      <button
        class="ag-icon-button"
        title="Zoom out"
        aria-label="Zoom out"
        @click=${() => this.onAdjustZoom(-1)}
        ?disabled=${disabled}
      >
        ${this.icons.getIcon('zoom-out', IconSize.SMALL)}
      </button>
      <button
        class="ag-icon-button"
        title="Reset zoom to 100%"
        aria-label="Reset zoom to 100%"
        @click=${this.onResetZoom}
        ?disabled=${disabled}
      >
        ${this.icons.getIcon('zoom-default', IconSize.SMALL)}
      </button>
      <button
        class="ag-icon-button"
        title="Zoom in"
        aria-label="Zoom in"
        @click=${() => this.onAdjustZoom(1)}
        ?disabled=${disabled}
      >
        ${this.icons.getIcon('zoom-in', IconSize.SMALL)}
      </button>
      <button
        class="ag-icon-button"
        title="Fit the image to the view"
        aria-label="Fit the image to the view"
        @click=${this.onFitStageToView}
        ?disabled=${disabled}
      >
        ${this.icons.getIcon('zoom-fit', IconSize.SMALL)}
      </button>
      <span class="ag-zoom-readout" title="Stage zoom"
        >${Math.round(this.stageView.zoom * 100)}%</span
      >
    `;
  }

  /**
   * Spritesheet actions. Both need the image to exist as a project file (the frame files are
   * written next to it), so they stay disabled until the panel is bound to one — save the image
   * first and the tab rebinds.
   */
  private renderSpritesheetActions() {
    const busy = this.sliceBusy || this.bgBusy || this.generating || this.cropMode;
    const canSlice = Boolean(this.boundImagePath) && !busy;
    const hint = this.boundImagePath
      ? undefined
      : 'Save the image into the project first — frame files are written next to it.';

    return html`
      <button
        class="ag-icon-button"
        title=${hint ?? 'Slice this spritesheet into individual frame files'}
        aria-label="Slice into frames"
        @click=${this.onSliceIntoFrames}
        ?disabled=${!canSlice}
      >
        ${this.icons.getIcon('grid', IconSize.SMALL)}
      </button>
      <button
        class="ag-icon-button"
        title=${hint ?? 'Create an animation (sprite folder) from this image'}
        aria-label="Create animation"
        @click=${this.onCreateAnimation}
        ?disabled=${!canSlice}
      >
        ${this.icons.getIcon('film', IconSize.SMALL)}
      </button>
    `;
  }

  private renderSliceStatus() {
    if (this.sliceBusy) {
      return html`<div class="ag-slice-status">Writing frame files…</div>`;
    }
    if (!this.sliceStatus) {
      return null;
    }
    return html`<div class="ag-slice-status ${this.sliceStatus.isError ? 'is-error' : ''}">
      ${this.sliceStatus.text}
      <button
        class="ag-icon-button ag-slice-status-close"
        title="Dismiss"
        aria-label="Dismiss"
        @click=${() => {
          this.sliceStatus = null;
        }}
      >
        ${this.icons.getIcon('x', IconSize.SMALL)}
      </button>
    </div>`;
  }

  private renderSaveMenu() {
    return html`
      <div class="ag-save-wrap">
        <button
          class="ag-toolbar-button ag-save-button ${this.savePopoverOpen ? 'is-open' : ''}"
          title="Save options"
          ?disabled=${!this.current || this.cropMode}
          @click=${this.toggleSavePopover}
        >
          ${this.icons.getIcon('save', IconSize.SMALL)} Save
          ${this.icons.getIcon('chevron-down', IconSize.SMALL)}
        </button>
        ${this.savePopoverOpen && this.current ? this.renderSavePopover() : null}
      </div>
    `;
  }

  private renderSavePopover() {
    const projectReady = appState.project.status === 'ready';
    return html`
      <div class="ag-save-popover" @click=${(e: Event) => e.stopPropagation()}>
        <div class="ag-popover-title">Save asset</div>
        <input
          class="ag-save-name"
          type="text"
          placeholder="folder/name.png"
          .value=${this.saveName}
          @input=${this.onSaveNameInput}
        />
        ${this.renderSaveResize()}
        <div class="ag-save-actions">
          <button
            class="ag-action-button"
            ?disabled=${!projectReady || !this.saveName.trim()}
            @click=${this.onSaveToProject}
          >
            Save to project
          </button>
          <button
            class="ag-action-button"
            ?disabled=${!projectReady || !this.saveName.trim()}
            @click=${this.onInsertSprite}
          >
            Insert as Sprite2D
          </button>
          <button
            class="ag-action-button"
            ?disabled=${!this.saveName.trim() || !this.assetLibrary.isUserScopeSupported()}
            @click=${this.onSaveToLibrary}
          >
            Save to Library
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

  private renderSaveResize() {
    const current = this.current;
    const selectValue = this.saveSizeCustom
      ? 'custom'
      : this.saveMaxSize > 0
        ? String(this.saveMaxSize)
        : '0';
    const target =
      current?.width && current.height
        ? scaledDimensions(current.width, current.height, this.saveMaxSize)
        : null;
    const sourceLabel =
      current?.width && current.height ? `${current.width}×${current.height}` : '?';
    const targetLabel = target ? `${target.width}×${target.height}` : '?';
    return html`
      <label class="ag-field ag-save-resize">
        <span class="ag-field-label">Resize on save (longest edge)</span>
        <select @change=${this.onSaveResizeChange}>
          <option value="0" ?selected=${selectValue === '0'}>Original size</option>
          ${SAVE_SIZE_PRESETS.map(
            size =>
              html`<option value=${String(size)} ?selected=${selectValue === String(size)}>
                ≤ ${size} px
              </option>`
          )}
          <option value="custom" ?selected=${selectValue === 'custom'}>Custom…</option>
        </select>
      </label>
      ${this.saveSizeCustom
        ? html`<input
            class="ag-save-custom-size"
            type="number"
            min="1"
            step="1"
            placeholder="Max px"
            .value=${this.saveMaxSize > 0 ? String(this.saveMaxSize) : ''}
            @input=${this.onSaveCustomSizeInput}
          />`
        : null}
      <div class="ag-hint">
        ${this.saveMaxSize > 0
          ? html`Source ${sourceLabel} → saved at <strong>${targetLabel}</strong> px`
          : html`Saved at full generated size (${sourceLabel} px)`}
      </div>
    `;
  }

  private renderSidebar() {
    const model = this.providers.get(this.providerId)?.getModel(this.modelId);
    const maxReferences = model?.capabilities.maxReferenceImages ?? 0;
    if (maxReferences <= 0) {
      return null;
    }
    return html`<aside class="ag-sidebar">${this.renderReferences(maxReferences)}</aside>`;
  }

  private renderPromptBar() {
    const provider = this.providers.get(this.providerId);
    const model = provider?.getModel(this.modelId);
    const models = provider?.models ?? [];
    const canGenerate =
      this.keyConfigured && this.prompt.trim().length > 0 && !this.generating && Boolean(model);

    return html`
      <div class="ag-prompt-bar">
        ${this.generateError ? html`<div class="ag-error">${this.generateError}</div>` : null}
        <div class="ag-prompt-box">
          <textarea
            class="ag-prompt"
            rows="2"
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
      </div>
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
          ${caps && caps.imageSizes.length > 0
            ? html`<label class="ag-field">
                <span class="ag-field-label">Size</span>
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
            ? html`<label class="ag-field">
                <span class="ag-field-label">Quality</span>
                <select @change=${this.onQualityChange}>
                  ${caps.qualities.map(
                    q => html`<option value=${q} ?selected=${q === this.quality}>${q}</option>`
                  )}
                </select>
              </label>`
            : null}
        </div>

        ${caps?.supportsTransparency
          ? html`<label class="ag-toggle-field">
              <input
                type="checkbox"
                .checked=${this.transparentBackground}
                @change=${this.onTransparentChange}
              />
              <span>Transparent background (alpha) — no bg-removal needed</span>
            </label>`
          : null}

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

  /**
   * One stage for every mode. The image is *sized* by zoom (never CSS-scaled) and
   * the pan rides on a transform, so overlays laid out in image pixels × zoom
   * land exactly on the pixels they describe while their chrome — the crop
   * border, the handles — stays screen-sized and grabbable at any zoom.
   */
  private renderStage() {
    const current = this.current;
    const size = this.getImageSize();
    const zoom = this.stageView.zoom;
    const imageStyle =
      size && current ? `width:${size.width * zoom}px; height:${size.height * zoom}px;` : '';

    return html`
      <div
        class="ag-stage ${this.cropMode ? 'is-cropping' : ''} ${this.stageView.isPanning
          ? 'is-panning'
          : ''}"
        ${ref(this.stageRef)}
        @wheel=${this.onStageWheel}
        @pointerdown=${this.onStagePointerDown}
        @pointermove=${this.onStagePointerMove}
        @pointerup=${this.onStagePointerUp}
        @pointercancel=${this.onStagePointerUp}
      >
        ${current
          ? html`<div
              class="ag-stage-content"
              style="transform: translate(${this.stageView.panX}px, ${this.stageView.panY}px);"
            >
              <img
                class="ag-stage-image ${zoom >= PIXELATED_ZOOM_THRESHOLD ? 'is-pixelated' : ''}"
                src=${current.objectUrl}
                alt="Working image"
                draggable="false"
                style=${imageStyle}
                ${ref(this.stageImageRef)}
                @load=${this.onStageImageLoad}
              />
              ${this.cropMode && this.cropRect ? this.renderCropRect(this.cropRect, zoom) : null}
            </div>`
          : html`<div class="ag-empty">
              <div class="ag-empty-title">Nothing here yet</div>
              <div class="ag-empty-body">
                Enter a prompt and press Generate, or open an image asset to edit it.
              </div>
            </div>`}
        ${this.bgBusy ? html`<div class="ag-progress">${this.renderBgProgress()}</div>` : null}
      </div>
      ${this.cropMode ? this.renderCropToolbar() : null}
      ${this.bgError ? html`<div class="ag-error ag-stage-error">${this.bgError}</div>` : null}
    `;
  }

  private renderCropRect(rect: CropRect, zoom: number) {
    return html`<div
      class="ag-crop-rect"
      style="left:${rect.x * zoom}px; top:${rect.y * zoom}px; width:${rect.w *
      zoom}px; height:${rect.h * zoom}px"
      @pointerdown=${(event: PointerEvent) => this.beginCropDrag(event, 'move', '')}
    >
      ${CROP_HANDLES.map(handle => this.renderCropHandle(handle))}
    </div>`;
  }

  private renderCropToolbar() {
    const rect = this.cropRect;
    return html`
      <div class="ag-crop-toolbar">
        <span class="ag-crop-dims"
          >${rect ? describeCropRect(rect) : 'Drag on the image to select a region'}</span
        >
        <div class="ag-prompt-spacer"></div>
        <button class="ag-cancel-button" @click=${this.onCancelCrop}>Cancel</button>
        <button
          class="ag-generate-button ag-crop-apply"
          ?disabled=${!isApplicableCropRect(this.cropRect)}
          @click=${this.onApplyCrop}
        >
          Apply crop
        </button>
      </div>
    `;
  }

  private renderCropHandle(handle: { pos: string; edges: string }) {
    return html`<span
      class="ag-crop-handle ag-crop-handle--${handle.pos}"
      @pointerdown=${(event: PointerEvent) => this.beginCropDrag(event, 'resize', handle.edges)}
    ></span>`;
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

  private renderHistory() {
    if (this.historyRecords.length === 0) {
      return null;
    }
    return html`
      <footer class="ag-history">
        <div class="ag-history-head">
          <span class="ag-field-label">History (${this.historyRecords.length})</span>
          <span class="ag-history-hint">Drag a thumbnail to the Asset Browser to save it.</span>
          <button class="ag-link-button" @click=${this.onClearHistory}>Clear</button>
        </div>
        <div class="ag-history-strip">
          ${this.historyRecords.map(record => {
            const url = this.historyUrls.get(record.id);
            return html`
              <div class="ag-history-card" title=${record.prompt}>
                <button
                  class="ag-history-thumb"
                  draggable="true"
                  @click=${() => this.useHistoryRecord(record)}
                  @dragstart=${(event: DragEvent) => this.onHistoryDragStart(event, record)}
                >
                  ${url ? html`<img src=${url} alt=${record.prompt} draggable="false" />` : null}
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

  private toggleSavePopover(): void {
    this.savePopoverOpen = !this.savePopoverOpen;
    if (this.savePopoverOpen) {
      this.saveMessage = null;
      this.saveError = null;
    }
  }

  private openFullSettings(): void {
    this.apiKeyPopoverOpen = false;
    void this.editorSettings.showSettings('images');
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

  private onQualityChange(event: Event): void {
    this.quality = (event.target as HTMLSelectElement).value;
    this.aiSettings.updatePreferences({ defaultQuality: this.quality });
  }

  private onTransparentChange(event: Event): void {
    this.transparentBackground = (event.target as HTMLInputElement).checked;
    this.aiSettings.updatePreferences({ transparentBackground: this.transparentBackground });
  }

  private onSaveNameInput(event: Event): void {
    this.saveName = (event.target as HTMLInputElement).value;
    this.saveMessage = null;
    this.saveError = null;
  }

  private onSaveResizeChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value === 'custom') {
      this.saveSizeCustom = true;
      // Keep whatever custom value was there; seed a sensible default the first time.
      if (this.saveMaxSize <= 0) {
        this.saveMaxSize = 256;
      }
    } else {
      this.saveSizeCustom = false;
      this.saveMaxSize = Number(value) || 0;
    }
    this.aiSettings.updatePreferences({ defaultSaveMaxSize: this.saveMaxSize });
  }

  private onSaveCustomSizeInput(event: Event): void {
    const parsed = Math.round(Number((event.target as HTMLInputElement).value));
    this.saveMaxSize = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    this.aiSettings.updatePreferences({ defaultSaveMaxSize: this.saveMaxSize });
  }

  /**
   * Resolve the bytes to write for the current image, applying the save-time downscale when one is
   * set and the image is larger than the cap. Returns the original blob unchanged otherwise.
   */
  private async resolveSaveBlob(): Promise<{ blob: Blob; mimeType: string } | null> {
    const current = this.current;
    if (!current) {
      return null;
    }
    const longest = Math.max(current.width ?? 0, current.height ?? 0);
    // No cap, or the image already fits within it → write the exact generated bytes untouched.
    if (this.saveMaxSize <= 0 || (longest > 0 && longest <= this.saveMaxSize)) {
      return { blob: current.blob, mimeType: current.mimeType };
    }
    try {
      // Preserve the source format so alpha (transparent PNGs / cut-outs) survives the resize.
      const result = await resizeImageBlob(current.blob, {
        maxSize: this.saveMaxSize,
        mimeType: current.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png',
      });
      return { blob: result.blob, mimeType: result.blob.type || current.mimeType };
    } catch (error) {
      console.warn('[SpriteEditor] Resize on save failed; writing original size', error);
      return { blob: current.blob, mimeType: current.mimeType };
    }
  }

  private openSettings(): void {
    void this.editorSettings.showSettings('images');
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
      console.warn('[SpriteEditor] Failed to read dropped asset', error);
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
          quality: caps.qualities?.includes(this.quality) ? this.quality : undefined,
          background:
            caps.supportsTransparency && this.transparentBackground ? 'transparent' : undefined,
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
        fillHoles: this.bgFillHoles,
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

  // -- rotate / flip ---------------------------------------------------------

  private onRotate(): void {
    void this.applyTransform('rotated', blob => rotateImageBlob(blob, 1));
  }

  private onFlipHorizontal(): void {
    void this.applyFlip('horizontal');
  }

  private onFlipVertical(): void {
    void this.applyFlip('vertical');
  }

  private applyFlip(axis: FlipAxis): Promise<void> {
    return this.applyTransform('flipped', blob => flipImageBlob(blob, axis));
  }

  /**
   * Run a geometric transform over the current working image and swap it in. The transform is a
   * plain canvas re-encode (no network / model), so it's cheap; `transformBusy` just guards against
   * overlapping clicks. The save name is intentionally left untouched.
   */
  private async applyTransform(
    source: CurrentSource,
    transform: (blob: Blob) => Promise<{ blob: Blob; width: number; height: number }>
  ): Promise<void> {
    if (!this.current || this.transformBusy || this.cropMode) {
      return;
    }
    this.transformBusy = true;
    try {
      const result = await transform(this.current.blob);
      const objectUrl = this.trackUrl(URL.createObjectURL(result.blob));
      this.setCurrent({
        blob: result.blob,
        mimeType: result.blob.type || this.current.mimeType,
        objectUrl,
        source,
        width: result.width,
        height: result.height,
      });
    } catch (error) {
      this.bgError = `Transform failed: ${describeError(error)}`;
    } finally {
      this.transformBusy = false;
    }
  }

  // -- stage view (zoom / pan) -----------------------------------------------

  /** Intrinsic size of the working image; the decoded element wins over cached metadata. */
  private getImageSize(): ImageSize | null {
    const image = this.stageImageRef.value;
    if (image && image.naturalWidth > 0 && image.naturalHeight > 0) {
      return { width: image.naturalWidth, height: image.naturalHeight };
    }
    const width = this.current?.width;
    const height = this.current?.height;
    if (width && height) {
      return { width, height };
    }
    return null;
  }

  /**
   * The content box the zoom/pan controller reasons about: the stage's own rect,
   * with the image's intrinsic size as the content size. The content element sits
   * at the stage's top-left and is moved by the pan, which is exactly the model
   * `toStageCoords` and `fitToViewport` assume.
   */
  private getStageViewport(): StageViewport | null {
    const stage = this.stageRef.value;
    const size = this.getImageSize();
    if (!stage || !size) {
      return null;
    }
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return { rect, contentWidth: size.width, contentHeight: size.height };
  }

  /** Pointer event → image pixels. Returns null before the image size is known. */
  private toImagePoint(event: PointerEvent): { point: StagePoint; size: ImageSize } | null {
    const viewport = this.getStageViewport();
    if (!viewport) {
      return null;
    }
    return {
      point: this.stageView.toStageCoords(event, viewport),
      size: { width: viewport.contentWidth, height: viewport.contentHeight },
    };
  }

  private onStageWheel(event: WheelEvent): void {
    const viewport = this.getStageViewport();
    if (!viewport) {
      return;
    }
    event.preventDefault();
    this.stageView.zoomAtPointer(event, viewport);
    this.hasUserAdjustedView = true;
  }

  private onAdjustZoom(direction: -1 | 1): void {
    this.stageView.adjustZoom(direction * 2);
    this.hasUserAdjustedView = true;
  }

  private onResetZoom(): void {
    this.stageView.reset();
    this.hasUserAdjustedView = true;
  }

  private onFitStageToView(): void {
    this.fitStageToViewport();
  }

  private fitStageToViewport(): void {
    const viewport = this.getStageViewport();
    if (!viewport) {
      return;
    }
    this.stageView.fitToViewport(viewport, STAGE_FIT_PADDING);
    // An explicit fit hands the view back to the stage, so resizes refit again.
    this.hasUserAdjustedView = false;
  }

  private observeStageResize(): void {
    if (this.stageResizeObserver || typeof ResizeObserver === 'undefined') {
      return;
    }
    const stage = this.stageRef.value;
    if (!stage) {
      return;
    }
    this.stageResizeObserver = new ResizeObserver(() => {
      if (!this.hasUserAdjustedView) {
        this.fitStageToViewport();
      }
    });
    this.stageResizeObserver.observe(stage);
  }

  private onStageImageLoad(): void {
    if (this.pendingStageFit) {
      this.pendingStageFit = false;
      this.fitStageToViewport();
      return;
    }
    // The size may only now be known (element mounted before `current.width` was set).
    this.requestUpdate();
  }

  private onStagePointerDown(event: PointerEvent): void {
    // Middle-drag (or Alt+left) pans; plain left-drag belongs to the crop tool.
    if (this.stageView.beginPan(event)) {
      this.hasUserAdjustedView = true;
      // begin/endPan don't notify (only `setPan` does), so ask for the repaint
      // that swaps the grab cursor in and out.
      this.requestUpdate();
      event.preventDefault();
      return;
    }
    if (!this.cropMode || event.button !== 0) {
      return;
    }
    const resolved = this.toImagePoint(event);
    if (!resolved) {
      return;
    }
    const point = clampToImage(resolved.point, resolved.size);
    this.cropDrag = {
      mode: 'draw',
      edges: '',
      originX: point.x,
      originY: point.y,
      startRectX: point.x,
      startRectY: point.y,
      startRectW: 0,
      startRectH: 0,
    };
    this.cropRect = { x: point.x, y: point.y, w: 0, h: 0 };
    this.stageRef.value?.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  private onStagePointerMove(event: PointerEvent): void {
    if (this.stageView.updatePan(event)) {
      return;
    }
    const drag = this.cropDrag;
    if (!drag) {
      return;
    }
    const resolved = this.toImagePoint(event);
    if (!resolved) {
      return;
    }
    this.cropRect = applyCropDrag(drag, resolved.point, resolved.size);
  }

  private onStagePointerUp(event: PointerEvent): void {
    if (this.stageView.endPan(event)) {
      this.requestUpdate();
      return;
    }
    if (!this.cropDrag) {
      return;
    }
    const stage = this.stageRef.value;
    if (stage?.hasPointerCapture(event.pointerId)) {
      stage.releasePointerCapture(event.pointerId);
    }
    this.cropDrag = null;
  }

  // -- crop ------------------------------------------------------------------

  private onToggleCrop(): void {
    if (!this.current) {
      return;
    }
    this.cropMode = !this.cropMode;
    this.cropRect = null;
    this.cropDrag = null;
  }

  private onCancelCrop(): void {
    this.cropMode = false;
    this.cropRect = null;
    this.cropDrag = null;
  }

  private initCropRect(): void {
    if (this.cropRect || !this.cropMode) {
      return;
    }
    const size = this.getImageSize();
    if (!size) {
      return;
    }
    this.cropRect = initialCropRect(size);
  }

  private beginCropDrag(event: PointerEvent, mode: 'move' | 'resize', edges: string): void {
    // Pan gestures (middle button, Alt+left) belong to the stage even when they
    // start on the selection — let them bubble instead of grabbing them here.
    if (event.button !== 0 || event.altKey || !this.cropRect) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    const resolved = this.toImagePoint(event);
    if (!resolved) {
      return;
    }
    this.cropDrag = {
      mode,
      edges,
      originX: resolved.point.x,
      originY: resolved.point.y,
      startRectX: this.cropRect.x,
      startRectY: this.cropRect.y,
      startRectW: this.cropRect.w,
      startRectH: this.cropRect.h,
    };
    this.stageRef.value?.setPointerCapture(event.pointerId);
  }

  private async onApplyCrop(): Promise<void> {
    const image = this.stageImageRef.value;
    const rect = this.cropRect;
    const size = this.getImageSize();
    if (!image || !rect || !size || !this.current) {
      return;
    }

    const pixels = cropRectToPixels(rect, size);
    if (!pixels) {
      return;
    }
    const { sx, sy, sw, sh } = pixels;

    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);

    const blob = await new Promise<Blob | null>(resolve =>
      canvas.toBlob(result => resolve(result), 'image/png')
    );
    if (!blob) {
      return;
    }

    const objectUrl = this.trackUrl(URL.createObjectURL(blob));
    this.cropMode = false;
    this.cropRect = null;
    this.cropDrag = null;
    this.setCurrent({
      blob,
      mimeType: 'image/png',
      objectUrl,
      source: 'cropped',
      width: sw,
      height: sh,
    });
    this.saveName = setImageExt(
      `${stripImageExt(normalizeRelativePath(this.saveName) || 'cropped')}-crop`,
      'png'
    );

    try {
      await this.history.add({
        providerId: this.providerId,
        modelId: this.modelId,
        prompt: this.prompt.trim() ? `${this.prompt.trim()} (crop)` : 'Cropped image',
        aspectRatio: this.aspectRatio,
        imageSize: this.imageSize,
        mimeType: 'image/png',
        blob,
        width: sw,
        height: sh,
      });
    } catch (error) {
      console.warn('[SpriteEditor] Failed to add crop to history', error);
    }
  }

  // -- result actions --------------------------------------------------------

  private async onSaveToProject(): Promise<string | null> {
    if (!this.current) {
      return null;
    }
    const output = await this.resolveSaveBlob();
    if (!output) {
      return null;
    }
    const relativePath = ensureImageExt(normalizeRelativePath(this.saveName), output.mimeType);
    if (!relativePath) {
      this.saveError = 'Enter a file name.';
      return null;
    }
    this.saveError = null;
    this.saveMessage = null;
    try {
      await this.ensureParentDirectory(relativePath);
      const buffer = await output.blob.arrayBuffer();
      await this.storage.writeBinaryFile(relativePath, buffer);
      this.saveMessage = this.describeSaveResult(relativePath, output.blob);
      return relativePath;
    } catch (error) {
      this.saveError = `Save failed: ${describeError(error)}`;
      return null;
    }
  }

  /**
   * Save the current image into the personal Asset Library (editor-level; no project needed).
   * The blob becomes a one-file `image` bundle; the file name (minus folders) seeds the item name.
   */
  private onSaveToLibrary = async (): Promise<void> => {
    if (!this.current) {
      return;
    }
    const output = await this.resolveSaveBlob();
    if (!output) {
      return;
    }
    const fileName = ensureImageExt(normalizeRelativePath(this.saveName), output.mimeType)
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
      const files = new Map<string, Blob>([[fileName, output.blob]]);
      await this.assetLibrary.putUserItem({
        manifest: {
          id: crypto.randomUUID(),
          slug,
          name,
          type: 'image',
          tags: ['generated'],
          description: this.prompt || undefined,
          preview: fileName,
          entry: fileName,
          files: [fileName],
          source: 'generated',
          createdAt: 0,
          updatedAt: 0,
        },
        files,
      });
      this.saveMessage = `Saved "${name}" to your library.`;
    } catch (error) {
      this.saveError = `Save to Library failed: ${describeError(error)}`;
    }
  };

  /** Human-readable confirmation, noting the downscaled dimensions when a resize was applied. */
  private describeSaveResult(path: string, blob: Blob): string {
    if (this.saveMaxSize > 0 && this.current?.width && this.current.height) {
      const target = scaledDimensions(this.current.width, this.current.height, this.saveMaxSize);
      return `Saved to ${path} (${target.width}×${target.height}, ${formatBytes(blob.size)})`;
    }
    return `Saved to ${path}`;
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
    const output = await this.resolveSaveBlob();
    if (!output) {
      return;
    }
    this.saveError = null;
    this.saveMessage = null;
    try {
      const buffer = await output.blob.arrayBuffer();
      await this.storage.writeBinaryFile(this.boundImagePath, buffer);
      this.saveMessage = this.describeSaveResult(this.boundImagePath, output.blob).replace(
        'Saved to',
        'Overwrote'
      );
    } catch (error) {
      this.saveError = `Overwrite failed: ${describeError(error)}`;
    }
  }

  private async onDownload(): Promise<void> {
    if (!this.current) {
      return;
    }
    const output = await this.resolveSaveBlob();
    if (!output) {
      return;
    }
    const url = URL.createObjectURL(output.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = ensureImageExt(
      normalizeRelativePath(this.saveName) || 'generated',
      output.mimeType
    )
      .split('/')
      .pop()!;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  // -- spritesheet actions ----------------------------------------------------

  /**
   * Ask for a slice grid. Shares the animation editor's dialog (generalised in Phase 2) so the
   * grid preview/overlay is identical wherever slicing is offered.
   */
  private async askForSliceGrid(
    copy: Pick<
      Parameters<AnimationAutoSliceDialogService['showDialog']>[0],
      'contextCaption' | 'confirmNote' | 'confirmLabel' | 'cancelLabel'
    >
  ): Promise<{ columns: number; rows: number } | null> {
    const imagePath = this.boundImagePath;
    if (!imagePath) {
      return null;
    }
    const result = await this.sliceDialog.showDialog({
      texturePath: imagePath,
      contextLabel: deriveNodeName(imagePath),
      defaultColumns: this.sliceColumns,
      defaultRows: this.sliceRows,
      ...copy,
    });
    if (!result) {
      return null;
    }
    this.sliceColumns = result.columns;
    this.sliceRows = result.rows;
    return result;
  }

  /**
   * Cut the bound image into individual PNG files in a `<name>_frames/` folder next to it. Pure
   * file output — no `.pix3anim` and no scene mutation, so no Command/Operation (matching the
   * Save-to-project precedent: project-file writes are not undoable app-state mutations).
   */
  private async onSliceIntoFrames(): Promise<void> {
    const imagePath = this.boundImagePath;
    if (!imagePath || this.sliceBusy) {
      return;
    }
    const stem = deriveNodeName(imagePath);
    const relative = normalizeRelativePath(imagePath);
    const slashIndex = relative.lastIndexOf('/');
    const folder = `${slashIndex >= 0 ? `${relative.slice(0, slashIndex)}/` : ''}${stem}_frames`;

    const grid = await this.askForSliceGrid({
      contextCaption: 'Spritesheet',
      confirmNote: `Frames are written to ${folder}/frame_0001.png …`,
      confirmLabel: 'Slice Into Files',
      cancelLabel: 'Cancel',
    });
    if (!grid) {
      return;
    }

    this.sliceBusy = true;
    this.sliceStatus = null;
    try {
      const source = this.current?.blob ?? (await this.storage.readBlob(imagePath));
      const cells = await sliceImageBlob(source, grid);
      await this.ensureParentDirectory(`${folder}/frame.png`);
      for (const [index, cell] of cells.entries()) {
        const framePath = `${folder}/frame_${String(index + 1).padStart(4, '0')}.png`;
        await this.storage.writeBinaryFile(framePath, await cell.arrayBuffer());
      }
      this.sliceStatus = {
        text: `Sliced into ${cells.length} frames in ${folder}/`,
        isError: false,
      };
    } catch (error) {
      this.sliceStatus = { text: `Slice failed: ${describeError(error)}`, isError: true };
    } finally {
      this.sliceBusy = false;
    }
  }

  /**
   * Turn the bound image into a **managed sprite folder**: `<dir>/<stem>/<stem>.pix3anim` plus
   * `<clip>_<nnnn>.png` frame files, then open the animation editor on it. A 1×1 grid is a valid
   * answer — it produces a one-frame clip from a single image.
   */
  private async onCreateAnimation(): Promise<void> {
    const imagePath = this.boundImagePath;
    if (!imagePath || this.sliceBusy) {
      return;
    }
    const assetPath = buildManagedSpriteAssetPath(imagePath);
    const folder = getAnimationAssetDirectory(assetPath).replace(/^res:\/\//, '');
    const clipName = 'idle';

    const grid = await this.askForSliceGrid({
      contextCaption: 'New animation',
      confirmNote: `Creates ${folder}/${deriveAnimationAssetStem(assetPath)}.pix3anim with the frames beside it.`,
      confirmLabel: 'Create Animation',
      cancelLabel: 'Cancel',
    });
    if (!grid) {
      return;
    }

    this.sliceBusy = true;
    this.sliceStatus = null;
    try {
      const source = this.current?.blob ?? (await this.storage.readBlob(imagePath));
      const cells = await sliceImageBlob(source, grid);
      await this.ensureParentDirectory(`${folder}/frame.png`);

      // Every cell of a grid slice is the same size — decode one and stamp all
      // frames with it so `sizeMode: 'native'` layout never waits on a load.
      const cellSize = cells.length > 0 ? await readBlobSize(cells[0]) : null;
      const framePaths: string[] = [];
      for (const [index, cell] of cells.entries()) {
        const framePath = buildAnimationFrameResourcePath(assetPath, index + 1, { clipName });
        await this.storage.writeBinaryFile(framePath, await cell.arrayBuffer());
        framePaths.push(framePath);
      }

      const resource = normalizeAnimationResource({
        version: '1.0.0',
        texturePath: '',
        clips: [
          {
            name: clipName,
            fps: 12,
            loop: true,
            playbackMode: 'normal',
            frames: framePaths.map(texturePath => ({
              textureIndex: 0,
              offset: { x: 0, y: 0 },
              repeat: { x: 1, y: 1 },
              durationMultiplier: 1,
              anchor: { x: 0.5, y: 0.5 },
              texturePath,
              boundingBox: { x: 0, y: 0, width: 0, height: 0 },
              collisionPolygon: [],
              sourceSize: cellSize ? { width: cellSize.width, height: cellSize.height } : undefined,
            })),
          },
        ],
      });

      const didMutate = await this.commandDispatcher.execute(
        new CreateAnimationAssetCommand({
          assetPath,
          texturePath: '',
          initialClipName: clipName,
          resource,
          overwrite: true,
        })
      );
      if (!didMutate) {
        this.sliceStatus = { text: 'Could not create the animation asset.', isError: true };
        return;
      }

      this.sliceStatus = {
        text: `Created a ${framePaths.length}-frame animation in ${folder}/`,
        isError: false,
      };
      await this.editorTabs.focusOrOpenAnimation(assetPath);
    } catch (error) {
      this.sliceStatus = {
        text: `Create animation failed: ${describeError(error)}`,
        isError: true,
      };
    } finally {
      this.sliceBusy = false;
    }
  }

  // -- history ---------------------------------------------------------------

  private async reloadHistory(): Promise<void> {
    let records: GenerationRecord[] = [];
    try {
      records = await this.history.list();
    } catch (error) {
      console.warn('[SpriteEditor] Failed to load history', error);
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

  private setCurrent(next: CurrentImage): void {
    const previous = this.current;
    this.current = next;
    if (previous && previous.objectUrl !== next.objectUrl) {
      this.revokeUrl(previous.objectUrl);
    }
    // A new working image gets a fresh view: the fit runs once the <img> has
    // decoded and can report its intrinsic size.
    this.pendingStageFit = true;
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

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

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
  // Images live under the project-root `sprites/` folder (flat project layout); the
  // `generated/` bucket keeps AI output out of the hand-curated sprites.
  return ensureImageExt(`sprites/generated/${base}`, mimeType);
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
    'pix3-sprite-editor-panel': SpriteEditorPanel;
  }
}
