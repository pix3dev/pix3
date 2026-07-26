import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { nothing } from 'lit';
import { subscribe } from 'valtio/vanilla';
import { appState } from '@/state';
import { AssetLibraryService } from '@/services/library/AssetLibraryService';
import { LibraryInsertService } from '@/services/library/LibraryInsertService';
import {
  LibrarySelectionService,
  type LibrarySelection,
} from '@/services/library/LibrarySelectionService';
import { IconService, IconSize } from '@/services/editor/IconService';
import { DialogService } from '@/services/editor/DialogService';
import { ApiClientError, storeFileUrl } from '@/services/cloud/ApiClient';
import { normalizeBundlePath } from '@/services/library/library-path-remap';
import {
  canEditSource,
  categoriesForSource,
  itemsForSource,
  subcategoriesOf,
  topLevelCategories,
} from '@/services/library/library-sources';
import type { StoreCategory, StoreItemStatus } from '@/services/library/library-types';
import type { StoreItemMetaPatch } from '@/services/library/StoreLibraryProvider';
import {
  STORE_LICENSE_WHITELIST,
  validateStorePublish,
  type StoreValidationIssue,
} from '@/services/library/store-validation';
import {
  assetFileCount,
  formatAddedDate,
  formatDownloads,
  formatItemType,
  iconForItemType,
  isFreePrice,
  isStoreLike,
  priceLabel,
  publisherLabel,
  statusIcon,
  statusLabel,
  storeStatus,
  thumbHue,
} from './library-view-model';

import './library-inspector.ts.css';

