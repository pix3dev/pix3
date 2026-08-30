import type { PropertyValues } from 'lit';
import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import {
  AgentChatService,
  type AgentChatState,
  type AgentTextAttachment,
} from '@/services/agent/AgentChatService';
import { DialogService } from '@/services/editor/DialogService';
import { IconService, IconSize } from '@/services/editor/IconService';
import { LightboxService, type LightboxItem } from '@/services/editor/LightboxService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import {
  DECISIONS_PATH,
  extractDecisionEntries,
  type DecisionEntry,
} from '@/services/flow/decision-log';
import { renderMarkdownLite } from '@/ui/agent-chat/markdown-lite';
import { ensureLightboxHost } from '@/ui/shared/pix3-lightbox';
import './pix3-idea-doc.ts.css';

/** Tool names whose success means the document on screen is out of date. */
const DOC_TOUCHING_TOOLS = new Set(['fs_write', 'str_replace', 'record_decision']);

/**
 * Images the document may inline. Only these get a blob URL: the scan hits every `res://` link in
 * the source, and reading a scene or a whole source document into an object URL would cost memory
 * for something the renderer cannot show anyway.
 */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i;

/** Every `res://…` reference in the markdown source, image or not. */
const RES_REFERENCE = /res:\/\/[^\s)'"<>\]]+/g;

/** How much of the rendered selection is quoted back as the "focus" hint. */
const FOCUS_HINT_LIMIT = 200;

/**
 * A selection inside the rendered document, resolved back to the markdown source.
 *
 * `startLine`/`endLine` are 0-based inclusive line indices into {@link Pix3IdeaDoc.source} — the
 * snapshot that was rendered, never "the current file", which the agent may already have rewritten.
 */
interface IdeaDocSelection {
  readonly startLine: number;
  readonly endLine: number;
  /** The source slice covering the selected blocks — valid markdown, and a `str_replace` needle. */
  readonly slice: string;
  /** What the user actually highlighted, as rendered text (a hint, not the edit target). */
  readonly rendered: string;
}

/**
 * The idea-stage design document: the game's brief (`design/gdd.md`) rendered as readable HTML in
 * the place the game stage occupies on the prototype stage.
 *
 * Three properties carry the feature and are easy to break:
 *  - **The file is the truth, not this component's state.** Everything the user and the agent agree
 *    on lives in the project file (design §1.2 principle 8), so this component only ever reads,
 *    re-reads and — for the explicit "edit source" escape hatch — writes it back whole.
 *  - **It re-reads on the agent's writes.** The agent edits the document mid-turn; a document that
 *    only refreshed when the turn ended would look frozen through the most interesting part.
 *  - **Blob URLs are diff-revoked.** A document with references re-renders on every agent turn, so
 *    minting object URLs without releasing the vanished ones leaks a few hundred KB per turn. Same
 *    pattern as `AssetsPreviewService.objectUrls`: revoke what left, revoke everything on detach.
 */
@customElement('pix3-idea-doc')
export class Pix3IdeaDoc extends ComponentBase {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(AgentChatService)
  private readonly agentChat!: AgentChatService;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  @inject(IconService)
  private readonly iconService!: IconService;

  @inject(LightboxService)
  private readonly lightbox!: LightboxService;

  /** Project-relative path of the document to render. */
  @property({ type: String, attribute: 'doc-path' })
  docPath = 'design/gdd.md';

  /** Markdown source as last read — the snapshot every rendered block is anchored to. */
  @state()
  private source = '';

  @state()
  private missing = false;

  /** Source-editing escape hatch: the rendered document is replaced by a raw textarea. */
  @state()
  private editing = false;

  /** The textarea's contents while editing; only Save moves it into the file. */
  @state()
  private draft = '';

  @state()
  private saving = false;

  /** Mirrors the agent's turn state — Save/Edit must not race a turn that rewrites the file. */
  @state()
  private agentRunning = false;

  /**
   * Settled forks from `design/decisions.md`, parsed with the same reader the planner uses.
   *
   * Shown here rather than duplicated into the document: one truth per fact (design §3.8), and the
   * user gets to see exactly what the transition will carry into the prototype.
   */
  @state()
  private decisions: DecisionEntry[] = [];

