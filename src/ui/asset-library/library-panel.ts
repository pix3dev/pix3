import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { nothing } from 'lit';
import { AssetLibraryService, LibraryInsertService } from '@/services';
import { DialogService } from '@/services/DialogService';
import { filterItems, type LibraryFilter } from '@/services/library/library-search';
import {
  LIBRARY_ITEM_TYPES,
  LIBRARY_SCOPES,
  LIBRARY_SCOPE_LABELS,
  type LibraryItem,
  type LibraryItemType,
  type LibraryScope,
} from '@/services/library/library-types';
import { setLibraryItemDragData } from '@/ui/shared/asset-drag-drop';

import '../shared/pix3-panel';
import '../shared/pix3-toolbar';
import './library-panel.ts.css';

interface ContextMenuState {
  readonly item: LibraryItem;
  readonly x: number;
  readonly y: number;
}

/**
 * The Asset Library panel: a card grid over the aggregated builtin/user/team items, with
 * scope/type filters and text search. Cards drag into the viewport/scene tree (via
 * {@link LibraryInsertService}) and expose insert/add-files/manage actions in a context menu.
 * Filter state is panel-local UI state; item data lives in {@link AssetLibraryService}.
 */
@customElement('pix3-library-panel')
export class LibraryPanel extends ComponentBase {
  @inject(AssetLibraryService) private readonly library!: AssetLibraryService;
  @inject(LibraryInsertService) private readonly insertService!: LibraryInsertService;
  @inject(DialogService) private readonly dialogService!: DialogService;

  @state() private items: LibraryItem[] = [];
  @state() private loading = true;
  @state() private query = '';
  @state() private activeScopes = new Set<LibraryScope>();
  @state() private activeTypes = new Set<LibraryItemType>();
  @state() private previews = new Map<string, string>();
  @state() private contextMenu: ContextMenuState | null = null;

  private disposeLibrarySubscription?: () => void;
  private readonly onDocumentPointerDown = () => this.closeContextMenu();

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeLibrarySubscription = this.library.subscribe(() => void this.reload());
    void this.reload();
    document.addEventListener('pointerdown', this.onDocumentPointerDown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.disposeLibrarySubscription?.();
    this.disposeLibrarySubscription = undefined;
    document.removeEventListener('pointerdown', this.onDocumentPointerDown);
  }

