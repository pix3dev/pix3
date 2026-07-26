import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { nothing } from 'lit';
import { AssetLibraryService } from '@/services/library/AssetLibraryService';
import { IconService, IconSize } from '@/services/editor/IconService';
import { subcategoriesOf, topLevelCategories } from '@/services/library/library-sources';
import type { StoreCategory } from '@/services/library/library-types';
import {
  STORE_LICENSE_WHITELIST,
  validateStorePublish,
  type StoreValidationIssue,
} from '@/services/library/store-validation';
import {
  StoreUploadService,
  bundleByteSize,
  formatBytes,
  type StagedBundle,
  type StoreIngestPlan,
  type UploadOutcome,
} from '@/services/library/StoreUploadService';
import { formatItemType, iconForItemType } from './library-view-model';

import './store-upload-dialog.ts.css';

interface BundleProgress {
  readonly loaded: number;
  readonly total: number;
}

/**
 * The staging dialog for content dragged in from the OS (or picked with the file input): a list of
 * prospective store items on the left, the selected item's metadata on the right, per-bundle upload
 * progress with a working Cancel at the bottom.
 *
 * Two upload buttons, because the two intents are genuinely different. "Upload as drafts" is the
 * cheap path — everything lands as `draft` and the admin finishes the metadata later in the
 * Inspector. "Upload & publish" runs {@link validateStorePublish} over every bundle first and
 * refuses the whole batch while anything is incomplete, listing (and highlighting) what is missing;
 * the server runs the same gate again and its checklist replaces ours if it disagrees.
 *
 * Bundles that broke a server limit during staging are shown in red and never uploaded — the rest
 * of the same drop still goes through, since a partial batch is a normal outcome here.
 */
@customElement('pix3-store-upload-dialog')
export class StoreUploadDialog extends ComponentBase {
  @inject(IconService) private readonly iconService!: IconService;
  @inject(AssetLibraryService) private readonly library!: AssetLibraryService;
  @inject(StoreUploadService) private readonly uploads!: StoreUploadService;

  /** The staged plan. Its manifests are edited in place by this dialog. */
  @property({ attribute: false }) plan: StoreIngestPlan | null = null;
  /** Category the content was dropped on, pre-applied to bundles that declare none. */
  @property({ attribute: false }) defaultCategoryPath: string | null = null;

  @state() private selectedId: string | null = null;
  @state() private categories: StoreCategory[] = [];
  @state() private progress = new Map<string, BundleProgress>();
  @state() private outcomes = new Map<string, UploadOutcome>();
  /** Publish-gate results per bundle, from our gate or echoed back by the server's. */
  @state() private issues = new Map<string, StoreValidationIssue[]>();
  @state() private uploading = false;
  @state() private finished = false;
  @state() private error: string | null = null;
  /** Bumped on every manifest edit — the staged manifests are plain objects, not reactive state. */
  @state() private revision = 0;
  @state() private previewUrl: string | null = null;