  @state()
  private decisionsOpen = true;

  /** Line range of the fragment already staged as a chip — re-selecting the same one is a no-op. */
  private stagedRange: string | null = null;

  /** `res://` path → object URL, for images currently referenced by {@link source}. */
  private readonly blobUrls = new Map<string, string>();

  private disposeAgent?: () => void;
  /** Tool name seen on the previous agent-state tick, so a write is reacted to once. */
  private lastTool: string | null = null;
  /** Whether the previous tick was mid-turn, so the end of a turn triggers exactly one re-read. */
  private wasRunning = false;
  /** Generation counter: a slow read must not overwrite the result of a newer one. */
  private reloadToken = 0;

  connectedCallback(): void {
    super.connectedCallback();
    // The overlay lives on `document.body`, outside every panel that clips with `overflow: hidden`.
    ensureLightboxHost();
    this.disposeAgent = this.agentChat.subscribe(state => this.onAgentState(state));
    // `selectionchange` is the only event that fires when a selection is *dropped* — pointerup
    // never reports the click that deselects.
    document.addEventListener('selectionchange', this.onSelectionChange);
    void this.reload();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.disposeAgent?.();
    this.disposeAgent = undefined;
    document.removeEventListener('selectionchange', this.onSelectionChange);
    // The chip stands for a selection in *this* view; leaving the view takes it back with us.
    this.retractSelection();
    // Nothing else owns these URLs, so the component must release them all on the way out.
    for (const url of this.blobUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this.blobUrls.clear();
    this.reloadToken++;
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has('docPath') && changed.get('docPath') !== undefined) {
      // Everything below belonged to the previous file: a chip anchored to its line numbers, and a
      // draft of its source. The shell asks {@link confirmLeave} before it gets here, so a draft
      // still standing at this point is one the user agreed to drop.
      this.retractSelection();
      this.editing = false;
      this.draft = '';
      void this.reload();
    }
  }

  protected updated(): void {
    this.makeImagesExpandable();
  }

  /**
   * Whether this element may be pointed at another document. Asked by the shell before it swaps
   * `docPath`: source edits live in {@link draft} until Save, so an unguarded swap would throw away
   * typed text — the same loss {@link onCancel} refuses to take silently.
   */
  async confirmLeave(): Promise<boolean> {
    return this.confirmDiscardDraft(
      'The document has unsaved changes. Discard them and open the other document?'
    );
  }

  /**
   * Re-read the decision log. Separate from {@link reload} because it fails independently: a
   * project with no `design/decisions.md` still has a document to show, and a document that failed
   * to read must not blank a decision list that is perfectly readable.
   */
  private async reloadDecisions(): Promise<void> {
    try {
      const text = await this.storage.readTextFile(DECISIONS_PATH);
      this.decisions = extractDecisionEntries(text);
    } catch {
      this.decisions = [];
    }
  }

  /** Re-read the document from disk. Public so the shell can refresh it after a stage change. */
  async reload(): Promise<void> {
    void this.reloadDecisions();
    const token = ++this.reloadToken;
    let text: string;
    try {
      text = await this.storage.readTextFile(this.docPath);
    } catch {
      if (token !== this.reloadToken) {
        return;
      }
      this.source = '';
      this.stagedRange = null;
      this.missing = true;
      this.syncImageBlobs('', token);
      return;
    }
    if (token !== this.reloadToken) {
      return;
    }
    // Resolve blobs before publishing the source: rendering first would flash a "missing image"
    // plaque for every reference on every refresh.
    await this.resolveImageBlobs(text, token);
    if (token !== this.reloadToken) {
      return;
    }
    // Anchors point into the snapshot that was rendered; a new source invalidates them.
    this.stagedRange = null;
    this.source = text;
    this.missing = false;
  }

  /** Load object URLs for newly referenced images, then release the ones that left the document. */
  private async resolveImageBlobs(source: string, token: number): Promise<void> {
    const wanted = collectImagePaths(source);
    for (const path of wanted) {
      if (this.blobUrls.has(path)) {
        continue;
      }
      try {
        const blob = await this.storage.readBlob(path);
        if (token !== this.reloadToken) {
          return;
        }
        this.blobUrls.set(path, URL.createObjectURL(blob));
      } catch {
        // A missing reference is normal (the agent writes the link before generating the art) —
        // leave it unresolved so the renderer shows the file-name plaque.
      }
    }
    if (token !== this.reloadToken) {
      return;
    }
    this.syncImageBlobs(source, token);
  }

