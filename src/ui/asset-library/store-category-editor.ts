import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { nothing } from 'lit';
import * as ApiClient from '@/services/cloud/ApiClient';
import { DialogService } from '@/services/editor/DialogService';
import { IconService, IconSize } from '@/services/editor/IconService';
import { subcategoriesOf, topLevelCategories } from '@/services/library/library-sources';
import type { StoreCategory } from '@/services/library/library-types';

import './store-category-editor.ts.css';

/**
 * Slugify one path segment of a store category id.
 *
 * The server accepts only `[a-z0-9][a-z0-9-]*` segments, so the editor slugifies the label up
 * front and shows the resulting id — a rejected 400 for a segment the user never typed would be
 * unexplainable.
 */
export function slugifyCategorySegment(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // A slug starting with a digit is fine; one starting with `-` is not, and `replace` above
  // already stripped those. An all-punctuation label collapses to nothing.
  return slug || 'category';
}

/**
 * Full category id for a new node. Subcategory ids must be literally `<parentId>/<segment>` —
 * the server derives the hierarchy from the id, it does not build it from `parentId`.
 */
export function buildCategoryId(parentId: string | null, label: string): string {
  const segment = slugifyCategorySegment(label);
  return parentId ? `${parentId}/${segment}` : segment;
}

/** Depth of a category id (1 = top level). The server caps this at 2. */
export function categoryDepth(id: string): number {
  return id.split('/').filter(Boolean).length;
}

/**
 * Admin editor for the curated store taxonomy: a two-level tree with add / rename / reorder /
 * delete. CRUD goes straight to the store endpoints (the taxonomy is server state, not editor
 * state, and has no undo — see plan §2.6); the host panel refreshes its rail when this closes
 * after a change.
 *
 * Deleting a category is allowed even when it holds items — the server re-homes them to the
 * parent (or clears the path for a top-level node), which the confirmation spells out.
 */
@customElement('pix3-store-category-editor')
export class StoreCategoryEditor extends ComponentBase {
  @inject(IconService) private readonly iconService!: IconService;
  @inject(DialogService) private readonly dialogService!: DialogService;

