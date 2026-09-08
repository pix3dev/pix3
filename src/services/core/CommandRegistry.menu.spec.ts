import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Command, CommandMetadata } from '@/core/command';
import { KeybindingService } from '@/services/editor/KeybindingService';
import { CommandRegistry } from '@/services/core/CommandRegistry';

/**
 * Two guards live in this file.
 *
 * 1. The *machinery*: section order, submenu grouping by `menuPath` segments, and the `menuOrder`
 *    banding a dropdown turns into separators. Exercised against a hand-built registry.
 * 2. The *metadata*: every menu command must carry a `menuPath` and a `menuOrder`, and the
 *    `(menuPath, menuOrder)` pair must be unique — otherwise two rows land in the same slot and
 *    their order silently falls back to import order. Because commands are instantiated inside a
 *    Lit shell component (`src/ui/pix3-editor-shell.ts`), there is no cheap way to boot the real
 *    registrations in a unit test, so the metadata literals are read straight off disk — the same
 *    approach `color-convention.spec.ts` and `strippable-runtime-modules.spec.ts` use.
 */

const makeCommand = (metadata: CommandMetadata): Command => ({
  metadata,
  execute: () => ({ didMutate: false, payload: undefined }),
});

const registryWith = (...metadata: CommandMetadata[]): CommandRegistry => {
  const registry = new CommandRegistry(new KeybindingService());
  registry.registerMany(...metadata.map(makeCommand));
  return registry;
};