  private syncImageBlobs(source: string, token: number): void {
    if (token !== this.reloadToken) {
      return;
    }
    const wanted = collectImagePaths(source);
    for (const [path, url] of [...this.blobUrls]) {
      if (!wanted.has(path)) {
        URL.revokeObjectURL(url);
        this.blobUrls.delete(path);
      }
    }
  }

  private readonly resolveImage = (src: string): string | null => {
    const path = stripResPrefix(src);
    return this.blobUrls.get(path) ?? null;
  };

  private onAgentState(state: AgentChatState): void {
    // A started turn flushed the composer's attachments, chip included: the same fragment must be
    // stageable again without the user having to select something else first.
    if (!this.wasRunning && state.status === 'running') {
      this.stagedRange = null;
    }
    this.agentRunning = state.status === 'running';
    const tool = state.activeTool ?? null;
    if (tool !== this.lastTool) {
      this.lastTool = tool;
      // Re-read while the turn is still running: the agent edits the document mid-turn, and a doc
      // that only refreshed at the end would look frozen through the most interesting part.
      if (tool && DOC_TOUCHING_TOOLS.has(tool)) {
        void this.reload();
      }
    }
    if (this.wasRunning && state.status !== 'running') {
      void this.reload();
    }
    this.wasRunning = state.status === 'running';
  }

  /**
   * Expand the whole document. It goes in as `markdown`, not as a screenshot: the lightbox renders
   * it through the same `markdown-lite` doc mode, so a full-screen read costs no second renderer.
   */
  private onExpandDocument(): void {
    ensureLightboxHost();
    this.lightbox.open([
      { kind: 'markdown', title: this.documentTitle(), text: this.source, path: this.docPath },
    ]);
  }

  /** The document's H1, or its file name while the agent has not written a heading yet. */
  private documentTitle(): string {
    const heading = this.source.match(/^#\s+(.+)$/m);
    return heading ? heading[1].trim() : fileNameOf(this.docPath);
  }

  /**
   * Turn the rendered images into keyboard-operable buttons.
   *
   * Done to the DOM after each render rather than in a template, because `markdown-lite` owns that
   * markup and stays a pure renderer (no IconService, no lightbox). `role="button"` + `tabindex`
   * plus {@link onBodyKeyDown} is what makes this an affordance the keyboard can reach — a bare
   * `<img>` with a delegated click handler would be mouse-only.
   */
  private makeImagesExpandable(): void {
    for (const image of this.documentImages()) {
      if (image.getAttribute('role') === 'button') {
        continue;
      }
      image.setAttribute('role', 'button');
      image.setAttribute('tabindex', '0');
      image.title = 'Show larger';
      image.setAttribute('aria-label', image.alt ? `Show larger: ${image.alt}` : 'Show larger');
    }
  }

  /** Every rendered document image, in the order it appears — the lightbox's arrow order. */
  private documentImages(): HTMLImageElement[] {
    return Array.from(this.querySelectorAll<HTMLImageElement>('.idea-doc__body img.md-img'));
  }

  private onBodyClick(event: MouseEvent): void {
    const image = documentImageOf(event);
    if (image) {
      this.openImage(image);
    }
  }

  private onBodyKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    const image = documentImageOf(event);
    if (!image) {
      return;
    }
    // Space would scroll the document and Enter would do nothing — this element is the button.
    event.preventDefault();
    this.openImage(image);
  }

  private openImage(image: HTMLImageElement): void {
    const images = this.documentImages();
    // The blob cache is keyed by path; the DOM only has the URL, so invert it to recover the paths
    // the lightbox shows under each title. The cache stays this component's to revoke.
    const pathByUrl = new Map<string, string>();
    for (const [path, url] of this.blobUrls) {
      pathByUrl.set(url, path);
    }
    const items: LightboxItem[] = images.map(node => {
      const url = node.getAttribute('src') ?? '';
      const path = pathByUrl.get(url);
      return {
        kind: 'image',
        title: node.alt || (path ? fileNameOf(path) : this.docPath),
        url,
        ...(path && { path }),
      };
    });
    ensureLightboxHost();
    this.lightbox.open(items, Math.max(0, images.indexOf(image)));
  }

