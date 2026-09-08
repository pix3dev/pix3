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
 * A labelled group inside a section, produced by a `menuPath` with a child segment
 * (`node/align` -> group `align` under section `node`).
 */
export interface MenuSectionGroup {
  /** Full menu path of the group, e.g. `node/align`. */
  id: string;
  label: string;
  items: CommandMenuItem[];
}

/**
 * Represents a section of menu items organized by menu path. `items` are the parent-level rows;
 * `groups` are the labelled child groups. Both can be present — a renderer draws the plain items
 * first, then the groups.
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

/**
 * Display labels for the child segments of a `menuPath` (`node/align` -> key `align`). Anything
 * missing falls back to a capitalised segment.
 */
export const SUBMENU_LABELS: Record<string, string> = {
  align: 'Align',
  distribute: 'Distribute',
  '2d': '2D',
  '3d': '3D',
};

const capitalise = (segment: string): string =>
  segment.length === 0 ? segment : segment.charAt(0).toUpperCase() + segment.slice(1);

/** Label for a child path (`align`, or `align/edges` for a deeper nesting). */
const submenuLabel = (childPath: string): string => {
  const known = SUBMENU_LABELS[childPath];
  if (known) {
    return known;
  }
  const lastSegment = childPath.split('/').pop() ?? childPath;
  return SUBMENU_LABELS[lastSegment] ?? capitalise(lastSegment);
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

const lowestOrder = (items: readonly CommandMenuItem[]): number =>
  items.reduce(
    (lowest, item) => Math.min(lowest, item.menuOrder ?? Number.MAX_SAFE_INTEGER),
    Number.MAX_SAFE_INTEGER
  );

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
   * Register multiple commands at once.
   */
  registerMany(...commands: Command[]): void {
    for (const command of commands) {
      this.register(command);
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
          .map(([childPath, items]) => ({
            id: `${sectionId}/${childPath}`,
            label: submenuLabel(childPath),
            items: items.sort((a, b) => this.compareMenuItems(a, b)),
          }))
          // Groups sit after the plain items, ordered by the first slot they occupy.
          .sort((a, b) => lowestOrder(a.items) - lowestOrder(b.items) || a.id.localeCompare(b.id)),
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
  }
}
