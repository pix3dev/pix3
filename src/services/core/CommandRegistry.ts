import { injectable } from '@/fw/di';
import type { Command } from '@/core/command';
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
  command: Command;
}

/**
 * Represents a section of menu items organized by menu path.
 */
export interface MenuSection {
  id: string;
  label: string;
  items: CommandMenuItem[];
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
   * Build menu sections from registered commands that have addToMenu=true.
   * Menu items are grouped by their menuPath and sorted by menuOrder (or registration order).
   * @returns Array of MenuSection objects organized by menuPath
   */
  buildMenuSections(): MenuSection[] {
    const sectionMap = new Map<string, CommandMenuItem[]>();

    // Collect all menu-enabled commands
    for (const command of this.commands.values()) {
      const { addToMenu, menuPath } = command.metadata;
      if (addToMenu && menuPath) {
        if (!sectionMap.has(menuPath)) {
          sectionMap.set(menuPath, []);
        }

        const menuItem: CommandMenuItem = {
          id: `${menuPath}-${command.metadata.id}`,
          commandId: command.metadata.id,
          label: command.metadata.title,
          // Get shortcut dynamically from KeybindingService (platform-aware formatting)
          shortcut: this.keybindingService.getDisplayString(command.metadata.id),
          command,
        };

        sectionMap.get(menuPath)!.push(menuItem);
      }
    }

    // Convert map to MenuSection array with standard section labels
    const sectionLabels: Record<string, string> = {
      file: 'File',
      edit: 'Edit',
      view: 'View',
      project: 'Project',
      help: 'Help',
    };

    // Standard menu section order - File, Edit, View, Insert, Window, Help
    const standardMenuOrder = ['file', 'edit', 'view', 'project', 'insert', 'window', 'help'];

    const sections: MenuSection[] = Array.from(sectionMap.entries())
      .sort((a, b) => {
        const orderA = standardMenuOrder.indexOf(a[0]);
        const orderB = standardMenuOrder.indexOf(b[0]);

        // If both menu paths are in standard order, use their order
        if (orderA !== -1 && orderB !== -1) {
          return orderA - orderB;
        }

        // If only one is in standard order, put it first
        if (orderA !== -1) return -1;
        if (orderB !== -1) return 1;

        // If neither is in standard order, fall back to alphabetical
        return a[0].localeCompare(b[0]);
      })
      .map(([menuPath, items]) => ({
        id: menuPath,
        label: sectionLabels[menuPath] || menuPath.charAt(0).toUpperCase() + menuPath.slice(1),
        items: items.sort((a, b) => {
          // First, use menuOrder if specified in command metadata
          const orderA = a.command.metadata.menuOrder ?? Number.MAX_SAFE_INTEGER;
          const orderB = b.command.metadata.menuOrder ?? Number.MAX_SAFE_INTEGER;

          if (orderA !== orderB) {
            return orderA - orderB;
          }

          // Fall back to registration order for commands without explicit menuOrder
          const regOrderA = this.registrationOrder.get(a.commandId) ?? Number.MAX_SAFE_INTEGER;
          const regOrderB = this.registrationOrder.get(b.commandId) ?? Number.MAX_SAFE_INTEGER;

          return regOrderA - regOrderB;
        }),
      }));

    return sections;
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