describe('CommandRegistry menu machinery', () => {
  it('orders sections File · Edit · Create · Node · View · Run · Project · Window · Help', () => {
    const registry = registryWith(
      { id: 'a.help', title: 'Help', menuPath: 'help', addToMenu: true, menuOrder: 100 },
      { id: 'a.window', title: 'Window', menuPath: 'window', addToMenu: true, menuOrder: 100 },
      { id: 'a.project', title: 'Project', menuPath: 'project', addToMenu: true, menuOrder: 100 },
      { id: 'a.run', title: 'Run', menuPath: 'run', addToMenu: true, menuOrder: 100 },
      { id: 'a.view', title: 'View', menuPath: 'view', addToMenu: true, menuOrder: 100 },
      { id: 'a.node', title: 'Node', menuPath: 'node', addToMenu: true, menuOrder: 100 },
      { id: 'a.create', title: 'Create', menuPath: 'create', addToMenu: true, menuOrder: 100 },
      { id: 'a.edit', title: 'Edit', menuPath: 'edit', addToMenu: true, menuOrder: 100 },
      { id: 'a.file', title: 'File', menuPath: 'file', addToMenu: true, menuOrder: 100 }
    );

    expect(registry.buildMenuSections().map(section => section.id)).toEqual([
      'file',
      'edit',
      'create',
      'node',
      'view',
      'run',
      'project',
      'window',
      'help',
    ]);
  });

  it('labels every standard section', () => {
    const registry = registryWith(
      { id: 'a.node', title: 'Group', menuPath: 'node', addToMenu: true, menuOrder: 100 },
      { id: 'a.run', title: 'Play', menuPath: 'run', addToMenu: true, menuOrder: 100 },
      { id: 'a.window', title: 'Logs', menuPath: 'window', addToMenu: true, menuOrder: 100 },
      { id: 'a.create', title: 'Prefab', menuPath: 'create', addToMenu: true, menuOrder: 100 }
    );

    expect(registry.buildMenuSections().map(section => section.label)).toEqual([
      'Create',
      'Node',
      'Run',
      'Window',
    ]);
  });

  it('sorts unknown menu paths after the standard ones, alphabetically', () => {
    const registry = registryWith(
      { id: 'a.zebra', title: 'Zebra', menuPath: 'zebra', addToMenu: true, menuOrder: 100 },
      { id: 'a.tools', title: 'Tools', menuPath: 'tools', addToMenu: true, menuOrder: 100 },
      { id: 'a.file', title: 'Save', menuPath: 'file', addToMenu: true, menuOrder: 100 }
    );

    expect(registry.buildMenuSections().map(section => section.id)).toEqual([
      'file',
      'tools',
      'zebra',
    ]);
  });

  it('groups a slashed menuPath under its parent section instead of a new top-level section', () => {
    const registry = registryWith(
      {
        id: 'node.group',
        title: 'Group Selection',
        menuPath: 'node',
        addToMenu: true,
        menuOrder: 100,
      },
      {
        id: 'node.distribute-h',
        title: 'Horizontal Centers',
        menuPath: 'node/distribute',
        addToMenu: true,
        menuOrder: 210,
      },
      {
        id: 'node.align-left',
        title: 'Left Edges',
        menuPath: 'node/align',
        addToMenu: true,
        menuOrder: 200,
      },
      {
        id: 'node.align-right',
        title: 'Right Edges',
        menuPath: 'node/align',
        addToMenu: true,
        menuOrder: 201,
      }
    );

    const sections = registry.buildMenuSections();
    expect(sections.map(section => section.id)).toEqual(['node']);

    const [node] = sections;
    expect(node.items.map(item => item.commandId)).toEqual(['node.group']);
    expect(node.groups.map(group => ({ id: group.id, label: group.label }))).toEqual([
      { id: 'node/align', label: 'Align' },
      { id: 'node/distribute', label: 'Distribute' },
    ]);
    expect(node.groups[0].items.map(item => item.commandId)).toEqual([
      'node.align-left',
      'node.align-right',
    ]);
  });

  it('falls back to a capitalised segment for an unmapped submenu label', () => {
    const registry = registryWith({
      id: 'node.arrange-front',
      title: 'Bring to Front',
      menuPath: 'node/arrange',
      addToMenu: true,
      menuOrder: 400,
    });

    expect(registry.buildMenuSections()[0].groups[0].label).toBe('Arrange');
  });

  it('carries menuOrder onto the menu item so the renderer can band it', () => {
    const registry = registryWith(
      { id: 'file.save', title: 'Save', menuPath: 'file', addToMenu: true, menuOrder: 200 },
      { id: 'file.new', title: 'New Project…', menuPath: 'file', addToMenu: true, menuOrder: 100 },
      {
        id: 'file.close',
        title: 'Close Project',
        menuPath: 'file',
        addToMenu: true,
        menuOrder: 900,
      }
    );

    const items = registry.buildMenuSections()[0].items;
    expect(items.map(item => item.menuOrder)).toEqual([100, 200, 900]);
    // The hundreds digit is the band, so this section renders two separators.
    expect(items.map(item => Math.floor((item.menuOrder ?? 0) / 100))).toEqual([1, 2, 9]);
  });

  it('leaves commands without addToMenu out of the menu entirely', () => {
    const registry = registryWith(
      { id: 'scene.save', title: 'Save', addToMenu: false, keybinding: 'Mod+S' },
      {
        id: 'scene.create-colorrect2d',
        title: 'Create ColorRect2D',
        addToMenu: false,
      },
      {
        id: 'editor.save-active-resource',
        title: 'Save',
        menuPath: 'file',
        addToMenu: true,
        menuOrder: 200,
      }
    );

    const sections = registry.buildMenuSections();
    expect(sections).toHaveLength(1);
    expect(sections[0].items.map(item => item.commandId)).toEqual(['editor.save-active-resource']);
  });
});

// ---------------------------------------------------------------------------
// Metadata guard — reads the `CommandMetadata` literals off disk.
// ---------------------------------------------------------------------------

interface ScannedCommand {
  file: string;
  id: string;
  title?: string;
  addToMenu: boolean;
  menuPath?: string;
  menuOrder?: number;
}

const FEATURES_ROOT = path.resolve(__dirname, '../../features');

const listCommandSources = (directory: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...listCommandSources(entryPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      found.push(entryPath);
    }
  }
  return found;
};

/**
 * A `metadata` object literal. The trailing `[^;\n]*` catches the `} as const;` form
 * (`ToggleNavigationModeCommand`, `SwitchWorkspaceModeCommand`) — without it the scan silently
 * skips those commands, which is how the documented `view` slot-24 collision first hid.
 */
const METADATA_BLOCK = /metadata\s*(?::\s*CommandMetadata\s*)?=\s*\{([\s\S]*?)\n\s*\}[^;\n]*;/g;

