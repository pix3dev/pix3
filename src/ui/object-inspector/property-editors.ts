/**
 * Custom Property Editor Components
 *
 * Specialized editors for vector and rotation properties that display
 * multiple components (x, y, z) in a single row.
 */

import { html, css, customElement, property, state } from '@/fw';
import { ComponentBase } from '@/fw/component-base';

export interface Vector2Value {
  x: number;
  y: number;
}

export interface Vector3Value {
  x: number;
  y: number;
  z: number;
}

/**
 * Emit a bubbling, composed `locate-resource` event so the Inspector can reveal
 * the given resource in the Asset Browser / Assets Preview. Shared by every
 * resource editor below (texture / audio / model / animation).
 */
function dispatchLocate(source: HTMLElement, url: string): void {
  const trimmed = url.trim();
  if (!trimmed) {
    return;
  }
  source.dispatchEvent(
    new CustomEvent('locate-resource', {
      detail: { url: trimmed },
      bubbles: true,
      composed: true,
    })
  );
}

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  const kb = size / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

/** Axis identity for a number field — drives the coloured chip and reads like Blender/Unity. */
export type NumberFieldAxis = 'x' | 'y' | 'z' | 'w' | 'h' | '';

/**
 * Shared styles for the drag-to-scrub number field. Kept as a standalone
 * template so every vector/size editor renders identical fields.
 */
const NUMBER_FIELD_STYLES = css`
  :host {
    display: inline-flex;
    align-items: center;
    flex: 1;
    min-width: 0;
  }

  .field {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    flex: 1;
    min-width: 0;
    height: 30px;
    padding: 0 0.5rem;
    box-sizing: border-box;
    background: var(--bg-2);
    border: 1px solid var(--line-1);
    border-radius: var(--radius-1);
    cursor: ew-resize;
    overflow: hidden;
    user-select: none;
    -webkit-user-select: none;
    touch-action: none;
  }

  .field:hover:not(.disabled):not(.editing) {
    border-color: var(--line-2);
  }

  .field.editing {
    cursor: text;
    border-color: var(--accent);
  }

  .field.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .axis {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
    color: var(--fg-2);
  }

  .axis--x,
  .axis--w {
    color: var(--axis-x);
  }

  .axis--y,
  .axis--h {
    color: var(--axis-y);
  }

  .axis--z {
    color: var(--axis-z);
  }

  .value {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: 13px;
    color: var(--fg-0);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: right;
    pointer-events: none;
  }

  .unit {
    margin-left: 0.15rem;
    color: var(--fg-3);
  }

  input {
    all: unset;
    flex: 1;
    min-width: 0;
    width: 100%;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: 13px;
    color: var(--fg-0);
    text-align: right;
  }
`;

/**
 * Drag-to-scrub number input (Blender / Unity style).
 *
 * - Press and drag horizontally to scrub the value live. Hold Shift for fine
 *   (×0.1) and Ctrl/Cmd for coarse (×10) steps.
 * - A plain click (no drag) drops into text-edit mode; Enter or blur commits,
 *   Escape cancels.
 *
 * Emits `preview-change` continuously while scrubbing (coalesced into a single
 * undo step by the mutation gateway) and `commit-change` once on release / edit
 * commit. Both carry `{ value: number }` and are `bubbles` + `composed` so hosts
 * in light DOM can listen through the editor's shadow boundary.
 */
@customElement('pix3-number-field')
export class NumberField extends ComponentBase {
  protected static useShadowDom = true;

  @property({ type: Number })
  value: number = 0;

  @property({ type: Number })
  step: number = 0.01;

  @property({ type: Number })
  precision: number = 2;

  @property({ type: Number })
  min: number = Number.NEGATIVE_INFINITY;

  @property({ type: Number })
  max: number = Number.POSITIVE_INFINITY;

  /** Units changed per horizontal pixel while scrubbing. `0` → derive from step. */
  @property({ type: Number })
  sensitivity: number = 0;

  @property({ type: Boolean })
  disabled: boolean = false;

  @property({ type: String })
  axis: NumberFieldAxis = '';

  /** Overrides the axis letter shown in the chip (e.g. a custom glyph). */
  @property({ type: String })
  label: string = '';

  @property({ type: String })
  unit: string = '';

  @state()
  private editing = false;

  private pointerId: number | null = null;
  private dragged = false;
  private accumX = 0;
  private startValue = 0;

  static styles = NUMBER_FIELD_STYLES;

  private get decimals(): number {
    return Number.isFinite(this.precision) && this.precision >= 0 ? this.precision : 2;
  }

  private get scrubSensitivity(): number {
    if (Number.isFinite(this.sensitivity) && this.sensitivity > 0) {
      return this.sensitivity;
    }
    return Number.isFinite(this.step) && this.step > 0 ? this.step : 0.01;
  }

  private clamp(v: number): number {
    let result = v;
    if (Number.isFinite(this.min)) {
      result = Math.max(this.min, result);
    }
    if (Number.isFinite(this.max)) {
      result = Math.min(this.max, result);
    }
    return result;
  }

  /** Snap to the step grid and strip float noise to the field's precision. */
  private snap(v: number): number {
    const step = Number.isFinite(this.step) && this.step > 0 ? this.step : 0;
    const snapped = step > 0 ? Math.round(v / step) * step : v;
    return Number.parseFloat(snapped.toFixed(this.decimals));
  }

  private format(v: number): string {
    return v.toFixed(this.decimals);
  }

