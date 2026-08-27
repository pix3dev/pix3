import type { PropertyValues } from 'lit';
import { subscribe } from 'valtio/vanilla';
import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { appState } from '@/state';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { AgentChatService } from '@/services/agent/AgentChatService';
import { IconService, IconSize } from '@/services/editor/IconService';
import { LightboxService, type LightboxItem } from '@/services/editor/LightboxService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import type { FlowPlan, FlowPlanStep } from '@/services/flow/FlowPlanService';
import type { FlowStage } from '@/services/flow/FlowStageService';
import {
  FlowReferencesService,
  type FlowReferenceItem,
  type FlowReferenceList,
  type FlowReferenceRole,
} from '@/services/flow/FlowReferencesService';
import { DeleteReferenceCommand } from '@/features/flow/DeleteReferenceCommand';
import { MakeStyleCommand } from '@/features/flow/MakeStyleCommand';
import {
  ATTACHMENT_ROLES,
  attachmentRoleHint,
  attachmentRoleLabel,
  dragCarriesFiles,
  formatAttachmentSize,
} from '@/ui/shared/composer-attachments';
import { ensureLightboxHost } from '@/ui/shared/pix3-lightbox';
import './pix3-flow-side-panel.ts.css';

const EMPTY_PLAN: FlowPlan = { pitch: null, title: null, steps: [] };

/** Which tab is showing. At the idea stage there is no plan, so only `files` exists. */
type SidePanelTab = 'plan' | 'files';

/** Same key the shell used while the plan was the only thing in this column. */
const PANEL_OPEN_KEY = 'pix3.flow.planOpen:v1';
const PANEL_TAB_KEY = 'pix3.flow.sidePanelTab:v1';

/**
 * Tool names whose success means the file list on screen is out of date. `fs_write` is in here for
 * the same reason it is in the document's set — the agent writes references and captions with it.
 */
const FILE_TOUCHING_TOOLS = new Set(['generate_asset', 'fs_write', 'fs_delete', 'process_asset']);

/** Coalescing window for refreshes: one agent turn can write a dozen files in a burst. */
const REFRESH_DEBOUNCE_MS = 120;

