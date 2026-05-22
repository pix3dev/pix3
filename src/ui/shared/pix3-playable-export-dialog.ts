import { ComponentBase, customElement, html, property, state } from '@/fw';
import './pix3-playable-export-dialog.ts.css';

@customElement('pix3-playable-export-dialog')
export class Pix3PlayableExportDialog extends ComponentBase {
  @property({ type: String, reflect: true })
  public dialogId: string = '';

  @property({ attribute: false })
  public scenePaths: readonly string[] = [];

  @property({ type: String })
  public selectedScenePath: string = '';

  @state()
  private draftScenePath: string = '';

  connectedCallback(): void {
    super.connectedCallback();
    this.syncDraftScenePath();
  }

  protected updated(): void {
    if (!this.scenePaths.includes(this.draftScenePath)) {
      this.syncDraftScenePath();
    }
  }

  protected render() {
    const selectedScenePath =
      this.draftScenePath ||
      (this.scenePaths.includes(this.selectedScenePath)
        ? this.selectedScenePath
        : (this.scenePaths[0] ?? ''));

    return html`
      <div class="dialog-backdrop" @click=${this.onBackdropClick}>
        <div
          class="dialog-content playable-export-dialog-content"
          role="dialog"
          aria-modal="true"
          aria-label="Export playable HTML"
          @click=${(event: Event) => event.stopPropagation()}
          @keydown=${this.onDialogKeyDown}
        >
          <h2 class="dialog-title">Export Playable HTML</h2>
          <p class="dialog-message">
            Choose which scene should start when the exported HTML file opens in the browser.
          </p>

          <label class="dialog-field">
            <span class="dialog-field__label">Entry Scene</span>
            <select
              class="dialog-field__select"
              .value=${selectedScenePath}
              @change=${this.onSceneChange}
              autofocus
            >
              ${this.scenePaths.map(
                scenePath => html`
                  <option value=${scenePath}>${scenePath}</option>
                `
              )}
            </select>
          </label>

          <div class="dialog-actions">
            <button class="btn-secondary" @click=${this.dispatchCancel}>Cancel</button>
            <button
              class="btn-primary"
              ?disabled=${selectedScenePath.length === 0}
              @click=${() => this.dispatchConfirm(selectedScenePath)}
            >
              Export
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private syncDraftScenePath(): void {
    this.draftScenePath = this.scenePaths.includes(this.selectedScenePath)
      ? this.selectedScenePath
      : (this.scenePaths[0] ?? '');
  }

  private onSceneChange(event: Event): void {
    this.draftScenePath = (event.currentTarget as HTMLSelectElement).value;
  }

  private onDialogKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.dispatchCancel();
      return;
    }

    if (event.key === 'Enter' && this.draftScenePath) {
      event.preventDefault();
      this.dispatchConfirm(this.draftScenePath);
    }
  };

  private onBackdropClick(): void {
    this.dispatchCancel();
  }

  private dispatchConfirm(scenePath: string): void {
    this.dispatchEvent(
      new CustomEvent('playable-export-confirmed', {
        detail: { dialogId: this.dialogId, scenePath },
        bubbles: true,
        composed: true,
      })
    );
  }

  private dispatchCancel = (): void => {
    this.dispatchEvent(
      new CustomEvent('playable-export-cancelled', {
        detail: { dialogId: this.dialogId },
        bubbles: true,
        composed: true,
      })
    );
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-playable-export-dialog': Pix3PlayableExportDialog;
  }
}