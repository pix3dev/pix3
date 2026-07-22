import { ComponentBase, customElement, html, property, state, inject } from '@/fw';
import { IconService, IconSize } from '@/services/editor/IconService';
import { DropdownPortal } from './dropdown-portal';
import './pix3-dropdown-button.ts.css';

export interface DropdownItem {
  id: string;
  label: string;
  icon?: string;
  disabled?: boolean;
  divider?: boolean;
}

@customElement('pix3-dropdown-button')
export class Pix3DropdownButton extends ComponentBase {
  @inject(IconService)
  private readonly iconService!: IconService;

  @property({ type: String })
  icon = '';

  @property({ type: String, attribute: 'aria-label' })
  ariaLabel = 'Menu';

  @property({ type: Boolean, reflect: true })
  disabled = false;

  @property({ type: Array })
  items: DropdownItem[] = [];

  @property({ type: Array })
  groupedItems: Array<{ label: string; items: DropdownItem[] }> = [];

  @state()
  private isOpen = false;

  private portal: DropdownPortal = new DropdownPortal({ minWidth: '12rem' });

  connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute('role', 'menubutton');
    this.setAttribute('aria-haspopup', 'menu');
    this.setAttribute('aria-expanded', 'false');
    if (!this.hasAttribute('tabindex')) {
      this.tabIndex = -1;
    }
    this.setupEventListeners();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListeners();
    this.portal.close();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has('disabled')) {
      this.updateAriaDisabled();
    }

    if (changed.has('isOpen')) {
      this.setAttribute('aria-expanded', String(this.isOpen));
      this.updatePortal();
    }

    if (changed.has('ariaLabel')) {
      this.setAttribute('aria-label', this.ariaLabel);
    }
  }

  private keydownHandler = (event: KeyboardEvent) => {
    if (this.disabled) {
      return;
    }

    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      this.isOpen = !this.isOpen;
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.isOpen = false;
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
      return;
    }
    this.isOpen = !this.isOpen;
  };

  private setupEventListeners(): void {
    this.addEventListener('keydown', this.keydownHandler);
    this.addEventListener('pointerdown', this.pointerDownHandler);
    this.addEventListener('click', this.clickHandler, { capture: true });
    document.addEventListener('click', this.handleOutsideClick);
  }

  private removeEventListeners(): void {
    this.removeEventListener('keydown', this.keydownHandler);
    this.removeEventListener('pointerdown', this.pointerDownHandler);
    this.removeEventListener('click', this.clickHandler, { capture: true });
    document.removeEventListener('click', this.handleOutsideClick);
  }

  private handleOutsideClick = (event: MouseEvent) => {
    const target = event.target as Node;
    if (!this.contains(target) && this.isOpen) {
      this.isOpen = false;
    }
  };

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

  private selectItem = (item: DropdownItem) => {
    if (item.disabled || item.divider) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent('item-select', {
        detail: item,
        bubbles: true,
        composed: true,
      })
    );
    this.isOpen = false;
  };

  private updatePortal(): void {
    if (this.isOpen) {
      // Get the hidden menu element and open the portal
      const menuElement = this.querySelector('.dropdown__menu') as HTMLElement;
      if (menuElement) {
        this.portal.open(this, menuElement);
      }
    } else {
      this.portal.close();
    }
  }

  protected render() {
    return html`
      <div class="dropdown__trigger">
        ${this.icon
          ? html`<span class="dropdown__icon"
              >${this.iconService.getIconOrRawSvg(this.icon, IconSize.LARGE)}</span
            >`
          : null}
        ${this.iconService.getIcon('chevron-down-caret', 12)}
      </div>
      <div class="dropdown__menu dropdown__menu--hidden" role="menu">
        ${this.groupedItems.length > 0
          ? this.groupedItems.map(
              group =>
                html`<div class="dropdown__group">
                  <div class="dropdown__group-label">${group.label}</div>
                  ${group.items.map(
                    item =>
                      html`<button
                        role="menuitem"
                        class="dropdown__item dropdown__item--grouped"
                        @click=${() => this.selectItem(item)}
                      >
                        ${item.icon
                          ? html`<span class="dropdown__item-icon"
                              >${this.iconService.getIconOrRawSvg(item.icon, IconSize.MEDIUM)}</span
                            >`
                          : null}
                        <span class="dropdown__item-label">${item.label}</span>
                      </button>`
                  )}
                </div>`
            )
          : this.items.map(
              item =>
                html`${item.divider
                  ? html`<div class="dropdown__divider" role="separator"></div>`
                  : html`<button
                      role="menuitem"
                      class="dropdown__item ${item.disabled ? 'dropdown__item--disabled' : ''}"
                      ?disabled=${item.disabled}
                      @click=${() => this.selectItem(item)}
                    >
                      ${item.icon
                        ? html`<span class="dropdown__item-icon"
                            >${this.iconService.getIconOrRawSvg(item.icon, IconSize.MEDIUM)}</span
                          >`
                        : null}
                      <span class="dropdown__item-label">${item.label}</span>
                    </button>`}`
            )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-dropdown-button': Pix3DropdownButton;
  }
}
