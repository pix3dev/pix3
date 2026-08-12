import { ComponentBase, customElement, html, inject, state, unsafeCSS } from '@/fw';
import { createCommandContext } from '@/core/command';
import { ServiceContainer } from '@/fw/di';
import { CommandRegistry } from '@/services/core/CommandRegistry';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { NodeRegistry } from '@/services/scene/NodeRegistry';
import { NodeTypePickerService } from '@/services/editor/NodeTypePickerService';
import { IconService, IconSize } from '@/services/editor/IconService';
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

/**
 * Synthetic section id for the "…" button. The menu bar is width-capped so it can never reach the
 * centred project name, and whatever no longer fits is folded into this one dropdown — its groups
 * are the sections that were dropped, so nothing becomes unreachable.
 */
const OVERFLOW_SECTION_ID = '__overflow__';

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

  /** How many sections still fit on the bar; the rest live under the "…" button. */
  @state()
  private inlineSectionCount = Number.POSITIVE_INFINITY;

  private portalElement: HTMLElement | null = null;

  /**
   * Natural width of each section button, captured while it was on the bar. Sections folded into
   * the overflow have no box to measure, so without this cache the bar could never grow back.
   */
  private readonly sectionWidths = new Map<string, number>();

  private resizeObserver?: ResizeObserver;

  connectedCallback(): void {
    super.connectedCallback();
    this.menuSections = this.buildMenuSections();
    document.addEventListener('click', this.handleDocumentClick);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.fitSectionsToWidth());
      this.resizeObserver.observe(this);
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('click', this.handleDocumentClick);
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.removePortal();
  }

  protected firstUpdated(): void {
    this.ensureMenuFocusGroup();
  }

  protected updated(): void {
    this.ensureMenuFocusGroup();
    this.fitSectionsToWidth();
    if (this.activeSection) {
      this.createPortal();
      this.updateMenuPosition();
    } else {
      this.removePortal();
    }
  }

  /**
   * Decide how many sections fit on the bar. The host has a CSS-fixed inline size (see
   * `pix3-main-menu.ts.css`), so the available width depends on the window and never on how many
   * buttons are currently rendered — that is what keeps this from oscillating between two counts.
   */
  private fitSectionsToWidth(): void {
    const bar = this.querySelector<HTMLElement>('.menu-bar');
    if (!bar || this.menuSections.length === 0) {
      return;
    }

    for (const button of bar.querySelectorAll<HTMLElement>('.menu-section-button[data-section]')) {
      const id = button.dataset.section;
      const width = button.getBoundingClientRect().width;
      if (id && id !== OVERFLOW_SECTION_ID && width > 0) {
        this.sectionWidths.set(id, width);
      }
    }

    const available = bar.clientWidth;
    if (available === 0) {
      return;
    }

    const logoWidth =
      bar.querySelector<HTMLElement>('.menu-logo-button')?.getBoundingClientRect().width ?? 0;
    const logoMargin = Number.parseFloat(
      getComputedStyle(bar.querySelector('.menu-logo-button') ?? bar).marginRight
    );
    const widths = this.menuSections.map(section => this.sectionWidths.get(section.id) ?? 0);
    if (widths.some(width => width === 0)) {
      // Not measured yet (first paint renders every section) — try again next frame.
      return;
    }

    const base = logoWidth + (Number.isFinite(logoMargin) ? logoMargin : 0);
    const total = widths.reduce((sum, width) => sum + width, base);
    let count = this.menuSections.length;
    if (total > available) {
      const overflowWidth =
        bar.querySelector<HTMLElement>('.menu-section-button--overflow')?.getBoundingClientRect()
          .width ?? 40;
      let used = base + overflowWidth;
      count = 0;
      for (const width of widths) {
        if (used + width > available) break;
        used += width;
        count += 1;
      }
    }

    if (count !== this.inlineSectionCount) {
      this.inlineSectionCount = count;
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
        // The "…" trigger sits at the right end of the bar, so a left-aligned panel can hang off
        // the window; pull it back in rather than letting it clip.
        const maxLeft = window.innerWidth - dropdown.offsetWidth - 8;
        dropdown.style.left = `${Math.max(8, Math.min(triggerRect.left, maxLeft))}px`;

        // Re-attach event listeners to the portal menu items
        this.attachPortalEventListeners();
      }
    }, 0);
  };

  private renderMenuToString(): string {
    if (!this.activeSection) return '';

    const section = this.getSectionForDropdown(this.activeSection);
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
          ${this.menuSections
            .slice(0, this.inlineSectionCount)
            .map(section => this.renderSectionButton(section.id, section.label))}
          ${this.overflowSections.length > 0
            ? this.renderSectionButton(
                OVERFLOW_SECTION_ID,
                this.iconService.getIcon('more-horizontal', IconSize.MEDIUM),
                'More menus'
              )
            : null}
        </div>
      </div>
    `;
  }

  private renderSectionButton(id: string, label: unknown, ariaLabel?: string) {
    const isOverflow = id === OVERFLOW_SECTION_ID;
    return html`
      <button
        class="menu-section-button ${this.activeSection === id ? 'menu-section-button--active' : ''}
        ${isOverflow ? 'menu-section-button--overflow' : ''}"
        data-section=${id}
        title=${ariaLabel ?? ''}
        aria-label=${ariaLabel ?? ''}
        @click=${() => this.toggleSection(id)}
        @mouseenter=${() => this.handleSectionHover(id)}
        @mouseleave=${this.handleSectionMouseLeave}
        aria-haspopup="menu"
        aria-expanded=${this.activeSection === id}
      >
        ${label}
      </button>
    `;
  }

  /** Sections that no longer fit on the bar, in menu order. */
  private get overflowSections(): MainMenuSection[] {
    return this.menuSections.slice(this.inlineSectionCount);
  }

  /**
   * The section a dropdown should render. For the "…" button this is synthesised on the fly: each
   * dropped section becomes a labelled group, so the overflow panel reads like the menus it stands
   * in for rather than one flat list.
   */
  private getSectionForDropdown(id: string): MainMenuSection | undefined {
    if (id !== OVERFLOW_SECTION_ID) {
      return this.menuSections.find(section => section.id === id);
    }
    const hidden = this.overflowSections;
    if (hidden.length === 0) {
      return undefined;
    }
    return {
      id: OVERFLOW_SECTION_ID,
      label: 'More menus',
      items: [],
      groupedItems: hidden.flatMap(section =>
        section.groupedItems?.length
          ? section.groupedItems.map(group => ({
              label: `${section.label} — ${group.label}`,
              items: group.items,
            }))
          : [{ label: section.label, items: section.items }]
      ),
    };
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