  private emit(type: 'preview-change' | 'commit-change', value: number): void {
    // composed:false so a vector/euler editor wrapping this field is the ONLY
    // listener — its own re-emitted {x,y,…} event is what reaches the inspector.
    // Directly-hosted fields (size/rotation) still receive it: the inspector's
    // listener sits on this element in the same (light DOM) tree.
    this.dispatchEvent(new CustomEvent(type, { detail: { value }, bubbles: true }));
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.disabled || this.editing || event.button !== 0) {
      return;
    }
    const target = event.currentTarget as HTMLElement;
    this.pointerId = event.pointerId;
    this.dragged = false;
    this.accumX = 0;
    this.startValue = this.value;
    // Pointer capture keeps move/up events flowing while the cursor leaves the
    // field; a rare failure (detached element) must not abort the scrub.
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      /* non-fatal — scrubbing still works within the element bounds */
    }
    event.preventDefault();
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.pointerId === null) {
      return;
    }
    this.accumX += event.movementX;
    if (!this.dragged && Math.abs(this.accumX) < 3) {
      return;
    }
    this.dragged = true;
    const multiplier = event.shiftKey ? 0.1 : event.ctrlKey || event.metaKey ? 10 : 1;
    const delta = this.accumX * this.scrubSensitivity * multiplier;
    const next = this.clamp(this.snap(this.startValue + delta));
    if (next !== this.value) {
      this.value = next;
      this.emit('preview-change', next);
    }
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.pointerId === null) {
      return;
    }
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
    this.pointerId = null;
    if (this.dragged) {
      this.emit('commit-change', this.value);
    } else {
      this.enterEdit();
    }
  }

  private enterEdit(): void {
    if (this.disabled) {
      return;
    }
    this.editing = true;
    void this.updateComplete.then(() => {
      const input = this.renderRoot.querySelector('input');
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  private commitEdit(rawValue: string): void {
    this.editing = false;
    const parsed = Number.parseFloat(rawValue);
    if (Number.isFinite(parsed)) {
      const next = this.clamp(parsed);
      this.value = next;
      this.emit('commit-change', next);
    }
  }

  private onInputKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      (event.target as HTMLInputElement).blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.editing = false;
    }
  }

  protected render() {
    const chip = this.label || (this.axis ? this.axis.toUpperCase() : '');
    const editValue = Number.parseFloat(this.value.toFixed(this.decimals)).toString();
    return html`
      <div
        class="field ${this.editing ? 'editing' : ''} ${this.disabled ? 'disabled' : ''}"
        @pointerdown=${(e: PointerEvent) => this.onPointerDown(e)}
        @pointermove=${(e: PointerEvent) => this.onPointerMove(e)}
        @pointerup=${(e: PointerEvent) => this.onPointerUp(e)}
        @pointercancel=${(e: PointerEvent) => this.onPointerUp(e)}
      >
        ${chip ? html`<span class="axis axis--${this.axis || 'none'}">${chip}</span>` : ''}
        ${this.editing
          ? html`<input
              type="text"
              inputmode="decimal"
              .value=${editValue}
              @keydown=${(e: KeyboardEvent) => this.onInputKeydown(e)}
              @blur=${(e: Event) => this.commitEdit((e.target as HTMLInputElement).value)}
            />`
          : html`<span class="value"
              >${this.format(this.value)}${this.unit
                ? html`<span class="unit">${this.unit}</span>`
                : ''}</span
            >`}
      </div>
    `;
  }
}

/**
 * Vector2 Editor - Displays x, y drag-scrub fields in one row
 */
@customElement('pix3-vector2-editor')
export class Vector2Editor extends ComponentBase {
  protected static useShadowDom = true;
  @property({ type: Number })
  x: number = 0;

  @property({ type: Number })
  y: number = 0;

  @property({ type: Number })
  step: number = 0.01;

  @property({ type: Number })
  precision: number = 2;

  /** Scrub sensitivity (units/px) forwarded to both fields; `0` → derive from step. */
  @property({ type: Number })
  sensitivity: number = 0;

