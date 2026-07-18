import { ComponentBase, customElement, html, inject, state } from '@/fw';
import {
  AssetFileActivationService,
  AssetsPreviewService,
  IconService,
  type AssetActivation,
  type AssetPreviewItem,
  type AssetsPreviewSnapshot,
} from '@/services';
import {
  ASSET_PATH_LIST_MIME,
  ASSET_PATH_MIME,
  ASSET_RESOURCE_LIST_MIME,
  ASSET_RESOURCE_MIME,
  hasGenerationDragData,
  toProjectResourcePath,
} from '@/ui/shared/asset-drag-drop';
import { EditorTabService } from '@/services/EditorTabService';
import { GeneratedAssetDropService } from '@/services/GeneratedAssetDropService';
import { DropdownPortal } from '@/ui/shared/dropdown-portal';
import './assets-preview-panel.ts.css';
import '../shared/pix3-panel';

@customElement('pix3-assets-preview-panel')
export class AssetsPreviewPanel extends ComponentBase {
  @inject(AssetsPreviewService)
  private readonly assetsPreviewService!: AssetsPreviewService;

  @inject(AssetFileActivationService)
  private readonly assetFileActivationService!: AssetFileActivationService;

  @inject(IconService)
  private readonly iconService!: IconService;

  @inject(EditorTabService)
  private readonly editorTabService!: EditorTabService;

  @inject(GeneratedAssetDropService)
  private readonly generatedAssetDropService!: GeneratedAssetDropService;

  @state()
  private snapshot: AssetsPreviewSnapshot = {
    selectedFolderPath: null,
    displayPath: 'res://',
    isLoading: false,
    errorMessage: null,
    selectedItemPath: null,
    selectedItem: null,
    items: [],
  };

  @state()
  private contextMenu: { item: AssetPreviewItem; x: number; y: number } | null = null;

  @state()
  private isGenerationDropActive = false;

  /** Path of the audio asset currently previewing (null = none). */
  @state()
  private playingAudioPath: string | null = null;

