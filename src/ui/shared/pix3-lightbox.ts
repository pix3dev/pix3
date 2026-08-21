import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { IconService, IconSize } from '@/services/editor/IconService';
import {
  LightboxService,
  type LightboxItem,
  type LightboxState,
} from '@/services/editor/LightboxService';
import { renderMarkdownLite } from '@/ui/agent-chat/markdown-lite';
import './pix3-lightbox.ts.css';

/** Zoom limits. Below the lower bound the picture is a stamp; above the upper one it is pixels. */
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;

/** Zoom a double click jumps to (and back from). */
const DOUBLE_CLICK_ZOOM = 2.5;

/** Wheel-to-zoom sensitivity: one notch (~100px of deltaY) is ~1.16x. */
const WHEEL_ZOOM_SPEED = 0.0015;

/**
 * The application's single full-screen viewer (design §3.7), driven imperatively through
 * {@link LightboxService}.
 *
 * Three properties are load-bearing:
 *  - **One overlay, mounted on `document.body`.** "Show me that bigger" is the same need in the
 *    references column and in the chat, and every panel between them clips with
 *    `overflow: hidden` — so the element lives outside every shell (see {@link ensureLightboxHost}).
 *  - **It owns no URLs.** `LightboxItem.url` belongs to the caller, which already diff-revokes its
 *    blob cache; a second owner would double-free. This component only ever reads the string.
 *  - **Zoom/pan live in plain fields, not reactive state.** A pointermove that re-rendered a lit
 *    template would drop frames on a large image, so the transform is written straight to the
 *    element and re-applied after each render.
 */
@customElement('pix3-lightbox')
export class Pix3Lightbox extends ComponentBase {
  @inject(LightboxService)
  private readonly lightbox!: LightboxService;

  @inject(IconService)
  private readonly icons!: IconService;

  /** The open request, or `null` when closed — a closed lightbox renders nothing at all. */
  @state()
  private view: LightboxState | null = null;

  private zoom = 1;
  private panX = 0;
  private panY = 0;

  /** Item the current zoom/pan belongs to, so stepping to the next picture starts fitted again. */
  private zoomedItem: LightboxItem | null = null;

  private dragPointerId: number | null = null;
  private dragStartX = 0;
  private dragStartY = 0;

  /** Element focus came from, so closing puts the caret back where the user left it. */
  private returnFocus: HTMLElement | null = null;

  /** The dialog can only be focused once lit has rendered it, so the open defers to `updated()`. */
  private focusPending = false;

