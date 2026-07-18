import { ComponentBase, customElement, html, property, state } from '@/fw';
import { createRef, ref } from 'lit/directives/ref.js';
import './pix3-save-asset-dialog.ts.css';

/**
 * Modal that lets the user name a generated image before it is written into the project.
 * Shown when an Sprite Editor history entry is dropped onto the Asset Browser or Asset
 * Preview panel. The blob write itself is performed by the caller (see
 * {@link GeneratedAssetDropService}); this dialog only collects the file name.
 */
@customElement('pix3-save-asset-dialog')
export class SaveAssetDialog extends ComponentBase {
  @property({ type: String, reflect: true })
  public dialogId = '';

  @property({ type: String })
  public suggestedName = '';

  @property({ type: String })
  public targetDirectory = '.';

  @property({ type: String })
  public previewUrl = '';

  @property({ type: Number })
  public width = 0;

  @property({ type: Number })
  public height = 0;

  @state()
  private fileName = '';

  private readonly inputRef = createRef<HTMLInputElement>();
  private initialized = false;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.onWindowKeyDown, true);
  }

  disconnectedCallback(): void {
    window.removeEventListener('keydown', this.onWindowKeyDown, true);
    super.disconnectedCallback();
  }

  protected updated(): void {
    if (!this.initialized && this.suggestedName) {
      this.initialized = true;
      this.fileName = this.suggestedName;
      // Focus the field and select the base name (without extension) for quick renaming.
      void this.updateComplete.then(() => {
        const input = this.inputRef.value;
        if (input) {
          input.focus();
          const dot = this.fileName.lastIndexOf('.');
          input.setSelectionRange(0, dot > 0 ? dot : this.fileName.length);
        }
      });
    }
  }

  protected render() {
    const targetLabel = this.targetDirectory === '.' ? 'project root' : this.targetDirectory;
    const dimensions = this.width > 0 && this.height > 0 ? `${this.width} × ${this.height}` : null;
    const canSave = this.fileName.trim().length > 0;

    return html`
      <div class="dialog-backdrop" @click=${this.onCancel}>
        <div
          class="dialog-content"
          role="dialog"
          aria-modal="true"
          aria-label="Save image"
          @click=${(event: Event) => event.stopPropagation()}
        >
          <h2 class="dialog-title">Save image</h2>

          <div class="save-body">
            <div class="save-preview">
              ${this.previewUrl ? html`<img src=${this.previewUrl} alt="Image to save" />` : null}
            </div>
            <div class="save-fields">
              <p class="save-target">
                Destination <span class="save-target__path">res://${targetLabel}</span>
              </p>
              ${dimensions ? html`<p class="save-dimensions">${dimensions} px</p>` : null}
              <label class="save-field">
                <span class="save-field__label">File name</span>
                <input
                  ${ref(this.inputRef)}
                  class="save-field__input"
                  type="text"
                  spellcheck="false"
                  autocomplete="off"
                  placeholder="name.png"
                  .value=${this.fileName}
                  @input=${this.onNameInput}
                  @keydown=${this.onInputKeyDown}
                />
              </label>
            </div>
          </div>

          <div class="dialog-actions">
            <button class="btn-cancel" type="button" @click=${this.onCancel}>Cancel</button>
            <button
              class="btn-confirm"
              type="button"
              ?disabled=${!canSave}
              @click=${this.onConfirm}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private onNameInput(event: Event): void {
    this.fileName = (event.target as HTMLInputElement).value;
  }

  private onInputKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.onConfirm();
    }
  }

  private onWindowKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.onCancel();
    }
  };

  private onConfirm(): void {
    const fileName = this.fileName.trim();
    if (!fileName) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent('save-asset-confirmed', {
        detail: { dialogId: this.dialogId, fileName },
        bubbles: true,
        composed: true,
      })
    );
  }

  private onCancel = (): void => {
    this.dispatchEvent(
      new CustomEvent('save-asset-cancelled', {
        detail: { dialogId: this.dialogId },
        bubbles: true,
        composed: true,
      })
    );
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-save-asset-dialog': SaveAssetDialog;
  }
}
