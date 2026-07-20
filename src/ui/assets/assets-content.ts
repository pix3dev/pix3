import { ComponentBase, customElement, html, inject, state } from '@/fw';
import {
  AssetFileActivationService,
  AssetsPreviewService,
  IconService,
  IconSize,
  ProjectService,
  type AssetActivation,
  type AssetPreviewItem,
  type AssetsPreviewSnapshot,
} from '@/services';
import {
  ASSET_PATH_LIST_MIME,
  ASSET_PATH_MIME,
  ASSET_RESOURCE_LIST_MIME,
  ASSET_RESOURCE_MIME,
  getLibraryItemDragData,
  hasGenerationDragData,
  hasLibraryItemDragData,
  toProjectResourcePath,
} from '@/ui/shared/asset-drag-drop';
import { EditorTabService } from '@/services/EditorTabService';
import { GeneratedAssetDropService } from '@/services/GeneratedAssetDropService';
import { LibraryInsertService } from '@/services/LibraryInsertService';
import { DropdownPortal } from '@/ui/shared/dropdown-portal';
import { appState } from '@/state';
import { subscribe } from 'valtio/vanilla';
import './assets-content.ts.css';

/** Content-pane layout mode. */
type ContentView = 'grid' | 'list';

const MIN_THUMBNAIL_SIZE = 56;
const MAX_THUMBNAIL_SIZE = 160;
const DEFAULT_THUMBNAIL_SIZE = 104;

function clampThumbnailSize(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_THUMBNAIL_SIZE;
  }
  return Math.min(MAX_THUMBNAIL_SIZE, Math.max(MIN_THUMBNAIL_SIZE, Math.round(value)));
}

@customElement('pix3-assets-content')
export class AssetsContent extends ComponentBase {
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

  @inject(LibraryInsertService)
  private readonly libraryInsertService!: LibraryInsertService;

  @inject(ProjectService)
  private readonly projectService!: ProjectService;

  @state()
  private snapshot: AssetsPreviewSnapshot = {
    selectedFolderPath: null,
    displayPath: 'res://',
    isLoading: false,
    errorMessage: null,
    selectedItemPath: null,
    selectedItem: null,
    items: [],
    folderItemCount: null,
    folderSizeBytes: null,
  };

  @state()
  private contextMenu: { item: AssetPreviewItem; x: number; y: number } | null = null;

  @state()
  private contentView: ContentView = 'grid';

  @state()
  private thumbnailSize = DEFAULT_THUMBNAIL_SIZE;

  @state()
  private isGenerationDropActive = false;

  /** Path of the audio asset currently previewing (null = none). */
  @state()
  private playingAudioPath: string | null = null;

  private disposePreviewSubscription?: () => void;
  private disposeProjectSubscription?: () => void;
  private lastProjectId: string | null = null;
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

