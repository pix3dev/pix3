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
 * A live selection inside the rendered document, resolved back to the markdown source.
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
  /** Viewport coordinates for the floating toolbar (CSS pixels, `position: fixed`). */
  readonly left: number;
  readonly top: number;
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

  /** The live selection inside the rendered document, or `null` when there is none to act on. */
  @state()
  private selection: IdeaDocSelection | null = null;

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
    // `selectionchange` is the only event that fires when a selection is *dropped* (a click
    // elsewhere, Escape, a keyboard collapse) — pointerup alone would leave the toolbar stranded.
    document.addEventListener('selectionchange', this.onSelectionChange);
    void this.reload();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.disposeAgent?.();
    this.disposeAgent = undefined;
    document.removeEventListener('selectionchange', this.onSelectionChange);
    this.selection = null;
    // Nothing else owns these URLs, so the component must release them all on the way out.
    for (const url of this.blobUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this.blobUrls.clear();
    this.reloadToken++;
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has('docPath') && changed.get('docPath') !== undefined) {
      void this.reload();
    }
  }

  protected updated(): void {
    this.makeImagesExpandable();
  }

  /** Re-read the document from disk. Public so the shell can refresh it after a stage change. */
  async reload(): Promise<void> {
    const token = ++this.reloadToken;
    let text: string;
    try {
      text = await this.storage.readTextFile(this.docPath);
    } catch {
      if (token !== this.reloadToken) {
        return;
      }
      this.source = '';
      this.selection = null;
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
    this.selection = null;
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

  private readonly onSelectionChange = (): void => {
    // Only ever *retracts* the toolbar: a fresh selection is captured on pointerup/keyup, when the
    // gesture has finished. Reacting to every intermediate change would flicker the toolbar mid-drag.
    if (!this.selection) {
      return;
    }
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed) {
      this.selection = null;
    }
  };

  /**
   * Resolve the current DOM selection back to a slice of the markdown source.
   *
   * The slice — not `selection.toString()` — is what the agent gets: the rendered text has lost the
   * markdown syntax (`**bold**` reads as "bold"), so a `str_replace` against it would never match.
   * Granularity is whole blocks on purpose: that is exactly coarse enough for the slice to be valid
   * markdown and an exact `str_replace` needle.
   */
  private captureSelection(): void {
    const body = this.querySelector('.idea-doc__body');
    const selection = document.getSelection();
    if (!body || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      this.selection = null;
      return;
    }
    const range = selection.getRangeAt(0);
    if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) {
      this.selection = null;
      return;
    }
    const start = blockLinesOf(range.startContainer, body);
    const end = blockLinesOf(range.endContainer, body);
    if (!start || !end) {
      this.selection = null;
      return;
    }
    const startLine = Math.min(start[0], end[0]);
    const endLine = Math.max(start[1], end[1]);
    const slice = this.source
      .split('\n')
      .slice(startLine, endLine + 1)
      .join('\n');
    if (!slice.trim()) {
      this.selection = null;
      return;
    }
    const rect = range.getBoundingClientRect();
    this.selection = {
      startLine,
      endLine,
      slice,
      rendered: condense(selection.toString()),
      left: rect.left + rect.width / 2,
      top: rect.bottom,
    };
  }

  private readonly onBodyPointerUp = (): void => {
    // After the browser has settled the selection for this gesture.
    requestAnimationFrame(() => this.captureSelection());
  };

  private readonly onBodyKeyUp = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.selection = null;
      return;
    }
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
      ? `\n\nThe user highlighted this inside the fragment: "${truncate(anchor.rendered, FOCUS_HINT_LIMIT)}"`
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

  private sendSelectionToAgent(prefill?: string): void {
    const anchor = this.selection;
    if (!anchor) {
      return;
    }
    this.agentChat.composeContext({
      attachment: this.selectionAttachment(anchor),
      ...(prefill && { prefill }),
    });
    this.selection = null;
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
    if (this.draft !== this.source) {
      const discard = await this.dialogService.showConfirmation({
        title: 'Discard source edits?',
        message: 'The document has unsaved changes. Discard them and go back to the preview?',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        isDangerous: true,
      });
      if (!discard) {
        return;
      }
    }
    this.editing = false;
    this.draft = '';
  }

  protected render() {
    return html`
      <div class="idea-doc">
        ${this.renderToolbar()}
        <div class="idea-doc__scroll" @scroll=${() => (this.selection = null)}>
          ${this.editing ? this.renderSource() : this.renderPreview()}
        </div>
        ${this.renderSelectionMenu()}
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

  /**
   * The floating selection toolbar. `pointerdown` is swallowed on purpose: letting it through would
   * collapse the very selection the buttons are about to read.
   */
  private renderSelectionMenu() {
    const anchor = this.selection;
    if (!anchor || this.editing) {
      return null;
    }
    return html`
      <div
        class="idea-doc__selection-menu"
        style=${`left: ${Math.round(anchor.left)}px; top: ${Math.round(anchor.top)}px`}
        @pointerdown=${(event: PointerEvent) => event.preventDefault()}
      >
        <button
          type="button"
          class="idea-doc__selection-action"
          title="Attach the selected fragment to the chat"
          @click=${() => this.sendSelectionToAgent()}
        >
          ${this.iconService.getIcon('message-square', IconSize.SMALL)}
          <span>Discuss</span>
        </button>
        <button
          type="button"
          class="idea-doc__selection-action"
          title="Attach the fragment and start a rewrite request"
          @click=${() => this.sendSelectionToAgent('Change the selected fragment: ')}
        >
          ${this.iconService.getIcon('edit-3', IconSize.SMALL)}
          <span>Change</span>
        </button>
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
