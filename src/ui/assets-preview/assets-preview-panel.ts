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
  toProjectResourcePath,
} from '@/ui/shared/asset-drag-drop';
import { EditorTabService } from '@/services/EditorTabService';
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

  private disposePreviewSubscription?: () => void;
  private selectedPaths = new Set<string>();
  private lastSelectedPath: string | null = null;
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
        <div class="preview-root">
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
        <button type="button" role="menuitem" @click=${() => this.openInAssetGenerator(item)}>
          Open in Asset Generator
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

  private openInAssetGenerator(item: AssetPreviewItem): void {
    this.closeContextMenu();
    void this.editorTabService.focusOrOpenAssetGenerator(toProjectResourcePath(item.path));
  }

  private renderItem(item: AssetPreviewItem) {
    const isSelected = this.selectedPaths.has(item.path);
    return html`
      <button
        class="assets-preview-item ${isSelected ? 'is-selected' : ''}"
        title=${this.buildTooltip(item)}
        draggable=${item.kind === 'file' ? 'true' : 'false'}
        @click=${(event: MouseEvent) => this.onItemSelected(event, item)}
        @dblclick=${() => {
          void this.onItemDoubleClick(item);
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
                  ${item.previewType === 'model' && item.thumbnailStatus === 'loading'
                    ? html`<span class="thumb-spinner" aria-hidden="true"></span>`
                    : null}
                `}
        </span>
        <span class="name">${item.name}</span>
        ${item.kind === 'file' && item.sizeBytes !== null
          ? html`<span class="meta">${this.formatFileSize(item.sizeBytes)}</span>`
          : null}
      </button>
    `;
  }

  private onItemSelected(event: MouseEvent, item: AssetPreviewItem): void {
    this.updateSelectionFromClick(event, item);
    this.assetsPreviewService.selectItem(item.path);
    if (item.previewType === 'model') {
      this.assetsPreviewService.requestThumbnail(item.path);
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

  private async onItemDoubleClick(item: AssetPreviewItem): Promise<void> {
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

    const activation: AssetActivation = {
      name: item.name,
      path: item.path,
      kind: item.kind,
      resourcePath: toProjectResourcePath(item.path),
      extension: item.extension,
    };

    await this.assetFileActivationService.handleActivation(activation);
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