/** The lifecycle states an admin can switch between, in pipeline order. */
const STORE_STATUSES: readonly StoreItemStatus[] = ['draft', 'published', 'unlisted'];

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
  /** Server taxonomy, for the store category selects. Empty when the store is unreachable. */
  @state() private storeCategories: StoreCategory[] = [];
  /** Unmet publish requirements — from the local gate, or echoed back by the server's. */
  @state() private publishIssues: StoreValidationIssue[] = [];
  @state() private storeError: string | null = null;
  @state() private storeBusy = false;

  private previewKey: string | null = null;
  private disposeAuthSubscription?: () => void;
  private readonly onDocumentPointerDown = (event: PointerEvent) => {
    if (this.categoryMenuOpen && !event.composedPath().includes(this)) {
      this.categoryMenuOpen = false;
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('pointerdown', this.onDocumentPointerDown);
    // Admin editing is a capability of the signed-in user, so the chrome follows sign-in/out.
    this.disposeAuthSubscription = subscribe(appState.auth, () => this.requestUpdate());
    void this.refreshPreview();
    void this.loadStoreCategories();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('pointerdown', this.onDocumentPointerDown);
    this.disposeAuthSubscription?.();
    this.disposeAuthSubscription = undefined;
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has('selection')) {
      this.categoryMenuOpen = false;
      this.publishIssues = [];
      this.storeError = null;
      void this.refreshPreview();
      if (this.isStoreAdmin && this.storeCategories.length === 0) {
        void this.loadStoreCategories();
      }
    }
  }

  private async loadStoreCategories(): Promise<void> {
    try {
      this.storeCategories = await this.library.getStoreCategories();
    } catch {
      this.storeCategories = [];
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

  /**
   * Whether the current user may edit the selected item. Personal items are editable by design;
   * the curated store opens up for an admin (capability, not a config flag — see plan §2.4).
   */
  private get isEditable(): boolean {
    const selection = this.selection;
    if (!selection) {
      return false;
    }
    return canEditSource(selection.source, { isAdmin: appState.auth.user?.is_admin ?? false });
  }

  /** Editing a *store* item: unlocks the curation section (status, featured, taxonomy, delete). */
  private get isStoreAdmin(): boolean {
    return this.selection?.item.scope === 'store' && this.isEditable;
  }

  /** Editing a *personal* item: the pre-store path (bundle rewrite through the local provider). */
  private get isUserEditable(): boolean {
    return this.selection?.item.scope === 'user' && this.isEditable;
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
    const tags = [...item.manifest.tags, raw];
    if (this.isStoreAdmin) {
      await this.patchStore({ manifestPatch: { tags } });
      return;
    }
    await this.mutateManifest(manifest => ({ ...manifest, tags: [...manifest.tags, raw] }));
  }

  private async removeTag(tag: string): Promise<void> {
    const item = this.selection?.item;
    if (!item) return;
    if (this.isStoreAdmin) {
      await this.patchStore({ manifestPatch: { tags: item.manifest.tags.filter(t => t !== tag) } });
      return;
    }
    await this.mutateManifest(manifest => ({
      ...manifest,
      tags: manifest.tags.filter(t => t !== tag),
    }));
  }

  // ── Store curation (admin) ─────────────────────────────────────────────────
  // Every edit is a server PATCH; the local manifest is never mutated, because the server owns
  // status/featured/downloads and re-stamps them onto whatever it hands back.

  private async patchStore(patch: StoreItemMetaPatch): Promise<void> {
    const selection = this.selection;
    if (!selection || !this.isStoreAdmin) {
      return;
    }
    this.storeBusy = true;
    this.storeError = null;
    try {
      const fresh = await this.library.patchStoreItemMeta(selection.item.manifest.id, patch);
      this.publishIssues = [];
      this.selectionService.setSelection({ item: fresh, source: selection.source });
    } catch (error) {
      // The server runs the same publish gate; when it is the one that says no, render its
      // checklist rather than a bare "400 Bad Request".
      if (error instanceof ApiClientError && error.issues && error.issues.length > 0) {
        this.publishIssues = error.issues;
      } else {
        this.storeError =
          error instanceof Error && error.message ? error.message : 'The store rejected that edit.';
      }
    } finally {
      this.storeBusy = false;
    }
  }

  /** Switch lifecycle state. Publishing runs the local gate first so nothing round-trips in vain. */
  private async setStoreStatus(status: StoreItemStatus): Promise<void> {
    const item = this.selection?.item;
    if (!item || storeStatus(item.manifest) === status) {
      return;
    }
    if (status === 'published') {
      const issues = validateStorePublish(item.manifest);
      if (issues.length > 0) {
        this.publishIssues = issues;
        this.storeError = null;
        return;
      }
    }
    this.publishIssues = [];
    await this.patchStore({ status });
  }

  private async toggleFeatured(): Promise<void> {
    const item = this.selection?.item;
    if (!item) return;
    await this.patchStore({ featured: !item.manifest.featured });
  }

  /** Commit a manifest text field, skipping the round-trip when nothing actually changed. */
  private async setStoreField(
    field: 'name' | 'description' | 'license',
    raw: string
  ): Promise<void> {
    const item = this.selection?.item;
    if (!item) return;
    const value = raw.trim();
    const current = item.manifest[field] ?? '';
    if (value === current) {
      return;
    }
    // Send the empty string, not `undefined`: JSON.stringify drops undefined keys, so clearing a
    // field (picking "— none —" for the license, emptying the description) would never reach the
    // server — the patch would arrive without the key and the old value would survive.
    await this.patchStore({ manifestPatch: { [field]: value } });
  }

  /**
   * File the item under the taxonomy. The selects are two levels: picking a top-level category
   * clears any subcategory, picking a subcategory sends the full `<parent>/<segment>` path.
   */
  private async setStoreCategoryPath(path: string): Promise<void> {
    const item = this.selection?.item;
    if (!item || (item.manifest.categoryPath ?? '') === path) {
      return;
    }
    await this.patchStore({ categoryPath: path || null });
  }

  private async deleteStoreItem(): Promise<void> {
    const selection = this.selection;
    if (!selection || !this.isStoreAdmin) {
      return;
    }
    const confirmed = await this.dialogService.showConfirmation({
      title: 'Delete from the store?',
      message:
        `"${selection.item.manifest.name}" and its files are removed from the curated store for ` +
        `everyone. This cannot be undone — projects that already inserted it are unaffected.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      isDangerous: true,
    });
    if (!confirmed) return;
    this.storeBusy = true;
    try {
      await this.library.deleteStoreItem(selection.item.manifest.id);
      this.selectionService.clear();
    } catch (error) {
      this.storeError =
        error instanceof Error && error.message ? error.message : 'Could not delete the item.';
    } finally {
      this.storeBusy = false;
    }
  }

  private issueFor(field: string): StoreValidationIssue | undefined {
    return this.publishIssues.find(issue => issue.field === field);
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

        ${this.renderPreview(item)} ${this.renderGallery(item)} ${this.renderActions(item, store)}
        ${item.manifest.description
          ? html`<p class="lib-insp__desc">${item.manifest.description}</p>`
          : nothing}
        ${this.renderDetails(item, source, store)} ${this.renderTags(item)}
        ${this.renderStoreAdmin(item)}
        ${this.isUserEditable
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

  /** Extra store preview images (`manifest.gallery`), served straight from the public file URL. */
  private renderGallery(item: LibrarySelection['item']) {
    const gallery = item.manifest.gallery ?? [];
    if (item.scope !== 'store' || gallery.length === 0) {
      return nothing;
    }
    return html`
      <div class="lib-insp__gallery">
        ${gallery.map(
          path =>
            html`<img
              class="lib-insp__gallery-img"
              src=${storeFileUrl(item.manifest.id, normalizeBundlePath(path))}
              alt=""
              loading="lazy"
            />`
        )}
      </div>
    `;
  }

  private renderPreview(item: LibrarySelection['item']) {
    const store = this.selection ? isStoreLike(this.selection.source) : false;
    const price = this.selection && store ? priceLabel(item, this.selection.source) : '';
    return html`
      <div
        class="lib-insp__preview ${this.issueFor('preview') ? 'is-invalid' : ''}"
        style=${`--lib-thumb-hue:${thumbHue(item.manifest.id)}`}
      >
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
        ${item.scope === 'store'
          ? this.renderRow(
              'Downloads',
              html`<span class="lib-insp__mono">${formatDownloads(item.manifest.downloads)}</span>`
            )
          : nothing}
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

    if (!this.isUserEditable) {
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
        <div class="lib-insp__tags ${this.issueFor('tags') ? 'is-invalid' : ''}">
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

  // ── Store curation UI ──────────────────────────────────────────────────────

  /** The whole admin block: lifecycle, curation flags, editable metadata, version log, delete. */
  private renderStoreAdmin(item: LibrarySelection['item']) {
    if (!this.isStoreAdmin) {
      return nothing;
    }
    const manifest = item.manifest;
    const status = storeStatus(manifest);
    const categoryPath = manifest.categoryPath ?? '';
    const topId = categoryPath.split('/')[0] ?? '';
    const roots = topLevelCategories(this.storeCategories);
    const children = topId ? subcategoriesOf(this.storeCategories, topId) : [];

    return html`
      <div class="lib-insp__section lib-insp__admin ${this.storeBusy ? 'is-busy' : ''}">
        <div class="lib-insp__section-title">
          <span class="lib-insp__admin-badge">${this.icon('shield')}</span>Store admin
        </div>

        ${this.storeError
          ? html`<div class="lib-insp__alert" role="alert">
              <span class="lib-insp__alert-icon">${this.icon('alert-circle')}</span>
              <span>${this.storeError}</span>
            </div>`
          : nothing}

        <div class="lib-insp__row">
          <span class="lib-insp__row-label">Status</span>
          <div class="lib-insp__row-value">
            <div class="lib-insp__segmented" role="group" aria-label="Store status">
              ${STORE_STATUSES.map(
                candidate =>
                  html`<button
                    type="button"
                    class="lib-insp__segment ${candidate === status ? 'is-active' : ''}"
                    aria-pressed=${candidate === status}
                    ?disabled=${this.storeBusy}
                    @click=${() => void this.setStoreStatus(candidate)}
                  >
                    <span class="lib-insp__segment-icon">${this.icon(statusIcon(candidate))}</span>
                    <span>${statusLabel(candidate)}</span>
                  </button>`
              )}
            </div>
          </div>
        </div>

        ${this.renderPublishIssues()}

        <div class="lib-insp__row">
          <span class="lib-insp__row-label">Featured</span>
          <div class="lib-insp__row-value">
            <button
              type="button"
              class="lib-insp__toggle ${manifest.featured ? 'is-on' : ''}"
              aria-pressed=${manifest.featured === true}
              ?disabled=${this.storeBusy}
              @click=${() => void this.toggleFeatured()}
            >
              ${this.icon('star')}<span>${manifest.featured ? 'Featured' : 'Not featured'}</span>
            </button>
          </div>
        </div>

        ${this.renderRow(
          'Name',
          html`<input
            class="lib-insp__field ${this.issueFor('name') ? 'is-invalid' : ''}"
            type="text"
            aria-label="Store item name"
            .value=${manifest.name}
            ?disabled=${this.storeBusy}
            @change=${(event: Event) =>
              void this.setStoreField('name', (event.target as HTMLInputElement).value)}
          />`
        )}
        ${this.renderRow(
          'Category',
          html`
            <select
              class="lib-insp__field ${this.issueFor('categoryPath') ? 'is-invalid' : ''}"
              aria-label="Store category"
              ?disabled=${this.storeBusy || roots.length === 0}
              @change=${(event: Event) =>
                void this.setStoreCategoryPath((event.target as HTMLSelectElement).value)}
            >
              <option value="" ?selected=${!topId}>— none —</option>
              ${roots.map(
                root =>
                  html`<option value=${root.id} ?selected=${root.id === topId}>
                    ${root.label}
                  </option>`
              )}
            </select>
            <select
              class="lib-insp__field"
              aria-label="Store subcategory"
              ?disabled=${this.storeBusy || children.length === 0}
              @change=${(event: Event) =>
                void this.setStoreCategoryPath((event.target as HTMLSelectElement).value || topId)}
            >
              <option value="" ?selected=${categoryPath === topId}>— all —</option>
              ${children.map(
                child =>
                  html`<option value=${child.id} ?selected=${child.id === categoryPath}>
                    ${child.label}
                  </option>`
              )}
            </select>
          `
        )}
        ${this.renderRow(
          'License',
          html`<select
            class="lib-insp__field ${this.issueFor('license') ? 'is-invalid' : ''}"
            aria-label="License"
            ?disabled=${this.storeBusy}
            @change=${(event: Event) =>
              void this.setStoreField('license', (event.target as HTMLSelectElement).value)}
          >
            <option value="" ?selected=${!manifest.license}>— none —</option>
            ${STORE_LICENSE_WHITELIST.map(
              license =>
                html`<option value=${license} ?selected=${license === manifest.license}>
                  ${license}
                </option>`
            )}
          </select>`
        )}

        <div class="lib-insp__field-block">
          <label class="lib-insp__field-label" for="libInspStoreDescription">Description</label>
          <textarea
            id="libInspStoreDescription"
            class="lib-insp__field lib-insp__field--area ${this.issueFor('description')
              ? 'is-invalid'
              : ''}"
            rows="3"
            .value=${manifest.description ?? ''}
            ?disabled=${this.storeBusy}
            @change=${(event: Event) =>
              void this.setStoreField('description', (event.target as HTMLTextAreaElement).value)}
          ></textarea>
        </div>

        ${this.renderChangelog(item)}

        <button
          type="button"
          class="lib-insp__danger"
          ?disabled=${this.storeBusy}
          @click=${() => void this.deleteStoreItem()}
        >
          ${this.icon('trash-2')}<span>Delete from store</span>
        </button>
      </div>
    `;
  }

  /** The publish checklist — the same list whether the local gate or the server produced it. */
  private renderPublishIssues() {
    if (this.publishIssues.length === 0) {
      return nothing;
    }
    return html`
      <div class="lib-insp__issues" role="alert">
        <div class="lib-insp__issues-title">
          <span class="lib-insp__alert-icon">${this.icon('alert-circle')}</span>
          Not ready to publish
        </div>
        <ul class="lib-insp__issues-list">
          ${this.publishIssues.map(issue => html`<li>${issue.message}</li>`)}
        </ul>
      </div>
    `;
  }

  /** Version + release notes. Read-only in this phase — uploads own the version field. */
  private renderChangelog(item: LibrarySelection['item']) {
    const { version, changelog } = item.manifest;
    if (!version && (!changelog || changelog.length === 0)) {
      return nothing;
    }
    return html`
      <div class="lib-insp__field-block">
        <div class="lib-insp__field-label">Version</div>
        <div class="lib-insp__row-value">
          <span class="lib-insp__mono">${version ?? '—'}</span>
        </div>
        ${changelog && changelog.length > 0
          ? html`<ul class="lib-insp__changelog">
              ${changelog.map(
                entry =>
                  html`<li>
                    <span class="lib-insp__mono">${entry.version}</span>
                    <span class="lib-insp__changelog-date">${formatAddedDate(entry.date)}</span>
                    <span class="lib-insp__changelog-notes">${entry.notes}</span>
                  </li>`
              )}
            </ul>`
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-library-inspector': LibraryInspector;
  }
}
