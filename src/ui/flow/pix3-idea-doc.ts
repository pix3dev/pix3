import type { PropertyValues } from 'lit';
import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { AgentChatService, type AgentChatState } from '@/services/agent/AgentChatService';
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
    void this.reload();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.disposeAgent?.();
    this.disposeAgent = undefined;
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

declare global {
  interface HTMLElementTagNameMap {
    'pix3-idea-doc': Pix3IdeaDoc;
  }
}
