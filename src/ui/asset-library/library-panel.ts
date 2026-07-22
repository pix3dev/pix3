import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { nothing } from 'lit';
import { AssetLibraryService } from '@/services/library/AssetLibraryService';
import { LibraryInsertService } from '@/services/library/LibraryInsertService';
import { LibrarySelectionService } from '@/services/library/LibrarySelectionService';
import { LibrarySyncService, type LibrarySyncState } from '@/services/library/LibrarySyncService';
import { PublishToLibraryService } from '@/services/library/PublishToLibraryService';
import { IconService, IconSize } from '@/services/editor/IconService';
import {
  LIBRARY_SOURCES,
  addCustomCategory,
  categoriesForSource,
  countItemsInCategory,
  itemsForSource,
  type LibrarySourceCategory,
  type LibrarySourceConfig,
} from '@/services/library/library-sources';
import {
  LIBRARY_ITEM_TYPES,
  type LibraryItem,
  type LibraryItemType,
} from '@/services/library/library-types';
import {
  getDroppedAssetResourcePath,
  getLibraryItemDragData,
  hasAssetDragData,
  hasLibraryItemDragData,
  setLibraryItemDragData,
} from '@/ui/shared/asset-drag-drop';
import {
  assetFileCount,
  formatItemType,
  iconForItemType,
  isFreePrice,
  isStoreLike,
  priceLabel,
  publisherLabel,
  thumbHue,
} from './library-view-model';

import './library-panel.ts.css';

/** MIME emitted by the Scene Tree when dragging a node (payload = node id). */
const SCENE_TREE_NODE_MIME = 'application/x-scene-tree-node';

/** Type filter chips: the aggregate plus every item type, in display order. */
const TYPE_FILTERS: ReadonlyArray<'all' | LibraryItemType> = ['all', ...LIBRARY_ITEM_TYPES];

const THUMB_MIN = 72;
const THUMB_MAX = 150;
const THUMB_DEFAULT = 104;

interface DropTarget {
  readonly kind: 'zone' | 'grid' | 'category';
  readonly categoryId?: string;
}

/**
 * The Asset Library document: a source rail (My Library / Team / Pix3 Store / providers, from
 * config) + a content pane (breadcrumb toolbar, search + type chips, grid/list of items). Selecting
 * an item routes its details to the Inspector via {@link LibrarySelectionService}. Editable sources
 * accept drops (scene-tree nodes, asset files) into the personal library, and cards drag out into
 * the viewport/scene. Real data comes from {@link AssetLibraryService} (user + builtin); Team and
 * providers are declared in config and list no items until the server lands.
 */
@customElement('pix3-library-panel')
export class LibraryPanel extends ComponentBase {
  @inject(AssetLibraryService) private readonly library!: AssetLibraryService;
  @inject(LibraryInsertService) private readonly insertService!: LibraryInsertService;
  @inject(PublishToLibraryService) private readonly publishService!: PublishToLibraryService;
  @inject(LibrarySelectionService) private readonly selectionService!: LibrarySelectionService;
  @inject(LibrarySyncService) private readonly syncService!: LibrarySyncService;
  @inject(IconService) private readonly iconService!: IconService;

  @state() private items: LibraryItem[] = [];
  @state() private previews = new Map<string, string>();
  @state() private loading = true;
  @state() private sourceId = 'user';
  @state() private categoryId = 'all';
  @state() private typeFilter: 'all' | LibraryItemType = 'all';
  @state() private query = '';
  @state() private view: 'grid' | 'list' = 'grid';
  @state() private thumb = THUMB_DEFAULT;
  @state() private selectedItemId: string | null = null;
  @state() private dropTarget: DropTarget | null = null;
  /** Bumped after creating a custom category so the rail re-derives. */
  @state() private categoryRevision = 0;
  @state() private syncState: LibrarySyncState = this.syncService.getState();