const loadPanelOpen = (): boolean => {
  try {
    return localStorage.getItem(PANEL_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
};

const persistPanelOpen = (open: boolean): void => {
  try {
    localStorage.setItem(PANEL_OPEN_KEY, open ? '1' : '0');
  } catch {
    // A forgotten preference must never break the shell.
  }
};

const loadPanelTab = (): SidePanelTab => {
  try {
    return localStorage.getItem(PANEL_TAB_KEY) === 'files' ? 'files' : 'plan';
  } catch {
    return 'plan';
  }
};

const persistPanelTab = (tab: SidePanelTab): void => {
  try {
    localStorage.setItem(PANEL_TAB_KEY, tab);
  } catch {
    // Same as above.
  }
};

/**
 * The Flow right sidebar: **Plan** (the increment checklist) and **Files** (every artefact of the
 * project), collapsible to a rail.
 *
 * One tabbed column rather than two panels: two open at once eat the stage on a laptop (design
 * §3.6), and they are rarely both wanted. At the idea stage only Files exists — `design/progress.md`
 * is written by the recipe expander, so a Plan tab there would be an affordance with no meaning.
 *
 * Three properties of the Files tab carry the feature:
 *  - **It is a list of arbitrary files, not a picture gallery.** Markdown, csv, pdf, zip and glb all
 *    belong here; only pictures get a thumbnail and a role chip. References mostly arrive from the
 *    user (drop, "+"), not from a generator, and a panel that showed only generated art would send
 *    them to Studio to look for their own files.
 *  - **The user's delete goes through the mutation gateway.** `DeleteReferenceCommand` keeps the
 *    bytes in an undo closure; the agent's own `fs_delete` stays outside history, as all its edits do.
 *  - **Thumbnail blob URLs are diff-revoked** (`AssetsPreviewService.objectUrls` pattern): the list
 *    refreshes on every agent turn, so minting without releasing leaks a thumbnail per turn.
 */
@customElement('pix3-flow-side-panel')
export class Pix3FlowSidePanel extends ComponentBase {
  @inject(IconService)
  private readonly icons!: IconService;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(FlowReferencesService)
  private readonly references!: FlowReferencesService;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(LightboxService)
  private readonly lightbox!: LightboxService;

  @inject(AgentChatService)
  private readonly agentChat!: AgentChatService;

  /** Which Flow stage the shell is in — decides whether the Plan tab exists at all. */
  @property({ type: String })
  stage: FlowStage = 'prototype';

  /** The increment checklist, owned and refreshed by the shell (which also reads its title). */
  @property({ attribute: false })
  plan: FlowPlan = EMPTY_PLAN;

  @property({ type: Boolean, attribute: 'agent-running' })
  agentRunning = false;

  /** Tool the agent is running right now; a file-touching one refreshes the list mid-turn. */
  @property({ type: String, attribute: 'active-tool' })
  activeTool: string | null = null;

  /** Reflected so the panel's collapsed width lives in CSS rather than in an inline style. */
  @property({ type: Boolean, reflect: true })
  collapsed = !loadPanelOpen();

  @state()
  private tab: SidePanelTab = loadPanelTab();

  @state()
  private list: FlowReferenceList | null = null;

  @state()
  private dragging = false;

  @state()
  private busy = false;

  /** Why some dropped files were skipped. Inline next to the list, never a modal. */
  @state()
  private warnings: readonly string[] = [];

  /** Project-relative path → object URL, for the thumbnails currently on screen. */
  private readonly thumbnails = new Map<string, string>();

  private disposeProject?: () => void;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  /** Generation counter: a slow listing must not overwrite a newer one. */
  private refreshToken = 0;
  /** Nested dragenter/dragleave pairs fire per child element; count them instead of toggling. */
  private dragDepth = 0;

  connectedCallback(): void {
    super.connectedCallback();
    // The overlay lives on `document.body`, outside every panel that clips with `overflow: hidden`.
    ensureLightboxHost();
    // Every storage write bumps this signal, so it covers the agent's writes, our own, and the
    // file a history undo puts back — none of which this component would otherwise hear about.
    this.disposeProject = subscribe(appState.project, () => this.scheduleRefresh());
    this.scheduleRefresh();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.disposeProject?.();
    this.disposeProject = undefined;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.refreshToken++;
    // Nothing else owns these URLs, so the component must release them all on the way out.
    for (const url of this.thumbnails.values()) {
      URL.revokeObjectURL(url);
    }
    this.thumbnails.clear();
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has('activeTool') && this.activeTool && FILE_TOUCHING_TOOLS.has(this.activeTool)) {
      // Mid-turn: a generated moodboard shows up while the agent is still writing about it.
      this.scheduleRefresh();
    }
    if (changed.has('agentRunning') && changed.get('agentRunning') === true && !this.agentRunning) {
      this.scheduleRefresh();
    }
    if (changed.has('stage')) {
      this.scheduleRefresh();
    }
  }

  /** Coalesce refreshes: one agent turn can write a dozen files, and each write bumps the signal. */
  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  /** Re-read the file list. Public so the shell can force it after its own mutations. */
  async refresh(): Promise<void> {
    if (appState.project.status !== 'ready') {
      this.list = null;
      return;
    }
    const token = ++this.refreshToken;
    let list: FlowReferenceList;
    try {
      list = await this.references.list();
    } catch {
      // A listing failure leaves the previous list on screen: an empty column would read as "your
      // files are gone", which is a worse answer than a stale one.
      return;
    }
    if (token !== this.refreshToken) {
      return;
    }
    await this.syncThumbnails(list, token);
    if (token !== this.refreshToken) {
      return;
    }
    this.list = list;
  }

  /** Mint object URLs for newly listed pictures, then release the ones that left the list. */
  private async syncThumbnails(list: FlowReferenceList, token: number): Promise<void> {
    const wanted = new Set(
      allItems(list)
        .filter(item => item.kind === 'image')
        .map(item => item.path)
    );
    for (const path of wanted) {
      if (this.thumbnails.has(path)) {
        continue;
      }
      try {
        const blob = await this.storage.readBlob(path);
        if (token !== this.refreshToken) {
          return;
        }
        this.thumbnails.set(path, URL.createObjectURL(blob));
      } catch {
        // Unreadable (mid-write, or a broken file): the card falls back to its type icon.
      }
    }
    if (token !== this.refreshToken) {
      return;
    }
    for (const [path, url] of [...this.thumbnails]) {
      if (!wanted.has(path)) {
        URL.revokeObjectURL(url);
        this.thumbnails.delete(path);
      }
    }
  }

  // -- actions ---------------------------------------------------------------

  private readonly onToggleCollapsed = (): void => {
    this.collapsed = !this.collapsed;
    persistPanelOpen(!this.collapsed);
    // The stage column just changed width; the shell re-letterboxes the game on this event.
    void this.updateComplete.then(() => {
      this.dispatchEvent(new CustomEvent('panel-resize', { bubbles: true, composed: true }));
    });
  };

  private selectTab(tab: SidePanelTab): void {
    this.tab = tab;
    persistPanelTab(tab);
  }

  private readonly onDragOver = (event: DragEvent): void => {
    if (!dragCarriesFiles(event)) {
      return;
    }
    // Without preventDefault the browser navigates to the dropped file instead of giving it to us.
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    this.dragging = true;
  };

  private readonly onDragEnter = (event: DragEvent): void => {
    if (!dragCarriesFiles(event)) {
      return;
    }
    this.dragDepth += 1;
    this.dragging = true;
  };

  private readonly onDragLeave = (): void => {
    // dragenter/dragleave fire for every child crossed, so the highlight is depth-counted.
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) {
      this.dragging = false;
    }
  };

  private readonly onDrop = (event: DragEvent): void => {
    if (!dragCarriesFiles(event)) {
      return;
    }
    event.preventDefault();
    this.dragDepth = 0;
    this.dragging = false;
    const files = Array.from(event.dataTransfer?.files ?? []);
    void this.addFiles(files);
  };

  private readonly onPickFiles = (): void => {
    this.querySelector<HTMLInputElement>('.side-panel__file-input')?.click();
  };

  private readonly onFileInput = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    // Reset so picking the same file twice in a row fires `change` the second time too.
    input.value = '';
    void this.addFiles(files);
  };

  private async addFiles(files: readonly File[]): Promise<void> {
    if (files.length === 0) {
      return;
    }
    // A drop lands on the Files tab whichever tab was showing: the user aimed at the column.
    if (this.tab !== 'files') {
      this.selectTab('files');
    }
    this.busy = true;
    try {
      const result = await this.references.addFiles(files);
      this.warnings = result.warnings;
    } finally {
      this.busy = false;
    }
    await this.refresh();
  }

  /** Cycle a picture's role chip. `style-candidate` lands on `style` — the three roles are the cycle. */
  private async onCycleRole(item: FlowReferenceItem): Promise<void> {
    // `style-candidate` and an unset role both land on index -1, so the cycle starts at `style`.
    const current = ATTACHMENT_ROLES.findIndex(role => role === item.role);
    const next = ATTACHMENT_ROLES[(current + 1) % ATTACHMENT_ROLES.length];
    await this.references.setRole(item.name, next);
    await this.refresh();
  }

  /**
   * Answer the moodboard by clicking, not by typing (design §3.9).
   *
   * The whole point of the button is that the choice costs no turn: the palette is measured from
   * the image and `design/style.md` is written by code, so the look the user picked is exactly the
   * look the project carries — no model in between to paraphrase the colours.
   */
  private async onMakeStyle(item: FlowReferenceItem): Promise<void> {
    this.busy = true;
    try {
      await this.commandDispatcher.execute(new MakeStyleCommand({ path: item.path }));
    } finally {
      this.busy = false;
    }
    await this.refresh();
  }

  private async onDelete(item: FlowReferenceItem): Promise<void> {
    await this.commandDispatcher.execute(new DeleteReferenceCommand({ path: item.path }));
    // Refresh regardless of the result: a delete the user declined leaves the list correct anyway,
    // and a non-undoable delete reports no history push while the file really is gone.
    await this.refresh();
  }

  /**
   * "Regenerate" is a composer prefill, not a turn of ours: the user reviews and sends it, and the
   * conversation is not reset (a fresh conversation would throw away the discussion that produced
   * the asset in the first place).
   */
  private onRegenerate(item: FlowReferenceItem): void {
    const prompt = item.caption ? `\n\nThe prompt that produced it: "${item.caption}"` : '';
    this.agentChat.composePrefill(
      `Regenerate \`res://${item.path}\` — same path, another attempt.${prompt}`
    );
  }

  /** Open the lightbox on this item, with the same-kind siblings behind the arrow keys. */
  private async onExpand(item: FlowReferenceItem): Promise<void> {
    if (item.missing) {
      return;
    }
    const siblings = allItems(this.list).filter(candidate => candidate.kind === item.kind);
    const items = await Promise.all(siblings.map(candidate => this.toLightboxItem(candidate)));
    const index = Math.max(
      0,
      siblings.findIndex(candidate => candidate.path === item.path)
    );
    this.lightbox.open(items, index);
  }

  private async toLightboxItem(item: FlowReferenceItem): Promise<LightboxItem> {
    const base = {
      title: item.name,
      path: item.path,
      ...(item.sizeBytes !== null ? { sizeBytes: item.sizeBytes } : {}),
    };
    if (item.kind === 'image') {
      const url = this.thumbnails.get(item.path);
      // No blob URL means the file could not be read; `other` is the honest "no preview" case.
      return url ? { ...base, kind: 'image', url } : { ...base, kind: 'other' };
    }
    if (item.kind === 'markdown' || item.kind === 'text') {
      try {
        return { ...base, kind: item.kind, text: await this.storage.readTextFile(item.path) };
      } catch {
        return { ...base, kind: 'other' };
      }
    }
    return { ...base, kind: 'other' };
  }

  // -- render ----------------------------------------------------------------

  protected render() {
    const tab = this.effectiveTab();
    return html`
      <div
        class="side-panel ${this.dragging ? 'side-panel--drag' : ''}"
        @dragenter=${this.onDragEnter}
        @dragover=${this.onDragOver}
        @dragleave=${this.onDragLeave}
        @drop=${this.onDrop}
      >
        ${this.renderHead(tab)}
        ${this.collapsed ? null : tab === 'plan' ? this.renderPlanSteps() : this.renderFiles()}
        <input
          class="side-panel__file-input"
          type="file"
          multiple
          aria-hidden="true"
          tabindex="-1"
          @change=${this.onFileInput}
        />
      </div>
    `;
  }

  /** At the idea stage the plan does not exist, so the stored tab cannot select it. */
  private effectiveTab(): SidePanelTab {
    return this.stage === 'idea' ? 'files' : this.tab;
  }

  private renderHead(tab: SidePanelTab) {
    const label = this.collapsed ? 'Show panel' : 'Hide panel';
    return html`
      <div class="side-panel__head">
        <button
          class="side-panel__toggle"
          type="button"
          aria-expanded=${this.collapsed ? 'false' : 'true'}
          title=${label}
          aria-label=${label}
          @click=${this.onToggleCollapsed}
        >
          ${this.icons.getIcon(this.collapsed ? 'list' : 'chevron-right', IconSize.SMALL)}
        </button>
        ${this.collapsed ? this.renderRailSummary(tab) : this.renderTabs(tab)}
      </div>
    `;
  }

  /** Collapsed rail: the numbers that made the user open it, and nothing else. */
  private renderRailSummary(tab: SidePanelTab) {
    if (tab === 'plan') {
      const progress = this.planProgress();
      return progress ? html`<span class="side-panel__count">${progress}</span>` : null;
    }
    const count = this.list ? this.list.references.length + this.list.sources.length : 0;
    return count > 0 ? html`<span class="side-panel__count">${count}</span>` : null;
  }

  private renderTabs(tab: SidePanelTab) {
    const showPlanTab = this.stage !== 'idea';
    return html`
      <div class="side-panel__tabs" role="tablist" aria-label="Sidebar">
        ${showPlanTab
          ? html`
              <button
                class="side-panel__tab ${tab === 'plan' ? 'side-panel__tab--active' : ''}"
                type="button"
                role="tab"
                aria-selected=${tab === 'plan' ? 'true' : 'false'}
                @click=${() => this.selectTab('plan')}
              >
                <span>Plan</span>
                ${this.planProgress()
                  ? html`<span class="side-panel__count">${this.planProgress()}</span>`
                  : null}
              </button>
            `
          : null}
        <button
          class="side-panel__tab ${tab === 'files' ? 'side-panel__tab--active' : ''}"
          type="button"
          role="tab"
          aria-selected=${tab === 'files' ? 'true' : 'false'}
          @click=${() => this.selectTab('files')}
        >
          <span>Files</span>
        </button>
      </div>
      ${tab === 'files'
        ? html`
            <button
              class="side-panel__add"
              type="button"
              title="Add files to the references folder"
              aria-label="Add files"
              ?disabled=${this.busy}
              @click=${this.onPickFiles}
            >
              ${this.icons.getIcon('plus', IconSize.SMALL)}
            </button>
          `
        : null}
    `;
  }

  private planProgress(): string {
    const total = this.plan.steps.length;
    if (total === 0) {
      return '';
    }
    return `${this.plan.steps.filter(step => step.status === 'done').length}/${total}`;
  }

  // -- plan tab (moved verbatim from the shell) ------------------------------

  private renderPlanSteps() {
    if (this.plan.steps.length === 0) {
      return html`
        <div class="flow-plan flow-plan--empty">
          ${this.agentRunning
            ? html`<span class="flow-plan__spinner"></span><span>Working…</span>`
            : html`<span>No plan yet — ask for a change and the steps appear here.</span>`}
        </div>
      `;
    }
    return html`
      <div class="flow-plan" role="list">
        ${this.plan.steps.map(step => this.renderPlanStep(step))}
        ${this.agentRunning
          ? html`<span class="flow-plan__working"
              ><span class="flow-plan__spinner"></span><span>Working…</span></span
            >`
          : null}
      </div>
    `;
  }

  private renderPlanStep(step: FlowPlanStep) {
    const icon =
      step.status === 'done' ? 'check-circle' : step.status === 'active' ? 'loader' : 'circle';
    return html`
      <span class="flow-plan__step flow-plan__step--${step.status}" role="listitem">
        ${this.icons.getIcon(icon, IconSize.SMALL)}
        <span class="flow-plan__body">
          <span class="flow-plan__label">${step.title}</span>
          ${step.note ? html`<span class="flow-plan__note">${step.note}</span>` : null}
        </span>
      </span>
    `;
  }

  // -- files tab -------------------------------------------------------------

  private renderFiles() {
    const list = this.list;
    return html`
      <div class="ref-list">
        ${this.warnings.length > 0
          ? html`<div class="ref-list__warnings" role="status">
              ${this.warnings.map(warning => html`<span>${warning}</span>`)}
            </div>`
          : null}
        ${list ? this.renderCard(list.document) : null}
        ${this.renderGroup('References', list?.references ?? [], 'Drop files here, or use +.')}
        ${list && list.sources.length > 0 ? this.renderGroup('Sources', list.sources, '') : null}
        <div class="ref-list__hint">${this.dragging ? 'Drop to add to references' : ''}</div>
      </div>
    `;
  }

  private renderGroup(title: string, items: readonly FlowReferenceItem[], empty: string) {
    return html`
      <div class="ref-group">
        <span class="ref-group__title">${title}</span>
        ${items.length === 0
          ? empty
            ? html`<span class="ref-group__empty">${empty}</span>`
            : null
          : items.map(item => this.renderCard(item))}
      </div>
    `;
  }

  private renderCard(item: FlowReferenceItem) {
    const caption = item.caption ?? item.previewLine;
    return html`
      <div class="ref-card ${item.pinned ? 'ref-card--pinned' : ''}" role="listitem">
        <button
          class="ref-card__body"
          type="button"
          ?disabled=${item.missing}
          title=${item.missing ? `${item.path} does not exist yet` : `Open ${item.path}`}
          @click=${() => void this.onExpand(item)}
        >
          <span class="ref-card__thumb">${this.renderThumb(item)}</span>
          <span class="ref-card__text">
            <span class="ref-card__name">${item.name}</span>
            <span class="ref-card__meta">${this.describeMeta(item, caption)}</span>
          </span>
        </button>
        <span class="ref-card__actions">
          ${item.role
            ? html`
                <button
                  class="ref-card__chip"
                  type="button"
                  title=${roleTitle(item.role)}
                  @click=${() => void this.onCycleRole(item)}
                >
                  ${roleChipLabel(item.role)}
                </button>
              `
            : null}
          ${canBecomeStyle(item)
            ? html`
                <button
                  class="ref-card__action"
                  type="button"
                  title="Make this the project style — measures its palette and writes design/style.md"
                  aria-label=${`Make ${item.name} the style`}
                  @click=${() => void this.onMakeStyle(item)}
                >
                  ${this.icons.getIcon('droplet', IconSize.SMALL)}
                </button>
              `
            : null}
          ${item.origin === 'agent' && !item.pinned && !item.readOnly
            ? html`
                <button
                  class="ref-card__action"
                  type="button"
                  title="Ask the agent for another attempt"
                  aria-label="Regenerate"
                  @click=${() => this.onRegenerate(item)}
                >
                  ${this.icons.getIcon('refresh-cw', IconSize.SMALL)}
                </button>
              `
            : null}
          ${item.pinned || item.readOnly
            ? null
            : html`
                <button
                  class="ref-card__action ref-card__action--danger"
                  type="button"
                  title="Delete this file"
                  aria-label=${`Delete ${item.name}`}
                  @click=${() => void this.onDelete(item)}
                >
                  ${this.icons.getIcon('trash-2', IconSize.SMALL)}
                </button>
              `}
        </span>
      </div>
    `;
  }

  private renderThumb(item: FlowReferenceItem) {
    const url = item.kind === 'image' ? this.thumbnails.get(item.path) : undefined;
    if (url) {
      return html`<img class="ref-card__image" src=${url} alt="" />`;
    }
    return this.icons.getIcon(kindIcon(item), IconSize.SMALL);
  }

  /** One line under the name: what it is for, where it came from, how big it is. */
  private describeMeta(item: FlowReferenceItem, caption: string | null): string {
    if (item.missing) {
      return 'not written yet';
    }
    if (caption) {
      return caption;
    }
    const parts: string[] = [item.readOnly ? 'attached' : item.origin];
    if (item.sizeBytes !== null) {
      parts.push(formatAttachmentSize(item.sizeBytes));
    }
    return parts.join(' · ');
  }
}

