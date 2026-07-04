import { ComponentBase, customElement, html, property, inject } from '@/fw';
import { IconService, IconSize } from '@/services/IconService';
import './pix3-toolbar-button.ts.css';

@customElement('pix3-toolbar-button')
export class Pix3ToolbarButton extends ComponentBase {
  @inject(IconService)
  private readonly iconService!: IconService;

  @property({ type: Boolean, reflect: true })
  disabled = false;

  @property({ type: Boolean, reflect: true })
  toggled = false;

  @property({ attribute: 'aria-label' })
  label: string | null = null;

  /**
   * Hover tooltip text. Reflected to the native `title` attribute so the
   * browser shows a tooltip on the custom-element host. Falls back to `label`
   * when unset, so icon-only buttons get a tooltip for free without regressing
   * the screen-reader `aria-label`.
   */
  @property({ type: String })
  tooltip: string | null = null;

  @property({ type: Boolean, reflect: true })
  iconOnly = false;

  @property({ type: String })
  icon: string | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute('role', 'button');
    this.setAttribute('aria-pressed', String(this.toggled));
    if (!this.hasAttribute('tabindex')) {
      this.tabIndex = -1;
    }
    this.updateAriaDisabled();
    this.updateTitle();
    this.setupEventListeners();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListeners();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has('toggled')) {
      this.setAttribute('aria-pressed', String(this.toggled));
    }

    if (changed.has('disabled')) {
      this.updateAriaDisabled();
    }

    if (changed.has('label')) {
      if (this.label) {
        this.setAttribute('aria-label', this.label);
      } else {
        this.removeAttribute('aria-label');
      }
    }

    if (changed.has('tooltip') || changed.has('label')) {
      this.updateTitle();
    }
  }

  private updateTitle(): void {
    const title = this.tooltip ?? this.label;
    if (title) {
      this.setAttribute('title', title);
    } else {
      this.removeAttribute('title');
    }
  }

  private keydownHandler = (event: KeyboardEvent) => {
    if (this.disabled) {
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      this.click();
    }
  };

  private pointerDownHandler = (event: PointerEvent) => {
    if (this.disabled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    this.focus();
  };

  private clickHandler = (event: MouseEvent) => {
    if (this.disabled) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  private setupEventListeners(): void {
    this.addEventListener('keydown', this.keydownHandler);
    this.addEventListener('pointerdown', this.pointerDownHandler);
    this.addEventListener('click', this.clickHandler, { capture: true });
  }

  private removeEventListeners(): void {
    this.removeEventListener('keydown', this.keydownHandler);
    this.removeEventListener('pointerdown', this.pointerDownHandler);
    this.removeEventListener('click', this.clickHandler, { capture: true });
  }

  private updateAriaDisabled(): void {
    if (this.disabled) {
      this.setAttribute('aria-disabled', 'true');
      this.tabIndex = -1;
    } else {
      this.removeAttribute('aria-disabled');
      if (!this.hasAttribute('tabindex')) {
        this.tabIndex = -1;
      }
    }
  }

  protected render() {
    return html`<span class="toolbar-button">
      ${this.icon
        ? html`<span class="toolbar-icon"
            >${this.iconService.getIcon(this.icon, IconSize.LARGE)}</span
          >`
        : null}
      <slot></slot>
    </span>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-toolbar-button': Pix3ToolbarButton;
  }
}