  @property({ type: Boolean })
  disabled = false;

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      min-width: 0;
      flex: 1;
    }

    .vector-input-group {
      display: flex;
      gap: 0.35rem;
      flex: 1;
      min-width: 0;
      align-items: center;
    }
  `;

  private emit(type: 'preview-change' | 'commit-change', detail: Vector2Value): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  protected render() {
    return html`
      <div class="vector-input-group">
        <pix3-number-field
          axis="x"
          .value=${this.x}
          .step=${this.step}
          .precision=${this.precision}
          .sensitivity=${this.sensitivity}
          ?disabled=${this.disabled}
          @preview-change=${(e: CustomEvent<{ value: number }>) =>
            this.emit('preview-change', { x: e.detail.value, y: this.y })}
          @commit-change=${(e: CustomEvent<{ value: number }>) =>
            this.emit('commit-change', { x: e.detail.value, y: this.y })}
        ></pix3-number-field>
        <pix3-number-field
          axis="y"
          .value=${this.y}
          .step=${this.step}
          .precision=${this.precision}
          .sensitivity=${this.sensitivity}
          ?disabled=${this.disabled}
          @preview-change=${(e: CustomEvent<{ value: number }>) =>
            this.emit('preview-change', { x: this.x, y: e.detail.value })}
          @commit-change=${(e: CustomEvent<{ value: number }>) =>
            this.emit('commit-change', { x: this.x, y: e.detail.value })}
        ></pix3-number-field>
      </div>
    `;
  }
}

/**
 * Vector3 Editor - Displays x, y, z drag-scrub fields in one row
 */
@customElement('pix3-vector3-editor')
export class Vector3Editor extends ComponentBase {
  protected static useShadowDom = true;
  @property({ type: Number })
  x: number = 0;

  @property({ type: Number })
  y: number = 0;

  @property({ type: Number })
  z: number = 0;

  @property({ type: Number })
  step: number = 0.01;

  @property({ type: Number })
  precision: number = 2;

  @property({ type: Number })
  sensitivity: number = 0;

  @property({ type: Boolean })
  disabled = false;

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      min-width: 0;
      flex: 1;
    }

    .vector-input-group {
      display: flex;
      gap: 0.35rem;
      flex: 1;
      min-width: 0;
      align-items: center;
    }
  `;

  private emit(type: 'preview-change' | 'commit-change', detail: Vector3Value): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  protected render() {
    return html`
      <div class="vector-input-group">
        <pix3-number-field
          axis="x"
          .value=${this.x}
          .step=${this.step}
          .precision=${this.precision}
          .sensitivity=${this.sensitivity}
          ?disabled=${this.disabled}
          @preview-change=${(e: CustomEvent<{ value: number }>) =>
            this.emit('preview-change', { x: e.detail.value, y: this.y, z: this.z })}
          @commit-change=${(e: CustomEvent<{ value: number }>) =>
            this.emit('commit-change', { x: e.detail.value, y: this.y, z: this.z })}
        ></pix3-number-field>
        <pix3-number-field
          axis="y"
          .value=${this.y}
          .step=${this.step}
          .precision=${this.precision}
          .sensitivity=${this.sensitivity}
          ?disabled=${this.disabled}
          @preview-change=${(e: CustomEvent<{ value: number }>) =>
            this.emit('preview-change', { x: this.x, y: e.detail.value, z: this.z })}
          @commit-change=${(e: CustomEvent<{ value: number }>) =>
            this.emit('commit-change', { x: this.x, y: e.detail.value, z: this.z })}
        ></pix3-number-field>
        <pix3-number-field
          axis="z"
          .value=${this.z}
          .step=${this.step}
          .precision=${this.precision}
          .sensitivity=${this.sensitivity}
          ?disabled=${this.disabled}
          @preview-change=${(e: CustomEvent<{ value: number }>) =>
            this.emit('preview-change', { x: this.x, y: this.y, z: e.detail.value })}
          @commit-change=${(e: CustomEvent<{ value: number }>) =>
            this.emit('commit-change', { x: this.x, y: this.y, z: e.detail.value })}
        ></pix3-number-field>
      </div>
    `;
  }
}

/**
 * Euler Rotation Editor - Displays pitch, yaw, roll (x, y, z) in degrees
 */
@customElement('pix3-euler-editor')
export class EulerEditor extends ComponentBase {
  protected static useShadowDom = true;
  @property({ type: Number })
  x: number = 0; // pitch

  @property({ type: Number })
  y: number = 0; // yaw

  @property({ type: Number })
  z: number = 0; // roll

  @property({ type: Number })
  step: number = 0.1;

  @property({ type: Number })
  precision: number = 1;

  /** Scrub sensitivity (deg/px); defaults to a rotation-friendly 0.5 when unset. */
  @property({ type: Number })
  sensitivity: number = 0;

