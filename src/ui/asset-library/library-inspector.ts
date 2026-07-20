import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { nothing } from 'lit';
import {
  AssetLibraryService,
  LibraryInsertService,
  LibrarySelectionService,
  IconService,
  IconSize,
  type LibrarySelection,
} from '@/services';
import { DialogService } from '@/services/DialogService';
import { categoriesForSource, itemsForSource } from '@/services/library/library-sources';
import {
  assetFileCount,
  formatAddedDate,
  formatItemType,
  iconForItemType,
  isFreePrice,
  isStoreLike,
  priceLabel,
  publisherLabel,
  thumbHue,
} from './library-view-model';

import './library-inspector.ts.css';

/**
 * The Inspector detail view for a selected library item. Rendered by the Inspector panel while the
 * Library document is focused. Editable (personal) items expose category / tag editing and removal;
 * store/provider items expose install/buy actions and read-only metadata. All mutations route
 * through {@link AssetLibraryService}; after a write it re-selects the fresh item so the view (and
 * the Library document counters) stay consistent.
 */
@customElement('pix3-library-inspector')
export class LibraryInspector extends ComponentBase {
  @inject(AssetLibraryService) private readonly library!: AssetLibraryService;
  @inject(LibraryInsertService) private readonly insertService!: LibraryInsertService;
  @inject(LibrarySelectionService) private readonly selectionService!: LibrarySelectionService;
  @inject(DialogService) private readonly dialogService!: DialogService;
  @inject(IconService) private readonly iconService!: IconService;

  @property({ attribute: false }) selection: LibrarySelection | null = null;

  @state() private previewUrl: string | null = null;
  @state() private categoryMenuOpen = false;

  private previewKey: string | null = null;
  private readonly onDocumentPointerDown = (event: PointerEvent) => {
    if (this.categoryMenuOpen && !event.composedPath().includes(this)) {
      this.categoryMenuOpen = false;
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('pointerdown', this.onDocumentPointerDown);
    void this.refreshPreview();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('pointerdown', this.onDocumentPointerDown);
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has('selection')) {
      this.categoryMenuOpen = false;
      void this.refreshPreview();
    }
  }

  private async refreshPreview(): Promise<void> {
    const item = this.selection?.item;
    if (!item) {
      this.previewUrl = null;
      this.previewKey = null;
      return;
    }
    if (this.previewKey === item.manifest.id) {
      return;
    }
    this.previewKey = item.manifest.id;
    try {
      this.previewUrl = await this.library.getPreviewUrl(item);
    } catch {
      this.previewUrl = null;
    }
  }

  private get isEditable(): boolean {
    // Only the personal (user) library is writable today.
    return this.selection?.item.scope === 'user';
  }