  private disposePreviewSubscription?: () => void;
  private selectedPaths = new Set<string>();
  private lastSelectedPath: string | null = null;
  /** Last service-driven selected item we mirrored, so unrelated snapshot updates don't clobber local selection. */
  private lastSyncedSelectedItemPath: string | null | undefined = undefined;
  /** Shared element for asset-browser audio preview; reused across items. */
  private audioPreviewEl: HTMLAudioElement | null = null;
  private lastPreviewFolderPath: string | null = null;
  private readonly contextMenuPortal = new DropdownPortal({ minWidth: '13rem' });
  private readonly onGlobalPointerDown = (event: PointerEvent): void => {
    if (this.contextMenu && !this.contextMenuPortal.contains(event.target as Node)) {
      this.closeContextMenu();
    }
  };
  private readonly onGlobalKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.closeContextMenu();
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    this.disposePreviewSubscription = this.assetsPreviewService.subscribe(snapshot => {
      // Stop preview when the folder changes (its blob URLs get revoked) or the
      // playing item disappears from the listing.
      if (snapshot.selectedFolderPath !== this.lastPreviewFolderPath) {
        this.lastPreviewFolderPath = snapshot.selectedFolderPath;
        this.stopAudioPreview();
      } else if (
        this.playingAudioPath &&
        !snapshot.items.some(entry => entry.path === this.playingAudioPath)
      ) {
        this.stopAudioPreview();
      }
      // Mirror an externally-driven selection (reveal from Scene Tree / selection in Asset
      // Browser) into the local highlight set. Only react when the service's selected item
      // actually changes, so local multi-selection made inside this panel isn't clobbered by
      // unrelated snapshot updates (e.g. thumbnails becoming ready).
      if (snapshot.selectedItemPath !== this.lastSyncedSelectedItemPath) {
        this.lastSyncedSelectedItemPath = snapshot.selectedItemPath;
        if (snapshot.selectedItemPath) {
          this.selectedPaths = new Set([snapshot.selectedItemPath]);
          this.lastSelectedPath = snapshot.selectedItemPath;
        } else {
          this.selectedPaths = new Set();
          this.lastSelectedPath = null;
        }
      }
      this.snapshot = snapshot;
      this.requestUpdate();
    });
    window.addEventListener('pointerdown', this.onGlobalPointerDown, true);
    window.addEventListener('keydown', this.onGlobalKeyDown);
  }

  disconnectedCallback(): void {
    this.disposePreviewSubscription?.();
    this.disposePreviewSubscription = undefined;
    window.removeEventListener('pointerdown', this.onGlobalPointerDown, true);
    window.removeEventListener('keydown', this.onGlobalKeyDown);
    this.contextMenuPortal.close();
    this.stopAudioPreview();
    this.audioPreviewEl = null;
    super.disconnectedCallback();
  }

  protected updated(): void {
    if (this.contextMenu && !this.contextMenuPortal.isOpen()) {
      const menu = this.querySelector<HTMLElement>('.assets-preview-context-menu');
      if (menu) {
        this.contextMenuPortal.openAt(this.contextMenu.x, this.contextMenu.y, menu);
      }
    } else if (!this.contextMenu && this.contextMenuPortal.isOpen()) {
      this.contextMenuPortal.close();
    }
  }

  protected render() {
    return html`
      <pix3-panel
        panel-description="Select a folder in Asset Browser to preview files as thumbnails."
      >
        <span slot="subtitle" class="folder-path">${this.snapshot.displayPath}</span>
        <div
          class="preview-root ${this.isGenerationDropActive ? 'is-generation-drop' : ''}"
          @dragover=${this.onGenerationDragOver}
          @dragleave=${this.onGenerationDragLeave}
          @drop=${this.onGenerationDrop}
        >
          ${this.isGenerationDropActive
            ? html`<div class="generation-drop-overlay">
                Drop to save into ${this.snapshot.displayPath}
              </div>`
            : null}
          ${this.snapshot.isLoading
            ? html`<p class="preview-status">Loading folder preview...</p>`
            : this.snapshot.errorMessage
              ? html`<p class="preview-status preview-error">${this.snapshot.errorMessage}</p>`
              : this.snapshot.items.length === 0
                ? html`<p class="preview-status">No files found in this folder.</p>`
                : html`<div class="assets-preview-grid">
                    ${this.snapshot.items.map(item => this.renderItem(item))}
                  </div>`}
        </div>
        ${this.renderContextMenu()}
      </pix3-panel>
    `;
  }

  private renderContextMenu() {
    if (!this.contextMenu) {
      return null;
    }
    const item = this.contextMenu.item;
    return html`
      <div
        class="assets-preview-context-menu"
        role="menu"
        @click=${(event: Event) => event.stopPropagation()}
      >
        <button type="button" role="menuitem" @click=${() => this.openInSpriteEditor(item)}>
          Open in Sprite Editor
        </button>
        <button type="button" role="menuitem" @click=${() => this.addToSceneAsSprite(item)}>
          Add to Scene as Sprite2D
        </button>
      </div>
    `;
  }

  private onItemContextMenu(event: MouseEvent, item: AssetPreviewItem): void {
    if (item.kind !== 'file' || item.previewType !== 'image') {
      this.closeContextMenu();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.updateSelectionFromClick(event, item);
    this.assetsPreviewService.selectItem(item.path);
    this.contextMenu = { item, x: event.clientX, y: event.clientY };
  }

  private closeContextMenu(): void {
    if (this.contextMenu) {
      this.contextMenu = null;
    }
  }

  private openInSpriteEditor(item: AssetPreviewItem): void {
    this.closeContextMenu();
    void this.editorTabService.focusOrOpenSpriteEditor(toProjectResourcePath(item.path));
  }

  /** Explicit "create a node from this image" — the old double-click behavior, now on the menu. */
  private addToSceneAsSprite(item: AssetPreviewItem): void {
    this.closeContextMenu();
    void this.assetFileActivationService.createSpriteFromImage(this.toActivation(item));
  }

  private toActivation(item: AssetPreviewItem): AssetActivation {
    return {
      name: item.name,
      path: item.path,
      kind: item.kind,
      resourcePath: toProjectResourcePath(item.path),
      extension: item.extension,
    };
  }

  private renderItem(item: AssetPreviewItem) {
    const isSelected = this.selectedPaths.has(item.path);
    return html`
      <button
        class="assets-preview-item ${isSelected ? 'is-selected' : ''}"
        title=${this.buildTooltip(item)}
        draggable=${item.kind === 'file' ? 'true' : 'false'}
        @click=${(event: MouseEvent) => this.onItemSelected(event, item)}
        @dblclick=${(event: MouseEvent) => {
          void this.onItemDoubleClick(event, item);
        }}
        @contextmenu=${(event: MouseEvent) => this.onItemContextMenu(event, item)}
        @dragstart=${(event: DragEvent) => this.onItemDragStart(event, item)}
      >
        <span class="thumb">
          ${item.previewType === 'text' && item.previewText
            ? html`<span class="text-thumb">${item.previewText}</span>`
            : item.thumbnailUrl
              ? html`<img src=${item.thumbnailUrl} alt=${item.name} loading="lazy" />`
              : html`
                  <span class="icon">${this.iconService.getIcon(item.iconName, 24)}</span>
                  ${(item.previewType === 'model' || item.previewType === 'scene') &&
                  item.thumbnailStatus === 'loading'
                    ? html`<span class="thumb-spinner" aria-hidden="true"></span>`
                    : null}
                `}
          ${item.previewType === 'audio' && item.kind === 'file' && item.previewUrl
            ? html`<span
                class="audio-play-btn ${this.playingAudioPath === item.path ? 'is-playing' : ''}"
                aria-hidden="true"
                title=${this.playingAudioPath === item.path ? 'Stop preview' : 'Play preview'}
                >${this.iconService.getIcon(
                  this.playingAudioPath === item.path ? 'stop' : 'play',
                  18
                )}</span
              >`
            : null}
        </span>
        <span class="name">${item.name}</span>
        ${item.kind === 'file' && item.sizeBytes !== null
          ? html`<span class="meta">${this.formatFileSize(item.sizeBytes)}</span>`
          : null}
      </button>
    `;
  }

  private onItemSelected(event: MouseEvent, item: AssetPreviewItem): void {
    // Click on the audio play/stop affordance toggles preview (detected on the
    // parent item button so we avoid a nested interactive element).
    if (
      item.previewType === 'audio' &&
      (event.target as HTMLElement | null)?.closest('.audio-play-btn')
    ) {
      this.toggleAudioPreview(item);
      return;
    }
    this.updateSelectionFromClick(event, item);
    this.assetsPreviewService.selectItem(item.path);
    if (item.previewType === 'model' || item.previewType === 'scene') {
      this.assetsPreviewService.requestThumbnail(item.path);
    }
  }

  private toggleAudioPreview(item: AssetPreviewItem): void {
    if (this.playingAudioPath === item.path) {
      this.stopAudioPreview();
      return;
    }
    if (!item.previewUrl) {
      return;
    }
    if (!this.audioPreviewEl) {
      this.audioPreviewEl = new Audio();
      this.audioPreviewEl.addEventListener('ended', () => {
        this.playingAudioPath = null;
      });
    }
    this.audioPreviewEl.src = item.previewUrl;
    this.audioPreviewEl.currentTime = 0;
    void this.audioPreviewEl.play().catch(() => {
      this.playingAudioPath = null;
    });
    this.playingAudioPath = item.path;
  }

  private stopAudioPreview(): void {
    if (this.audioPreviewEl) {
      this.audioPreviewEl.pause();
      this.audioPreviewEl.removeAttribute('src');
      this.audioPreviewEl.load();
    }
    if (this.playingAudioPath !== null) {
      this.playingAudioPath = null;
    }
  }

  private onItemDragStart(event: DragEvent, item: AssetPreviewItem): void {
    if (item.kind !== 'file' || !event.dataTransfer) {
      return;
    }

    if (!this.selectedPaths.has(item.path)) {
      this.selectedPaths = new Set([item.path]);
      this.lastSelectedPath = item.path;
      this.requestUpdate();
    }

    const selectedItems = this.snapshot.items.filter(
      candidate => candidate.kind === 'file' && this.selectedPaths.has(candidate.path)
    );
    const itemsToDrag = selectedItems.length > 0 ? selectedItems : [item];
    const resourcePaths = itemsToDrag.map(candidate => toProjectResourcePath(candidate.path));
    const plainPaths = itemsToDrag.map(candidate => candidate.path);
    const resourcePath = resourcePaths[0] ?? toProjectResourcePath(item.path);
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', plainPaths.join('\n'));
    event.dataTransfer.setData(ASSET_PATH_MIME, plainPaths[0] ?? item.path);
    event.dataTransfer.setData(ASSET_RESOURCE_MIME, resourcePath);
    event.dataTransfer.setData(ASSET_PATH_LIST_MIME, JSON.stringify(plainPaths));
    event.dataTransfer.setData(ASSET_RESOURCE_LIST_MIME, JSON.stringify(resourcePaths));
    event.dataTransfer.setData('text/uri-list', resourcePath);
  }

  private onGenerationDragOver(event: DragEvent): void {
    if (!hasGenerationDragData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    this.isGenerationDropActive = true;
  }

  private onGenerationDragLeave(event: DragEvent): void {
    const related = event.relatedTarget as Node | null;
    if (related && this.contains(related)) {
      return;
    }
    this.isGenerationDropActive = false;
  }

  private async onGenerationDrop(event: DragEvent): Promise<void> {
    if (!hasGenerationDragData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    this.isGenerationDropActive = false;
    const targetDirectory = this.snapshot.selectedFolderPath ?? '.';
    await this.generatedAssetDropService.handleDrop(event.dataTransfer, targetDirectory);
    // The preview refreshes automatically once the write signals a directory change.
  }

  private updateSelectionFromClick(event: MouseEvent, item: AssetPreviewItem): void {
    const orderedPaths = this.snapshot.items.map(candidate => candidate.path);
    const nextSelectedPaths = new Set(this.selectedPaths);

    if (event.shiftKey && this.lastSelectedPath && orderedPaths.includes(this.lastSelectedPath)) {
      const startIndex = orderedPaths.indexOf(this.lastSelectedPath);
      const endIndex = orderedPaths.indexOf(item.path);
      const [rangeStart, rangeEnd] =
        startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
      nextSelectedPaths.clear();
      for (let index = rangeStart; index <= rangeEnd; index += 1) {
        const path = orderedPaths[index];
        if (path) {
          nextSelectedPaths.add(path);
        }
      }
    } else if (event.ctrlKey || event.metaKey) {
      if (nextSelectedPaths.has(item.path)) {
        nextSelectedPaths.delete(item.path);
      } else {
        nextSelectedPaths.add(item.path);
      }
    } else {
      nextSelectedPaths.clear();
      nextSelectedPaths.add(item.path);
    }

    if (nextSelectedPaths.size === 0) {
      nextSelectedPaths.add(item.path);
    }

    this.selectedPaths = nextSelectedPaths;
    this.lastSelectedPath = item.path;
    this.requestUpdate();
  }

  private async onItemDoubleClick(event: MouseEvent, item: AssetPreviewItem): Promise<void> {
    // The audio play/stop affordance handles its own clicks; don't also activate.
    if (
      item.previewType === 'audio' &&
      (event.target as HTMLElement | null)?.closest('.audio-play-btn')
    ) {
      return;
    }
    if (item.kind === 'directory') {
      window.dispatchEvent(
        new CustomEvent('assets-preview:reveal-path', {
          detail: { path: item.path },
        })
      );
      return;
    }

    await this.onItemActivate(item);
  }

  private async onItemActivate(item: AssetPreviewItem): Promise<void> {
    if (item.kind !== 'file') {
      return;
    }

    await this.assetFileActivationService.handleActivation(this.toActivation(item));
  }

  private buildTooltip(item: AssetPreviewItem): string {
    const lines: string[] = [item.name];

    if (item.previewType === 'text' && item.previewText) {
      lines.push('');
      lines.push(item.previewText);
    }

    if (item.width !== null && item.height !== null) {
      lines.push(`Resolution: ${item.width} x ${item.height}`);
    }

    if (item.durationSeconds !== null) {
      lines.push(`Duration: ${this.formatDuration(item.durationSeconds)}`);
    }

    if (item.channelCount !== null) {
      lines.push(`Channels: ${item.channelCount}`);
    }

    if (item.sampleRate !== null) {
      lines.push(`Sample rate: ${this.formatSampleRate(item.sampleRate)}`);
    }

    if (item.sizeBytes !== null) {
      lines.push(`Size: ${this.formatFileSize(item.sizeBytes)}`);
    }

    return lines.join('\n');
  }

  private formatFileSize(sizeBytes: number): string {
    if (sizeBytes < 1024) {
      return `${sizeBytes} B`;
    }
    const kb = sizeBytes / 1024;
    if (kb < 1024) {
      return `${kb.toFixed(1)} KB`;
    }
    const mb = kb / 1024;
    return `${mb.toFixed(2)} MB`;
  }

  private formatDuration(durationSeconds: number): string {
    const totalSeconds = Math.round(durationSeconds);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  private formatSampleRate(sampleRate: number): string {
    const khz = sampleRate / 1000;
    return `${khz % 1 === 0 ? khz.toFixed(0) : khz.toFixed(1)} kHz`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-assets-preview-panel': AssetsPreviewPanel;
  }
}
