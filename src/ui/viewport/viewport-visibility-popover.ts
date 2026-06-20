import { ComponentBase, customElement, html, property, state, inject } from '@/fw';
import { IconService } from '@/services/IconService';
import { DropdownPortal } from '@/ui/shared/dropdown-portal';
import './viewport-visibility-popover.ts.css';

@customElement('pix3-viewport-visibility-popover')
export class ViewportVisibilityPopover extends ComponentBase {
  @inject(IconService)
  private readonly iconService!: IconService;

  @property({ type: Boolean })
  showGrid = false;

  @property({ type: Boolean })
  showLighting = false;

  @property({ type: Boolean })
  showLayer2D = false;

  @property({ type: Boolean })
  showLayer3D = false;

  @state()
  private isOpen = false;

  private readonly portal = new DropdownPortal({ minWidth: '18rem' });

  connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute('role', 'button');
    this.setAttribute('aria-haspopup', 'menu');
    this.setAttribute('aria-expanded', 'false');
    if (!this.hasAttribute('tabindex')) {
      this.tabIndex = -1;
    }
    this.addEventListener('keydown', this.handleKeyDown);
    this.addEventListener('pointerdown', this.handlePointerDown);
    this.addEventListener('click', this.handleClick, { capture: true });
    document.addEventListener('click', this.handleOutsideClick);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener('keydown', this.handleKeyDown);
    this.removeEventListener('pointerdown', this.handlePointerDown);
    this.removeEventListener('click', this.handleClick, { capture: true });
    document.removeEventListener('click', this.handleOutsideClick);
    this.portal.close();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has('isOpen')) {
      this.setAttribute('aria-expanded', String(this.isOpen));
      this.updatePortal();
    }
  }

  private handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      this.isOpen = !this.isOpen;
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.isOpen = false;
    }
  };

  private handlePointerDown = (event: PointerEvent) => {
    event.stopPropagation();
    this.focus();
  };

  private handleClick = (event: MouseEvent) => {
    event.stopPropagation();
    this.isOpen = !this.isOpen;
  };

  private handleOutsideClick = (event: MouseEvent) => {
    const target = event.target as Node;
    if (!this.contains(target) && !this.portal.contains(target) && this.isOpen) {
      this.isOpen = false;
    }
  };

  private updatePortal(): void {
    if (this.isOpen) {
      const menuElement = this.querySelector('.visibility-popover__menu') as HTMLElement | null;
      if (menuElement) {
        this.portal.open(this, menuElement);
      }
      return;
    }

    this.portal.close();
  }

  private emitToggle(eventName: string): void {
    this.dispatchEvent(new CustomEvent(eventName, { bubbles: true, composed: true }));
  }

  protected render() {
    return html`
      <div class="visibility-popover__trigger">
        <span class="visibility-popover__icon">${this.iconService.getIcon('eye')}</span>
        <span class="visibility-popover__caret"
          >${this.iconService.getIcon('chevron-down-caret', 12)}</span
        >
      </div>

      <div class="visibility-popover__menu visibility-popover__menu--hidden" role="menu">
        <div class="visibility-popover__section">
          <div class="visibility-popover__title">Visibility Settings</div>
          ${this.renderToggleRow(
            'Grid',
            this.showGrid,
            'toggle-grid',
            'Show or hide the editor grid'
          )}
          ${this.renderToggleRow(
            'System Lighting',
            this.showLighting,
            'toggle-lighting',
            'Light the scene only when it has no explicit light sources'
          )}
          ${this.renderToggleRow(
            '2D Layer',
            this.showLayer2D,
            'toggle-layer-2d',
            'Show or hide the 2D layer'
          )}
          ${this.renderToggleRow(
            '3D Layer',
            this.showLayer3D,
            'toggle-layer-3d',
            'Show or hide the 3D layer'
          )}
        </div>
      </div>
    `;
  }

  private renderToggleRow(label: string, checked: boolean, eventName: string, description: string) {
    return html`
      <button
        class="visibility-popover__row"
        title=${description}
        @click=${(event: Event) => {
          event.stopPropagation();
          this.emitToggle(eventName);
        }}
      >
        <span class="visibility-popover__row-text">
          <span class="visibility-popover__row-label">${label}</span>
          <span class="visibility-popover__row-description">${description}</span>
        </span>
        <span class="visibility-popover__switch ${checked ? 'is-on' : ''}">
          <span class="visibility-popover__switch-thumb"></span>
        </span>
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-viewport-visibility-popover': ViewportVisibilityPopover;
  }
}