  private icon(name: string, size: number = IconSize.SMALL) {
    return this.iconService.getIcon(name, size);
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  private async addToScene(): Promise<void> {
    const id = this.selection?.item.manifest.id;
    if (!id) return;
    try {
      await this.insertService.insert(id);
    } catch (error) {
      console.error('[LibraryInspector] Failed to add to scene:', error);
    }
  }

  private async importFiles(): Promise<void> {
    const id = this.selection?.item.manifest.id;
    if (!id) return;
    try {
      await this.insertService.copyBundleIntoProject(id);
    } catch (error) {
      console.error('[LibraryInspector] Failed to import files:', error);
    }
  }

  private async openAsScene(): Promise<void> {
    const id = this.selection?.item.manifest.id;
    if (!id) return;
    try {
      await this.insertService.addAsScene(id);
    } catch (error) {
      console.error('[LibraryInspector] Failed to open as scene:', error);
    }
  }

  private async setCategory(categoryId: string | undefined): Promise<void> {
    this.categoryMenuOpen = false;
    const item = this.selection?.item;
    if (!item || item.scope !== 'user') {
      return;
    }
    const category = categoryId && categoryId !== 'all' ? categoryId : undefined;
    if (category === item.manifest.category) {
      return;
    }
    await this.mutateManifest(manifest => ({ ...manifest, category }));
  }

  private async addTag(): Promise<void> {
    const item = this.selection?.item;
    if (!item) return;
    const raw = window.prompt('Add tag:')?.trim();
    if (!raw) return;
    if (item.manifest.tags.includes(raw)) return;
    await this.mutateManifest(manifest => ({ ...manifest, tags: [...manifest.tags, raw] }));
  }

  private async removeTag(tag: string): Promise<void> {
    await this.mutateManifest(manifest => ({
      ...manifest,
      tags: manifest.tags.filter(t => t !== tag),
    }));
  }

  private async mutateManifest(
    mutate: (manifest: LibrarySelection['item']['manifest']) => LibrarySelection['item']['manifest']
  ): Promise<void> {
    const selection = this.selection;
    if (!selection || selection.item.scope !== 'user') {
      return;
    }
    try {
      const bundle = await this.library.getItemBundle(selection.item.manifest.id);
      if (!bundle) return;
      await this.library.putUserItem({ manifest: mutate(bundle.manifest), files: bundle.files });
      // Re-select the fresh item so this view and the document re-read the manifest.
      const fresh = await this.library.getItem(selection.item.manifest.id);
      if (fresh) {
        this.selectionService.setSelection({ item: fresh, source: selection.source });
      }
    } catch (error) {
      console.error('[LibraryInspector] Failed to update item:', error);
    }
  }

  private async removeFromLibrary(): Promise<void> {
    const selection = this.selection;
    if (!selection || selection.item.scope !== 'user') {
      return;
    }
    const confirmed = await this.dialogService.showConfirmation({
      title: 'Remove from library?',
      message: `Remove "${selection.item.manifest.name}" from your library? Projects it was inserted into are unaffected.`,
      confirmLabel: 'Remove',
      cancelLabel: 'Cancel',
      isDangerous: true,
    });
    if (!confirmed) return;
    try {
      await this.library.deleteItem(selection.item);
      this.selectionService.clear();
    } catch (error) {
      console.error('[LibraryInspector] Failed to remove item:', error);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  protected render() {
    const selection = this.selection;
    if (!selection) {
      return html`<div class="lib-insp lib-insp--empty">
        Select a library item to see its details.
      </div>`;
    }

    const { item, source } = selection;
    const store = isStoreLike(source);
    const typeLabel = formatItemType(item.manifest.type);
    const subtitle = store ? publisherLabel(item, source) : 'Library item';

    return html`
      <div class="lib-insp">
        <div class="lib-insp__header">
          <span class="lib-insp__plaque"
            >${this.icon(iconForItemType(item.manifest.type), IconSize.LARGE)}</span
          >
          <div class="lib-insp__title">
            <div class="lib-insp__name">${item.manifest.name}</div>
            <div class="lib-insp__subtitle">${typeLabel} · ${subtitle}</div>
          </div>
        </div>

        ${this.renderPreview(item)} ${this.renderActions(item, store)}
        ${item.manifest.description
          ? html`<p class="lib-insp__desc">${item.manifest.description}</p>`
          : nothing}
        ${this.renderDetails(item, source, store)} ${this.renderTags(item)}
        ${this.isEditable
          ? html`<div class="lib-insp__section">
              <button
                type="button"
                class="lib-insp__danger"
                @click=${() => void this.removeFromLibrary()}
              >
                ${this.icon('trash-2')}<span>Remove from library</span>
              </button>
            </div>`
          : nothing}
      </div>
    `;
  }

  private renderPreview(item: LibrarySelection['item']) {
    const store = this.selection ? isStoreLike(this.selection.source) : false;
    const price = this.selection && store ? priceLabel(item, this.selection.source) : '';
    return html`
      <div class="lib-insp__preview" style=${`--lib-thumb-hue:${thumbHue(item.manifest.id)}`}>
        ${this.previewUrl
          ? html`<img src=${this.previewUrl} alt="" loading="lazy" />`
          : html`<span class="lib-insp__preview-icon"
              >${this.icon(iconForItemType(item.manifest.type), IconSize.XLARGE)}</span
            >`}
        ${store
          ? html`<span class="lib-insp__price ${isFreePrice(price) ? 'is-free' : ''}"
              >${price}</span
            >`
          : nothing}
      </div>
    `;
  }

  private renderActions(item: LibrarySelection['item'], store: boolean) {
    if (store) {
      const price = this.selection ? priceLabel(item, this.selection.source) : 'Free';
      const free = isFreePrice(price);
      return html`
        <div class="lib-insp__actions">
          <button
            type="button"
            class="lib-insp__btn lib-insp__btn--primary"
            @click=${() => void this.importFiles()}
          >
            ${this.icon('download')}<span>${free ? 'Install' : `Buy ${price}`}</span>
          </button>
          <button
            type="button"
            class="lib-insp__btn lib-insp__btn--ghost"
            title="Open store page"
            aria-label="Open store page"
          >
            ${this.icon('external-link')}
          </button>
        </div>
      `;
    }
    // A scene *template* (shop, level map, settings menu, cutscene shell) opens as its own scene
    // tab rather than being instanced into the current scene.
    if (item.manifest.type === 'scene') {
      return html`
        <div class="lib-insp__actions">
          <button
            type="button"
            class="lib-insp__btn lib-insp__btn--primary"
            @click=${() => void this.openAsScene()}
          >
            ${this.icon('film')}<span>Open as Scene</span>
          </button>
          <button
            type="button"
            class="lib-insp__btn lib-insp__btn--ghost"
            @click=${() => void this.importFiles()}
          >
            ${this.icon('download')}<span>Import</span>
          </button>
        </div>
      `;
    }
    return html`
      <div class="lib-insp__actions">
        <button
          type="button"
          class="lib-insp__btn lib-insp__btn--primary"
          @click=${() => void this.addToScene()}
        >
          ${this.icon('plus')}<span>Add to Scene</span>
        </button>
        <button
          type="button"
          class="lib-insp__btn lib-insp__btn--ghost"
          @click=${() => void this.importFiles()}
        >
          ${this.icon('download')}<span>Import</span>
        </button>
      </div>
    `;
  }

  private renderDetails(
    item: LibrarySelection['item'],
    source: LibrarySelection['source'],
    store: boolean
  ) {
    return html`
      <div class="lib-insp__section">
        <div class="lib-insp__section-title">Details</div>
        ${this.renderRow(
          'Type',
          html`<span class="lib-insp__inline-icon"
              >${this.icon(iconForItemType(item.manifest.type))}</span
            >${formatItemType(item.manifest.type)}`
        )}
        ${!store ? this.renderCategoryRow(item, source) : nothing}
        ${store ? this.renderRow('Publisher', publisherLabel(item, source)) : nothing}
        ${store
          ? this.renderRow(
              'Price',
              html`<span
                class="lib-insp__mono ${isFreePrice(priceLabel(item, source)) ? 'is-free' : ''}"
                >${priceLabel(item, source)}</span
              >`
            )
          : nothing}
        ${item.manifest.license
          ? this.renderRow(
              'License',
              html`<span class="lib-insp__mono">${item.manifest.license}</span>`
            )
          : nothing}
        ${this.renderRow(
          'Files',
          html`<span class="lib-insp__mono">${assetFileCount(item)}</span>`
        )}
        ${!store ? this.renderRow('Source', item.manifest.source ?? 'Library item') : nothing}
        ${!store
          ? this.renderRow(
              'Added',
              html`<span class="lib-insp__mono">${formatAddedDate(item.manifest.createdAt)}</span>`
            )
          : nothing}
      </div>
    `;
  }

  private renderCategoryRow(item: LibrarySelection['item'], source: LibrarySelection['source']) {
    const sourceItems = itemsForSource(source, this.itemsCache);
    const categories = categoriesForSource(source, sourceItems);
    const current =
      categories.find(c => c.id === (item.manifest.category ?? 'all')) ?? categories[0];

    if (!this.isEditable) {
      return this.renderRow('Category', current?.label ?? '—');
    }

    return this.renderRow(
      'Category',
      html`
        <div class="lib-insp__dropdown">
          <button
            type="button"
            class="lib-insp__dropdown-btn"
            @click=${(e: Event) => {
              e.stopPropagation();
              this.categoryMenuOpen = !this.categoryMenuOpen;
            }}
          >
            <span>${current?.label ?? '—'}</span>${this.icon('chevron-down')}
          </button>
          ${this.categoryMenuOpen
            ? html`<div class="lib-insp__menu">
                ${categories.map(
                  cat =>
                    html`<button
                      type="button"
                      class="lib-insp__menu-item ${cat.id === (item.manifest.category ?? 'all')
                        ? 'is-active'
                        : ''}"
                      @click=${() => void this.setCategory(cat.id)}
                    >
                      ${cat.label}
                    </button>`
                )}
              </div>`
            : nothing}
        </div>
      `
    );
  }

  /** Best-effort snapshot of all items, used only to enumerate the source's categories. */
  private itemsCache: LibrarySelection['item'][] = [];

  protected willUpdate(): void {
    void this.library.getItems().then(items => {
      if (items !== this.itemsCache) {
        this.itemsCache = items;
        this.requestUpdate();
      }
    });
  }

  private renderTags(item: LibrarySelection['item']) {
    return html`
      <div class="lib-insp__section">
        <div class="lib-insp__section-title">Tags</div>
        <div class="lib-insp__tags">
          ${item.manifest.tags.map(
            tag =>
              html`<span class="lib-insp__tag">
                <span class="lib-insp__tag-icon">${this.icon('tag')}</span>${tag}
                ${this.isEditable
                  ? html`<button
                      type="button"
                      class="lib-insp__tag-remove"
                      aria-label=${`Remove tag ${tag}`}
                      @click=${() => void this.removeTag(tag)}
                    >
                      ${this.icon('x')}
                    </button>`
                  : nothing}
              </span>`
          )}
          ${this.isEditable
            ? html`<button
                type="button"
                class="lib-insp__tag lib-insp__tag--add"
                @click=${() => void this.addTag()}
              >
                ${this.icon('plus')}<span>tag</span>
              </button>`
            : nothing}
          ${item.manifest.tags.length === 0 && !this.isEditable
            ? html`<span class="lib-insp__tags-empty">No tags.</span>`
            : nothing}
        </div>
      </div>
    `;
  }

  private renderRow(label: string, value: unknown) {
    return html`
      <div class="lib-insp__row">
        <span class="lib-insp__row-label">${label}</span>
        <div class="lib-insp__row-value">${value}</div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-library-inspector': LibraryInspector;
  }
}
