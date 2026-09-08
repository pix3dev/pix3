import { injectable } from '@/fw/di';
import type { Command } from '@/core/command';
import { getAppStateSnapshot } from '@/state';
import { KeybindingService } from '@/services/editor/KeybindingService';
import { ServiceContainer } from '@/fw/di';

/**
 * Represents a menu item generated from a registered command.
 */
export interface CommandMenuItem {
  id: string;
  commandId: string;
  label: string;
  shortcut?: string;
  /**
   * The command's `menuOrder`. Carried through so a renderer can band it: the hundreds digit is
   * a semantic band, and a dropdown draws a separator wherever it changes between neighbours.
   */
  menuOrder?: number;
  command: Command;
}

/**
 * A submenu inside a section, produced by a `menuPath` with a child segment
 * (`node/align` -> submenu `align` under section `node`).
 */
export interface MenuSectionGroup {
  /** Full menu path of the submenu, e.g. `node/align`. */
  id: string;
  label: string;
  /**
   * Slot of the *row* that opens this submenu, in its parent section — same three-digit banding as
   * a command's `menuOrder`, which is how a renderer interleaves it with the plain rows.
   */
  menuOrder: number;
  items: CommandMenuItem[];
}

/**
 * Represents a section of menu items organized by menu path. `items` are the parent-level rows;
 * `groups` are the submenus. Both carry a `menuOrder`, and a renderer merges the two lists by it —
 * a submenu row occupies a slot among the plain rows, it is not appended after them.
 */
export interface MenuSection {
  id: string;
  label: string;
  items: CommandMenuItem[];
  groups: MenuSectionGroup[];
}

/**
 * Top-level menu sections in bar order. A `menuPath` whose first segment is not listed here still
 * becomes a section, sorted after these ones alphabetically.
 */
export const MENU_SECTION_ORDER = [
  'file',
  'edit',
  'create',
  'node',
  'view',
  'run',
  'project',
  'window',
  'help',
] as const;

/** Display labels for the top-level sections. Missing entries fall back to a capitalised id. */
const SECTION_LABELS: Record<string, string> = {
  file: 'File',
  edit: 'Edit',
  create: 'Create',
  node: 'Node',
  view: 'View',
  run: 'Run',
  project: 'Project',
  window: 'Window',
  help: 'Help',
};

/** Lowest slot occupied by a submenu's own items — the fallback slot for its row. */
const lowestOrder = (items: readonly CommandMenuItem[]): number =>
  items.reduce(
    (lowest, item) => Math.min(lowest, item.menuOrder ?? Number.MAX_SAFE_INTEGER),
    Number.MAX_SAFE_INTEGER
  );

/** Presentation of the row that opens a submenu: its label and its slot in the parent section. */
export interface SubmenuRowMeta {
  readonly label: string;
  readonly menuOrder: number;
}

/**
 * Metadata of the submenu *rows*, keyed by full menu path (`node/align`).
 *
 * A submenu row is not a command — it has no id, no handler and no metadata of its own — so this
 * is the only place its label and its slot can live. Both fields belong here for the same reason:
 * storing the slot once, next to the label, is giving that row its metadata, not duplicating a
 * command's `menuOrder`.
 *
 * An unlisted path still renders: the label falls back to its capitalised last segment and the
 * slot to the lowest `menuOrder` among its own items.
 */
export const SUBMENU_ROWS: Record<string, SubmenuRowMeta> = {
  'node/align': { label: 'Align', menuOrder: 200 },
  'node/distribute': { label: 'Distribute', menuOrder: 210 },
};

const capitalise = (segment: string): string =>
  segment.length === 0 ? segment : segment.charAt(0).toUpperCase() + segment.slice(1);

/**
 * Row metadata for a submenu at `fullPath` (`node/align`, or `node/align/edges` when nested):
 * the full path first, then its last segment, then the fallbacks.
 */