    // Restore persisted view/thumbnail-size prefs and re-restore on project switch.
    this.restoreContentPrefs();
    this.lastProjectId = appState.project.id;
    this.disposeProjectSubscription = subscribe(appState.project, () => {
      if (appState.project.id !== this.lastProjectId) {
        this.lastProjectId = appState.project.id;
        this.restoreContentPrefs();
      }
    });
  }

  disconnectedCallback(): void {
    this.disposePreviewSubscription?.();
    this.disposePreviewSubscription = undefined;
    this.disposeProjectSubscription?.();
    this.disposeProjectSubscription = undefined;
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

  /** Current grid multi-selection as an array (used by the Phase 4 toolbar). */
  getSelectedPaths(): string[] {
    return Array.from(this.selectedPaths);
  }

  private restoreContentPrefs(): void {
    const persisted = this.projectService.loadAssetBrowserState();
    const thumbnailSize = clampThumbnailSize(
      persisted?.thumbnailSize ?? appState.project.assetsThumbnailSize
    );
    const contentView: ContentView =
      (persisted?.contentView ?? appState.project.assetsContentView) === 'list' ? 'list' : 'grid';
    this.thumbnailSize = thumbnailSize;
    this.contentView = contentView;
    appState.project.assetsThumbnailSize = thumbnailSize;
    appState.project.assetsContentView = contentView;
    this.style.setProperty('--assets-thumb-size', `${thumbnailSize}px`);
  }

  private setContentView(view: ContentView): void {
    if (this.contentView === view) {
      return;
    }
    this.contentView = view;
    appState.project.assetsContentView = view;
    this.projectService.saveAssetBrowserState({ contentView: view });
  }

  private onThumbnailSizeInput(event: Event): void {
    const value = clampThumbnailSize(Number((event.target as HTMLInputElement).value));
    this.thumbnailSize = value;
    this.style.setProperty('--assets-thumb-size', `${value}px`);
    appState.project.assetsThumbnailSize = value;
    this.projectService.saveAssetBrowserState({ thumbnailSize: value });
  }

  protected render() {
    return html`
      ${this.renderHeader()}
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
        ${this.renderBody()}
      </div>
      ${this.renderContextMenu()}
    `;
  }

  private renderBody() {
    if (this.snapshot.isLoading) {
      return html`<p class="preview-status">Loading folder preview...</p>`;
    }
    if (this.snapshot.errorMessage) {
      return html`<p class="preview-status preview-error">${this.snapshot.errorMessage}</p>`;
    }
    if (this.snapshot.items.length === 0) {
      return html`<p class="preview-status">No files found in this folder.</p>`;
    }
    return this.contentView === 'list'
      ? html`<div class="assets-list">
          ${this.snapshot.items.map(item => this.renderListRow(item))}
        </div>`
      : html`<div class="assets-preview-grid">
          ${this.snapshot.items.map(item => this.renderItem(item))}
        </div>`;
  }

  private renderHeader() {
    return html`
      <div class="assets-content-header">
        ${this.renderBreadcrumbs()} ${this.renderStats()}
        <span class="assets-header-spacer"></span>
        ${this.renderViewControls()}
      </div>
    `;
  }

  private renderBreadcrumbs() {
    const rootLabel = appState.project.projectName ?? 'Assets';
    const folderPath = this.snapshot.selectedFolderPath;
    const parts =
      folderPath && folderPath !== '.' ? folderPath.split('/').filter(part => part.length > 0) : [];
    const isRootActive = parts.length === 0;
    return html`
      <nav class="assets-breadcrumbs" aria-label="Folder path">
        <button
          type="button"
          class="crumb ${isRootActive ? 'is-active' : ''}"
          ?disabled=${isRootActive}
          @click=${() => this.onBreadcrumbClick('.')}
        >
          ${rootLabel}
        </button>
        ${parts.map((part, index) => {
          const path = parts.slice(0, index + 1).join('/');
          const isLast = index === parts.length - 1;
          return html`
            <span class="crumb-sep" aria-hidden="true"
              >${this.iconService.getIcon('chevron-right', IconSize.SMALL)}</span
            >
            <button
              type="button"
              class="crumb ${isLast ? 'is-active' : ''}"
              ?disabled=${isLast}
              @click=${() => this.onBreadcrumbClick(path)}
            >
              ${part}
            </button>
          `;
        })}
      </nav>
    `;
  }

  private renderStats() {
    const { folderItemCount, folderSizeBytes } = this.snapshot;
    if (folderItemCount === null) {
      return html`<span class="assets-folder-stats is-placeholder" aria-hidden="true"></span>`;
    }
    const itemLabel = `${folderItemCount} ${folderItemCount === 1 ? 'item' : 'items'}`;
    const sizeLabel = folderSizeBytes !== null ? ` · ${this.formatFileSize(folderSizeBytes)}` : '';
    return html`<span class="assets-folder-stats">${itemLabel}${sizeLabel}</span>`;
  }

  private renderViewControls() {
    return html`
      <div class="assets-view-controls">
        ${this.contentView === 'grid'
          ? html`<input
              class="assets-thumb-slider"
              type="range"
              min=${MIN_THUMBNAIL_SIZE}
              max=${MAX_THUMBNAIL_SIZE}
              step="8"
              aria-label="Thumbnail size"
              .value=${String(this.thumbnailSize)}
              @input=${this.onThumbnailSizeInput}
            />`
          : null}
        <button
          type="button"
          class="assets-view-btn ${this.contentView === 'grid' ? 'is-active' : ''}"
          aria-label="Grid view"
          aria-pressed=${this.contentView === 'grid'}
          @click=${() => this.setContentView('grid')}
        >
          ${this.iconService.getIcon('grid', IconSize.SMALL)}
        </button>
        <button
          type="button"
          class="assets-view-btn ${this.contentView === 'list' ? 'is-active' : ''}"
          aria-label="List view"
          aria-pressed=${this.contentView === 'list'}
          @click=${() => this.setContentView('list')}
        >
          ${this.iconService.getIcon('list', IconSize.SMALL)}
        </button>
      </div>
    `;
  }

  private onBreadcrumbClick(path: string): void {
    this.dispatchEvent(
      new CustomEvent('folder-navigate', { detail: { path }, bubbles: true, composed: true })
    );
  }

  private renderContextMenu() {
    // The menu element is ALWAYS present in the template (gated by `hidden`) so its
    // ChildPart stays stable. DropdownPortal physically moves this node to document.body
    // while open and restores it on close; if Lit ever rendered it as null the portal
    // would orphan the detached node at the bottom of the panel on close.
    const item = this.contextMenu?.item ?? null;
    const isImage = !!item && item.kind === 'file' && item.previewType === 'image';
    return html`
      <div
        class="assets-preview-context-menu"
        role="menu"
        ?hidden=${!this.contextMenu}
        @click=${(event: Event) => event.stopPropagation()}
      >
        ${item
          ? html`
              ${isImage
                ? html`
                    <button
                      type="button"
                      role="menuitem"
                      @click=${() => this.openInSpriteEditor(item)}
                    >
                      Open in Sprite Editor
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      @click=${() => this.addToSceneAsSprite(item)}
                    >
                      Add to Scene as Sprite2D
                    </button>
                    <div class="menu-separator" role="separator"></div>
                  `
                : null}
              <button type="button" role="menuitem" @click=${() => this.requestRename(item)}>
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                class="is-danger"
                @click=${() => this.requestDelete(item)}
              >
                Delete
              </button>
            `
          : null}
      </div>
    `;
  }

  private onItemContextMenu(event: MouseEvent, item: AssetPreviewItem): void {
    event.preventDefault();
    event.stopPropagation();
    // Right-clicking an item outside the current selection selects just it; right-clicking a
    // member of a multi-selection keeps the selection intact (so Delete acts on all of them).
    if (!this.selectedPaths.has(item.path)) {
      this.updateSelectionFromClick(event, item);
      this.assetsPreviewService.selectItem(item.path);
    }
    this.contextMenu = { item, x: event.clientX, y: event.clientY };
  }

  /** Emits a rename request the panel (Phase 4) routes to the DialogService rename flow. */
  private requestRename(item: AssetPreviewItem): void {
    this.closeContextMenu();
    this.dispatchEvent(
      new CustomEvent('content-rename-request', {
        detail: { path: item.path },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Emits a delete request for the multi-selection (or the clicked item alone). */
  private requestDelete(item: AssetPreviewItem): void {
    this.closeContextMenu();
    const paths = this.selectedPaths.has(item.path) ? Array.from(this.selectedPaths) : [item.path];
    this.dispatchEvent(
      new CustomEvent('content-delete-request', {
        detail: { paths },
        bubbles: true,
        composed: true,
      })
    );
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

  private renderListRow(item: AssetPreviewItem) {
    const isSelected = this.selectedPaths.has(item.path);
    const dimensions =
      item.width !== null && item.height !== null ? `${item.width}×${item.height}` : '';
    return html`
      <button
        class="assets-list-row ${isSelected ? 'is-selected' : ''}"
        title=${this.buildTooltip(item)}
        draggable=${item.kind === 'file' ? 'true' : 'false'}
        @click=${(event: MouseEvent) => this.onItemSelected(event, item)}
        @dblclick=${(event: MouseEvent) => {
          void this.onItemDoubleClick(event, item);
        }}
        @contextmenu=${(event: MouseEvent) => this.onItemContextMenu(event, item)}
        @dragstart=${(event: DragEvent) => this.onItemDragStart(event, item)}
      >
        <span class="row-thumb">
          ${item.thumbnailUrl
            ? html`<img src=${item.thumbnailUrl} alt=${item.name} loading="lazy" />`
            : html`<span class="icon"
                >${this.iconService.getIcon(item.iconName, IconSize.MEDIUM)}</span
              >`}
        </span>
        <span class="row-name">${item.name}</span>
        <span class="row-dim">${dimensions}</span>
        <span class="row-size"
          >${item.kind === 'file' && item.sizeBytes !== null
            ? this.formatFileSize(item.sizeBytes)
            : ''}</span
        >
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
    if (!hasGenerationDragData(event.dataTransfer) && !hasLibraryItemDragData(event.dataTransfer)) {
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
    // A Library card imports its files into the project (no scene node); a generation entry
    // saves into the current folder. Both refresh the preview via the write signal.
    if (hasLibraryItemDragData(event.dataTransfer)) {
      event.preventDefault();
      this.isGenerationDropActive = false;
      const drag = getLibraryItemDragData(event.dataTransfer);
      if (!drag) {
        return;
      }
      try {
        await this.libraryInsertService.copyBundleIntoProject(drag.itemId);
      } catch (error) {
        console.error('[AssetsContent] Failed to import library item:', error);
      }
      return;
    }
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
      this.dispatchEvent(
        new CustomEvent('folder-navigate', {
          detail: { path: item.path },
          bubbles: true,
          composed: true,
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
    'pix3-assets-content': AssetsContent;
  }
}