  private disposeSubscription?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeSubscription = this.lightbox.subscribe(this.onLightboxState);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.disposeSubscription?.();
    this.disposeSubscription = undefined;
    window.removeEventListener('keydown', this.onKeyDown);
  }

  protected updated(): void {
    if (this.focusPending) {
      this.focusPending = false;
      this.querySelector<HTMLElement>('.lightbox__dialog')?.focus();
    }
    this.applyImageTransform();
  }

  private readonly onLightboxState = (state: LightboxState | null): void => {
    const wasOpen = this.view !== null;
    const item = state ? (state.items[state.index] ?? null) : null;
    if (item !== this.zoomedItem) {
      this.resetZoom(item);
    }
    this.view = state;
    if (state && !wasOpen) {
      this.returnFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.focusPending = true;
      // Listening on the window rather than the dialog: the overlay traps focus, but a click on the
      // backdrop or an image can leave the active element on `body`, and Esc must still work there.
      window.addEventListener('keydown', this.onKeyDown);
    } else if (!state && wasOpen) {
      window.removeEventListener('keydown', this.onKeyDown);
      const target = this.returnFocus;
      this.returnFocus = null;
      if (target?.isConnected) {
        target.focus();
      }
    }
  };

  private resetZoom(item: LightboxItem | null): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.zoomedItem = item;
  }

  private get currentItem(): LightboxItem | null {
    const view = this.view;
    return view ? (view.items[view.index] ?? null) : null;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.view) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.lightbox.close();
      return;
    }
    if (event.key === 'Tab') {
      this.trapFocus(event);
      return;
    }
    if (this.view.items.length < 2) {
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.lightbox.step(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.lightbox.step(1);
    }
  };

  /**
   * Keep Tab inside the overlay. A modal that lets Tab walk into the editor behind it hands the
   * keyboard user a panel they cannot see and cannot get back from.
   */
  private trapFocus(event: KeyboardEvent): void {
    const dialog = this.querySelector<HTMLElement>('.lightbox__dialog');
    if (!dialog) {
      return;
    }
    const stops = Array.from(
      dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]')
    );
    if (stops.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && dialog.contains(active);
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (event.shiftKey) {
      if (!inside || active === first || active === dialog) {
        event.preventDefault();
        last.focus();
      }
      return;
    }
    if (!inside || active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private onBackdropClick(): void {
    this.lightbox.close();
  }

  // ── Image zoom / pan ────────────────────────────────────────────────────────

  /** The rendered image, when the current item is one. */
  private get imageElement(): HTMLElement | null {
    return this.querySelector<HTMLElement>('.lightbox__image');
  }

  private applyImageTransform(): void {
    const image = this.imageElement;
    if (!image) {
      return;
    }
    image.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    image.style.cursor = this.zoom > 1 ? (this.dragPointerId === null ? 'grab' : 'grabbing') : '';
  }

  /**
   * Zoom to `next` while keeping the content point under (`pointerX`, `pointerY`) — measured from
   * the stage centre, because that is where an untransformed `object-fit: contain` image sits — in
   * place. Zooming around the middle instead makes the detail you aimed at slide off screen.
   */
  private zoomTo(next: number, pointerX: number, pointerY: number): void {
    const clamped = Math.min(Math.max(next, MIN_ZOOM), MAX_ZOOM);
    if (clamped === this.zoom) {
      return;
    }
    const ratio = clamped / this.zoom;
    this.panX = pointerX - (pointerX - this.panX) * ratio;
    this.panY = pointerY - (pointerY - this.panY) * ratio;
    this.zoom = clamped;
    this.applyImageTransform();
  }

  /** Pointer position relative to the centre of the stage, in CSS pixels. */
  private stageOffset(event: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
    const stage = this.querySelector<HTMLElement>('.lightbox__stage');
    if (!stage) {
      return { x: 0, y: 0 };
    }
    const rect = stage.getBoundingClientRect();
    return {
      x: event.clientX - (rect.left + rect.width / 2),
      y: event.clientY - (rect.top + rect.height / 2),
    };
  }

  private readonly onStageWheel = (event: WheelEvent): void => {
    if (this.currentItem?.kind !== 'image') {
      return;
    }
    event.preventDefault();
    const { x, y } = this.stageOffset(event);
    this.zoomTo(this.zoom * Math.exp(-event.deltaY * WHEEL_ZOOM_SPEED), x, y);
  };

  private readonly onStageDoubleClick = (event: MouseEvent): void => {
    if (this.currentItem?.kind !== 'image') {
      return;
    }
    const { x, y } = this.stageOffset(event);
    if (this.zoom > 1) {
      this.resetZoom(this.currentItem);
      this.applyImageTransform();
      return;
    }
    this.zoomTo(DOUBLE_CLICK_ZOOM, x, y);
  };

  private readonly onStagePointerDown = (event: PointerEvent): void => {
    if (this.currentItem?.kind !== 'image' || event.button !== 0) {
      return;
    }
    const stage = event.currentTarget as HTMLElement;
    this.dragPointerId = event.pointerId;
    this.dragStartX = event.clientX - this.panX;
    this.dragStartY = event.clientY - this.panY;
    // Capture so a fast drag that leaves the stage (or the window) still pans and still ends.
    stage.setPointerCapture?.(event.pointerId);
    this.applyImageTransform();
  };

  private readonly onStagePointerMove = (event: PointerEvent): void => {
    if (this.dragPointerId !== event.pointerId) {
      return;
    }
    this.panX = event.clientX - this.dragStartX;
    this.panY = event.clientY - this.dragStartY;
    this.applyImageTransform();
  };

  private readonly onStagePointerUp = (event: PointerEvent): void => {
    if (this.dragPointerId !== event.pointerId) {
      return;
    }
    this.dragPointerId = null;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    this.applyImageTransform();
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  protected render() {
    const view = this.view;
    const item = this.currentItem;
    if (!view || !item) {
      return null;
    }
    const multiple = view.items.length > 1;
    return html`
      <div class="lightbox" @click=${() => this.onBackdropClick()} @keydown=${() => {}}>
        <div
          class="lightbox__dialog"
          role="dialog"
          aria-modal="true"
          aria-label=${item.title}
          tabindex="-1"
          @click=${(event: Event) => event.stopPropagation()}
          @keydown=${() => {}}
        >
          ${this.renderHeader(item, view)}
          <div class="lightbox__body">
            ${multiple ? this.renderStepButton(-1, 'Previous', 'chevron-left') : null}
            <div
              class="lightbox__stage ${item.kind === 'image' ? 'lightbox__stage--image' : ''}"
              @wheel=${this.onStageWheel}
              @dblclick=${this.onStageDoubleClick}
              @pointerdown=${this.onStagePointerDown}
              @pointermove=${this.onStagePointerMove}
              @pointerup=${this.onStagePointerUp}
              @pointercancel=${this.onStagePointerUp}
            >
              ${this.renderItem(item)}
            </div>
            ${multiple ? this.renderStepButton(1, 'Next', 'chevron-right') : null}
          </div>
        </div>
      </div>
    `;
  }

  private renderHeader(item: LightboxItem, view: LightboxState) {
    return html`
      <header class="lightbox__header">
        <div class="lightbox__titles">
          <span class="lightbox__title" title=${item.title}>${item.title}</span>
          ${item.path
            ? html`<span class="lightbox__path" title=${item.path}>${item.path}</span>`
            : null}
        </div>
        ${view.items.length > 1
          ? html`<span class="lightbox__counter">${view.index + 1} / ${view.items.length}</span>`
          : null}
        <button
          type="button"
          class="lightbox__btn"
          title="Close (Esc)"
          aria-label="Close"
          @click=${() => this.lightbox.close()}
        >
          ${this.icons.getIcon('x', IconSize.MEDIUM)}
        </button>
      </header>
    `;
  }

  private renderStepButton(delta: number, label: string, icon: string) {
    return html`
      <button
        type="button"
        class="lightbox__btn lightbox__step"
        title=${`${label} (${delta < 0 ? 'Left' : 'Right'} arrow key)`}
        aria-label=${label}
        @click=${() => this.lightbox.step(delta)}
      >
        ${this.icons.getIcon(icon, IconSize.LARGE)}
      </button>
    `;
  }

  private renderItem(item: LightboxItem) {
    switch (item.kind) {
      case 'image':
        // A url-less image is a broken caller, not a picture — say so instead of showing a void.
        return item.url
          ? html`<img
              class="lightbox__image"
              src=${item.url}
              alt=${item.title}
              draggable="false"
              @dragstart=${(event: Event) => event.preventDefault()}
            />`
          : this.renderUnavailable(item);
      case 'markdown':
        // Same renderer as the design document, so "expand the brief" costs nothing. No image
        // resolver: this component owns no blob cache, so `res://` pictures show their name plaque.
        return html`<article class="lightbox__doc">
          ${renderMarkdownLite(item.text ?? '', { mode: 'doc' })}
        </article>`;
      case 'text':
        return html`<pre class="lightbox__text">${item.text ?? ''}</pre>`;
      case 'other':
        return this.renderUnavailable(item);
    }
  }

  /** The honest no-preview case: what the file is, how big it is, and that we cannot show it. */
  private renderUnavailable(item: LightboxItem) {
    return html`
      <div class="lightbox__plaque">
        <span class="lightbox__plaque-icon">
          ${this.icons.getIcon(iconForMime(item.mimeType), IconSize.XLARGE)}
        </span>
        <span class="lightbox__plaque-name">${item.title}</span>
        ${item.sizeBytes !== undefined
          ? html`<span class="lightbox__plaque-meta">${formatBytes(item.sizeBytes)}</span>`
          : null}
        <span class="lightbox__plaque-note">Preview not available</span>
      </div>
    `;
  }
}

/**
 * Mount the one overlay element on `document.body`, or hand back the one already there.
 *
 * Called as an import side effect below **and** from consumers' `connectedCallback`s. The side
 * effect covers callers that only `import '@/ui/shared/pix3-lightbox'` for its registration, while
 * the explicit call covers the two cases the side effect cannot: a document that had no `<body>`
 * yet when the module was evaluated, and a host removed by something that wiped `document.body`
 * (which every component spec does in `afterEach`). Idempotency comes from querying the DOM rather
 * than a module-level flag, because module state resets on HMR while the element survives.
 */
export function ensureLightboxHost(): Pix3Lightbox | null {
  if (typeof document === 'undefined' || !document.body) {
    return null;
  }
  const existing = document.querySelector('pix3-lightbox');
  if (existing) {
    return existing as Pix3Lightbox;
  }
  const host = document.createElement('pix3-lightbox');
  document.body.appendChild(host);
  return host;
}

ensureLightboxHost();

/** Feather icon that matches a mime type, for the no-preview plaque. */
function iconForMime(mimeType: string | undefined): string {
  if (!mimeType) {
    return 'file';
  }
  if (mimeType.startsWith('image/')) {
    return 'image';
  }
  if (mimeType.startsWith('audio/')) {
    return 'music';
  }
  if (mimeType.startsWith('video/')) {
    return 'film';
  }
  if (mimeType.startsWith('text/') || mimeType === 'application/json') {
    return 'file-text';
  }
  if (/zip|compressed|tar|gzip/.test(mimeType)) {
    return 'archive';
  }
  return 'file';
}

/** Compact byte label. Local on purpose — importing one from a service would drag the service in. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-lightbox': Pix3Lightbox;
  }
}