const submenuRowMeta = (
  fullPath: string,
  items: readonly CommandMenuItem[]
): { label: string; menuOrder: number } => {
  const lastSegment = fullPath.split('/').pop() ?? fullPath;
  const known = SUBMENU_ROWS[fullPath] ?? SUBMENU_ROWS[lastSegment];
  return {
    label: known?.label ?? capitalise(lastSegment),
    menuOrder: known?.menuOrder ?? lowestOrder(items),
  };
};

const sectionRank = (sectionId: string): number => {
  const index = (MENU_SECTION_ORDER as readonly string[]).indexOf(sectionId);
  return index === -1 ? MENU_SECTION_ORDER.length : index;
};

/** Sections in bar order; unknown ids keep the historical alphabetical-last fallback. */
export const compareSectionIds = (a: string, b: string): number => {
  const rankA = sectionRank(a);
  const rankB = sectionRank(b);
  return rankA !== rankB ? rankA - rankB : a.localeCompare(b);
};

/** Accumulator used while bucketing commands into a section and its child groups. */
interface SectionAccumulator {
  items: CommandMenuItem[];
  groups: Map<string, CommandMenuItem[]>;
}

/**
 * Registry for managing commands and building menu structures from registered commands.
 * Commands can opt into the main menu by setting addToMenu=true and providing menuPath.
 */
@injectable()
export class CommandRegistry {
  private commands = new Map<string, Command>();
  private registrationOrder = new Map<string, number>();
  private registrationCounter = 0;
  private keybindingService: KeybindingService;
  private readonly changeListeners = new Set<() => void>();

  constructor(keybindingService?: KeybindingService) {
    if (keybindingService) {
      this.keybindingService = keybindingService;
      return;
    }

    const container = ServiceContainer.getInstance();
    try {
      this.keybindingService = container.getService<KeybindingService>(
        container.getOrCreateToken(KeybindingService)
      );
    } catch {
      this.keybindingService = new KeybindingService();
    }
  }

  /**
   * Register a command for discovery, shortcuts, and menu generation.
   * @param command The command to register
   */
  register(command: Command): void {
    this.registerOne(command);
    this.notifyChanged();
  }

  /**
   * Register multiple commands at once. One change notification for the whole batch — the editor
   * shell registers ~120 commands in a single call, and every menu does not need 120 rebuilds.
   */
  registerMany(...commands: Command[]): void {
    for (const command of commands) {
      this.registerOne(command);
    }
    this.notifyChanged();
  }

  private registerOne(command: Command): void {
    this.commands.set(command.metadata.id, command);
    this.registrationOrder.set(command.metadata.id, this.registrationCounter++);

    // Register keybinding if specified
    if (command.metadata.keybinding) {
      this.keybindingService.register(command.metadata.id, command.metadata.keybinding, {
        when: command.metadata.when,
        preventRepeat: command.metadata.preventRepeat,
      });
    }
  }