  // ── Selection → agent context ───────────────────────────────────────────────

  /**
   * Resolve the current DOM selection back to a slice of the markdown source and stage it as the
   * chat's context chip. No toolbar, no confirmation: selecting *is* the gesture, and the chip is a
   * single slot, so the next selection swaps it and a stray click leaves the last one in place.
   *
   * The slice — not `selection.toString()` — is what the agent gets: the rendered text has lost the
   * markdown syntax (`**bold**` reads as "bold"), so a `str_replace` against it would never match.
   * Granularity is whole blocks on purpose: that is exactly coarse enough for the slice to be valid
   * markdown and an exact `str_replace` needle.
   */
  private get selectionSlotKey(): string {
    return `idea-doc:${this.docPath}`;
  }

  /**
   * Take the chip back when the selection it stood for is dropped.
   *
   * Only a collapse *inside the document* counts. Clicking into the chat composer to type the
   * question also collapses the page selection — retracting there would delete the context exactly
   * when the user is about to ask about it — but the caret lands outside this body, so it is left
   * alone.
   */
  private readonly onSelectionChange = (): void => {
    if (this.stagedRange === null) {
      return;
    }
    const body = this.querySelector('.idea-doc__body');
    const selection = document.getSelection();
    if (!body || !selection) {
      return;
    }
    const insideDocument = selection.anchorNode ? body.contains(selection.anchorNode) : false;
    if (selection.isCollapsed && insideDocument) {
      this.retractSelection();
    }
  };

  private retractSelection(): void {
    if (this.stagedRange === null) {
      return;
    }
    this.stagedRange = null;
    this.agentChat.clearComposeContext(this.selectionSlotKey);
  }

  private captureSelection(): void {
    const anchor = this.resolveSelection();
    if (!anchor) {
      return;
    }
    const range = `${anchor.startLine}-${anchor.endLine}`;
    if (range === this.stagedRange) {
      return;
    }
    this.stagedRange = range;
    this.agentChat.composeContext({
      attachment: this.selectionAttachment(anchor),
      // One slot per document: re-selecting swaps the fragment instead of stacking chips.
      replaceKey: this.selectionSlotKey,
    });
  }