  @property({ type: Boolean })
  disabled = false;

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      min-width: 0;
      flex: 1;
    }

    .euler-input-group {
      display: flex;
      gap: 0.35rem;
      flex: 1;
      min-width: 0;
      align-items: center;
    }
  `;

  private emit(type: 'preview-change' | 'commit-change', detail: Vector3Value): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  protected render() {
    const sensitivity = this.sensitivity > 0 ? this.sensitivity : 0.5;
    return html`
      <div class="euler-input-group">
        <pix3-number-field
          axis="x"
          unit="°"
          .value=${this.x}
          .step=${this.step}
          .precision=${this.precision}
          .sensitivity=${sensitivity}
          ?disabled=${this.disabled}
          @preview-change=${(e: CustomEvent<{ value: number }>) =>
            this.emit('preview-change', { x: e.detail.value, y: this.y, z: this.z })}
          @commit-change=${(e: CustomEvent<{ value: number }>) =>
            this.emit('commit-change', { x: e.detail.value, y: this.y, z: this.z })}
        ></pix3-number-field>
        <pix3-number-field
          axis="y"
          unit="°"
          .value=${this.y}
          .step=${this.step}
          .precision=${this.precision}
          .sensitivity=${sensitivity}
          ?disabled=${this.disabled}
          @preview-change=${(e: CustomEvent<{ value: number }>) =>
            this.emit('preview-change', { x: this.x, y: e.detail.value, z: this.z })}
          @commit-change=${(e: CustomEvent<{ value: number }>) =>
            this.emit('commit-change', { x: this.x, y: e.detail.value, z: this.z })}
        ></pix3-number-field>
        <pix3-number-field
          axis="z"
          unit="°"
          .value=${this.z}
          .step=${this.step}
          .precision=${this.precision}
          .sensitivity=${sensitivity}
          ?disabled=${this.disabled}
          @preview-change=${(e: CustomEvent<{ value: number }>) =>
            this.emit('preview-change', { x: this.x, y: this.y, z: e.detail.value })}
          @commit-change=${(e: CustomEvent<{ value: number }>) =>
            this.emit('commit-change', { x: this.x, y: this.y, z: e.detail.value })}
        ></pix3-number-field>
      </div>
    `;
  }
}

@customElement('pix3-texture-resource-editor')
export class TextureResourceEditor extends ComponentBase {
  protected static useShadowDom = true;
  @property({ type: String })
  resourceUrl: string = '';

  @property({ type: String })
  previewUrl: string = '';

  @property({ type: Number })
  originalWidth: number = 0;

  @property({ type: Number })
  originalHeight: number = 0;

  @property({ type: Number })
  fileSize: number = 0;

  @property({ type: Boolean })
  disabled: boolean = false;

  @state()
  private isDragOver = false;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      width: 100%;
    }

    .preview {
      position: relative;
      border: 1px dashed var(--line-1);
      border-radius: var(--radius-2);
      width: 64px;
      height: 64px;
      background: var(--bg-2);
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      transition:
        border-color 0.15s ease,
        background 0.15s ease;
      flex-shrink: 0;
    }

    .editor-row {
      display: flex;
      gap: 0.75rem;
      align-items: center;
    }

    .info-column {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      font-size: 0.7rem;
      color: var(--fg-3);
      line-height: 1.25;
      overflow: hidden;
    }

    .info-item {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .info-label {
      font-weight: 600;
      color: var(--fg-1);
      margin-right: 2px;
    }

    .preview.is-dragover {
      border-color: var(--accent);
      background: var(--accent-soft);
    }

    .preview img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }

    .preview-empty {
      color: var(--fg-3);
      font-size: 0.75rem;
      text-align: center;
      padding: 0.5rem;
    }

    .url-row {
      display: flex;
      gap: 0.4rem;
      align-items: center;
    }

    input {
      flex: 1;
      min-width: 0;
      background: var(--bg-2);
      color: var(--fg-0);
      border: 1px solid var(--line-1);
      border-radius: var(--radius-1);
      padding: 0.25rem 0.5rem;
      height: 30px;
      font-size: 13px;
      box-sizing: border-box;
    }

    input:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }

    button {
      border: 1px solid var(--line-1);
      background: var(--bg-2);
      color: var(--fg-1);
      border-radius: var(--radius-2);
      padding: 0.2rem 0.5rem;
      font-size: 0.75rem;
      cursor: pointer;
      white-space: nowrap;
    }

    button:hover:not(:disabled) {
      background: var(--bg-3);
      color: var(--fg-0);
    }

    button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }

    button:disabled,
    input:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
  `;

  private emitChange(url: string): void {
    this.dispatchEvent(
      new CustomEvent('change', {
        detail: { url },
        bubbles: true,
        composed: true,
      })
    );
  }

  private onDragOver(event: DragEvent): void {
    if (this.disabled) {
      return;
    }
    event.preventDefault();
    this.isDragOver = true;
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  private onDragLeave(): void {
    this.isDragOver = false;
  }

  private onDrop(event: DragEvent): void {
    if (this.disabled) {
      return;
    }
    event.preventDefault();
    this.isDragOver = false;

    this.dispatchEvent(
      new CustomEvent('texture-drop', {
        detail: { event },
        bubbles: true,
        composed: true,
      })
    );
  }

  protected render() {
    const fileSizeStr =
      this.fileSize > 0
        ? this.fileSize < 1024 * 1024
          ? `${(this.fileSize / 1024).toFixed(1)} KB`
          : `${(this.fileSize / (1024 * 1024)).toFixed(1)} MB`
        : '';

    return html`
      <div class="editor-row">
        <div
          class="preview ${this.isDragOver ? 'is-dragover' : ''}"
          @dragover=${(event: DragEvent) => this.onDragOver(event)}
          @dragleave=${() => this.onDragLeave()}
          @drop=${(event: DragEvent) => this.onDrop(event)}
        >
          ${this.previewUrl
            ? html`<img src=${this.previewUrl} alt="Texture preview" />`
            : html`<span class="preview-empty">Drop image from Assets here</span>`}
        </div>

        ${this.previewUrl && (this.originalWidth > 0 || this.fileSize > 0)
          ? html` <div class="info-column">
              ${this.originalWidth > 0
                ? html` <div class="info-item">
                    <span class="info-label">Dim:</span>
                    ${this.originalWidth} × ${this.originalHeight}
                  </div>`
                : ''}
              ${this.fileSize > 0
                ? html` <div class="info-item">
                    <span class="info-label">Size:</span>
                    ${fileSizeStr}
                  </div>`
                : ''}
            </div>`
          : ''}
      </div>

      <div class="url-row">
        <input
          type="text"
          .value=${this.resourceUrl}
          ?disabled=${this.disabled}
          placeholder="res://path/to/texture.png"
          @change=${(e: Event) => this.emitChange((e.target as HTMLInputElement).value)}
        />
        <button
          type="button"
          ?disabled=${!this.resourceUrl.trim()}
          title="Show this file in the Asset Browser"
          @click=${() => dispatchLocate(this, this.resourceUrl)}
        >
          Locate
        </button>
        <button type="button" ?disabled=${this.disabled} @click=${() => this.emitChange('')}>
          Clear
        </button>
      </div>
    `;
  }
}

@customElement('pix3-audio-resource-editor')
export class AudioResourceEditor extends ComponentBase {
  protected static useShadowDom = true;
  @property({ type: String })
  resourceUrl: string = '';

  @property({ type: String })
  previewUrl: string = '';