  /**
   * Subscribe to changes of the registered command set; returns the disposer.
   *
   * The main menu is generated from this registry, and the registry keeps filling up after the
   * menu element is connected (window/align commands, and anything registered by a feature that
   * loads later). Without a notification a menu built once at `connectedCallback` serves a stale
   * snapshot forever — a section registered later has no button on the bar at all.
   */
  onDidChangeCommands(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private notifyChanged(): void {
    for (const listener of Array.from(this.changeListeners)) {
      listener();
    }
  }

  /**
   * Get a registered command by ID.
   */
  getCommand(commandId: string): Command | undefined {
    return this.commands.get(commandId);
  }

  /**
   * Get all registered commands.
   */
  getAllCommands(): Command[] {
    return Array.from(this.commands.values());
  }

  /**
   * Checked state of a *checkable* command (a view toggle, a transform mode).
   *
   * `undefined` means the command declares no `checked` predicate and therefore is not a checkable
   * item at all — a plain menu action. Callers must distinguish that from `false` ("checkable, but
   * currently off"): the menu renders the first as `role="menuitem"` and the second as
   * `role="menuitemcheckbox" aria-checked="false"`.
   *
   * This is the single source of truth for both the menu check and the viewport toolbar's active
   * state, which is why it reads a fresh snapshot rather than taking one from the caller.
   */
  isChecked(commandId: string): boolean | undefined {
    const checked = this.commands.get(commandId)?.metadata.checked;
    if (!checked) {
      return undefined;
    }
    return checked(getAppStateSnapshot());
  }

  /**
   * Build menu sections from registered commands that have addToMenu=true.
   * Menu items are grouped by their menuPath and sorted by menuOrder (or registration order).
   * @returns Array of MenuSection objects organized by menuPath
   */
  buildMenuSections(): MenuSection[] {
    const sectionMap = new Map<string, SectionAccumulator>();

    // Collect all menu-enabled commands
    for (const command of this.commands.values()) {
      const { addToMenu, menuPath } = command.metadata;
      if (!addToMenu || !menuPath) {
        continue;
      }

      const [sectionId, ...childSegments] = menuPath.split('/');
      if (!sectionId) {
        continue;
      }

      let accumulator = sectionMap.get(sectionId);
      if (!accumulator) {
        accumulator = { items: [], groups: new Map() };
        sectionMap.set(sectionId, accumulator);
      }

      const menuItem = this.createMenuItem(menuPath, command);

      if (childSegments.length === 0) {
        accumulator.items.push(menuItem);
        continue;
      }

      // A `menuPath` with child segments is a submenu of its section, never its own section.
      const childPath = childSegments.join('/');
      const group = accumulator.groups.get(childPath);
      if (group) {
        group.push(menuItem);
      } else {
        accumulator.groups.set(childPath, [menuItem]);
      }
    }

    return Array.from(sectionMap.entries())
      .sort(([a], [b]) => compareSectionIds(a, b))
      .map(([sectionId, accumulator]) => ({
        id: sectionId,
        label: SECTION_LABELS[sectionId] ?? capitalise(sectionId),
        items: accumulator.items.sort((a, b) => this.compareMenuItems(a, b)),
        groups: Array.from(accumulator.groups.entries())
          .map(([childPath, items]) => {
            const sorted = items.sort((a, b) => this.compareMenuItems(a, b));
            const fullPath = `${sectionId}/${childPath}`;
            const { label, menuOrder } = submenuRowMeta(fullPath, sorted);
            return { id: fullPath, label, menuOrder, items: sorted };
          })
          // Ordered by the slot each submenu row occupies; the renderer merges them with `items`.
          .sort((a, b) => a.menuOrder - b.menuOrder || a.id.localeCompare(b.id)),
      }));
  }

  private createMenuItem(menuPath: string, command: Command): CommandMenuItem {
    return {
      id: `${menuPath}-${command.metadata.id}`,
      commandId: command.metadata.id,
      label: command.metadata.title,
      // Get shortcut dynamically from KeybindingService (platform-aware formatting)
      shortcut: this.keybindingService.getDisplayString(command.metadata.id),
      menuOrder: command.metadata.menuOrder,
      command,
    };
  }

  private compareMenuItems(a: CommandMenuItem, b: CommandMenuItem): number {
    // First, use menuOrder if specified in command metadata
    const orderA = a.menuOrder ?? Number.MAX_SAFE_INTEGER;
    const orderB = b.menuOrder ?? Number.MAX_SAFE_INTEGER;

    if (orderA !== orderB) {
      return orderA - orderB;
    }

    // Fall back to registration order for commands without explicit menuOrder
    const regOrderA = this.registrationOrder.get(a.commandId) ?? Number.MAX_SAFE_INTEGER;
    const regOrderB = this.registrationOrder.get(b.commandId) ?? Number.MAX_SAFE_INTEGER;

    return regOrderA - regOrderB;
  }

  /**
   * Get a command by its menu item ID.
   */
  getCommandByMenuItemId(menuItemId: string): Command | undefined {
    const [, commandId] = menuItemId.split('-', 2);
    if (!commandId) return undefined;

    // Re-construct the full command ID by taking everything after the first dash
    const fullCommandId = menuItemId.substring(menuItemId.indexOf('-') + 1);
    return this.getCommand(fullCommandId);
  }

  dispose(): void {
    this.commands.clear();
    this.notifyChanged();
    this.changeListeners.clear();
  }
}