  private controller: AbortController | null = null;
  private previewKey: string | null = null;
  private appliedPlan: StoreIngestPlan | null = null;

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !this.uploading) {
      event.stopPropagation();
      this.close();
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('keydown', this.onKeyDown);
    void this.loadCategories();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this.onKeyDown);
    this.controller?.abort();
    this.releasePreview();
  }

  // The preview URL is derived here rather than in `updated()` so that swapping it never schedules
  // a second render pass off the back of the first.
  protected willUpdate(): void {
    this.applyPlan();
    this.refreshPreview();
  }

  private applyPlan(): void {
    const plan = this.plan;
    if (!plan || plan === this.appliedPlan) {
      return;
    }
    this.appliedPlan = plan;
    this.selectedId = plan.bundles[0]?.id ?? null;
    if (this.defaultCategoryPath) {
      for (const bundle of plan.bundles) {
        if (!bundle.manifest.categoryPath) {
          bundle.manifest = { ...bundle.manifest, categoryPath: this.defaultCategoryPath };
        }
      }
    }
  }

  private async loadCategories(): Promise<void> {
    try {
      this.categories = await this.library.getStoreCategories();
    } catch {
      // Offline: the category selects stay empty and publishing is blocked by the gate anyway.
      this.categories = [];
    }
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  private get bundles(): readonly StagedBundle[] {
    return this.plan?.bundles ?? [];
  }

  private get selected(): StagedBundle | null {
    return this.bundles.find(bundle => bundle.id === this.selectedId) ?? null;
  }

  /** The bundles an upload would actually send (limit violators are excluded up front). */
  private get uploadable(): StagedBundle[] {
    return this.bundles.filter(bundle => !bundle.oversize);
  }

  // ── Editing ────────────────────────────────────────────────────────────────
  private edit(bundle: StagedBundle, patch: Partial<StagedBundle['manifest']>): void {
    bundle.manifest = { ...bundle.manifest, ...patch };
    this.revision += 1;
  }

  private editSelected(patch: Partial<StagedBundle['manifest']>): void {
    const bundle = this.selected;
    if (bundle) {
      this.edit(bundle, patch);
    }
  }

  /** Top-level select clears the subcategory; the child select sends the full `parent/child` path. */
  private setCategoryPath(path: string): void {
    this.editSelected({ categoryPath: path || undefined });
  }

  private setTags(raw: string): void {
    const tags = raw
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean);
    this.editSelected({ tags });
  }

  // ── Upload ─────────────────────────────────────────────────────────────────
  private async startUpload(status: 'draft' | 'published'): Promise<void> {
    const bundles = this.uploadable;
    if (bundles.length === 0 || this.uploading) {
      return;
    }

    if (status === 'published') {
      const gate = new Map<string, StoreValidationIssue[]>();
      for (const bundle of bundles) {
        const found = validateStorePublish({ ...bundle.manifest, status });
        if (found.length > 0) {
          gate.set(bundle.id, found);
        }
      }
      if (gate.size > 0) {
        this.issues = gate;
        this.error = null;
        this.selectedId = [...gate.keys()][0] ?? this.selectedId;
        return;
      }
    }

    for (const bundle of bundles) {
      bundle.manifest = { ...bundle.manifest, status };
    }

    this.issues = new Map();
    this.error = null;
    this.progress = new Map();
    this.outcomes = new Map();
    this.uploading = true;
    this.controller = new AbortController();

    const results = await this.uploads.upload(bundles, {
      signal: this.controller.signal,
      onProgress: (bundleId, loaded, total) => {
        const next = new Map(this.progress);
        next.set(bundleId, { loaded, total });
        this.progress = next;
      },
    });

    const outcomes = new Map<string, UploadOutcome>();
    const issues = new Map<string, StoreValidationIssue[]>();
    for (const outcome of results) {
      outcomes.set(outcome.bundleId, outcome);
      if (outcome.status === 'error' && outcome.issues && outcome.issues.length > 0) {
        issues.set(outcome.bundleId, outcome.issues);
      }
    }
    this.outcomes = outcomes;
    this.issues = issues;
    this.uploading = false;
    this.finished = true;
    this.controller = null;
  }

  private cancelUpload(): void {
    this.controller?.abort();
  }

  private get uploadedCount(): number {
    let count = 0;
    for (const outcome of this.outcomes.values()) {
      if (outcome.status === 'ok') {
        count += 1;
      }
    }
    return count;
  }

  private close(): void {
    this.controller?.abort();
    this.dispatchEvent(
      new CustomEvent('store-upload-close', {
        detail: { uploaded: this.uploadedCount },
        bubbles: true,
        composed: true,
      })
    );
  }

  // ── Preview ────────────────────────────────────────────────────────────────
  private refreshPreview(): void {
    const bundle = this.selected;
    const preview = bundle?.manifest.preview;
    const key = bundle && preview ? `${bundle.id}:${preview}` : null;
    if (key === this.previewKey) {
      return;
    }
    this.releasePreview();
    this.previewKey = key;
    const blob = preview ? bundle?.files.get(preview) : undefined;
    if (blob) {
      this.previewUrl = URL.createObjectURL(blob);
    }
  }

  private releasePreview(): void {
    if (this.previewUrl) {
      URL.revokeObjectURL(this.previewUrl);
      this.previewUrl = null;
    }
    this.previewKey = null;
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  private icon(name: string, size: number = IconSize.SMALL) {
    return this.iconService.getIcon(name, size);
  }

  protected render() {
    void this.revision;
    const planIssues = this.plan?.issues ?? [];
    return html`
      <div
        class="sud-overlay"
        @click=${() => {
          // A click-away while bytes are in flight would abort the batch by surprise.
          if (!this.uploading) {
            this.close();
          }
        }}
      >
        <div
          class="sud-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Add items to the Pix3 Store"
          @click=${(event: Event) => event.stopPropagation()}
        >
          <div class="sud-header">
            <div class="sud-title">Add to the Pix3 Store</div>
            <button
              type="button"
              class="sud-close"
              aria-label="Close"
              ?disabled=${this.uploading}
              @click=${() => this.close()}
            >
              ${this.icon('x')}
            </button>
          </div>
          <p class="sud-hint">
            Each top-level folder or archive becomes one item; a lone file becomes a one-file item.
            An <code>item.json</code> inside a folder is used as-is, so re-uploading it updates the
            same store item.
          </p>

          ${planIssues.length > 0
            ? html`<div class="sud-alert" role="alert">
                <span class="sud-alert__icon">${this.icon('alert-circle')}</span>
                <ul class="sud-alert__list">
                  ${planIssues.map(issue => html`<li>${issue}</li>`)}
                </ul>
              </div>`
            : nothing}
          ${this.error
            ? html`<div class="sud-alert" role="alert">
                <span class="sud-alert__icon">${this.icon('alert-circle')}</span>
                <span>${this.error}</span>
              </div>`
            : nothing}

          <div class="sud-body">
            <div class="sud-list" role="listbox" aria-label="Staged items">
              ${this.bundles.length === 0
                ? html`<div class="sud-empty">Nothing usable was dropped.</div>`
                : this.bundles.map(bundle => this.renderListRow(bundle))}
            </div>
            <div class="sud-meta">${this.renderMeta()}</div>
          </div>

          ${this.renderFooter()}
        </div>
      </div>
    `;
  }

  private renderListRow(bundle: StagedBundle) {
    const outcome = this.outcomes.get(bundle.id);
    const progress = this.progress.get(bundle.id);
    const percent =
      progress && progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;
    const selected = bundle.id === this.selectedId;
    const failing = bundle.oversize || outcome?.status === 'error';
    return html`
      <button
        type="button"
        role="option"
        aria-selected=${selected}
        class="sud-item ${selected ? 'is-selected' : ''} ${failing ? 'is-blocked' : ''}"
        @click=${() => (this.selectedId = bundle.id)}
      >
        <span class="sud-item__icon">${this.icon(iconForItemType(bundle.manifest.type))}</span>
        <span class="sud-item__text">
          <span class="sud-item__name">${bundle.manifest.name}</span>
          <span class="sud-item__sub">
            ${formatItemType(bundle.manifest.type)} · ${bundle.files.size} files ·
            ${formatBytes(bundleByteSize(bundle))}
          </span>
          ${bundle.issues.length > 0
            ? html`<span class="sud-item__issue">${bundle.issues.join(' ')}</span>`
            : nothing}
          ${outcome?.status === 'error'
            ? html`<span class="sud-item__issue">${outcome.message}</span>`
            : nothing}
        </span>
        ${this.renderRowStatus(bundle, outcome, percent)}
      </button>
    `;
  }

  private renderRowStatus(
    bundle: StagedBundle,
    outcome: UploadOutcome | undefined,
    percent: number
  ) {
    if (outcome?.status === 'ok') {
      return html`<span class="sud-item__state is-ok" title="Uploaded"
        >${this.icon('check')}</span
      >`;
    }
    if (outcome?.status === 'cancelled') {
      return html`<span class="sud-item__state" title="Cancelled">${this.icon('slash')}</span>`;
    }
    if (outcome?.status === 'error' || bundle.oversize) {
      return html`<span class="sud-item__state is-bad" title="Not uploaded"
        >${this.icon('alert-circle')}</span
      >`;
    }
    if (this.uploading && percent > 0) {
      return html`<span class="sud-item__state is-progress">${percent}%</span>`;
    }
    return nothing;
  }

  private renderMeta() {
    const bundle = this.selected;
    if (!bundle) {
      return html`<div class="sud-empty">Select an item to edit its store metadata.</div>`;
    }
    const manifest = bundle.manifest;
    const issues = this.issues.get(bundle.id) ?? [];
    const invalid = (field: string) =>
      issues.some(issue => issue.field === field) ? 'is-invalid' : '';
    const categoryPath = manifest.categoryPath ?? '';
    const topId = categoryPath.split('/')[0] ?? '';
    const roots = topLevelCategories(this.categories);
    const children = topId ? subcategoriesOf(this.categories, topId) : [];
    const disabled = this.uploading;

    return html`
      ${issues.length > 0
        ? html`<div class="sud-issues" role="alert">
            <div class="sud-issues__title">
              <span class="sud-alert__icon">${this.icon('alert-circle')}</span>Not ready to publish
            </div>
            <ul class="sud-issues__list">
              ${issues.map(issue => html`<li>${issue.message}</li>`)}
            </ul>
          </div>`
        : nothing}

      <div class="sud-preview ${invalid('preview')}">
        ${this.previewUrl
          ? html`<img src=${this.previewUrl} alt="" />`
          : html`<span class="sud-preview__icon"
              >${this.icon(iconForItemType(manifest.type), IconSize.XLARGE)}</span
            >`}
        <span class="sud-preview__caption"
          >${manifest.preview ?? 'No preview image in bundle'}</span
        >
      </div>

      <label class="sud-field-label" for="sudName">Name</label>
      <input
        id="sudName"
        class="sud-field ${invalid('name')}"
        type="text"
        .value=${manifest.name}
        ?disabled=${disabled}
        @input=${(event: Event) =>
          this.editSelected({ name: (event.target as HTMLInputElement).value })}
      />

      <label class="sud-field-label" for="sudCategory">Category</label>
      <div class="sud-field-row">
        <select
          id="sudCategory"
          class="sud-field ${invalid('categoryPath')}"
          ?disabled=${disabled || roots.length === 0}
          @change=${(event: Event) =>
            this.setCategoryPath((event.target as HTMLSelectElement).value)}
        >
          <option value="" ?selected=${!topId}>— none —</option>
          ${roots.map(
            root =>
              html`<option value=${root.id} ?selected=${root.id === topId}>${root.label}</option>`
          )}
        </select>
        <select
          class="sud-field"
          aria-label="Subcategory"
          ?disabled=${disabled || children.length === 0}
          @change=${(event: Event) =>
            this.setCategoryPath((event.target as HTMLSelectElement).value || topId)}
        >
          <option value="" ?selected=${categoryPath === topId}>— all —</option>
          ${children.map(
            child =>
              html`<option value=${child.id} ?selected=${child.id === categoryPath}>
                ${child.label}
              </option>`
          )}
        </select>
      </div>

      <label class="sud-field-label" for="sudLicense">License</label>
      <select
        id="sudLicense"
        class="sud-field ${invalid('license')}"
        ?disabled=${disabled}
        @change=${(event: Event) =>
          this.editSelected({ license: (event.target as HTMLSelectElement).value || undefined })}
      >
        <option value="" ?selected=${!manifest.license}>— none —</option>
        ${STORE_LICENSE_WHITELIST.map(
          license =>
            html`<option value=${license} ?selected=${license === manifest.license}>
              ${license}
            </option>`
        )}
      </select>

      <label class="sud-field-label" for="sudTags">Tags <span>(comma separated)</span></label>
      <input
        id="sudTags"
        class="sud-field ${invalid('tags')}"
        type="text"
        .value=${manifest.tags.join(', ')}
        ?disabled=${disabled}
        @change=${(event: Event) => this.setTags((event.target as HTMLInputElement).value)}
      />

      <label class="sud-field-label" for="sudDescription">Description</label>
      <textarea
        id="sudDescription"
        class="sud-field sud-field--area ${invalid('description')}"
        rows="3"
        .value=${manifest.description ?? ''}
        ?disabled=${disabled}
        @input=${(event: Event) =>
          this.editSelected({ description: (event.target as HTMLTextAreaElement).value })}
      ></textarea>

      <div class="sud-files">
        <div class="sud-files__title">${bundle.files.size} files · ${bundle.sourceLabel}</div>
        <ul class="sud-files__list">
          ${[...bundle.files.keys()].slice(0, 12).map(path => html`<li><code>${path}</code></li>`)}
          ${bundle.files.size > 12
            ? html`<li class="sud-files__more">…and ${bundle.files.size - 12} more</li>`
            : nothing}
        </ul>
      </div>
    `;
  }

  private renderFooter() {
    const uploadable = this.uploadable.length;
    const blocked = this.bundles.length - uploadable;
    const current = this.selected ? this.progress.get(this.selected.id) : undefined;
    const percent =
      current && current.total > 0 ? Math.round((current.loaded / current.total) * 100) : 0;

    return html`
      <div class="sud-footer">
        <div class="sud-status">
          ${this.finished
            ? html`<span class="sud-status__done"
                >${this.icon('check')} ${this.uploadedCount} of ${uploadable} uploaded</span
              >`
            : html`<span
                >${uploadable} item${uploadable === 1 ? '' : 's'}
                ready${blocked > 0 ? ` · ${blocked} blocked` : ''}</span
              >`}
          ${this.uploading
            ? html`<div class="sud-progress">
                <div class="sud-progress__bar" style=${`width:${percent}%`}></div>
              </div>`
            : nothing}
        </div>
        ${this.uploading
          ? html`<button
              type="button"
              class="sud-btn sud-btn--ghost"
              @click=${() => this.cancelUpload()}
            >
              ${this.icon('x')}<span>Cancel</span>
            </button>`
          : this.finished
            ? html`<button
                type="button"
                class="sud-btn sud-btn--primary"
                @click=${() => this.close()}
              >
                Done
              </button>`
            : html`
                <button
                  type="button"
                  class="sud-btn sud-btn--ghost"
                  ?disabled=${uploadable === 0}
                  @click=${() => void this.startUpload('draft')}
                >
                  ${this.icon('upload')}<span>Upload as drafts</span>
                </button>
                <button
                  type="button"
                  class="sud-btn sud-btn--primary"
                  ?disabled=${uploadable === 0}
                  @click=${() => void this.startUpload('published')}
                >
                  ${this.icon('check')}<span>Upload &amp; publish</span>
                </button>
              `}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-store-upload-dialog': StoreUploadDialog;
  }
}