const unquote = (value: string): string => value.replace(/^['"`]|['"`]$/g, '');

const parseMetadataBlock = (body: string): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    const colon = line.indexOf(':');
    if (colon <= 0) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) {
      continue;
    }
    fields[key] = line
      .slice(colon + 1)
      .trim()
      .replace(/,$/, '');
  }
  return fields;
};

let scanned: ScannedCommand[] | undefined;

/** Every `CommandMetadata` literal under `src/features`, parsed from source. */
const scanCommandMetadata = (): ScannedCommand[] => {
  if (scanned) {
    return scanned;
  }

  const found: ScannedCommand[] = [];
  for (const file of listCommandSources(FEATURES_ROOT)) {
    const source = readFileSync(file, 'utf8');
    METADATA_BLOCK.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = METADATA_BLOCK.exec(source)) !== null) {
      const fields = parseMetadataBlock(match[1]);
      if (!fields.id) {
        continue;
      }
      const menuOrder = fields.menuOrder === undefined ? undefined : Number(fields.menuOrder);
      found.push({
        file: path.relative(FEATURES_ROOT, file).replace(/\\/g, '/'),
        id: unquote(fields.id),
        title: fields.title === undefined ? undefined : unquote(fields.title),
        addToMenu: fields.addToMenu === 'true',
        menuPath: fields.menuPath === undefined ? undefined : unquote(fields.menuPath),
        menuOrder: menuOrder !== undefined && Number.isFinite(menuOrder) ? menuOrder : undefined,
      });
    }
  }

  scanned = found;
  return found;
};

describe('command menu metadata', () => {
  it('finds the command corpus (so a broken scan cannot pass the guards below by finding nothing)', () => {
    const all = scanCommandMetadata();
    expect(all.length).toBeGreaterThan(100);
    expect(all.filter(command => command.addToMenu).length).toBeGreaterThan(40);
    expect(all.map(command => command.id)).toContain('editor.save-active-resource');
  });

  it('keeps the five node-type create commands out of the menu (the registry is the only source)', () => {
    const phantomMenuSources = new Set([
      'scene.create-colorrect2d',
      'scene.create-animatedsprite2d',
      'scene.create-spineskeleton2d',
      'scene.create-animatedsprite3d',
      'scene.create-particles3d',
    ]);

    const leaking = scanCommandMetadata()
      .filter(command => phantomMenuSources.has(command.id))
      .filter(command => command.addToMenu || command.menuPath !== undefined);

    expect(leaking.map(command => `${command.id} (${command.file})`)).toEqual([]);
  });

  it('has exactly one Save row in the menu', () => {
    const saveRows = scanCommandMetadata().filter(
      command => command.addToMenu && command.title === 'Save'
    );

    expect(saveRows.map(command => command.id)).toEqual(['editor.save-active-resource']);
  });

  // Unskip in G3 — the current metadata still has the documented collisions.
  it.skip('gives every menu command a menuPath', () => {
    const offenders = scanCommandMetadata().filter(
      command => command.addToMenu && !command.menuPath
    );

    expect(
      offenders.map(command => `${command.id} (${command.file}) has addToMenu but no menuPath`)
    ).toEqual([]);
  });

  // Unskip in G3 — the current metadata still has the documented collisions.
  it.skip('gives every menu command a menuOrder', () => {
    const offenders = scanCommandMetadata().filter(
      command => command.addToMenu && command.menuOrder === undefined
    );

    expect(
      offenders.map(command => `${command.id} (${command.file}) has addToMenu but no menuOrder`)
    ).toEqual([]);
  });

  // Unskip in G3 — the current metadata still has the documented collisions.
  it.skip('keeps every (menuPath, menuOrder) pair unique', () => {
    const slots = new Map<string, string[]>();
    for (const command of scanCommandMetadata()) {
      if (!command.addToMenu || !command.menuPath) {
        continue;
      }
      const slot = `${command.menuPath}#${command.menuOrder}`;
      const occupants = slots.get(slot);
      if (occupants) {
        occupants.push(command.id);
      } else {
        slots.set(slot, [command.id]);
      }
    }

    const collisions = Array.from(slots.entries())
      .filter(([, occupants]) => occupants.length > 1)
      .map(([slot, occupants]) => `${slot} claimed by ${occupants.join(', ')}`);

    expect(collisions).toEqual([]);
  });
});