  private resolveSelection(): IdeaDocSelection | null {
    const body = this.querySelector('.idea-doc__body');
    const selection = document.getSelection();
    if (!body || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      return null;
    }
    const range = selection.getRangeAt(0);
    if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) {
      return null;
    }
    const start = blockLinesOf(range.startContainer, body);
    const end = blockLinesOf(range.endContainer, body);
    if (!start || !end) {
      return null;
    }
    const startLine = Math.min(start[0], end[0]);
    const endLine = Math.max(start[1], end[1]);
    const slice = this.source
      .split('\n')
      .slice(startLine, endLine + 1)
      .join('\n');
    if (!slice.trim()) {
      return null;
    }
    return { startLine, endLine, slice, rendered: condense(selection.toString()) };
  }

  private readonly onBodyPointerUp = (): void => {
    // After the browser has settled the selection for this gesture.
    requestAnimationFrame(() => this.captureSelection());
  };

  private readonly onBodyKeyUp = (event: KeyboardEvent): void => {
    // Keyboard selections (shift+arrows, ctrl+A) must reach the chip too.
    if (event.shiftKey || event.key === 'Shift' || event.ctrlKey || event.metaKey) {
      this.captureSelection();
    }
  };

  /** The chip that goes to the agent: path, line range, the exact source slice, and the focus hint. */
  private selectionAttachment(anchor: IdeaDocSelection): AgentTextAttachment {
    const from = anchor.startLine + 1;
    const to = anchor.endLine + 1;
    const fence = fenceFor(anchor.slice);
    const focus = anchor.rendered
      ? `\nThe user highlighted this inside the fragment: "${truncate(anchor.rendered, FOCUS_HINT_LIMIT)}"`
      : '';
    return {
      name: `${this.docPath}:${from}–${to}`,
      content:
        [
          `Selected fragment of \`${this.docPath}\`, lines ${from}–${to}.`,
          'Edit it with `str_replace` against this exact text — it matches the file verbatim.',
          '',
          `${fence}markdown`,
          anchor.slice,
          fence,
        ].join('\n') + focus,
    };
  }

  private onEditSource(): void {
    this.draft = this.source;
    this.editing = true;
  }

  private onDraftInput(event: Event): void {
    this.draft = (event.target as HTMLTextAreaElement).value;
  }

  private async onSave(): Promise<void> {
    if (this.saving) {
      return;
    }
    this.saving = true;
    try {
      await this.storage.writeTextFile(this.docPath, this.draft);
      await this.reload();
      this.editing = false;
    } finally {
      this.saving = false;
    }
  }

  private async onCancel(): Promise<void> {
    // Never drop typed text silently: leaving source mode with a dirty draft asks first.
    const discard = await this.confirmDiscardDraft(
      'The document has unsaved changes. Discard them and go back to the preview?'
    );
    if (!discard) {
      return;
    }
    this.editing = false;
    this.draft = '';
  }

  /** `true` when there is nothing to lose, or when the user said the draft may go. */
  private async confirmDiscardDraft(message: string): Promise<boolean> {
    if (!this.editing || this.draft === this.source) {
      return true;
    }
    return this.dialogService.showConfirmation({
      title: 'Discard source edits?',
      message,
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      isDangerous: true,
    });
  }

  protected render() {
    return html`
      <div class="idea-doc">
        ${this.renderToolbar()}
        <div class="idea-doc__scroll">
          ${this.editing ? this.renderSource() : this.renderPreview()}
        </div>
      </div>
    `;
  }

  private renderToolbar() {
    const dirty = this.editing && this.draft !== this.source;
    return html`
      <div class="idea-doc__toolbar">
        <span class="idea-doc__path">${this.docPath}</span>
        ${this.editing
          ? html`
              <button
                type="button"
                class="idea-doc__action idea-doc__action--primary"
                ?disabled=${this.saving || !dirty}
                title=${dirty ? 'Save the document' : 'No changes to save'}
                @click=${() => void this.onSave()}
              >
                ${this.iconService.getIcon('save', IconSize.SMALL)}
                <span>Save</span>
              </button>
              <button
                type="button"
                class="idea-doc__action"
                ?disabled=${this.saving}
                title="Back to the preview"
                @click=${() => void this.onCancel()}
              >
                ${this.iconService.getIcon('x', IconSize.SMALL)}
                <span>Cancel</span>
              </button>
            `
          : html`
              <button
                type="button"
                class="idea-doc__action"
                ?disabled=${this.agentRunning}
                title=${this.agentRunning
                  ? 'The agent is working on the document — wait for the turn to finish'
                  : 'Edit the markdown source'}
                @click=${() => this.onEditSource()}
              >
                ${this.iconService.getIcon('edit-3', IconSize.SMALL)}
                <span>Edit source</span>
              </button>
              <button
                type="button"
                class="idea-doc__action"
                ?disabled=${this.missing}
                title="Read the document full-screen"
                @click=${() => this.onExpandDocument()}
              >
                ${this.iconService.getIcon('maximize-2', IconSize.SMALL)}
                <span>Expand</span>
              </button>
            `}
      </div>
    `;
  }

  private renderSource() {
    return html`
      <textarea
        class="idea-doc__source"
        spellcheck="false"
        aria-label="Markdown source"
        .value=${this.draft}
        @input=${(event: Event) => this.onDraftInput(event)}
      ></textarea>
    `;
  }

  private renderPreview() {
    if (this.missing) {
      return html`
        <div class="idea-doc__empty">
          <p>No design document yet — ask the agent to write one.</p>
        </div>
      `;
    }
    return html`
      <article
        class="idea-doc__body"
        @click=${(event: MouseEvent) => this.onBodyClick(event)}
        @keydown=${(event: KeyboardEvent) => this.onBodyKeyDown(event)}
        @pointerup=${this.onBodyPointerUp}
        @keyup=${this.onBodyKeyUp}
      >
        ${renderMarkdownLite(this.source, { mode: 'doc', resolveImage: this.resolveImage })}
      </article>
      ${this.renderDecisions()}
    `;
  }

  /**
   * The settled forks, under the document.
   *
   * Outside `.idea-doc__body` on purpose: the selection resolver anchors on that element and maps
   * `data-md-lines` back into `gdd.md`'s source. A decision rendered inside it would resolve to
   * line numbers of the wrong file, and the chip would send the agent a fragment that does not
   * exist. Nothing here is selectable-into-context, and that is correct — decisions are settled.
   *
   * Nothing is rendered until there is a decision: an empty "Decisions" box on every new project
   * would be chrome that teaches the user to ignore the section.
   */
  private renderDecisions() {
    // Under the decision log itself the list would be the file's own contents, twice over.
    if (this.decisions.length === 0 || this.docPath === DECISIONS_PATH) {
      return null;
    }
    return html`
      <section class="idea-doc__decisions">
        <button
          type="button"
          class="idea-doc__decisions-header"
          aria-expanded=${this.decisionsOpen ? 'true' : 'false'}
          @click=${() => {
            this.decisionsOpen = !this.decisionsOpen;
          }}
        >
          ${this.iconService.getIcon(
            this.decisionsOpen ? 'chevron-down' : 'chevron-right',
            IconSize.SMALL
          )}
          <span class="idea-doc__decisions-title">Decisions</span>
          <span class="idea-doc__decisions-count">${this.decisions.length}</span>
        </button>
        ${this.decisionsOpen
          ? html`
              <ul class="idea-doc__decisions-list">
                ${this.decisions.map(
                  entry => html`
                    <li class="idea-doc__decision">
                      <span class="idea-doc__decision-q">${entry.question}</span>
                      <span class="idea-doc__decision-a">${entry.choice}</span>
                      ${entry.reason
                        ? html`<span class="idea-doc__decision-why">${entry.reason}</span>`
                        : null}
                      ${entry.rejected.length > 0
                        ? html`<span class="idea-doc__decision-rejected"
                            >rejected: ${entry.rejected.join(', ')}</span
                          >`
                        : null}
                      ${entry.date
                        ? html`<span class="idea-doc__decision-date">${entry.date}</span>`
                        : null}
                    </li>
                  `
                )}
              </ul>
            `
          : null}
      </section>
    `;
  }
}