const allItems = (list: FlowReferenceList | null): readonly FlowReferenceItem[] =>
  list ? [list.document, ...list.references, ...list.sources] : [];

/** Feather name for a file the panel cannot show a picture of. Vector always, never a glyph. */
const kindIcon = (item: FlowReferenceItem): string => {
  if (item.kind === 'markdown' || item.kind === 'text') {
    return 'file-text';
  }
  if (item.kind === 'image') {
    return 'image';
  }
  const ext = item.name.toLowerCase().split('.').pop() ?? '';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive';
  if (['glb', 'gltf', 'obj', 'fbx'].includes(ext)) return 'box';
  if (['wav', 'mp3', 'ogg', 'flac'].includes(ext)) return 'music';
  if (['mp4', 'webm', 'mov'].includes(ext)) return 'film';
  if (['ttf', 'otf', 'woff', 'woff2'].includes(ext)) return 'type';
  return 'file';
};

/**
 * Whether the card offers "make it the style".
 *
 * Raster images under `references/` only — the palette is read from pixels, so an SVG or a text
 * file would adopt an empty one. The picture already carrying the `style` role is skipped: the
 * button would rewrite the same three files with the same contents and push a no-op onto history.
 */
const canBecomeStyle = (item: FlowReferenceItem): boolean =>
  item.kind === 'image' &&
  !item.pinned &&
  !item.readOnly &&
  !item.missing &&
  item.role !== 'style' &&
  /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(item.name);

const roleChipLabel = (role: FlowReferenceRole): string =>
  role === 'style-candidate' ? 'candidate' : attachmentRoleLabel(role);

const roleTitle = (role: FlowReferenceRole): string =>
  role === 'style-candidate'
    ? 'A style candidate from a moodboard turn — click to set a role'
    : `${attachmentRoleHint(role)} (click to change)`;

declare global {
  interface HTMLElementTagNameMap {
    'pix3-flow-side-panel': Pix3FlowSidePanel;
  }
}
