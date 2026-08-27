import type { PropertyValues } from 'lit';
import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { AgentChatService } from '@/services/agent/AgentChatService';
import { IconService, IconSize } from '@/services/editor/IconService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import {
  type AnnotationDoc,
  type AnnotationFit,
  type AnnotationPoint,
  type AnnotationStroke,
  type AnnotationTool,
  annotationPaths,
  createAnnotationDoc,
  describeAnnotation,
  fitImage,
  parseAnnotation,
  pressureWidth,
  serializeAnnotation,
  toImageSpace,
} from './annotation-doc';
import './pix3-image-annotator.ts.css';

/** Pen widths in source-image pixels, picked relative to the image so a 4K reference is not hairlined. */
const NOMINAL_WIDTH_FRACTION = 0.004;
const MIN_NOMINAL_WIDTH = 2;

/** The palette: the editor accent plus the three that read on any picture. */
const COLORS = ['#f5ae39', '#ff3b30', '#ffffff', '#111111'] as const;

const TOOLS: readonly { id: AnnotationTool; icon: string; label: string }[] = [
  { id: 'pen', icon: 'edit-2', label: 'Pen' },
  { id: 'arrow', icon: 'arrow-up-right', label: 'Arrow' },
  { id: 'rect', icon: 'square', label: 'Box' },
  { id: 'text', icon: 'type', label: 'Label' },
];

/**
 * Draw on a reference image and hand the result to the agent (design §3.7, phase V7).
 *
 * Three things about it are load-bearing:
 *
 *  - **Strokes are stored in image space, painted in stage space.** A resized window, a different
 *    monitor and the flattened PNG all have to show the same annotation, and the PNG is rendered at
 *    the image's natural size — so screen pixels are never what gets saved.
 *  - **Undo is local.** Until Save, this is draft input like text in the composer, not a project
 *    mutation, so Ctrl+Z pops the stroke stack and never touches `HistoryManager`.
 *  - **Saving does NOT go through the mutation gateway**, unlike the column's delete and
 *    "make it the style". Sending writes a PNG the conversation then points at by path; a history
 *    undo that deleted it would leave the agent holding a reference to a file that no longer
 *    exists — the exact failure the "it must be a project file" rule of the parent §5.7 exists to
 *    prevent. The reversible part of this feature is the stroke stack, and it is reversible there.
 */
@customElement('pix3-image-annotator')
export class Pix3ImageAnnotator extends ComponentBase {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(AgentChatService)
  private readonly agentChat!: AgentChatService;

  @inject(IconService)
  private readonly icons!: IconService;

  /** Object URL (or same-origin path) of the picture being annotated. */
  @property({ type: String, attribute: 'image-url' })
  imageUrl = '';

  /** Project-relative path of that picture — what the sidecars are named after. */
  @property({ type: String, attribute: 'image-path' })
  imagePath = '';

  @state()
  private tool: AnnotationTool = 'pen';

  @state()
  private color: string = COLORS[0];

  /** Committed strokes. Held as state so the toolbar's undo/clear enablement follows it. */
  @state()
  private strokes: readonly AnnotationStroke[] = [];

  @state()
  private busy = false;

  @state()
  private status: string | null = null;

  /** The stroke being drawn right now, painted on top but not yet committed. */
  private draft: AnnotationStroke | null = null;

  private image: HTMLImageElement | null = null;
  private imageWidth = 0;
  private imageHeight = 0;

