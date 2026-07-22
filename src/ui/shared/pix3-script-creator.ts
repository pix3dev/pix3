import { ComponentBase, customElement, html, property, state } from '@/fw';
import './pix3-script-creator.ts.css';

@customElement('pix3-script-creator')
export class ScriptCreator extends ComponentBase {
  @property({ type: String, reflect: true })
  public dialogId: string = '';

  @property({ type: String })
  public defaultName: string = '';

  @state()
  private scriptName: string = '';

  @state()
  private errorMessage: string = '';

  connectedCallback() {
    super.connectedCallback();
    this.scriptName = this.defaultName || 'NewScript';
  }

  protected render() {
    const fullClassName = this.getFullClassName();
    const fileName = `${fullClassName}.ts`;

    return html`
      <div class="dialog-backdrop" @click=${this.onBackdropClick}>
        <div
          class="dialog-content script-creator-content"
          @click=${(e: Event) => e.stopPropagation()}
        >
          <div class="dialog-header">
            <h2 class="dialog-title">Create New Component</h2>
          </div>

          <div class="dialog-body">
            <div class="form-group">
              <label for="script-name" class="form-label">Script Name</label>
              <input
                id="script-name"
                type="text"
                class="form-input"
                .value=${this.scriptName}
                @input=${(e: InputEvent) => {
                  this.scriptName = (e.target as HTMLInputElement).value;
                  this.errorMessage = '';
                }}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter') this.handleCreate();
                  if (e.key === 'Escape') this.handleCancel();
                }}
                placeholder="Enter script name"
                autofocus
              />
              ${this.errorMessage
                ? html`<div class="error-message">${this.errorMessage}</div>`
                : ''}
              <div class="help-text">
                The script will be created in the <code>scripts/</code> folder as
                <code>${fileName}</code>
              </div>
            </div>
          </div>

          <div class="dialog-actions">
            <button class="btn-secondary" @click=${this.handleCancel}>Cancel</button>
            <button
              class="btn-primary"
              ?disabled=${!this.isValidScriptName()}
              @click=${this.handleCreate}
            >
              Create Script
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private getFileName(): string {
    const name = this.scriptName.trim();
    if (!name) return 'NewScript';
    // Convert to PascalCase if not already
    const pascalCase = name.charAt(0).toUpperCase() + name.slice(1);
    return pascalCase;
  }

  private getFullClassName(): string {
    const fileName = this.getFileName();
    return `${fileName}`;
  }

  private isValidScriptName(): boolean {
    const name = this.scriptName.trim();
    if (!name) return false;
    // Check if name is a valid identifier
    const validIdentifier = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
    return validIdentifier.test(name);
  }

  private onBackdropClick(): void {
    this.handleCancel();
  }

  private handleCreate(): void {
    if (!this.isValidScriptName()) {
      this.errorMessage = 'Please enter a valid script name (letters, numbers, underscore only)';
      return;
    }

    this.dispatchEvent(
      new CustomEvent('script-create-confirmed', {
        detail: {
          dialogId: this.dialogId,
          scriptName: this.getFileName(),
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleCancel(): void {
    this.dispatchEvent(
      new CustomEvent('script-create-cancelled', {
        detail: { dialogId: this.dialogId },
        bubbles: true,
        composed: true,
      })
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-script-creator': ScriptCreator;
  }
}
