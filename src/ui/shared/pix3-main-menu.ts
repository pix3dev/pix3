import { ComponentBase, customElement, html, inject, state, unsafeCSS } from '@/fw';
import { createCommandContext } from '@/core/command';
import { ServiceContainer } from '@/fw/di';
import { CommandRegistry } from '@/services/CommandRegistry';
import { CommandDispatcher } from '@/services/CommandDispatcher';
import { NodeRegistry } from '@/services/NodeRegistry';
import { NodeTypePickerService } from '@/services/NodeTypePickerService';
import { IconService, IconSize } from '@/services/IconService';
import { appState, getAppStateSnapshot } from '@/state';
import styles from './pix3-main-menu.ts.css?raw';

interface MainMenuItem {
  id: string;
  label: string;
  shortcut?: string;
  icon?: string;
  commandId?: string;
  nodeTypeId?: string;
}

interface MainMenuSection {
  id: string;
  label: string;
  items: MainMenuItem[];
  groupedItems?: Array<{ label: string; items: MainMenuItem[] }>;
}

@customElement('pix3-main-menu')
export class Pix3MainMenu extends ComponentBase {
  @inject(CommandRegistry)
  private readonly commandRegistry!: CommandRegistry;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(NodeRegistry)
  private readonly nodeRegistry!: NodeRegistry;

  @inject(IconService)
  private readonly iconService!: IconService;

  @inject(NodeTypePickerService)
  private readonly nodeTypePickerService!: NodeTypePickerService;

  // Use light DOM (default) to avoid clipping issues with absolutely positioned dropdowns
  @state()
  private activeSection: string | null = null;

  @state()
  private menuOpenedByClick = false;

  @state()
  private menuSections: MainMenuSection[] = [];

