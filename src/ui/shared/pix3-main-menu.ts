import { ComponentBase, customElement, html, inject, state, unsafeCSS } from '@/fw';
import { createCommandContext } from '@/core/command';
import { ServiceContainer } from '@/fw/di';
import {
  CommandRegistry,
  MENU_SECTION_ORDER,
  type CommandMenuItem,
} from '@/services/core/CommandRegistry';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { NodeRegistry } from '@/services/scene/NodeRegistry';
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
  /**
   * `menuOrder` of the backing command. The hundreds digit is a semantic band, and the dropdown
   * draws a separator wherever it changes between two neighbours — so a band boundary cannot be
   * forgotten the way an explicit separator entry could.
   */
  menuOrder?: number;
  /** Present on a row that opens a flyout instead of running a command. */
  submenu?: MainMenuSubmenu;
}

/** A flyout panel: one child of a dropdown row, itself a list of rows (nesting is free). */
interface MainMenuSubmenu {
  /** Full menu path, e.g. `node/align`. Doubles as the DOM key of the row and its panel. */
  id: string;
  label: string;
  items: MainMenuItem[];
}

interface MainMenuSection {
  id: string;
  label: string;
  /** Plain rows and flyout rows in one list, ordered by `menuOrder` (unordered rows go last). */
  items: MainMenuItem[];
}

/** `<hr>`-equivalent between two `menuOrder` bands. */
const SEPARATOR_HTML = '<div class="menu-separator" role="separator"></div>';

/**
 * Hover dwell before a flyout opens. Long enough that a pointer crossing the row on its way to
 * another row does not flash a panel; short enough that aiming at the row feels immediate.
 */
const SUBMENU_HOVER_OPEN_MS = 150;

/**
 * Grace period before a flyout closes once the pointer leaves the row that owns it. Without it a
 * diagonal move from the row into its own panel — which clips the neighbouring row on the way —
 * would close the panel the user is aiming at.
 */
const SUBMENU_CLOSE_GRACE_MS = 220;

/** Keep-inside-the-window margin for any floating panel. */
const PANEL_EDGE_MARGIN = 8;

/** A flyout tucks this far under its parent panel, so the diagonal gap has no dead zone. */
const SUBMENU_OVERLAP = 4;

/** `.menu-section` vertical padding — subtracted so a flyout's first row lines up with its row. */
const PANEL_PADDING = 4;

/** Semantic band of a menu row; rows without an order share one trailing band. */
const bandOf = (item: MainMenuItem): number =>
  item.menuOrder === undefined ? Number.POSITIVE_INFINITY : Math.floor(item.menuOrder / 100);

const byMenuOrder = (a: MainMenuItem, b: MainMenuItem): number =>
  (a.menuOrder ?? Number.MAX_SAFE_INTEGER) - (b.menuOrder ?? Number.MAX_SAFE_INTEGER);

const toMainMenuItem = (item: CommandMenuItem): MainMenuItem => ({
  id: item.id,
  label: item.label,
  shortcut: item.shortcut,
  commandId: item.commandId,
  menuOrder: item.menuOrder,
});

/** A row that opens `items` as a flyout panel rather than running a command. */
const toSubmenuItem = (
  path: string,
  label: string,
  items: MainMenuItem[],
  menuOrder?: number
): MainMenuItem => ({
  id: `submenu-${path}`,
  label,
  menuOrder,
  submenu: { id: path, label, items },
});

/** Menu paths carry `/`; an id has to survive being a DOM id. */
const slugify = (path: string): string => path.replace(/[^a-zA-Z0-9-]+/g, '-');