  @property({ type: String })
  waveformUrl: string = '';

  @property({ type: Number })
  durationSeconds: number = 0;

  @property({ type: Number })
  channelCount: number = 0;

  @property({ type: Number })
  sampleRate: number = 0;

  @property({ type: Number })
  fileSize: number = 0;

  @property({ type: Boolean, attribute: 'show-resource-controls' })
  showResourceControls: boolean = true;

  @property({ type: Boolean })
  disabled: boolean = false;

  @state()
  private isDragOver = false;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      width: 100%;
    }

    .drop-zone {
      border: 1px dashed var(--line-1);
      border-radius: var(--radius-2);
      min-height: 3.5rem;
      background: var(--bg-2);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0.75rem;
      box-sizing: border-box;
      transition:
        border-color 0.15s ease,
        background 0.15s ease;
    }

    .drop-zone.is-dragover {
      border-color: var(--accent);
      background: var(--accent-soft);
    }

    .drop-label {
      color: var(--fg-3);
      font-size: 0.75rem;
      text-align: center;
      line-height: 1.35;
    }

    .audio-card {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding: 0.625rem;
      border: 1px solid var(--line-1);
      border-radius: var(--radius-2);
      background: var(--bg-2);
    }

    .waveform {
      display: block;
      width: 100%;
      min-height: 5rem;
      border-radius: var(--radius-1);
      overflow: hidden;
      background: var(--bg-0);
      object-fit: cover;
    }

    .waveform-empty {
      display: grid;
      place-items: center;
      min-height: 5rem;
      border-radius: var(--radius-1);
      border: 1px dashed var(--line-1);
      background: var(--bg-0);
      color: var(--fg-3);
      font-size: 0.75rem;
      text-align: center;
      padding: 0.75rem;
      box-sizing: border-box;
    }

    .audio-player {
      width: 100%;
      height: 2rem;
    }

    .info-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
    }

    .info-item {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.2rem 0.45rem;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--fg-0);
      font-size: 0.72rem;
      line-height: 1.2;
    }

    .info-label {
      color: var(--fg-3);
    }

    .url-row {
      display: flex;
      gap: 0.4rem;
      align-items: center;
    }

    input {
      flex: 1;
      min-width: 0;
      background: var(--bg-2);
      color: var(--fg-0);
      border: 1px solid var(--line-1);
      border-radius: var(--radius-1);
      padding: 0.25rem 0.5rem;
      height: 30px;
      font-size: 13px;
      box-sizing: border-box;
    }

    input:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }

    button {
      border: 1px solid var(--line-1);
      background: var(--bg-2);
      color: var(--fg-1);
      border-radius: var(--radius-2);
      padding: 0.2rem 0.5rem;
      font-size: 0.75rem;
      cursor: pointer;
      white-space: nowrap;
    }

    button:hover:not(:disabled) {
      background: var(--bg-3);
      color: var(--fg-0);
    }

    button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }

    button:disabled,
    input:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
  `;

  private emitChange(url: string): void {
    this.dispatchEvent(
      new CustomEvent('change', {
        detail: { url },
        bubbles: true,
        composed: true,
      })
    );
  }

  private onDragOver(event: DragEvent): void {
    if (this.disabled) {
      return;
    }
    event.preventDefault();
    this.isDragOver = true;
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  private onDragLeave(): void {
    this.isDragOver = false;
  }

  private onDrop(event: DragEvent): void {
    if (this.disabled) {
      return;
    }
    event.preventDefault();
    this.isDragOver = false;

    this.dispatchEvent(
      new CustomEvent('audio-drop', {
        detail: { event },
        bubbles: true,
        composed: true,
      })
    );
  }

  private formatDuration(durationSeconds: number): string {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return '';
    }

    const totalSeconds = Math.round(durationSeconds);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  private formatSampleRate(sampleRate: number): string {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      return '';
    }

    const khz = sampleRate / 1000;
    return `${khz % 1 === 0 ? khz.toFixed(0) : khz.toFixed(1)} kHz`;
  }

  protected render() {
    const hasAudioValue = this.resourceUrl.trim().length > 0;
    const durationLabel = this.formatDuration(this.durationSeconds);
    const sampleRateLabel = this.formatSampleRate(this.sampleRate);

    return html`
      ${hasAudioValue
        ? html`
            <div class="audio-card">
              ${this.waveformUrl
                ? html`<img
                    class="waveform"
                    src=${this.waveformUrl}
                    alt="Audio waveform preview"
                  />`
                : html`<div class="waveform-empty">Audio preview will appear here.</div>`}
              ${this.previewUrl
                ? html`<audio
                    class="audio-player"
                    controls
                    preload="metadata"
                    src=${this.previewUrl}
                  ></audio>`
                : ''}
              ${durationLabel || this.channelCount > 0 || sampleRateLabel || this.fileSize > 0
                ? html`
                    <div class="info-row">
                      ${durationLabel
                        ? html`<span class="info-item"
                            ><span class="info-label">Duration</span>${durationLabel}</span
                          >`
                        : ''}
                      ${this.channelCount > 0
                        ? html`<span class="info-item"
                            ><span class="info-label">Channels</span>${this.channelCount}</span
                          >`
                        : ''}
                      ${sampleRateLabel
                        ? html`<span class="info-item"
                            ><span class="info-label">Rate</span>${sampleRateLabel}</span
                          >`
                        : ''}
                      ${this.fileSize > 0
                        ? html`<span class="info-item"
                            ><span class="info-label">Size</span>${formatBytes(this.fileSize)}</span
                          >`
                        : ''}
                    </div>
                  `
                : ''}
            </div>
          `
        : ''}
      ${this.showResourceControls
        ? html`
            <div
              class="drop-zone ${this.isDragOver ? 'is-dragover' : ''}"
              @dragover=${(event: DragEvent) => this.onDragOver(event)}
              @dragleave=${() => this.onDragLeave()}
              @drop=${(event: DragEvent) => this.onDrop(event)}
            >
              <span class="drop-label">Drop audio from Assets here</span>
            </div>

            <div class="url-row">
              <input
                type="text"
                .value=${this.resourceUrl}
                ?disabled=${this.disabled}
                placeholder="res://path/to/sound.wav"
                @change=${(e: Event) => this.emitChange((e.target as HTMLInputElement).value)}
              />
              <button
                type="button"
                ?disabled=${!this.resourceUrl.trim()}
                title="Show this file in the Asset Browser"
                @click=${() => dispatchLocate(this, this.resourceUrl)}
              >
                Locate
              </button>
              <button type="button" ?disabled=${this.disabled} @click=${() => this.emitChange('')}>
                Clear
              </button>
            </div>
          `
        : ''}
    `;
  }
}

@customElement('pix3-model-resource-editor')
export class ModelResourceEditor extends ComponentBase {
  protected static useShadowDom = true;
  @property({ type: String })
  resourceUrl: string = '';

  @property({ type: Boolean })
  disabled: boolean = false;

  @state()
  private isDragOver = false;

  static styles = AudioResourceEditor.styles;

  private emitChange(url: string): void {
    this.dispatchEvent(
      new CustomEvent('change', {
        detail: { url },
        bubbles: true,
        composed: true,
      })
    );
  }

  private onDragOver(event: DragEvent): void {
    if (this.disabled) {
      return;
    }
    event.preventDefault();
    this.isDragOver = true;
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  private onDragLeave(): void {
    this.isDragOver = false;
  }

  private onDrop(event: DragEvent): void {
    if (this.disabled) {
      return;
    }
    event.preventDefault();
    this.isDragOver = false;

    this.dispatchEvent(
      new CustomEvent('model-drop', {
        detail: { event },
        bubbles: true,
        composed: true,
      })
    );
  }

  protected render() {
    return html`
      <div
        class="drop-zone ${this.isDragOver ? 'is-dragover' : ''}"
        @dragover=${(event: DragEvent) => this.onDragOver(event)}
        @dragleave=${() => this.onDragLeave()}
        @drop=${(event: DragEvent) => this.onDrop(event)}
      >
        <span class="drop-label">Drop GLB/GLTF model from Assets here</span>
      </div>

      <div class="url-row">
        <input
          type="text"
          .value=${this.resourceUrl}
          ?disabled=${this.disabled}
          placeholder="res://path/to/model.glb"
          @change=${(e: Event) => this.emitChange((e.target as HTMLInputElement).value)}
        />
        <button
          type="button"
          ?disabled=${!this.resourceUrl.trim()}
          title="Show this file in the Asset Browser"
          @click=${() => dispatchLocate(this, this.resourceUrl)}
        >
          Locate
        </button>
        <button type="button" ?disabled=${this.disabled} @click=${() => this.emitChange('')}>
          Clear
        </button>
      </div>
    `;
  }
}

@customElement('pix3-animation-resource-editor')
export class AnimationResourceEditor extends ComponentBase {
  protected static useShadowDom = true;
  @property({ type: String })
  resourceUrl: string = '';

  @property({ type: Boolean })
  disabled: boolean = false;

  @property({ type: Boolean, attribute: 'show-create-button' })
  showCreateButton: boolean = false;

  @property({ type: Boolean, attribute: 'is-creating' })
  isCreating: boolean = false;

  @state()
  private isDragOver = false;

  static styles = AudioResourceEditor.styles;

  private emitChange(url: string): void {
    this.dispatchEvent(
      new CustomEvent('change', {
        detail: { url },
        bubbles: true,
        composed: true,
      })
    );
  }

  private onDragOver(event: DragEvent): void {
    if (this.disabled) {
      return;
    }
    event.preventDefault();
    this.isDragOver = true;
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  private onDragLeave(): void {
    this.isDragOver = false;
  }

  private onDrop(event: DragEvent): void {
    if (this.disabled) {
      return;
    }

    event.preventDefault();
    this.isDragOver = false;
    this.dispatchEvent(
      new CustomEvent('animation-drop', {
        detail: { event },
        bubbles: true,
        composed: true,
      })
    );
  }

  private emitCreateRequest(): void {
    if (this.disabled || this.isCreating) {
      return;
    }

    this.dispatchEvent(
      new CustomEvent('create-request', {
        bubbles: true,
        composed: true,
      })
    );
  }

  private emitOpenRequest(): void {
    const resourceUrl = this.resourceUrl.trim();
    if (!resourceUrl) {
      return;
    }

    this.dispatchEvent(
      new CustomEvent('open-request', {
        detail: { url: resourceUrl },
        bubbles: true,
        composed: true,
      })
    );
  }

  protected render() {
    const hasResource = this.resourceUrl.trim().length > 0;

    return html`
      <div
        class="drop-zone ${this.isDragOver ? 'is-dragover' : ''}"
        @dragover=${(event: DragEvent) => this.onDragOver(event)}
        @dragleave=${() => this.onDragLeave()}
        @drop=${(event: DragEvent) => this.onDrop(event)}
        @dblclick=${() => this.emitOpenRequest()}
      >
        <span class="drop-label">Drop .pix3anim asset from Assets here</span>
      </div>

      <div class="url-row">
        <input
          type="text"
          .value=${this.resourceUrl}
          ?disabled=${this.disabled || this.isCreating}
          placeholder="res://path/to/animation.pix3anim"
          @change=${(e: Event) => this.emitChange((e.target as HTMLInputElement).value)}
          @dblclick=${() => this.emitOpenRequest()}
        />
        ${!hasResource && this.showCreateButton
          ? html`
              <button
                type="button"
                ?disabled=${this.disabled || this.isCreating}
                @click=${() => this.emitCreateRequest()}
              >
                ${this.isCreating ? 'Creating…' : 'Create'}
              </button>
            `
          : html`
              <button
                type="button"
                ?disabled=${!hasResource}
                title="Show this file in the Asset Browser"
                @click=${() => dispatchLocate(this, this.resourceUrl)}
              >
                Locate
              </button>
              <button
                type="button"
                ?disabled=${this.isCreating || !hasResource}
                @click=${() => this.emitOpenRequest()}
              >
                Open
              </button>
              <button
                type="button"
                ?disabled=${this.disabled || this.isCreating}
                @click=${() => this.emitChange('')}
              >
                Clear
              </button>
            `}
      </div>
    `;
  }
}

export interface SizeValue {
  width: number;
  height: number;
  aspectRatioLocked?: boolean;
  hasOriginalSize?: boolean;
}

/**
 * Size Editor - Displays width and height fields with aspect ratio lock and reset button
 */
@customElement('pix3-size-editor')
export class SizeEditor extends ComponentBase {
  protected static useShadowDom = true;
  @property({ type: Number })
  width: number = 64;

  @property({ type: Number })
  height: number = 64;

  @property({ type: Boolean })
  aspectRatioLocked: boolean = false;

  @property({ type: Boolean })
  hasOriginalSize: boolean = false;

  @property({ type: Number })
  originalWidth: number | null = null;

  @property({ type: Number })
  originalHeight: number | null = null;

  @property({ type: Boolean })
  disabled: boolean = false;

  @state()
  private localAspectRatio: number = 1;

  updated(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has('width') || changedProperties.has('height')) {
      if (this.height > 0) {
        this.localAspectRatio = this.width / this.height;
      }
    }
  }

  private emitChange(width: number, height: number): void {
    this.dispatchEvent(
      new CustomEvent('change', {
        detail: { width, height, aspectRatioLocked: this.aspectRatioLocked },
        bubbles: true,
        composed: true,
      })
    );
  }

  private onWidthChange(newWidth: number): void {
    if (!Number.isFinite(newWidth) || newWidth <= 0) return;

    let newHeight = this.height;
    if (this.aspectRatioLocked && this.localAspectRatio > 0) {
      newHeight = newWidth / this.localAspectRatio;
    }

    this.emitChange(newWidth, newHeight);
  }

  private onHeightChange(newHeight: number): void {
    if (!Number.isFinite(newHeight) || newHeight <= 0) return;

    let newWidth = this.width;
    if (this.aspectRatioLocked && this.localAspectRatio > 0) {
      newWidth = newHeight * this.localAspectRatio;
    }

    this.emitChange(newWidth, newHeight);
  }

  private onToggleLock(): void {
    this.aspectRatioLocked = !this.aspectRatioLocked;
    this.emitChange(this.width, this.height);
  }

  private onResetSize(): void {
    if (this.originalWidth && this.originalHeight) {
      this.dispatchEvent(
        new CustomEvent('reset-size', {
          bubbles: true,
          composed: true,
        })
      );
    }
  }

  static styles = css`
    :host {
      display: flex;
      gap: 0.5rem;
      width: 100%;
    }

    .size-fields {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      width: 100%;
    }

    .field-group {
      display: flex;
      flex: 1;
      min-width: 0;
      align-items: center;
    }

    button {
      background: var(--bg-2);
      border: 1px solid var(--line-1);
      color: var(--fg-1);
      border-radius: var(--radius-2);
      padding: 0.2rem 0.4rem;
      font-size: 0.7rem;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
    }

    button.reset-btn:hover:not(:disabled) {
      background: var(--bg-3);
      color: var(--fg-0);
    }

    button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }

    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .controls {
      display: flex;
      gap: 0.4rem;
      align-items: center;
    }

    .lock-toggle {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    .lock-btn {
      background: transparent;
      border: 1px solid var(--line-1);
      color: var(--fg-1);
      border-radius: var(--radius-2);
      padding: 0.2rem 0.4rem;
      font-size: 0.8rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 30px;
      min-width: 28px;
    }

    .lock-btn:hover:not(:disabled) {
      background: var(--bg-2);
      color: var(--fg-0);
    }

    .lock-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }

    .lock-btn.locked {
      color: var(--accent);
      border-color: var(--accent-line);
      background: var(--accent-soft);
    }

    .lock-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
  `;

  protected render() {
    return html`
      <div class="size-fields">
        <div class="field-group">
          <pix3-number-field
            axis="w"
            .value=${this.width}
            .step=${1}
            .precision=${0}
            .min=${1}
            .sensitivity=${0.5}
            ?disabled=${this.disabled}
            @commit-change=${(e: CustomEvent<{ value: number }>) =>
              this.onWidthChange(e.detail.value)}
          ></pix3-number-field>
        </div>

        <div class="field-group">
          <pix3-number-field
            axis="h"
            .value=${this.height}
            .step=${1}
            .precision=${0}
            .min=${1}
            .sensitivity=${0.5}
            ?disabled=${this.disabled}
            @commit-change=${(e: CustomEvent<{ value: number }>) =>
              this.onHeightChange(e.detail.value)}
          ></pix3-number-field>
        </div>

        <div class="controls">
          <div class="lock-toggle" title="Lock aspect ratio when resizing">
            <button
              class="lock-btn ${this.aspectRatioLocked ? 'locked' : ''}"
              type="button"
              ?disabled=${this.disabled}
              @click=${() => this.onToggleLock()}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
              </svg>
            </button>
          </div>

          <button
            type="button"
            class="reset-btn"
            ?disabled=${this.disabled || !this.hasOriginalSize}
            @click=${() => this.onResetSize()}
            title="Reset to original size"
          >
            Reset
          </button>
        </div>
      </div>
    `;
  }
}

@customElement('pix3-slider-number-editor')
export class SliderNumberEditor extends ComponentBase {
  protected static useShadowDom = true;

  @property({ type: Number })
  value: number = 0;

  @property({ type: Number })
  min: number = 0;

  @property({ type: Number })
  max: number = 100;

  @property({ type: Number })
  step: number = 0.01;

  @property({ type: Number })
  precision: number = 2;

  @property({ type: Boolean })
  disabled: boolean = false;

  private clamp(v: number): number {
    const hasFiniteMin = Number.isFinite(this.min);
    const hasFiniteMax = Number.isFinite(this.max);
    let result = v;

    if (hasFiniteMin) {
      result = Math.max(this.min, result);
    }
    if (hasFiniteMax) {
      result = Math.min(this.max, result);
    }
    return result;
  }

  private emitChange(nextValue: number): void {
    this.dispatchEvent(
      new CustomEvent('preview-change', {
        detail: { value: nextValue },
        bubbles: true,
        composed: true,
      })
    );
  }

  private emitCommit(nextValue: number): void {
    this.dispatchEvent(
      new CustomEvent('commit-change', {
        detail: { value: nextValue },
        bubbles: true,
        composed: true,
      })
    );
  }

  private onSliderInput(event: Event): void {
    const raw = Number.parseFloat((event.target as HTMLInputElement).value);
    if (!Number.isFinite(raw)) {
      return;
    }
    this.emitChange(this.clamp(raw));
  }

  private onNumberInput(event: Event): void {
    const raw = Number.parseFloat((event.target as HTMLInputElement).value);
    if (!Number.isFinite(raw)) {
      return;
    }
    this.emitChange(this.clamp(raw));
  }

  private onSliderCommit(event: Event): void {
    const raw = Number.parseFloat((event.target as HTMLInputElement).value);
    if (!Number.isFinite(raw)) {
      return;
    }
    this.emitCommit(this.clamp(raw));
  }

  private onNumberCommit(event: Event): void {
    const raw = Number.parseFloat((event.target as HTMLInputElement).value);
    if (!Number.isFinite(raw)) {
      return;
    }
    this.emitCommit(this.clamp(raw));
  }

  static styles = css`
    :host {
      display: flex;
      width: 100%;
      align-items: center;
      gap: 0.5rem;
    }

    .slider {
      flex: 1;
      accent-color: var(--accent);
      min-width: 0;
    }

    .number-input {
      width: 5.5rem;
      background: var(--bg-2);
      color: var(--fg-0);
      border: 1px solid var(--line-1);
      border-radius: var(--radius-1);
      padding: 0.25rem 0.45rem;
      height: 30px;
      font-size: 13px;
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      box-sizing: border-box;
      text-align: right;
    }

    .number-input:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }

    .slider:disabled,
    .number-input:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
  `;

  protected render() {
    const safeStep = Number.isFinite(this.step) && this.step > 0 ? this.step : 0.01;
    const safeValue = this.clamp(this.value);

    return html`
      <input
        class="slider"
        type="range"
        .value=${safeValue.toString()}
        min=${this.min.toString()}
        max=${this.max.toString()}
        step=${safeStep.toString()}
        ?disabled=${this.disabled}
        @input=${(event: Event) => this.onSliderInput(event)}
        @change=${(event: Event) => this.onSliderCommit(event)}
        @pointerup=${(event: Event) => this.onSliderCommit(event)}
      />
      <input
        class="number-input"
        type="number"
        .value=${safeValue.toFixed(this.precision)}
        min=${this.min.toString()}
        max=${this.max.toString()}
        step=${safeStep.toString()}
        ?disabled=${this.disabled}
        @input=${(event: Event) => this.onNumberInput(event)}
        @change=${(event: Event) => this.onNumberCommit(event)}
        @blur=${(event: Event) => this.onNumberCommit(event)}
      />
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-number-field': NumberField;
    'pix3-vector2-editor': Vector2Editor;
    'pix3-vector3-editor': Vector3Editor;
    'pix3-euler-editor': EulerEditor;
    'pix3-texture-resource-editor': TextureResourceEditor;
    'pix3-audio-resource-editor': AudioResourceEditor;
    'pix3-model-resource-editor': ModelResourceEditor;
    'pix3-animation-resource-editor': AnimationResourceEditor;
    'pix3-size-editor': SizeEditor;
    'pix3-slider-number-editor': SliderNumberEditor;
  }
}