  private async reload(): Promise<void> {
    this.loading = true;
    try {
      this.items = await this.library.getItems(true);
      await this.loadPreviews();
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
          // Missing preview — the card falls back to a type placeholder.
        }
      })
    );
    this.previews = next;
  }

  private get filter(): LibraryFilter {
    return {
      query: this.query,
      scopes: this.activeScopes.size > 0 ? [...this.activeScopes] : undefined,
      types: this.activeTypes.size > 0 ? [...this.activeTypes] : undefined,
    };
  }

  private get visibleItems(): LibraryItem[] {
    return filterItems(this.items, this.filter);
  }

  private toggleScope(scope: LibraryScope): void {
    const next = new Set(this.activeScopes);
    if (next.has(scope)) {
      next.delete(scope);
    } else {
      next.add(scope);
    }
    this.activeScopes = next;
  }

  private toggleType(type: LibraryItemType): void {
    const next = new Set(this.activeTypes);
    if (next.has(type)) {
      next.delete(type);
    } else {
      next.add(type);
    }
    this.activeTypes = next;
  }

  private onSearchInput(event: Event): void {
    this.query = (event.target as HTMLInputElement).value;
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

  private async onInsert(item: LibraryItem): Promise<void> {
    this.closeContextMenu();
    try {
      await this.insertService.insert(item.manifest.id);
    } catch (error) {
      console.error('[LibraryPanel] Failed to insert item:', error);
    }
  }

  private async onAddFiles(item: LibraryItem): Promise<void> {
    this.closeContextMenu();
    try {
      await this.insertService.copyBundleIntoProject(item.manifest.id);
    } catch (error) {
      console.error('[LibraryPanel] Failed to copy item files:', error);
    }
  }

  private async onDelete(item: LibraryItem): Promise<void> {
    this.closeContextMenu();
    const confirmed = await this.dialogService.showConfirmation({
      title: 'Delete Library Item?',
      message: `Remove "${item.manifest.name}" from your library? This does not affect projects it was inserted into.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      isDangerous: true,
    });
    if (!confirmed) {
      return;
    }
    try {
      await this.library.deleteItem(item);
    } catch (error) {
      console.error('[LibraryPanel] Failed to delete item:', error);
    }
  }

  private onCopyId(item: LibraryItem): void {
    this.closeContextMenu();
    void navigator.clipboard?.writeText(item.manifest.id);
  }

  private async onRename(item: LibraryItem): Promise<void> {
    this.closeContextMenu();
    const name = window.prompt('Rename library item:', item.manifest.name)?.trim();
    if (!name || name === item.manifest.name) {
      return;
    }
    await this.updateManifest(item, manifest => ({ ...manifest, name }));
  }

  private async onEditTags(item: LibraryItem): Promise<void> {
    this.closeContextMenu();
    const raw = window.prompt('Tags (comma-separated):', item.manifest.tags.join(', '));
    if (raw === null) {
      return;
    }
    const tags = raw
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean);
    await this.updateManifest(item, manifest => ({ ...manifest, tags }));
  }

  private async updateManifest(
    item: LibraryItem,
    mutate: (manifest: LibraryItem['manifest']) => LibraryItem['manifest']
  ): Promise<void> {
    try {
      const bundle = await this.library.getItemBundle(item.manifest.id);
      if (!bundle) {
        return;
      }
      await this.library.putUserItem({ manifest: mutate(bundle.manifest), files: bundle.files });
    } catch (error) {
      console.error('[LibraryPanel] Failed to update item metadata:', error);
    }
  }

  private openContextMenu(event: MouseEvent, item: LibraryItem): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenu = { item, x: event.clientX, y: event.clientY };
  }

  private closeContextMenu(): void {
    if (this.contextMenu) {
      this.contextMenu = null;
    }
  }

  protected render() {
    return html`
      <pix3-panel
        panel-description="Reusable prefabs, images, fonts, audio and shaders. Drag a card into the scene."
        actions-label="Asset library actions"
      >
        <div class="library-filters" slot="toolbar">
          <input
            class="library-search"
            type="search"
            placeholder="Search library…"
            aria-label="Search library"
            .value=${this.query}
            @input=${(event: Event) => this.onSearchInput(event)}
          />
        </div>
        ${this.renderChips()} ${this.renderBody()} ${this.renderContextMenu()}
      </pix3-panel>
    `;
  }

  private renderChips() {
    return html`
      <div class="library-chip-row" role="group" aria-label="Filter by scope">
        ${LIBRARY_SCOPES.map(
          scope => html`
            <button
              type="button"
              class="library-chip ${this.activeScopes.has(scope) ? 'is-active' : ''}"
              @click=${() => this.toggleScope(scope)}
            >
              ${LIBRARY_SCOPE_LABELS[scope]}
            </button>
          `
        )}
      </div>
      <div class="library-chip-row" role="group" aria-label="Filter by type">
        ${LIBRARY_ITEM_TYPES.map(
          type => html`
            <button
              type="button"
              class="library-chip ${this.activeTypes.has(type) ? 'is-active' : ''}"
              @click=${() => this.toggleType(type)}
            >
              ${type}
            </button>
          `
        )}
      </div>
    `;
  }

  private renderBody() {
    if (this.loading) {
      return html`<div class="library-empty">Loading…</div>`;
    }
    const items = this.visibleItems;
    if (items.length === 0) {
      return html`<div class="library-empty">
        ${this.items.length === 0
          ? 'Your library is empty. Save assets from the generator or publish a prefab.'
          : 'No items match the current filters.'}
      </div>`;
    }
    return html`<div class="library-grid">${items.map(item => this.renderCard(item))}</div>`;
  }

  private renderCard(item: LibraryItem) {
    const preview = this.previews.get(item.manifest.id);
    return html`
      <button
        type="button"
        class="library-card"
        draggable="true"
        title=${item.manifest.description ?? item.manifest.name}
        @dragstart=${(event: DragEvent) => this.onCardDragStart(event, item)}
        @dblclick=${() => void this.onInsert(item)}
        @contextmenu=${(event: MouseEvent) => this.openContextMenu(event, item)}
      >
        <span class="library-card__thumb" data-type=${item.manifest.type}>
          ${preview
            ? html`<img src=${preview} alt="" loading="lazy" />`
            : html`<span class="library-card__placeholder">${item.manifest.type}</span>`}
        </span>
        <span class="library-card__name">${item.manifest.name}</span>
        <span class="library-card__meta">
          <span class="library-card__badge">${item.manifest.type}</span>
          <span class="library-card__scope">${LIBRARY_SCOPE_LABELS[item.scope]}</span>
        </span>
      </button>
    `;
  }

  private renderContextMenu() {
    const menu = this.contextMenu;
    if (!menu) {
      return nothing;
    }
    const isUser = menu.item.scope === 'user';
    return html`
      <div
        class="library-context-menu"
        style="left:${menu.x}px; top:${menu.y}px"
        @pointerdown=${(event: Event) => event.stopPropagation()}
      >
        <button type="button" @click=${() => void this.onInsert(menu.item)}>
          Insert into scene
        </button>
        <button type="button" @click=${() => void this.onAddFiles(menu.item)}>
          Add files to project
        </button>
        ${isUser
          ? html`
              <button type="button" @click=${() => void this.onRename(menu.item)}>Rename…</button>
              <button type="button" @click=${() => void this.onEditTags(menu.item)}>
                Edit tags…
              </button>
              <button type="button" @click=${() => this.onCopyId(menu.item)}>Copy id</button>
              <button
                type="button"
                class="is-dangerous"
                @click=${() => void this.onDelete(menu.item)}
              >
                Delete
              </button>
            `
          : html`<button type="button" @click=${() => this.onCopyId(menu.item)}>Copy id</button>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-library-panel': LibraryPanel;
  }
}