/** The clicked/keyed element when it is a rendered document image, else `null`. */
function documentImageOf(event: Event): HTMLImageElement | null {
  const target = event.target;
  return target instanceof HTMLImageElement && target.classList.contains('md-img') ? target : null;
}

/** `res://references/hero.png` → `references/hero.png`; any other form is already project-relative. */
function stripResPrefix(src: string): string {
  return src.startsWith('res://') ? src.slice('res://'.length) : src;
}

/** Last path segment — the lightbox header wants a file name, not a sentence. */
function fileNameOf(path: string): string {
  const segments = path.split('/').filter(segment => segment.length > 0);
  return segments[segments.length - 1] ?? path;
}

/** Project-relative paths of every `res://` image the source references. */
function collectImagePaths(source: string): Set<string> {
  const paths = new Set<string>();
  for (const match of source.matchAll(RES_REFERENCE)) {
    const path = stripResPrefix(match[0]);
    if (IMAGE_EXTENSIONS.test(path)) {
      paths.add(path);
    }
  }
  return paths;
}

/**
 * The `data-md-lines` range of the block a selection endpoint sits in, or `null` when the endpoint
 * is not inside an anchored block (`markdown-lite` stamps every block it renders, so this happens
 * only for stray text nodes the renderer did not produce).
 */
function blockLinesOf(node: Node, body: Element): [number, number] | null {
  const element = node instanceof Element ? node : node.parentElement;
  const block = element?.closest('[data-md-lines]');
  if (!block || !body.contains(block)) {
    return null;
  }
  const [start, end] = (block.getAttribute('data-md-lines') ?? '').split('-').map(Number);
  return Number.isFinite(start) && Number.isFinite(end) ? [start, end] : null;
}

/** A fence long enough to survive a slice that itself contains fenced code. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Rendered selections carry the document's line breaks; the hint wants one line. */
function condense(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-idea-doc': Pix3IdeaDoc;
  }
}
