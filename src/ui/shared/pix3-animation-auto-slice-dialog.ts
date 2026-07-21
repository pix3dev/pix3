import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { ProjectStorageService } from '@/services/ProjectStorageService';
import './pix3-animation-auto-slice-dialog.ts.css';

@customElement('pix3-animation-auto-slice-dialog')
export class AnimationAutoSliceDialog extends ComponentBase {
  @inject(ProjectStorageService)
  private readonly projectStorage!: ProjectStorageService;

  @property({ type: String, reflect: true })
  public dialogId = '';

  @property({ type: String })
  public texturePath = '';

  @property({ type: String })
  public clipName = 'idle';

  @property({ type: Number })
  public defaultColumns = 1;

  @property({ type: Number })
  public defaultRows = 1;

  @state()
  private columns = 1;

  @state()
  private rows = 1;

  @state()
  private previewUrl = '';

  @state()
  private previewError: string | null = null;

  private loadToken = 0;

  connectedCallback(): void {
    super.connectedCallback();
    this.resetGridDefaults();
    void this.loadPreviewTexture();
  }

  protected updated(changedProperties: Map<PropertyKey, unknown>): void {
    if (
      changedProperties.has('dialogId') ||
      changedProperties.has('defaultColumns') ||
      changedProperties.has('defaultRows')
    ) {
      this.resetGridDefaults();
    }

    if (changedProperties.has('texturePath')) {
      void this.loadPreviewTexture();
    }
  }

  disconnectedCallback(): void {
    this.revokePreviewUrl();
    super.disconnectedCallback();
  }

  protected render() {
    const isValid =
      Number.isFinite(this.columns) &&
      Number.isFinite(this.rows) &&
      this.columns > 0 &&
      this.rows > 0;
    const previewGridStyle = `--slice-columns:${this.columns}; --slice-rows:${this.rows};`;
    const frameCount = this.columns * this.rows;

    return html`
      <div class="dialog-backdrop" @click=${this.onBackdropClick}>
        <div class="dialog-content" @click=${(event: Event) => event.stopPropagation()}>
          <h2 class="dialog-title">Slice Spritesheet</h2>
          <div class="dialog-layout">
            <div class="preview-panel">
              <div class="preview-header">
                <div>
                  <div class="dialog-copy dialog-copy--compact">Active clip</div>
                  <div class="dialog-highlight">${this.clipName}</div>
                </div>
                <div class="preview-stat">${frameCount} frames</div>
              </div>
              <div class="preview-surface" style=${previewGridStyle}>
                ${this.previewUrl
                  ? html`
                      <img class="preview-image" src=${this.previewUrl} alt="Spritesheet preview" />
                      <div class="preview-grid"></div>
                    `
                  : html`
                      <div class="preview-placeholder">
                        ${this.previewError ?? 'Texture preview is unavailable for this asset.'}
                      </div>
                    `}
              </div>
              <div class="dialog-copy dialog-copy--compact dialog-copy--path">
                ${this.texturePath}
              </div>
            </div>

            <div class="controls-panel">
              <p class="dialog-copy">
                Adjust the grid until the overlay matches the intended frame boundaries.
              </p>
              <div class="form-grid">
                <div class="field">
                  <label for="autoslice-columns">Columns</label>
                  <input
                    id="autoslice-columns"
                    type="number"
                    min="1"
                    step="1"
                    .value=${String(this.columns)}
                    @input=${(event: Event) => {
                      this.columns = Math.max(
                        1,
                        Number((event.target as HTMLInputElement).value) || 1
                      );
                    }}
                  />
                </div>
                <div class="field">
                  <label for="autoslice-rows">Rows</label>
                  <input
                    id="autoslice-rows"
                    type="number"
                    min="1"
                    step="1"
                    .value=${String(this.rows)}
                    @input=${(event: Event) => {
                      this.rows = Math.max(
                        1,
                        Number((event.target as HTMLInputElement).value) || 1
                      );
                    }}
                  />
                </div>
              </div>
              <div class="preview-stats-grid">
                <div>
                  <span class="stats-label">Frames</span>
                  <strong>${frameCount}</strong>
                </div>
                <div>
                  <span class="stats-label">Cell Size</span>
                  <strong>${(1 / this.columns).toFixed(3)} x ${(1 / this.rows).toFixed(3)}</strong>
                </div>
              </div>
              <p class="dialog-note">
                Confirm to append the generated frame sequence to the active clip.
              </p>
            </div>
          </div>
          <div class="dialog-actions">
            <button class="btn-secondary" @click=${this.handleCancel}>Keep Without Slicing</button>
            <button class="btn-primary" ?disabled=${!isValid} @click=${this.handleConfirm}>
              Slice Frames
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private resetGridDefaults(): void {
    this.columns = Math.max(1, this.defaultColumns || 1);
    this.rows = Math.max(1, this.defaultRows || 1);
  }

  private async loadPreviewTexture(): Promise<void> {
    const texturePath = this.texturePath.trim();
    this.previewError = null;
    this.loadToken += 1;
    const token = this.loadToken;

    this.revokePreviewUrl();

    if (!texturePath) {
      return;
    }

    try {
      const blob = await this.projectStorage.readBlob(texturePath);
      if (token !== this.loadToken) {
        return;
      }

      this.previewUrl = URL.createObjectURL(blob);
    } catch (error) {
      if (token !== this.loadToken) {
        return;
      }

      this.previewUrl = '';
      this.previewError =
        error instanceof Error ? error.message : 'Texture preview is unavailable for this asset.';
    }
  }

  private revokePreviewUrl(): void {
    if (this.previewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(this.previewUrl);
    }

    this.previewUrl = '';
  }

  private onBackdropClick(): void {
    this.handleCancel();
  }

  private handleCancel = (): void => {
    this.dispatchEvent(
      new CustomEvent('animation-auto-slice-cancelled', {
        detail: { dialogId: this.dialogId },
        bubbles: true,
        composed: true,
      })
    );
  };

  private handleConfirm = (): void => {
    this.dispatchEvent(
      new CustomEvent('animation-auto-slice-confirmed', {
        detail: {
          dialogId: this.dialogId,
          columns: this.columns,
          rows: this.rows,
        },
        bubbles: true,
        composed: true,
      })
    );
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-animation-auto-slice-dialog': AnimationAutoSliceDialog;
  }
}