  private canvas: HTMLCanvasElement | null = null;
  private fit: AnnotationFit = { scale: 1, offsetX: 0, offsetY: 0 };
  private drawPointerId: number | null = null;
  private resizeObserver?: ResizeObserver;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.onKeyDown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onKeyDown);
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has('imageUrl') || changed.has('imagePath')) {
      this.strokes = [];
      this.draft = null;
      void this.loadImage();
      void this.loadExisting();
    }
  }

  protected updated(): void {
    const canvas = this.querySelector<HTMLCanvasElement>('.annotator__canvas');
    if (canvas && canvas !== this.canvas) {
      this.canvas = canvas;
      this.observeSize(canvas);
    }
    this.paint();
  }

  // ── Loading ─────────────────────────────────────────────────────────────────

  private async loadImage(): Promise<void> {
    const url = this.imageUrl;
    if (!url) {
      return;
    }
    const image = new Image();
    image.decoding = 'async';
    await new Promise<void>(resolve => {
      image.onload = () => resolve();
      image.onerror = () => resolve();
      image.src = url;
    });
    if (this.imageUrl !== url) {
      // A newer picture was requested while this one was decoding.
      return;
    }
    this.image = image.naturalWidth > 0 ? image : null;
    this.imageWidth = image.naturalWidth;
    this.imageHeight = image.naturalHeight;
    this.paint();
  }

  /** Continue a previous annotation rather than starting over — the point of storing JSON. */
  private async loadExisting(): Promise<void> {
    const path = this.imagePath;
    if (!path) {
      return;
    }
    try {
      const text = await this.storage.readTextFile(annotationPaths(path).json);
      if (this.imagePath !== path) {
        return;
      }
      const doc = parseAnnotation(text, path);
      if (doc) {
        this.strokes = doc.strokes;
      }
    } catch {
      // No sidecar yet — the normal case for a first annotation.
    }
  }

  private observeSize(canvas: HTMLCanvasElement): void {
    this.resizeObserver?.disconnect();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    this.resizeObserver = new ResizeObserver(() => this.paint());
    this.resizeObserver.observe(canvas);
  }

  // ── Painting ────────────────────────────────────────────────────────────────

  /** Nominal stroke width for this image, so the same gesture reads the same on any resolution. */
  private get nominalWidth(): number {
    const longest = Math.max(this.imageWidth, this.imageHeight, 1);
    return Math.max(MIN_NOMINAL_WIDTH, longest * NOMINAL_WIDTH_FRACTION);
  }

  private paint(): void {
    const canvas = this.canvas;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) {
      // happy-dom and thumbnail capture have no 2d context; the component still holds its strokes.
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);

    this.fit = fitImage(this.imageWidth, this.imageHeight, rect.width, rect.height);
    if (this.image) {
      context.drawImage(
        this.image,
        this.fit.offsetX,
        this.fit.offsetY,
        this.imageWidth * this.fit.scale,
        this.imageHeight * this.fit.scale
      );
    }
    // Strokes are stored in image space, so painting is one transform rather than per-point maths.
    context.save();
    context.translate(this.fit.offsetX, this.fit.offsetY);
    context.scale(this.fit.scale, this.fit.scale);
    for (const stroke of this.strokes) {
      paintStroke(context, stroke);
    }
    if (this.draft) {
      paintStroke(context, this.draft);
    }
    context.restore();
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────

  private pointFrom(event: PointerEvent): AnnotationPoint {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const { x, y } = toImageSpace(this.fit, event.clientX - rect.left, event.clientY - rect.top);
    return { x, y, pressure: event.pressure > 0 ? event.pressure : 0.5 };
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.image) {
      return;
    }
    const point = this.pointFrom(event);
    if (this.tool === 'text') {
      void this.addLabel(point);
      return;
    }
    this.drawPointerId = event.pointerId;
    // Capture so a stroke that leaves the canvas still tracks and still ends.
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    this.draft = {
      tool: this.tool,
      color: this.color,
      width: this.nominalWidth,
      points: [point],
    };
    this.paint();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.drawPointerId !== event.pointerId || !this.draft) {
      return;
    }
    // Coalesced events are what makes a fast pen stroke smooth instead of a polyline of chords.
    const events =
      this.draft.tool === 'pen' && typeof event.getCoalescedEvents === 'function'
        ? event.getCoalescedEvents()
        : [event];
    const sampled = events.map(sample => this.pointFrom(sample));
    this.draft =
      this.draft.tool === 'pen'
        ? { ...this.draft, points: [...this.draft.points, ...sampled] }
        : // Arrow and box are defined by their ends, so a drag only ever moves the second point.
          { ...this.draft, points: [this.draft.points[0], sampled[sampled.length - 1]] };
    this.paint();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.drawPointerId !== event.pointerId) {
      return;
    }
    this.drawPointerId = null;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    const draft = this.draft;
    this.draft = null;
    if (draft && isDrawable(draft)) {
      this.strokes = [...this.strokes, draft];
    }
    this.paint();
  };

  private async addLabel(at: AnnotationPoint): Promise<void> {
    const text = window.prompt('Label text');
    if (!text?.trim()) {
      return;
    }
    this.strokes = [
      ...this.strokes,
      {
        tool: 'text',
        color: this.color,
        width: this.nominalWidth * 4,
        points: [at],
        text: text.trim(),
      },
    ];
    this.paint();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
      // Local stack, never HistoryManager: nothing is a project mutation until Save.
      if (this.strokes.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        this.undo();
      }
    }
  };

  private undo(): void {
    this.strokes = this.strokes.slice(0, -1);
    this.paint();
  }

  private clearAll(): void {
    this.strokes = [];
    this.draft = null;
    this.paint();
  }

  // ── Saving ──────────────────────────────────────────────────────────────────

  private get doc(): AnnotationDoc {
    return createAnnotationDoc(this.imagePath, this.imageWidth, this.imageHeight, this.strokes);
  }

  /** Write the editable layer. Cheap, and what makes reopening continue rather than restart. */
  private async saveDraft(): Promise<boolean> {
    const paths = annotationPaths(this.imagePath);
    try {
      await this.storage.writeTextFile(paths.json, serializeAnnotation(this.doc));
      return true;
    } catch (error) {
      this.status = `Could not save the annotation: ${messageOf(error)}`;
      return false;
    }
  }

  private async onSave(): Promise<void> {
    this.busy = true;
    this.status = null;
    try {
      if (await this.saveDraft()) {
        this.status = `Saved to ${annotationPaths(this.imagePath).json}`;
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * Flatten the annotation onto the picture at its natural size.
   *
   * Natural size rather than what is on screen: the composite is what the model looks at, and
   * handing it a downscaled copy of a reference would lose exactly the detail the user drew an
   * arrow at.
   */
  private async flatten(): Promise<Blob | null> {
    if (!this.image || this.imageWidth <= 0) {
      return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = this.imageWidth;
    canvas.height = this.imageHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }
    context.drawImage(this.image, 0, 0, this.imageWidth, this.imageHeight);
    for (const stroke of this.strokes) {
      paintStroke(context, stroke);
    }
    return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
  }

  /**
   * Send the annotation to the agent: the composite as an image block, and both paths as words.
   *
   * The paths matter as much as the picture — the model sees the drawing now, and can reach the
   * same file with `analyze_image` or `fs_read` after the conversation has been compacted.
   */
  private async onSend(): Promise<void> {
    this.busy = true;
    this.status = null;
    try {
      const blob = await this.flatten();
      if (!blob) {
        this.status = 'Could not render the annotation.';
        return;
      }
      const paths = annotationPaths(this.imagePath);
      await this.saveDraft();
      await this.storage.writeBinaryFile(paths.png, await blob.arrayBuffer());
      const data = await blobToBase64(blob);
      const summary = describeAnnotation(this.doc);
      await this.agentChat.send(
        `Annotation on \`res://${this.imagePath}\`${summary ? ` — ${summary}` : ''}. ` +
          `The composite is saved at \`res://${paths.png}\`, the strokes at \`res://${paths.json}\`.`,
        { images: [{ type: 'image', mimeType: 'image/png', data }] }
      );
      this.dispatchEvent(new CustomEvent('annotation-sent', { bubbles: true, composed: true }));
    } catch (error) {
      this.status = `Could not send the annotation: ${messageOf(error)}`;
    } finally {
      this.busy = false;
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  protected render() {
    const empty = this.strokes.length === 0;
    return html`
      <div class="annotator">
        <div class="annotator__tools">
          ${TOOLS.map(
            tool => html`
              <button
                type="button"
                class="annotator__tool ${this.tool === tool.id ? 'is-active' : ''}"
                title=${tool.label}
                aria-label=${tool.label}
                aria-pressed=${this.tool === tool.id ? 'true' : 'false'}
                @click=${() => {
                  this.tool = tool.id;
                }}
              >
                ${this.icons.getIcon(tool.icon, IconSize.SMALL)}
              </button>
            `
          )}
          <span class="annotator__sep"></span>
          ${COLORS.map(
            color => html`
              <button
                type="button"
                class="annotator__color ${this.color === color ? 'is-active' : ''}"
                style=${`--swatch: ${color}`}
                title=${`Colour ${color}`}
                aria-label=${`Colour ${color}`}
                aria-pressed=${this.color === color ? 'true' : 'false'}
                @click=${() => {
                  this.color = color;
                }}
              ></button>
            `
          )}
          <span class="annotator__sep"></span>
          <button
            type="button"
            class="annotator__tool"
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
            ?disabled=${empty}
            @click=${() => this.undo()}
          >
            ${this.icons.getIcon('corner-up-left', IconSize.SMALL)}
          </button>
          <button
            type="button"
            class="annotator__tool"
            title="Clear all strokes"
            aria-label="Clear"
            ?disabled=${empty}
            @click=${() => this.clearAll()}
          >
            ${this.icons.getIcon('trash-2', IconSize.SMALL)}
          </button>
          <span class="annotator__spacer"></span>
          <button
            type="button"
            class="annotator__action"
            ?disabled=${this.busy || empty}
            title="Save the strokes next to the image"
            @click=${() => void this.onSave()}
          >
            ${this.icons.getIcon('save', IconSize.SMALL)}<span>Save</span>
          </button>
          <button
            type="button"
            class="annotator__action annotator__action--primary"
            ?disabled=${this.busy || empty}
            title="Save the composite and send it to the agent"
            @click=${() => void this.onSend()}
          >
            ${this.icons.getIcon('send', IconSize.SMALL)}<span>Send to agent</span>
          </button>
        </div>
        <canvas
          class="annotator__canvas"
          @pointerdown=${this.onPointerDown}
          @pointermove=${this.onPointerMove}
          @pointerup=${this.onPointerUp}
          @pointercancel=${this.onPointerUp}
        ></canvas>
        ${this.status ? html`<p class="annotator__status" role="status">${this.status}</p>` : null}
      </div>
    `;
  }
}

/** A drag that never moved is a click, not a box — committing it would leave an invisible stroke. */
const isDrawable = (stroke: AnnotationStroke): boolean => {
  if (stroke.tool === 'pen') {
    return stroke.points.length > 1;
  }
  const [from, to] = stroke.points;
  return Boolean(to) && Math.hypot(to.x - from.x, to.y - from.y) > 2;
};

/** Paint one stroke in IMAGE space — the caller has already applied the fit transform. */
function paintStroke(context: CanvasRenderingContext2D, stroke: AnnotationStroke): void {
  context.save();
  context.strokeStyle = stroke.color;
  context.fillStyle = stroke.color;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  switch (stroke.tool) {
    case 'pen':
      // Each segment carries its own width, which is what turns pen pressure into a tapered line;
      // one path with a single lineWidth could not vary along its length.
      for (let i = 1; i < stroke.points.length; i++) {
        const from = stroke.points[i - 1];
        const to = stroke.points[i];
        context.lineWidth = pressureWidth(stroke.width, to.pressure);
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.stroke();
      }
      break;
    case 'arrow': {
      const [from, to] = stroke.points;
      context.lineWidth = stroke.width;
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const head = stroke.width * 4;
      context.beginPath();
      context.moveTo(to.x, to.y);
      context.lineTo(
        to.x - head * Math.cos(angle - Math.PI / 7),
        to.y - head * Math.sin(angle - Math.PI / 7)
      );
      context.lineTo(
        to.x - head * Math.cos(angle + Math.PI / 7),
        to.y - head * Math.sin(angle + Math.PI / 7)
      );
      context.closePath();
      context.fill();
      break;
    }
    case 'rect': {
      const [from, to] = stroke.points;
      context.lineWidth = stroke.width;
      context.strokeRect(
        Math.min(from.x, to.x),
        Math.min(from.y, to.y),
        Math.abs(to.x - from.x),
        Math.abs(to.y - from.y)
      );
      break;
    }
    case 'text': {
      const [at] = stroke.points;
      const size = stroke.width;
      context.font = `600 ${size}px system-ui, sans-serif`;
      context.textBaseline = 'top';
      // A halo, because a label lands on artwork whose colour nobody chose: without it a white
      // caption vanishes on a white wall and a black one on a shadow.
      context.lineWidth = Math.max(1, size / 6);
      context.strokeStyle = contrastOf(stroke.color);
      context.strokeText(stroke.text ?? '', at.x, at.y);
      context.fillText(stroke.text ?? '', at.x, at.y);
      break;
    }
  }
  context.restore();
}

/** Black on a light ink, white on a dark one — the halo has to be the opposite of the text. */
const contrastOf = (hex: string): string => {
  const value = hex.replace('#', '');
  if (value.length !== 6) {
    return '#000000';
  }
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? '#000000' : '#ffffff';
};

const blobToBase64 = async (blob: Blob): Promise<string> => {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // Chunked: `String.fromCharCode(...huge)` blows the argument limit on a full-size PNG.
  for (let i = 0; i < buffer.length; i += 0x8000) {
    binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
