import { ComponentBase, customElement, html, property, state } from '@/fw';
import type { DialogExpandableSection } from '@/services/editor/DialogService';
import './pix3-confirm-dialog.ts.css';

@customElement('pix3-confirm-dialog')
export class ConfirmDialog extends ComponentBase {
  @property({ type: String, reflect: true })
  public dialogId: string = '';

  @property({ type: String, reflect: true })
  public title: string = '';

  @property({ type: String, reflect: true })
  public message: string = '';

  @property({ type: String, reflect: true })
  public confirmLabel: string = 'Confirm';

  @property({ type: String, reflect: true })
  public secondaryLabel: string = '';

  @property({ type: String, reflect: true })
  public cancelLabel: string = 'Cancel';

  @property({ type: Boolean, reflect: true })
  public isDangerous: boolean = false;

  @property({ type: Boolean, reflect: true })
  public secondaryIsDangerous: boolean = false;

  @property({ type: String })
  public requiredInputLabel: string = '';

  @property({ type: String })
  public requiredInputValue: string = '';

  @property({ type: String })
  public requiredInputPlaceholder: string = '';

  @property({ type: String })
  public disclaimer: string = '';

  @property({ attribute: false })
  public expandableSection: DialogExpandableSection | null = null;

  @state()
  private confirmationInput: string = '';

  private get requiresExactConfirmation(): boolean {
    return this.requiredInputValue.length > 0;
  }

  private get isConfirmationSatisfied(): boolean {
    return !this.requiresExactConfirmation || this.confirmationInput === this.requiredInputValue;
  }

  protected render() {
    const expandableSection = this.expandableSection;

    return html`
      <div
        class="dialog-backdrop"
        @click=${this.onBackdropClick}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === 'Escape') this.dispatchCancel();
        }}
      >
        <div
          class="dialog-content ${expandableSection ? 'dialog-content--with-expandable' : ''}"
          role="alertdialog"
          aria-modal="true"
          @click=${(e: Event) => e.stopPropagation()}
          @keydown=${() => {}}
        >
          <h2 class="dialog-title">${this.title}</h2>
          <p class="dialog-message">${this.message}</p>
          ${this.disclaimer ? html`<p class="dialog-disclaimer">${this.disclaimer}</p>` : null}
          ${this.renderExpandableSection(expandableSection)}
          ${this.requiresExactConfirmation
            ? html`
                <label class="dialog-confirmation">
                  <span class="dialog-confirmation__label"
                    >${this.requiredInputLabel ||
                    `Type ${this.requiredInputValue} to confirm.`}</span
                  >
                  <input
                    class="dialog-confirmation__input"
                    type="text"
                    .value=${this.confirmationInput}
                    placeholder=${this.requiredInputPlaceholder || this.requiredInputValue}
                    spellcheck="false"
                    autocapitalize="off"
                    autocomplete="off"
                    @input=${this.onConfirmationInput}
                  />
                </label>
              `
            : null}
          <div class="dialog-actions">
            <button class="btn-cancel" @click=${() => this.dispatchCancel()}>
              ${this.cancelLabel}
            </button>
            ${this.secondaryLabel
              ? html`
                  <button
                    class="btn-confirm ${this.secondaryIsDangerous ? 'dangerous' : ''}"
                    @click=${() => this.dispatchSecondary()}
                  >
                    ${this.secondaryLabel}
                  </button>
                `
              : null}
            <button
              class="btn-confirm ${this.isDangerous ? 'dangerous' : ''}"
              ?disabled=${!this.isConfirmationSatisfied}
              @click=${() => this.dispatchConfirm()}
            >
              ${this.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderExpandableSection(expandableSection: DialogExpandableSection | null) {
    if (!expandableSection || expandableSection.items.length === 0) {
      return null;
    }

    const maxHeightPx = Math.max(120, expandableSection.maxHeightPx ?? 240);

    return html`
      <details
        class="dialog-expandable"
        style=${`--dialog-expandable-max-height: ${maxHeightPx}px;`}
      >
        <summary class="dialog-expandable__summary">
          <span class="dialog-expandable__title">${expandableSection.title}</span>
          <span class="dialog-expandable__count">${expandableSection.items.length}</span>
        </summary>
        <div class="dialog-expandable__body">
          <ul class="dialog-expandable__list">
            ${expandableSection.items.map(
              item => html`<li class="dialog-expandable__item">${item}</li>`
            )}
          </ul>
        </div>
      </details>
    `;
  }

  private onConfirmationInput(event: Event): void {
    this.confirmationInput = (event.currentTarget as HTMLInputElement).value;
  }

  private onBackdropClick(): void {
    this.dispatchCancel();
  }

  private dispatchConfirm(): void {
    if (!this.isConfirmationSatisfied) {
      return;
    }

    this.dispatchEvent(
      new CustomEvent('dialog-confirmed', {
        detail: { dialogId: this.dialogId },
        bubbles: true,
        composed: true,
      })
    );
  }

  private dispatchCancel(): void {
    this.dispatchEvent(
      new CustomEvent('dialog-cancelled', {
        detail: { dialogId: this.dialogId },
        bubbles: true,
        composed: true,
      })
    );
  }

  private dispatchSecondary(): void {
    this.dispatchEvent(
      new CustomEvent('dialog-secondary', {
        detail: { dialogId: this.dialogId },
        bubbles: true,
        composed: true,
      })
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-confirm-dialog': ConfirmDialog;
  }
}