/**
 * Synthetic section id for the "…" button. The menu bar is width-capped so it can never reach the
 * centred project name, and whatever no longer fits is folded into this one dropdown — each
 * dropped section becomes a flyout row, so nothing becomes unreachable.
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

  private disposeRegistryListener?: () => void;

  /** Coalesces the burst of `register()` calls the editor shell makes at boot into one rebuild. */
  private sectionRefreshQueued = false;

  /** Flyouts reachable from the panels currently rendered, keyed by menu path. */
  private readonly submenusByPath = new Map<string, MainMenuSubmenu>();

  private submenuOpenTimer?: number;

  private submenuCloseTimer?: number;

  /** Section whose dropdown already received the initial focus, so it is not stolen back. */
  private focusedSection: string | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.menuSections = this.buildMenuSections();
    // The bar is built from the registry, and the registry keeps filling up after this element is
    // connected (panel/align commands, plugins). Without this subscription the bar would serve the
    // snapshot it happened to take first — a section registered later would have no button at all.
    this.disposeRegistryListener = this.commandRegistry.onDidChangeCommands(() =>
      this.queueSectionRefresh()
    );
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
    this.disposeRegistryListener?.();
    this.disposeRegistryListener = undefined;
    this.cancelSubmenuTimers();
    this.removePortal();
  }

  protected updated(): void {
    this.fitSectionsToWidth();
    if (this.activeSection) {
      this.createPortal();
      this.updateMenuPosition();
    } else {
      this.focusedSection = null;
      this.removePortal();
    }
  }

  /** Rebuild the sections once the current task settles, however many commands arrived. */
  private queueSectionRefresh(): void {
    if (this.sectionRefreshQueued) {
      return;
    }
    this.sectionRefreshQueued = true;
    queueMicrotask(() => {
      this.sectionRefreshQueued = false;
      if (this.isConnected) {
        this.menuSections = this.buildMenuSections();
      }
    });
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
    this.submenusByPath.clear();
  }

  /**
   * Put focus on the first row of a freshly opened dropdown, once per opening — the arrow keys
   * need a starting point, and re-focusing on every update would yank focus back out of a flyout.
   * Called after the portal is filled, not from `updated()`: the panel is rendered in a timeout, so
   * an earlier call would look for rows that do not exist yet.
   */
  private ensureMenuFocusGroup(): void {
    if (!this.activeSection || this.focusedSection === this.activeSection) {
      return;
    }
    this.focusedSection = this.activeSection;
    this.portalElement?.querySelector<HTMLElement>('.menu-item:not([disabled])')?.focus();
  }

  private updateMenuPosition = () => {
    setTimeout(() => {
      if (!this.activeSection) return;

      const trigger = this.querySelector(
        `.menu-section-button[data-section="${this.activeSection}"]`
      ) as HTMLElement;

      if (!trigger || !this.portalElement) return;

      const triggerRect = trigger.getBoundingClientRect();

      // Render menu to portal. This wipes every flyout too, so their bookkeeping goes with it.
      this.cancelSubmenuTimers();
      this.submenusByPath.clear();
      this.portalElement.innerHTML = this.renderMenuToString();

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
        this.attachPanelListeners(dropdown);
        this.ensureMenuFocusGroup();
      }
    }, 0);
  };

  private renderMenuToString(): string {
    if (!this.activeSection) return '';

    const section = this.getSectionForDropdown(this.activeSection);
    if (!section) return '';

    return this.renderPanel(section.items, {
      depth: 0,
      path: '',
      label: section.label,
    });
  }

  /**
   * One dropdown/flyout panel. Panels are siblings in the portal rather than nested elements: the
   * dropdown scrolls (`overflow-y: auto`), so a nested flyout would be clipped by its own parent.
   */
  private renderPanel(
    items: MainMenuItem[],
    context: { depth: number; path: string; label: string; labelledBy?: string }
  ): string {
    const rows = items
      .map((item, index) => {
        const separator =
          index > 0 && bandOf(items[index - 1]) !== bandOf(item) ? SEPARATOR_HTML : '';
        return `${separator}${this.renderItem(item)}`;
      })
      .join('');

    const labelAttribute = context.labelledBy
      ? `aria-labelledby="${context.labelledBy}"`
      : `aria-label="${context.label}"`;

    return `
      <div
        class="menu-dropdown${context.depth > 0 ? ' menu-dropdown--submenu' : ''}"
        role="menu"
        ${labelAttribute}
        data-menu-depth="${context.depth}"
        ${context.depth > 0 ? `data-submenu-panel="${context.path}"` : ''}
      >
        <div class="menu-section">
          ${rows}
        </div>
      </div>
    `;
  }

  private renderItem(item: MainMenuItem): string {
    if (item.submenu) {
      // Remembered so the flyout can be built on demand, without re-deriving the whole tree.
      this.submenusByPath.set(item.submenu.id, item.submenu);
      return this.renderSubmenuRow(item, item.submenu);
    }

    const isDisabled = item.commandId ? !this.canExecuteCommand(item.commandId) : false;
    // `undefined` = not a checkable command at all; `false` = checkable and currently off.
    // Read at render time, not when the sections were built, so a row opened after the state
    // changed shows the current value.
    const checked = item.commandId ? this.commandRegistry.isChecked(item.commandId) : undefined;
    const isCheckable = checked !== undefined;
    return `
      <button
        role="${isCheckable ? 'menuitemcheckbox' : 'menuitem'}"
        class="menu-item"
        data-menu-item="${item.id}"
        ${isCheckable ? `aria-checked="${checked ? 'true' : 'false'}"` : ''}
        ${item.commandId ? `data-command-id="${item.commandId}"` : ''}
        ${item.nodeTypeId ? `data-node-type-id="${item.nodeTypeId}"` : ''}
        ${isDisabled ? 'disabled aria-disabled="true"' : ''}
      >
        <span class="menu-item-check" aria-hidden="true">${
          checked ? this.iconService.getIconSvg('check', IconSize.SMALL) : ''
        }</span>
        ${
          item.icon
            ? `<span class="menu-item-icon">${this.iconService.getIconSvg(item.icon, IconSize.MEDIUM)}</span>`
            : ''
        }
        <span class="menu-item-label">${item.label}</span>
        ${item.shortcut ? `<span class="menu-item-shortcut">${item.shortcut}</span>` : ''}
      </button>
    `;
  }

  /** A row that opens a flyout: same check gutter as every other row, chevron on the trailing end. */
  private renderSubmenuRow(item: MainMenuItem, submenu: MainMenuSubmenu): string {
    return `
      <button
        role="menuitem"
        class="menu-item menu-item--submenu"
        id="${this.submenuRowId(submenu.id)}"
        data-menu-item="${item.id}"
        data-submenu-row="${submenu.id}"
        aria-haspopup="menu"
        aria-expanded="false"
      >
        <span class="menu-item-check" aria-hidden="true"></span>
        ${
          item.icon
            ? `<span class="menu-item-icon">${this.iconService.getIconSvg(item.icon, IconSize.MEDIUM)}</span>`
            : ''
        }
        <span class="menu-item-label">${item.label}</span>
        <span class="menu-item-caret" aria-hidden="true">${this.iconService.getIconSvg(
          'chevron-right-caret',
          IconSize.SMALL
        )}</span>
      </button>
    `;
  }

  private submenuRowId(path: string): string {
    return `pix3-menu-submenu-${slugify(path)}`;
  }

  /** Wire one rendered panel: row activation, hover intent, keyboard, and hover-mode dismissal. */
  private attachPanelListeners(panel: HTMLElement): void {
    const depth = Number(panel.dataset.menuDepth ?? '0');

    for (const row of panel.querySelectorAll<HTMLElement>('.menu-item')) {
      row.addEventListener('click', event => {
        if (row.hasAttribute('disabled')) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();

        const submenuPath = row.dataset.submenuRow;
        if (submenuPath) {
          this.cancelSubmenuTimers();
          if (!this.isSubmenuOpen(submenuPath)) {
            this.openSubmenu(submenuPath, false);
          }
          return;
        }

        const commandId = row.getAttribute('data-command-id');
        const nodeTypeId = row.getAttribute('data-node-type-id');

        if (commandId) {
          void this.executeMenuItem(commandId);
          return;
        }

        if (nodeTypeId) {
          void this.executeCreateMenuItem(nodeTypeId);
        }
      });

      row.addEventListener('mouseenter', () => {
        this.cancelSubmenuTimers();
        const submenuPath = row.dataset.submenuRow;
        if (submenuPath) {
          if (this.isSubmenuOpen(submenuPath)) {
            return;
          }
          this.submenuOpenTimer = window.setTimeout(() => {
            this.submenuOpenTimer = undefined;
            this.openSubmenu(submenuPath, false);
          }, SUBMENU_HOVER_OPEN_MS);
          return;
        }
        // A plain row: any flyout of this panel goes away — but on a grace period, because the
        // path from a submenu row into its own panel can clip the row below it.
        this.scheduleClose(depth + 1, false);
      });

      row.addEventListener('keydown', event => this.handleRowKeydown(event, panel, row, depth));
    }

    panel.addEventListener('mouseenter', () => this.cancelSubmenuTimers());
    panel.addEventListener('mouseleave', event => {
      const next = event.relatedTarget;
      if (next instanceof Node && this.portalElement?.contains(next)) {
        // Moved into a flyout or back into the parent panel — still inside the menu.
        return;
      }
      if (depth > 0) {
        this.scheduleClose(depth, !this.menuOpenedByClick);
        return;
      }
      if (!this.menuOpenedByClick) {
        this.scheduleClose(1, true);
      }
    });
  }

  private handleRowKeydown(
    event: KeyboardEvent,
    panel: HTMLElement,
    row: HTMLElement,
    depth: number
  ): void {
    const submenuPath = row.dataset.submenuRow;

    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        this.moveRowFocus(panel, row, event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      case 'ArrowRight':
      case 'Enter':
      case ' ': {
        if (!submenuPath) {
          return;
        }
        event.preventDefault();
        this.cancelSubmenuTimers();
        this.openSubmenu(submenuPath, true);
        return;
      }
      case 'ArrowLeft': {
        if (depth === 0) {
          return;
        }
        event.preventDefault();
        this.closeSubmenusFrom(depth, true);
        return;
      }
      case 'Escape': {
        event.preventDefault();
        // Escape dismisses the innermost thing that is open. Focus can sit on the row whose flyout
        // is open (a flyout with no enabled row never takes focus), and there it means "close that
        // flyout", not "close the whole menu".
        if (submenuPath && this.isSubmenuOpen(submenuPath)) {
          this.closeSubmenusFrom(depth + 1, false);
          return;
        }
        if (depth > 0) {
          this.closeSubmenusFrom(depth, true);
          return;
        }
        this.closeMenu(true);
        return;
      }
      default:
        return;
    }
  }

  private moveRowFocus(panel: HTMLElement, from: HTMLElement, delta: number): void {
    const rows = Array.from(panel.querySelectorAll<HTMLElement>('.menu-item:not([disabled])'));
    if (rows.length === 0) {
      return;
    }
    const index = rows.indexOf(from);
    const next =
      rows[(((index === -1 ? 0 : index + delta) % rows.length) + rows.length) % rows.length];
    next?.focus();
  }

  private isSubmenuOpen(path: string): boolean {
    return Boolean(this.portalElement?.querySelector(`[data-submenu-panel="${path}"]`));
  }

  /** Build, place and wire the flyout for `path`, replacing any sibling flyout at that depth. */
  private openSubmenu(path: string, focusFirstItem: boolean): void {
    const submenu = this.submenusByPath.get(path);
    const row = this.portalElement?.querySelector<HTMLElement>(`[data-submenu-row="${path}"]`);
    if (!submenu || !row || !this.portalElement) {
      return;
    }

    const parentPanel = row.closest<HTMLElement>('.menu-dropdown');
    const depth = Number(parentPanel?.dataset.menuDepth ?? '0') + 1;
    if (this.isSubmenuOpen(path)) {
      if (focusFirstItem) {
        this.portalElement
          .querySelector<HTMLElement>(`[data-submenu-panel="${path}"] .menu-item:not([disabled])`)
          ?.focus();
      }
      return;
    }
    this.closeSubmenusFrom(depth, false);

    const host = document.createElement('div');
    host.innerHTML = this.renderPanel(submenu.items, {
      depth,
      path,
      label: submenu.label,
      labelledBy: this.submenuRowId(path),
    });
    const panel = host.firstElementChild;
    if (!(panel instanceof HTMLElement)) {
      return;
    }

    panel.style.position = 'fixed';
    this.portalElement.appendChild(panel);
    row.setAttribute('aria-expanded', 'true');
    this.positionSubmenuPanel(panel, row, parentPanel);
    this.attachPanelListeners(panel);

    if (focusFirstItem) {
      panel.querySelector<HTMLElement>('.menu-item:not([disabled])')?.focus();
    }
  }

  /**
   * Right of the parent panel, top-aligned with its row; flipped to the left when it would leave
   * the window, shifted up when it would fall off the bottom.
   */
  private positionSubmenuPanel(
    panel: HTMLElement,
    row: HTMLElement,
    parentPanel: HTMLElement | null
  ): void {
    const rowRect = row.getBoundingClientRect();
    const parentRect = parentPanel?.getBoundingClientRect() ?? rowRect;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = parentRect.right - SUBMENU_OVERLAP;
    if (left + width > viewportWidth - PANEL_EDGE_MARGIN) {
      const flipped = parentRect.left - width + SUBMENU_OVERLAP;
      left =
        flipped >= PANEL_EDGE_MARGIN
          ? flipped
          : Math.max(PANEL_EDGE_MARGIN, viewportWidth - width - PANEL_EDGE_MARGIN);
    }

    let top = rowRect.top - PANEL_PADDING;
    if (top + height > viewportHeight - PANEL_EDGE_MARGIN) {
      top = viewportHeight - height - PANEL_EDGE_MARGIN;
    }
    top = Math.max(PANEL_EDGE_MARGIN, top);

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  /** Close every flyout at `depth` or deeper; optionally return focus to the owning row. */
  private closeSubmenusFrom(depth: number, focusOwnerRow: boolean): void {
    const panels = this.portalElement?.querySelectorAll<HTMLElement>('[data-submenu-panel]') ?? [];
    let ownerRow: HTMLElement | null = null;
    for (const panel of panels) {
      if (Number(panel.dataset.menuDepth ?? '0') < depth) {
        continue;
      }
      const path = panel.dataset.submenuPanel;
      const row = path
        ? (this.portalElement?.querySelector<HTMLElement>(`[data-submenu-row="${path}"]`) ?? null)
        : null;
      row?.setAttribute('aria-expanded', 'false');
      if (row && Number(panel.dataset.menuDepth ?? '0') === depth) {
        ownerRow = row;
      }
      panel.remove();
    }
    if (focusOwnerRow) {
      ownerRow?.focus();
    }
  }

  private scheduleClose(depth: number, closeMenuToo: boolean): void {
    this.cancelSubmenuTimers();
    this.submenuCloseTimer = window.setTimeout(() => {
      this.submenuCloseTimer = undefined;
      this.closeSubmenusFrom(depth, false);
      if (closeMenuToo) {
        this.closeMenu(false);
      }
    }, SUBMENU_CLOSE_GRACE_MS);
  }

  private cancelSubmenuTimers(): void {
    if (this.submenuOpenTimer !== undefined) {
      window.clearTimeout(this.submenuOpenTimer);
      this.submenuOpenTimer = undefined;
    }
    if (this.submenuCloseTimer !== undefined) {
      window.clearTimeout(this.submenuCloseTimer);
      this.submenuCloseTimer = undefined;
    }
  }

  /** Tear the whole menu down; `focusTrigger` puts focus back on the bar button that opened it. */
  private closeMenu(focusTrigger: boolean): void {
    const sectionId = this.activeSection;
    this.cancelSubmenuTimers();
    this.activeSection = null;
    this.menuOpenedByClick = false;
    if (focusTrigger && sectionId) {
      this.querySelector<HTMLElement>(`.menu-section-button[data-section="${sectionId}"]`)?.focus();
    }
  }

  private handleLogoClick = (): void => {
    this.activeSection = null;
    this.menuOpenedByClick = false;
    void this.executeMenuItem('project.close');
  };

  private async executeMenuItem(commandId: string): Promise<void> {
    if (!this.canExecuteCommand(commandId)) {
      this.closeMenu(false);
      return;
    }

    const command = this.commandRegistry.getCommand(commandId);
    if (command) {
      await this.commandDispatcher.execute(command);
    }
    this.closeMenu(false);
  }

  private async executeCreateMenuItem(nodeTypeId: string): Promise<void> {
    const command = this.nodeRegistry.createCommand(nodeTypeId);
    if (!command) {
      console.error('[Pix3MainMenu] Unknown node type for create action:', nodeTypeId);
      return;
    }

    await this.commandDispatcher.execute(command);
    this.closeMenu(false);
  }

  private handleDocumentClick = (event: MouseEvent) => {
    const target = event.target as Node;
    if (this.contains(target) || this.portalElement?.contains(target)) {
      return;
    }
    if (this.activeSection) {
      this.closeMenu(false);
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
    if (this.activeSection === sectionId) {
      this.closeMenu(false);
      return;
    }
    // Opening is a user gesture, so rebuilding here is free — and it guarantees the dropdown shows
    // the commands the registry has *now*, not the ones it had when this element was connected.
    this.menuSections = this.buildMenuSections();
    this.activeSection = sectionId;
    this.menuOpenedByClick = true;
  };

  private handleSectionHover = (sectionId: string) => {
    // Only allow hover to open menus if a menu is already open (either by click or hover)
    if (this.activeSection !== null && this.activeSection !== sectionId) {
      this.menuSections = this.buildMenuSections();
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
    const sections: MainMenuSection[] = this.commandRegistry.buildMenuSections().map(section => ({
      id: section.id,
      label: section.label,
      // A `menuPath` child segment (`node/align`) is one flyout row, not an inlined block — and it
      // takes a slot among the plain rows (`SUBMENU_ROWS` in CommandRegistry), never a tail band.
      items: [
        ...section.items.map(toMainMenuItem),
        ...section.groups.map(group =>
          toSubmenuItem(group.id, group.label, group.items.map(toMainMenuItem), group.menuOrder)
        ),
      ].sort(byMenuOrder),
    }));

    // Create has two sources: commands that declare `menuPath: 'create'` (Browse All Nodes…) and
    // the node-type registry, whose groups become flyouts in the first band.
    const nodeTypeSubmenus = this.buildNodeTypeSubmenus();
    const existing = sections.find(section => section.id === 'create');
    if (existing) {
      existing.items = [...existing.items, ...nodeTypeSubmenus].sort(byMenuOrder);
      return sections;
    }

    sections.splice(this.createSectionIndex(sections), 0, {
      id: 'create',
      label: 'Create',
      items: nodeTypeSubmenus,
    });
    return sections;
  }

  /** Node types from the registry as 2D / UI / 3D / Audio flyouts, in the leading band. */
  private buildNodeTypeSubmenus(): MainMenuItem[] {
    return this.nodeRegistry.getGroupedDropdownItems().map((group, index) =>
      toSubmenuItem(
        `create/${slugify(group.label).toLowerCase()}`,
        group.label,
        group.items.map(item => ({
          id: `create-${item.id}`,
          // The verb already lives in the menu title, so the row is just the node type name.
          label: item.label,
          icon: item.icon,
          nodeTypeId: item.id,
        })),
        // Slots 100/110/120/130 for 2D / UI / 3D / Audio — band 1, so `Browse All Nodes…` (900)
        // stays below them with a separator. These rows are synthesised here, not by a command,
        // so their slot is declared here for the same reason `SUBMENU_ROWS` carries the others'.
        100 + index * 10
      )
    );
  }

  /** Where a synthesised Create section belongs, per the shared section order. */
  private createSectionIndex(sections: MainMenuSection[]): number {
    const rank = (id: string): number => {
      const index = (MENU_SECTION_ORDER as readonly string[]).indexOf(id);
      return index === -1 ? MENU_SECTION_ORDER.length : index;
    };
    const createRank = rank('create');
    const index = sections.findIndex(section => rank(section.id) > createRank);
    return index === -1 ? sections.length : index;
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
   * dropped section becomes a flyout row, so the overflow panel is the menu bar it stands in for —
   * including the sections that have flyouts of their own, which simply nest one level deeper.
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
      items: hidden.map(section =>
        toSubmenuItem(`${OVERFLOW_SECTION_ID}/${section.id}`, section.label, section.items)
      ),
    };
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-main-menu': Pix3MainMenu;
  }
}