  @state() private categories: StoreCategory[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;
  /** Id of the row currently waiting on a request (disables its actions). */
  @state() private busyId: string | null = null;
  /** Parent of the open "add" form: `null` = top level, `undefined` = no form open. */
  @state() private addingUnder: string | null | undefined = undefined;
  @state() private draftLabel = '';
  @state() private renamingId: string | null = null;
  @state() private renameLabel = '';

  private changed = false;

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.close();
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('keydown', this.onKeyDown);
    void this.load();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this.onKeyDown);
  }

  // ── Data ───────────────────────────────────────────────────────────────────
  private async load(): Promise<void> {
    this.loading = true;
    try {
      const { categories } = await ApiClient.getStoreCategories();
      this.categories = categories;
      this.error = null;
    } catch (error) {
      this.error = this.messageOf(error, 'Could not load the store taxonomy.');
    } finally {
      this.loading = false;
    }
  }

  private messageOf(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
  }

  private async run(id: string | null, action: () => Promise<void>): Promise<void> {
    this.busyId = id;
    try {
      await action();
      this.changed = true;
      this.error = null;
      await this.load();
    } catch (error) {
      this.error = this.messageOf(error, 'The store rejected that change.');
    } finally {
      this.busyId = null;
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  private openAddForm(parentId: string | null): void {
    this.addingUnder = parentId;
    this.draftLabel = '';
    this.renamingId = null;
  }

  private cancelAddForm(): void {
    this.addingUnder = undefined;
    this.draftLabel = '';
  }

  private async submitAddForm(): Promise<void> {
    const parentId = this.addingUnder ?? null;
    const label = this.draftLabel.trim();
    if (this.addingUnder === undefined || !label) {
      return;
    }
    const id = buildCategoryId(parentId, label);
    if (this.categories.some(category => category.id === id)) {
      this.error = `A category with the id "${id}" already exists.`;
      return;
    }
    const siblings = parentId
      ? subcategoriesOf(this.categories, parentId)
      : topLevelCategories(this.categories);
    const sortOrder = siblings.reduce((max, sibling) => Math.max(max, sibling.sortOrder + 1), 0);
    this.cancelAddForm();
    await this.run(id, async () => {
      await ApiClient.createStoreCategory({ id, parentId, label, sortOrder });
    });
  }

  private startRename(category: StoreCategory): void {
    this.renamingId = category.id;
    this.renameLabel = category.label;
    this.addingUnder = undefined;
  }

  private async submitRename(): Promise<void> {
    const id = this.renamingId;
    const label = this.renameLabel.trim();
    if (!id || !label) {
      return;
    }
    this.renamingId = null;
    await this.run(id, async () => {
      await ApiClient.updateStoreCategory(id, { label });
    });
  }

  /**
   * Swap a node with its sibling in the given direction. Both rows are PATCHed with the other's
   * `sortOrder`; ties break on label server-side, so the two writes are enough to reorder.
   */
  private async move(category: StoreCategory, delta: -1 | 1): Promise<void> {
    const siblings = category.parentId
      ? subcategoriesOf(this.categories, category.parentId)
      : topLevelCategories(this.categories);
    const index = siblings.findIndex(entry => entry.id === category.id);
    const neighbour = siblings[index + delta];
    if (!neighbour) {
      return;
    }
    // Equal sort orders (freshly seeded taxonomy) would make a swap a no-op — spread them first.
    const own = category.sortOrder === neighbour.sortOrder ? index : category.sortOrder;
    const other = category.sortOrder === neighbour.sortOrder ? index + delta : neighbour.sortOrder;
    await this.run(category.id, async () => {
      await ApiClient.updateStoreCategory(category.id, { sortOrder: other });
      await ApiClient.updateStoreCategory(neighbour.id, { sortOrder: own });
    });
  }

  private async deleteCategory(category: StoreCategory): Promise<void> {
    const children = subcategoriesOf(this.categories, category.id);
    const destination = category.parentId
      ? `moved up to "${this.labelOf(category.parentId)}"`
      : 'left without a category (visible only under Featured)';
    const childNote = children.length
      ? ` Its ${children.length} subcategor${children.length === 1 ? 'y is' : 'ies are'} removed too.`
      : '';
    const confirmed = await this.dialogService.showConfirmation({
      title: `Delete "${category.label}"?`,
      message:
        `Items filed under this category are not deleted — the server re-homes them: they will be ` +
        `${destination}.${childNote}`,
      confirmLabel: 'Delete category',
      cancelLabel: 'Cancel',
      isDangerous: true,
    });
    if (!confirmed) {
      return;
    }
    await this.run(category.id, async () => {
      await ApiClient.deleteStoreCategory(category.id);
    });
  }

  private labelOf(id: string): string {
    return this.categories.find(category => category.id === id)?.label ?? id;
  }

  private close(): void {
    this.dispatchEvent(
      new CustomEvent('store-categories-close', {
        detail: { changed: this.changed },
        bubbles: true,
        composed: true,
      })
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  private icon(name: string, size: number = IconSize.SMALL) {
    return this.iconService.getIcon(name, size);
  }

  protected render() {
    const roots = topLevelCategories(this.categories);
    return html`
      <div class="sce-overlay" @click=${() => this.close()}>
        <div
          class="sce-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Store categories"
          @click=${(event: Event) => event.stopPropagation()}
        >
          <div class="sce-header">
            <div class="sce-title">Store categories</div>
            <button type="button" class="sce-close" aria-label="Close" @click=${() => this.close()}>
              ${this.icon('x')}
            </button>
          </div>
          <p class="sce-hint">
            Two levels, curated order. Ids are generated from the label and are what items are filed
            under — renaming a category keeps its id.
          </p>

          ${this.error
            ? html`<div class="sce-error" role="alert">
                <span class="sce-error__icon">${this.icon('alert-circle')}</span>
                <span>${this.error}</span>
              </div>`
            : nothing}

          <div class="sce-tree">
            ${this.loading
              ? html`<div class="sce-empty">Loading…</div>`
              : roots.length === 0
                ? html`<div class="sce-empty">No categories yet — add the first one below.</div>`
                : roots.map(root => this.renderNode(root, roots))}
            ${this.addingUnder === null ? this.renderAddForm(null) : nothing}
          </div>

          <div class="sce-actions">
            <button
              type="button"
              class="sce-btn sce-btn--ghost"
              ?disabled=${this.loading || this.addingUnder === null}
              @click=${() => this.openAddForm(null)}
            >
              ${this.icon('plus')}<span>Add category</span>
            </button>
            <span class="sce-actions__spacer"></span>
            <button type="button" class="sce-btn sce-btn--primary" @click=${() => this.close()}>
              Done
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderNode(category: StoreCategory, siblings: readonly StoreCategory[]) {
    const children = subcategoriesOf(this.categories, category.id);
    return html`
      <div class="sce-node">
        ${this.renderRow(category, siblings)}
        <div class="sce-children">
          ${children.map(child => this.renderRow(child, children))}
          ${this.addingUnder === category.id ? this.renderAddForm(category.id) : nothing}
          ${categoryDepth(category.id) === 1
            ? html`<button
                type="button"
                class="sce-add-sub"
                ?disabled=${this.addingUnder === category.id}
                @click=${() => this.openAddForm(category.id)}
              >
                ${this.icon('plus')}<span>Add subcategory</span>
              </button>`
            : nothing}
        </div>
      </div>
    `;
  }

  private renderRow(category: StoreCategory, siblings: readonly StoreCategory[]) {
    const index = siblings.findIndex(entry => entry.id === category.id);
    const canMoveUp = index > 0;
    const canMoveDown = index >= 0 && index < siblings.length - 1;
    const busy = this.busyId === category.id;
    const isChild = categoryDepth(category.id) > 1;

    if (this.renamingId === category.id) {
      return html`
        <div class="sce-row sce-row--editing ${isChild ? 'is-child' : ''}">
          <input
            class="sce-input"
            type="text"
            aria-label=${`Rename ${category.label}`}
            .value=${this.renameLabel}
            @input=${(event: Event) =>
              (this.renameLabel = (event.target as HTMLInputElement).value)}
            @keydown=${(event: KeyboardEvent) => {
              if (event.key === 'Enter') void this.submitRename();
              if (event.key === 'Escape') this.renamingId = null;
            }}
          />
          <button
            type="button"
            class="sce-iconbtn"
            aria-label="Save name"
            @click=${() => void this.submitRename()}
          >
            ${this.icon('check')}
          </button>
          <button
            type="button"
            class="sce-iconbtn"
            aria-label="Cancel rename"
            @click=${() => (this.renamingId = null)}
          >
            ${this.icon('x')}
          </button>
        </div>
      `;
    }

    return html`
      <div class="sce-row ${isChild ? 'is-child' : ''} ${busy ? 'is-busy' : ''}">
        <span class="sce-row__icon">${this.icon(isChild ? 'corner-down-right' : 'folder')}</span>
        <span class="sce-row__label">${category.label}</span>
        <code class="sce-row__id">${category.id}</code>
        <span class="sce-row__count" title="Items filed directly here">${category.itemCount}</span>
        <button
          type="button"
          class="sce-iconbtn"
          aria-label=${`Move ${category.label} up`}
          ?disabled=${!canMoveUp || busy}
          @click=${() => void this.move(category, -1)}
        >
          ${this.icon('chevron-up')}
        </button>
        <button
          type="button"
          class="sce-iconbtn"
          aria-label=${`Move ${category.label} down`}
          ?disabled=${!canMoveDown || busy}
          @click=${() => void this.move(category, 1)}
        >
          ${this.icon('chevron-down')}
        </button>
        <button
          type="button"
          class="sce-iconbtn"
          aria-label=${`Rename ${category.label}`}
          ?disabled=${busy}
          @click=${() => this.startRename(category)}
        >
          ${this.icon('edit-2')}
        </button>
        <button
          type="button"
          class="sce-iconbtn sce-iconbtn--danger"
          aria-label=${`Delete ${category.label}`}
          ?disabled=${busy}
          @click=${() => void this.deleteCategory(category)}
        >
          ${this.icon('trash-2')}
        </button>
      </div>
    `;
  }

  private renderAddForm(parentId: string | null) {
    const label = this.draftLabel.trim();
    const id = label ? buildCategoryId(parentId, label) : '';
    return html`
      <div class="sce-row sce-row--editing ${parentId ? 'is-child' : ''}">
        <input
          class="sce-input"
          type="text"
          placeholder=${parentId ? 'Subcategory name' : 'Category name'}
          aria-label=${parentId
            ? `New subcategory under ${this.labelOf(parentId)}`
            : 'New category'}
          .value=${this.draftLabel}
          @input=${(event: Event) => (this.draftLabel = (event.target as HTMLInputElement).value)}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === 'Enter') void this.submitAddForm();
            if (event.key === 'Escape') this.cancelAddForm();
          }}
        />
        <code class="sce-row__id sce-row__id--preview">${id || '—'}</code>
        <button
          type="button"
          class="sce-iconbtn"
          aria-label="Create category"
          ?disabled=${!label}
          @click=${() => void this.submitAddForm()}
        >
          ${this.icon('check')}
        </button>
        <button
          type="button"
          class="sce-iconbtn"
          aria-label="Cancel new category"
          @click=${() => this.cancelAddForm()}
        >
          ${this.icon('x')}
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-store-category-editor': StoreCategoryEditor;
  }
}