  private portalElement: HTMLElement | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.menuSections = this.buildMenuSections();
    document.addEventListener('click', this.handleDocumentClick);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('click', this.handleDocumentClick);
    this.removePortal();
  }

  protected firstUpdated(): void {
    this.ensureMenuFocusGroup();
  }

  protected updated(): void {
    this.ensureMenuFocusGroup();
    if (this.activeSection) {
      this.createPortal();
      this.updateMenuPosition();
    } else {
      this.removePortal();
    }
  }

  private createPortal(): void {
    if (this.portalElement) {
      return;
    }

    this.portalElement = document.createElement('div');
    this.portalElement.className = 'pix3-menu-portal';
    document.body.appendChild(this.portalElement);
  }

  private removePortal(): void {
    if (this.portalElement) {
      this.portalElement.remove();
      this.portalElement = null;
    }
  }

  private ensureMenuFocusGroup(): void {
    if (!this.activeSection) {
      return;
    }

    const menuItems = this.portalElement?.querySelectorAll<HTMLElement>(
      '.menu-item:not([disabled])'
    );
    if (!menuItems || menuItems.length === 0) {
      return;
    }

    // Set focus to first menu item when menu opens
    setTimeout(() => {
      menuItems[0]?.focus();
    }, 0);
  }

  private updateMenuPosition = () => {
    setTimeout(() => {
      if (!this.activeSection) return;

      const trigger = this.querySelector(
        `.menu-section-button[data-section="${this.activeSection}"]`
      ) as HTMLElement;

      if (!trigger || !this.portalElement) return;

      const triggerRect = trigger.getBoundingClientRect();

      // Render menu to portal
      const menuHTML = this.renderMenuToString();
      this.portalElement.innerHTML = menuHTML;

      // Style the portal
      const dropdown = this.portalElement.querySelector('.menu-dropdown') as HTMLElement;
      if (dropdown) {
        dropdown.style.position = 'fixed';
        dropdown.style.top = `${triggerRect.bottom + 4}px`;
        dropdown.style.left = `${triggerRect.left}px`;

        // Re-attach event listeners to the portal menu items
        this.attachPortalEventListeners();
      }
    }, 0);
  };

  private renderMenuToString(): string {
    if (!this.activeSection) return '';

    const section = this.menuSections.find(s => s.id === this.activeSection);
    if (!section) return '';

    const renderItem = (item: MainMenuItem): string => {
      const isDisabled = item.commandId ? !this.canExecuteCommand(item.commandId) : false;
      return `
      <button
        role="menuitem"
        class="menu-item"
        data-menu-item="${item.id}"
        ${item.commandId ? `data-command-id="${item.commandId}"` : ''}
        ${item.nodeTypeId ? `data-node-type-id="${item.nodeTypeId}"` : ''}
        ${isDisabled ? 'disabled aria-disabled="true"' : ''}
      >
        ${
          item.icon
            ? `<span class="menu-item-icon">${this.iconService.getIconSvg(item.icon, IconSize.MEDIUM)}</span>`
            : ''
        }
        <span class="menu-item-label">${item.label}</span>
        ${item.shortcut ? `<span class="menu-item-shortcut">${item.shortcut}</span>` : ''}
      </button>
    `;
    };

    const content = section.groupedItems?.length
      ? section.groupedItems
          .map(
            group => `
              <div class="menu-group">
                <div class="menu-group-label">${group.label}</div>
                <div class="section-items">
                  ${group.items.map(item => renderItem(item)).join('')}
                </div>
              </div>
            `
          )
          .join('')
      : `<div class="section-items">${section.items.map(item => renderItem(item)).join('')}</div>`;

    return `
      <div class="menu-dropdown" role="menu" onmouseleave="this.dispatchEvent(new CustomEvent('menu-mouseleave', {bubbles: true}))">
        <div class="menu-section" role="group" aria-label="${section.label}">
          ${content}
        </div>
      </div>
    `;
  }

  private attachPortalEventListeners(): void {
    if (!this.portalElement) return;

    const menuItems = this.portalElement.querySelectorAll<HTMLElement>('.menu-item');
    menuItems.forEach(item => {
      item.addEventListener('click', e => {
        if (item.hasAttribute('disabled')) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        const commandId = item.getAttribute('data-command-id');
        const nodeTypeId = item.getAttribute('data-node-type-id');

        if (commandId) {
          void this.executeMenuItem(commandId);
          return;
        }

        if (nodeTypeId) {
          void this.executeCreateMenuItem(nodeTypeId);
        }
      });
    });

    // Add mouse leave handler for the dropdown
    const dropdown = this.portalElement.querySelector('.menu-dropdown');
    if (dropdown) {
      dropdown.addEventListener('menu-mouseleave', () => {
        if (!this.menuOpenedByClick && this.activeSection !== null) {
          this.activeSection = null;
        }
      });
    }
  }

  private handleLogoClick = (): void => {
    this.activeSection = null;
    this.menuOpenedByClick = false;
    void this.executeMenuItem('project.close');
  };

  private async executeMenuItem(commandId: string): Promise<void> {
    if (!this.canExecuteCommand(commandId)) {
      this.activeSection = null;
      this.menuOpenedByClick = false;
      return;
    }

    const command = this.commandRegistry.getCommand(commandId);
    if (command) {
      await this.commandDispatcher.execute(command);
    }
    this.activeSection = null;
    this.menuOpenedByClick = false;
  }

  private async executeCreateMenuItem(nodeTypeId: string): Promise<void> {
    const command = this.nodeRegistry.createCommand(nodeTypeId);
    if (!command) {
      console.error('[Pix3MainMenu] Unknown node type for create action:', nodeTypeId);
      return;
    }

    await this.commandDispatcher.execute(command);
    this.activeSection = null;
    this.menuOpenedByClick = false;
  }

  private handleDocumentClick = (event: MouseEvent) => {
    const target = event.target as Node;
    if (!this.contains(target) && this.activeSection) {
      this.activeSection = null;
      this.menuOpenedByClick = false;
    }
  };

  private canExecuteCommand(commandId: string): boolean {
    const command = this.commandRegistry.getCommand(commandId);
    if (!command?.preconditions) {
      return true;
    }

    try {
      const context = createCommandContext(
        appState,
        getAppStateSnapshot(),
        ServiceContainer.getInstance()
      );
      const result = command.preconditions(context);
      if (result instanceof Promise) {
        return true;
      }

      return result.canExecute;
    } catch {
      return false;
    }
  }

  private toggleSection = (sectionId: string) => {
    if (sectionId === 'create') {
      this.activeSection = null;
      this.menuOpenedByClick = false;
      void this.openNodeTypePicker();
      return;
    }

    this.activeSection = this.activeSection === sectionId ? null : sectionId;
    this.menuOpenedByClick = this.activeSection !== null;
  };

  private handleSectionHover = (sectionId: string) => {
    if (sectionId === 'create') {
      return;
    }

    // Only allow hover to open menus if a menu is already open (either by click or hover)
    if (this.activeSection !== null) {
      this.activeSection = sectionId;
    }
  };

  private handleSectionMouseLeave = () => {
    // Don't close on mouse leave if opened by click - let document click handle it
    if (!this.menuOpenedByClick && this.activeSection !== null) {
      this.activeSection = null;
    }
  };

  private handleKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.activeSection = null;
    }
  };

  private buildMenuSections(): MainMenuSection[] {
    const commandSections: MainMenuSection[] = this.commandRegistry
      .buildMenuSections()
      .map(section => ({
        id: section.id,
        label: section.label,
        items: section.items.map(item => ({
          id: item.id,
          label: item.label,
          shortcut: item.shortcut,
          commandId: item.commandId,
        })),
      }));

    const createSection: MainMenuSection = {
      id: 'create',
      label: 'Create',
      items: [],
    };

    const sectionsWithoutCreate = commandSections.filter(section => section.id !== 'create');
    const fileSectionIndex = sectionsWithoutCreate.findIndex(section => section.id === 'file');
    if (fileSectionIndex >= 0) {
      sectionsWithoutCreate.splice(fileSectionIndex + 1, 0, createSection);
      return sectionsWithoutCreate;
    }

    return [createSection, ...sectionsWithoutCreate];
  }

  protected render() {
    return html`
      <style>
        ${unsafeCSS(styles)}
      </style>
      <div class="main-menu" @keydown=${this.handleKeydown}>
        <div class="menu-bar">
          <button
            type="button"
            class="menu-logo-button"
            title="Close project and return to the welcome screen"
            aria-label="Close project"
            @click=${this.handleLogoClick}
          >
            <img src="/menu-logo.png" alt="Pix3" class="menu-logo" />
          </button>
          ${this.menuSections.map(
            section => html`
              <button
                class="menu-section-button ${this.activeSection === section.id
                  ? 'menu-section-button--active'
                  : ''}"
                data-section=${section.id}
                @click=${() => this.toggleSection(section.id)}
                @mouseenter=${() => this.handleSectionHover(section.id)}
                @mouseleave=${this.handleSectionMouseLeave}
                aria-haspopup="menu"
                aria-expanded=${this.activeSection === section.id}
              >
                ${section.label}
              </button>
            `
          )}
        </div>
      </div>
    `;
  }

  private async openNodeTypePicker(): Promise<void> {
    const nodeTypeId = await this.nodeTypePickerService.showPicker();
    if (!nodeTypeId) {
      return;
    }

    await this.executeCreateMenuItem(nodeTypeId);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-main-menu': Pix3MainMenu;
  }
}