  private disposeLibrarySubscription?: () => void;
  private disposeSelectionSubscription?: () => void;
  private disposeSyncSubscription?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.restoreViewPrefs();
    this.disposeLibrarySubscription = this.library.subscribe(() => void this.reload());
    // Mirror the shared selection so the card highlight tracks it (e.g. the Inspector clears the
    // library selection when a scene node is picked — the highlight should clear with it).
    this.disposeSelectionSubscription = this.selectionService.subscribe(() => {
      const id = this.selectionService.getSelection()?.item.manifest.id ?? null;
      if (id !== this.selectedItemId) {
        this.selectedItemId = id;
      }
    });
    this.disposeSyncSubscription = this.syncService.subscribe(state => {
      this.syncState = state;
    });
    void this.reload();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.disposeLibrarySubscription?.();
    this.disposeLibrarySubscription = undefined;
    this.disposeSelectionSubscription?.();
    this.disposeSelectionSubscription = undefined;
    this.disposeSyncSubscription?.();
    this.disposeSyncSubscription = undefined;
    // Closing the panel returns the Inspector to node properties.
    this.selectionService.clear();
  }

  // ── Data ───────────────────────────────────────────────────────────────────
  private async reload(): Promise<void> {
    this.loading = true;
    try {
      this.items = await this.library.getItems(true);
      await this.loadPreviews();
      this.reconcileSelection();
    } catch (error) {
      console.error('[LibraryPanel] Failed to load library items:', error);
      this.items = [];
    } finally {
      this.loading = false;
    }
  }

  private async loadPreviews(): Promise<void> {
    const next = new Map(this.previews);
    await Promise.all(
      this.items.map(async item => {
        if (next.has(item.manifest.id)) {
          return;
        }
        try {
          const url = await this.library.getPreviewUrl(item);
          if (url) {
            next.set(item.manifest.id, url);
          }
        } catch {
          // Missing preview — the card falls back to the type placeholder.
        }
      })
    );
    this.previews = next;
  }

  private reconcileSelection(): void {
    if (!this.selectedItemId) {
      return;
    }
    const item = this.items.find(i => i.manifest.id === this.selectedItemId);
    if (!item) {
      this.selectedItemId = null;
      this.selectionService.clear();
      return;
    }
    // Re-assert into the shared selection when it drifted (e.g. the panel was re-docked and
    // remounted, which clears the service on the way out).
    if (this.selectionService.getSelection()?.item.manifest.id !== this.selectedItemId) {
      this.selectionService.setSelection({ item, source: this.source });
    }
  }

  // ── Derived views ───────────────────────────────────────────────────────────
  private get source(): LibrarySourceConfig {
    return LIBRARY_SOURCES.find(s => s.id === this.sourceId) ?? LIBRARY_SOURCES[0];
  }

  private get sourceItems(): LibraryItem[] {
    return itemsForSource(this.source, this.items);
  }

  private get categories(): LibrarySourceCategory[] {
    void this.categoryRevision;
    return categoriesForSource(this.source, this.sourceItems);
  }

  private get visibleItems(): LibraryItem[] {
    const query = this.query.trim().toLowerCase();
    return this.sourceItems.filter(item => {
      const inCategory = this.categoryId === 'all' || item.manifest.category === this.categoryId;
      const inType = this.typeFilter === 'all' || item.manifest.type === this.typeFilter;
      const inQuery = !query || item.manifest.name.toLowerCase().includes(query);
      return inCategory && inType && inQuery;
    });
  }

  // ── Interactions ──────────────────────────────────────────────────────────
  private switchSource(id: string): void {
    if (this.sourceId === id) {
      return;
    }
    this.sourceId = id;
    this.categoryId = 'all';
    this.typeFilter = 'all';
    this.query = '';
    this.selectedItemId = null;
    this.selectionService.clear();
  }

  private select(item: LibraryItem): void {
    this.selectedItemId = item.manifest.id;
    this.selectionService.setSelection({ item, source: this.source });
  }

  private async activatePrimary(item: LibraryItem): Promise<void> {
    try {
      if (isStoreLike(this.source)) {
        await this.insertService.copyBundleIntoProject(item.manifest.id);
      } else {
        await this.insertService.insert(item.manifest.id);
      }
    } catch (error) {
      console.error('[LibraryPanel] Failed to activate item:', error);
    }
  }

  private async onNewCategory(): Promise<void> {
    const label = window.prompt('New category name:')?.trim();
    if (!label) {
      return;
    }
    const category = addCustomCategory(this.sourceId, label);
    this.categoryRevision += 1;
    this.categoryId = category.id;
  }

  private onCardDragStart(event: DragEvent, item: LibraryItem): void {
    if (!event.dataTransfer) {
      return;
    }
    setLibraryItemDragData(event.dataTransfer, {
      itemId: item.manifest.id,
      name: item.manifest.name,
    });
  }

  private setThumb(value: number): void {
    this.thumb = value;
    this.saveViewPrefs();
  }

  private setView(view: 'grid' | 'list'): void {
    this.view = view;
    this.saveViewPrefs();
  }

  private restoreViewPrefs(): void {
    try {
      const view = localStorage.getItem('pix3.library.view');
      if (view === 'grid' || view === 'list') {
        this.view = view;
      }
      const thumb = Number(localStorage.getItem('pix3.library.thumb'));
      if (Number.isFinite(thumb) && thumb >= THUMB_MIN && thumb <= THUMB_MAX) {
        this.thumb = thumb;
      }
    } catch {
      // Ignore unavailable storage.
    }
  }

  private saveViewPrefs(): void {
    try {
      localStorage.setItem('pix3.library.view', this.view);
      localStorage.setItem('pix3.library.thumb', String(this.thumb));
    } catch {
      // Ignore unavailable storage.
    }
  }

  // ── Drag & drop into the library ────────────────────────────────────────────
  private dropAllowed(dataTransfer: DataTransfer | null): boolean {
    if (!this.source.editable || !dataTransfer) {
      return false;
    }
    const types = dataTransfer.types ? Array.from(dataTransfer.types) : [];
    return (
      types.includes(SCENE_TREE_NODE_MIME) ||
      hasAssetDragData(dataTransfer) ||
      hasLibraryItemDragData(dataTransfer)
    );
  }

  private onDropTargetDragOver(event: DragEvent, target: DropTarget): void {
    if (!this.dropAllowed(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    if (
      this.dropTarget?.kind !== target.kind ||
      this.dropTarget?.categoryId !== target.categoryId
    ) {
      this.dropTarget = target;
    }
  }

  private onDropTargetDragLeave(): void {
    this.dropTarget = null;
  }

  private onDropTargetDrop(event: DragEvent, target: DropTarget): void {
    const dataTransfer = event.dataTransfer;
    if (!this.dropAllowed(dataTransfer) || !dataTransfer) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.dropTarget = null;
    void this.handleDropInto(target, dataTransfer);
  }

  private async handleDropInto(target: DropTarget, dataTransfer: DataTransfer): Promise<void> {
    // Resolve the destination category: a category row targets itself; the grid uses the
    // currently-browsed category; the rail drop zone files under no category ("All").
    const categoryId =
      target.kind === 'category'
        ? target.categoryId
        : target.kind === 'grid' && this.categoryId !== 'all'
          ? this.categoryId
          : undefined;

    // Reordering an existing library card between categories.
    const libraryDrag = getLibraryItemDragData(dataTransfer);
    if (libraryDrag) {
      await this.reassignCategory(libraryDrag.itemId, categoryId);
      return;
    }

    // A subtree dragged from the Scene Tree → pack into a personal-library prefab.
    const nodeId = dataTransfer.getData(SCENE_TREE_NODE_MIME);
    if (nodeId) {
      try {
        await this.publishService.publishNode({ nodeId, category: categoryId });
        this.afterPublish(categoryId);
      } catch (error) {
        console.error('[LibraryPanel] Failed to publish node to library:', error);
      }
      return;
    }

    // Files dragged from the Asset Browser → one-file library items.
    const assetPath = getDroppedAssetResourcePath(dataTransfer);
    if (assetPath) {
      try {
        await this.publishService.publishAssetPath(assetPath, { category: categoryId });
        this.afterPublish(categoryId);
      } catch (error) {
        console.error('[LibraryPanel] Failed to publish asset to library:', error);
      }
    }
  }

  private async reassignCategory(itemId: string, categoryId: string | undefined): Promise<void> {
    const item = this.items.find(i => i.manifest.id === itemId);
    // Only the personal (user) library is writable today.
    if (!item || item.scope !== 'user') {
      return;
    }
    try {
      const bundle = await this.library.getItemBundle(itemId);
      if (!bundle) {
        return;
      }
      const category = categoryId && categoryId !== 'all' ? categoryId : undefined;
      await this.library.putUserItem({
        manifest: { ...bundle.manifest, category },
        files: bundle.files,
      });
    } catch (error) {
      console.error('[LibraryPanel] Failed to reassign category:', error);
    }
  }

  /** Publishing always lands in the personal library — surface it there. */
  private afterPublish(categoryId: string | undefined): void {
    if (this.sourceId !== 'user') {
      this.switchSource('user');
    }
    if (categoryId) {
      this.categoryId = categoryId;
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  protected render() {
    return html` <div class="lib-doc">${this.renderRail()} ${this.renderContent()}</div> `;
  }

  private icon(name: string, size: number = IconSize.SMALL) {
    return this.iconService.getIcon(name, size);
  }

  private renderRail() {
    const source = this.source;
    return html`
      <div class="lib-rail">
        <div class="lib-rail__head">SOURCE</div>
        <div class="lib-rail__group">${LIBRARY_SOURCES.map(s => this.renderSourceRow(s))}</div>
        <div class="lib-rail__divider"></div>
        <div class="lib-rail__head">CATEGORIES</div>
        <div class="lib-rail__categories">
          ${this.categories.map(cat => this.renderCategoryRow(cat))}
          ${source.editable
            ? html`<button
                type="button"
                class="lib-cat lib-cat--new"
                @click=${() => void this.onNewCategory()}
              >
                ${this.icon('plus')}<span>New category</span>
              </button>`
            : nothing}
        </div>
        ${this.renderRailFooter(source)}
      </div>
    `;
  }

  private renderSourceRow(s: LibrarySourceConfig) {
    const active = s.id === this.sourceId;
    const count = itemsForSource(s, this.items).length;
    return html`
      <button
        type="button"
        class="lib-source ${active ? 'is-active' : ''}"
        @click=${() => this.switchSource(s.id)}
      >
        <span class="lib-source__icon">${this.icon(s.icon)}</span>
        <span class="lib-source__name">${s.name}</span>
        <span class="lib-source__count">${count}</span>
      </button>
    `;
  }

  private renderCategoryRow(cat: LibrarySourceCategory) {
    const active = cat.id === this.categoryId;
    const isDropTarget =
      this.dropTarget?.kind === 'category' && this.dropTarget.categoryId === cat.id;
    const count = countItemsInCategory(cat.id, this.sourceItems);
    return html`
      <button
        type="button"
        class="lib-cat ${active ? 'is-active' : ''} ${isDropTarget ? 'is-drop-target' : ''}"
        @click=${() => (this.categoryId = cat.id)}
        @dragover=${(e: DragEvent) =>
          this.onDropTargetDragOver(e, { kind: 'category', categoryId: cat.id })}
        @dragleave=${() => this.onDropTargetDragLeave()}
        @drop=${(e: DragEvent) =>
          this.onDropTargetDrop(e, { kind: 'category', categoryId: cat.id })}
      >
        <span class="lib-cat__icon">${this.icon('folder')}</span>
        <span class="lib-cat__label">${cat.label}</span>
        <span class="lib-cat__count">${count}</span>
      </button>
    `;
  }

  private renderRailFooter(source: LibrarySourceConfig) {
    if (source.editable) {
      const isDropTarget = this.dropTarget?.kind === 'zone';
      return html`
        ${source.id === 'user' ? this.renderSyncStatus() : nothing}
        <div
          class="lib-dropzone ${isDropTarget ? 'is-drop-target' : ''}"
          @dragover=${(e: DragEvent) => this.onDropTargetDragOver(e, { kind: 'zone' })}
          @dragleave=${() => this.onDropTargetDragLeave()}
          @drop=${(e: DragEvent) => this.onDropTargetDrop(e, { kind: 'zone' })}
        >
          <span class="lib-dropzone__icon">${this.icon('download', IconSize.MEDIUM)}</span>
          <span class="lib-dropzone__text">
            Drop nodes, prefabs or files here to save to <b>${source.name}</b>
          </span>
        </div>
      `;
    }
    return html`
      <div class="lib-readonly">
        <span class="lib-readonly__icon">${this.icon('lock')}</span>
        <span>Read-only source · ${source.hint}</span>
      </div>
    `;
  }

  /** Cloud-sync status + manual "Sync now" for the personal library. */
  private renderSyncStatus() {
    const { status } = this.syncState;
    const label =
      status === 'disabled'
        ? 'Sign in to sync'
        : status === 'syncing'
          ? 'Syncing…'
          : status === 'error'
            ? 'Sync failed'
            : this.syncState.lastSyncedAt
              ? `Synced ${this.formatSyncedAt(this.syncState.lastSyncedAt)}`
              : 'Synced to cloud';
    const iconName =
      status === 'disabled'
        ? 'cloud-off'
        : status === 'syncing'
          ? 'refresh-cw'
          : status === 'error'
            ? 'alert-triangle'
            : 'cloud';
    return html`
      <div class="lib-sync lib-sync--${status}" title=${this.syncState.error ?? label}>
        <span class="lib-sync__icon ${status === 'syncing' ? 'is-spinning' : ''}"
          >${this.icon(iconName)}</span
        >
        <span class="lib-sync__label">${label}</span>
        ${status === 'disabled'
          ? nothing
          : html`<button
              type="button"
              class="lib-sync__now"
              title="Sync now"
              aria-label="Sync now"
              ?disabled=${status === 'syncing'}
              @click=${() => void this.syncService.syncNow()}
            >
              ${this.icon('refresh-cw')}
            </button>`}
      </div>
    `;
  }

  private formatSyncedAt(timestamp: number): string {
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 45) {
      return 'just now';
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
      return `${hours}h ago`;
    }
    return `${Math.round(hours / 24)}d ago`;
  }

  private renderContent() {
    const source = this.source;
    const items = this.visibleItems;
    const categoryLabel = (
      this.categories.find(c => c.id === this.categoryId) ?? this.categories[0]
    ).label;
    return html`
      <div class="lib-content">
        <div class="lib-toolbar">
          <div class="lib-crumb">
            <span class="lib-crumb__source">${source.name}</span>
            <span class="lib-crumb__sep">›</span>
            <span class="lib-crumb__current">${categoryLabel}</span>
          </div>
          <span class="lib-toolbar__spacer"></span>
          <span class="lib-count">${items.length} items</span>
          <input
            class="lib-thumb-slider"
            type="range"
            min=${THUMB_MIN}
            max=${THUMB_MAX}
            .value=${String(this.thumb)}
            title="Thumbnail size"
            aria-label="Thumbnail size"
            @input=${(e: Event) => this.setThumb(Number((e.target as HTMLInputElement).value))}
          />
          <button
            type="button"
            class="lib-iconbtn ${this.view === 'grid' ? 'is-active' : ''}"
            title="Grid view"
            aria-label="Grid view"
            @click=${() => this.setView('grid')}
          >
            ${this.icon('grid')}
          </button>
          <button
            type="button"
            class="lib-iconbtn ${this.view === 'list' ? 'is-active' : ''}"
            title="List view"
            aria-label="List view"
            @click=${() => this.setView('list')}
          >
            ${this.icon('list')}
          </button>
        </div>

        <div class="lib-filters">
          <div class="lib-search">
            <span class="lib-search__icon">${this.icon('search')}</span>
            <input
              type="search"
              placeholder=${`Search ${source.name}…`}
              aria-label=${`Search ${source.name}`}
              .value=${this.query}
              @input=${(e: Event) => (this.query = (e.target as HTMLInputElement).value)}
            />
            ${this.query
              ? html`<button
                  type="button"
                  class="lib-search__clear"
                  aria-label="Clear search"
                  @click=${() => (this.query = '')}
                >
                  ${this.icon('x')}
                </button>`
              : nothing}
          </div>
          <div class="lib-chips" role="group" aria-label="Filter by type">
            ${TYPE_FILTERS.map(type => {
              const active = this.typeFilter === type;
              const label = type === 'all' ? 'All' : formatItemType(type);
              return html`<button
                type="button"
                class="lib-chip ${active ? 'is-active' : ''}"
                @click=${() => (this.typeFilter = type)}
              >
                ${label}
              </button>`;
            })}
          </div>
        </div>

        ${this.loading
          ? html`<div class="lib-empty">Loading…</div>`
          : this.view === 'grid'
            ? this.renderGrid(items)
            : this.renderList(items)}
      </div>
    `;
  }

  private renderGrid(items: LibraryItem[]) {
    const isGridDropTarget = this.dropTarget?.kind === 'grid';
    return html`
      <div
        class="lib-results lib-results--grid ${isGridDropTarget ? 'is-drop-target' : ''}"
        style=${`--lib-thumb:${this.thumb}px`}
        @dragover=${(e: DragEvent) => this.onDropTargetDragOver(e, { kind: 'grid' })}
        @dragleave=${() => this.onDropTargetDragLeave()}
        @drop=${(e: DragEvent) => this.onDropTargetDrop(e, { kind: 'grid' })}
      >
        ${items.length === 0
          ? html`<div class="lib-empty">Nothing matches — clear the search or filters.</div>`
          : html`<div class="lib-grid">${items.map(item => this.renderGridCard(item))}</div>`}
      </div>
    `;
  }

  private renderGridCard(item: LibraryItem) {
    const selected = item.manifest.id === this.selectedItemId;
    const meta = this.cardMeta(item);
    return html`
      <div
        class="lib-card ${selected ? 'is-selected' : ''}"
        draggable="true"
        title=${item.manifest.description ?? item.manifest.name}
        @click=${() => this.select(item)}
        @dblclick=${() => void this.activatePrimary(item)}
        @dragstart=${(e: DragEvent) => this.onCardDragStart(e, item)}
      >
        ${this.renderThumb(item, `height:${Math.round(this.thumb * 0.7)}px`)}
        <div class="lib-card__meta">
          <div class="lib-card__name">${item.manifest.name}</div>
          <div class="lib-card__sub">${meta}</div>
        </div>
      </div>
    `;
  }

  private renderList(items: LibraryItem[]) {
    const isGridDropTarget = this.dropTarget?.kind === 'grid';
    return html`
      <div
        class="lib-results lib-results--list ${isGridDropTarget ? 'is-drop-target' : ''}"
        @dragover=${(e: DragEvent) => this.onDropTargetDragOver(e, { kind: 'grid' })}
        @dragleave=${() => this.onDropTargetDragLeave()}
        @drop=${(e: DragEvent) => this.onDropTargetDrop(e, { kind: 'grid' })}
      >
        ${items.length === 0
          ? html`<div class="lib-empty">Nothing matches — clear the search or filters.</div>`
          : items.map(item => this.renderListRow(item))}
      </div>
    `;
  }

  private renderListRow(item: LibraryItem) {
    const selected = item.manifest.id === this.selectedItemId;
    const store = isStoreLike(this.source);
    const price = store ? priceLabel(item, this.source) : '';
    return html`
      <div
        class="lib-row ${selected ? 'is-selected' : ''}"
        draggable="true"
        @click=${() => this.select(item)}
        @dblclick=${() => void this.activatePrimary(item)}
        @dragstart=${(e: DragEvent) => this.onCardDragStart(e, item)}
      >
        <span class="lib-row__icon">${this.icon(iconForItemType(item.manifest.type))}</span>
        <span class="lib-row__name">${item.manifest.name}</span>
        <span class="lib-row__type">${formatItemType(item.manifest.type)}</span>
        <span class="lib-row__spacer"></span>
        ${store
          ? html`<span class="lib-row__pub">${publisherLabel(item, this.source)}</span>
              <span class="lib-row__price ${isFreePrice(price) ? 'is-free' : ''}">${price}</span>`
          : html`<span class="lib-row__files">${assetFileCount(item)} files</span>`}
      </div>
    `;
  }

  private renderThumb(item: LibraryItem, sizeStyle: string) {
    const preview = this.previews.get(item.manifest.id);
    const store = isStoreLike(this.source);
    const price = store ? priceLabel(item, this.source) : '';
    return html`
      <div class="lib-thumb" style=${`--lib-thumb-hue:${thumbHue(item.manifest.id)};${sizeStyle}`}>
        ${preview
          ? html`<img src=${preview} alt="" loading="lazy" />`
          : html`<span class="lib-thumb__icon"
              >${this.icon(iconForItemType(item.manifest.type), IconSize.XLARGE)}</span
            >`}
        ${store
          ? html`<span class="lib-thumb__price ${isFreePrice(price) ? 'is-free' : ''}"
              >${price}</span
            >`
          : nothing}
      </div>
    `;
  }

  private cardMeta(item: LibraryItem): string {
    if (isStoreLike(this.source)) {
      return `${publisherLabel(item, this.source)} · ${priceLabel(item, this.source)}`;
    }
    return `${formatItemType(item.manifest.type)} · ${assetFileCount(item)} files`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-library-panel': LibraryPanel;
  }
}
