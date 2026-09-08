import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import type { Command, CommandMetadata } from '@/core/command';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { CommandRegistry } from '@/services/core/CommandRegistry';
import { IconService } from '@/services/editor/IconService';
import { KeybindingService } from '@/services/editor/KeybindingService';
import { NodeRegistry } from '@/services/scene/NodeRegistry';
import { ToggleGridCommand } from '@/features/viewport/ToggleGridCommand';
import { createTransformModeCommands } from '@/features/viewport/SetTransformModeCommand';
import { appState, resetAppState } from '@/state';

type TestMenuElement = HTMLElement & { updateComplete: Promise<unknown> };

class CommandDispatcherStub {
  execute = vi.fn(async () => false);
  executeById = vi.fn(async () => false);
}

interface StubNodeTypeGroup {
  label: string;
  items: Array<{ id: string; label: string; icon: string }>;
}

/** Two node-type groups, so the synthesised Create section has flyouts to render. */
class NodeRegistryStub {
  getGroupedDropdownItems(): StubNodeTypeGroup[] {
    return [
      { label: '2D Nodes', items: [{ id: 'Sprite2D', label: 'Sprite2D', icon: 'image' }] },
      { label: 'UI Controls', items: [{ id: 'Button2D', label: 'Button2D', icon: 'square' }] },
    ];
  }
}

/** A plain, non-checkable menu action — no `checked` predicate, no preconditions. */
const plainCommand = (metadata: CommandMetadata): Command => ({
  metadata,
  execute: () => ({ didMutate: false, payload: undefined }),
});

const flushTimers = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};

/** Open one section's dropdown and hand back the portal it was rendered into. */
const openSection = async (menu: TestMenuElement, sectionId: string): Promise<HTMLElement> => {
  const trigger = menu.querySelector<HTMLElement>(
    `.menu-section-button[data-section="${sectionId}"]`
  );
  expect(trigger).not.toBeNull();
  trigger?.click();
  await menu.updateComplete;
  await flushTimers();
  const portal = document.querySelector<HTMLElement>('.pix3-menu-portal');
  expect(portal).not.toBeNull();
  return portal as HTMLElement;
};

const closeMenu = async (menu: TestMenuElement, sectionId: string): Promise<void> => {
  menu.querySelector<HTMLElement>(`.menu-section-button[data-section="${sectionId}"]`)?.click();
  await menu.updateComplete;
  await flushTimers();
};

const mountMenu = async (): Promise<TestMenuElement> => {
  const menu = document.createElement('pix3-main-menu') as TestMenuElement;
  document.body.appendChild(menu);
  await menu.updateComplete;
  return menu;
};

/** Open a flyout by clicking its row, and hand back the panel it produced. */
const openSubmenu = async (
  menu: TestMenuElement,
  portal: HTMLElement,
  path: string
): Promise<HTMLElement> => {
  const row = portal.querySelector<HTMLElement>(`[data-submenu-row="${path}"]`);
  expect(row).not.toBeNull();
  row?.click();
  await menu.updateComplete;
  const panel = portal.querySelector<HTMLElement>(`[data-submenu-panel="${path}"]`);
  expect(panel).not.toBeNull();
  return panel as HTMLElement;
};

const rowsOf = (panel: HTMLElement): HTMLElement[] =>
  Array.from(panel.querySelectorAll<HTMLElement>('.menu-item'));

const pressKey = (target: HTMLElement, key: string): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
};

/** `Node` plus a four-row `Node > Align` submenu — the shape G6's commands produce. */
const registerNodeSectionWithAlignSubmenu = (): void => {
  registry.registerMany(
    plainCommand({
      id: 'scene.group-selection',
      title: 'Group Selection',
      menuPath: 'node',
      addToMenu: true,
      menuOrder: 100,
    }),
    plainCommand({
      id: 'scene.save-as-prefab',
      title: 'Save Branch as Prefab…',
      menuPath: 'node',
      addToMenu: true,
      menuOrder: 300,
    }),
    ...(['left', 'center-x', 'right', 'top'] as const).map((edge, index) =>
      plainCommand({
        id: `scene.align-2d.container-${edge}`,
        title: `Align ${edge}`,
        menuPath: 'node/align',
        addToMenu: true,
        menuOrder: 100 + index * 10,
      })
    )
  );
};

let registry: CommandRegistry;

beforeAll(async () => {
  await import('./pix3-main-menu');
});

beforeEach(() => {
  resetAppState();

  const container = ServiceContainer.getInstance();
  container.addService(
    container.getOrCreateToken(CommandDispatcher),
    CommandDispatcherStub,
    'singleton'
  );
  container.addService(container.getOrCreateToken(NodeRegistry), NodeRegistryStub, 'singleton');
  container.addService(container.getOrCreateToken(IconService), IconService, 'singleton');

  container.addService(
    container.getOrCreateToken(KeybindingService),
    KeybindingService,
    'singleton'
  );
  // Re-registering drops the cached singleton, so every test gets an empty registry — and the one
  // the component injects is the very instance the test loads its commands into.
  container.addService(container.getOrCreateToken(CommandRegistry), CommandRegistry, 'singleton');
  registry = container.getService<CommandRegistry>(container.getOrCreateToken(CommandRegistry));
  // `addService` keeps the cached singleton when the same class is re-registered, so clear the
  // commands from the previous test explicitly.
  registry.dispose();
});

afterEach(() => {
  document.body.innerHTML = '';
  document.querySelector('.pix3-menu-portal')?.remove();
  resetAppState();
  vi.restoreAllMocks();
});

describe('Pix3MainMenu checkable items', () => {
  it('renders a checkable command as menuitemcheckbox whose aria-checked follows the predicate', async () => {
    registry.register(new ToggleGridCommand());

    appState.ui.showGrid = true;
    const menu = document.createElement('pix3-main-menu') as TestMenuElement;
    document.body.appendChild(menu);
    await menu.updateComplete;

    let portal = await openSection(menu, 'view');
    let row = portal.querySelector<HTMLElement>('[data-command-id="view.toggle-grid"]');
    expect(row?.getAttribute('role')).toBe('menuitemcheckbox');
    expect(row?.getAttribute('aria-checked')).toBe('true');
    // The check glyph comes from IconService, never from a text glyph or emoji.
    expect(row?.querySelector('.menu-item-check svg')).not.toBeNull();

    await closeMenu(menu, 'view');
    appState.ui.showGrid = false;
    portal = await openSection(menu, 'view');
    row = portal.querySelector<HTMLElement>('[data-command-id="view.toggle-grid"]');
    expect(row?.getAttribute('role')).toBe('menuitemcheckbox');
    expect(row?.getAttribute('aria-checked')).toBe('false');
    expect(row?.querySelector('.menu-item-check svg')).toBeNull();
  });

  it('keeps a plain command a menuitem, but gives it the same check gutter so labels line up', async () => {
    registry.register(
      plainCommand({
        id: 'edit.undo',
        title: 'Undo',
        menuPath: 'edit',
        addToMenu: true,
        menuOrder: 100,
      })
    );

    const menu = document.createElement('pix3-main-menu') as TestMenuElement;
    document.body.appendChild(menu);
    await menu.updateComplete;

    const portal = await openSection(menu, 'edit');
    const row = portal.querySelector<HTMLElement>('[data-command-id="edit.undo"]');
    expect(row?.getAttribute('role')).toBe('menuitem');
    expect(row?.hasAttribute('aria-checked')).toBe(false);
    expect(row?.querySelector('.menu-item-check')).not.toBeNull();
  });

  it('checks exactly one transform mode in the View menu', async () => {
    registry.registerMany(...createTransformModeCommands());

    appState.ui.transformMode = 'rotate';
    const menu = document.createElement('pix3-main-menu') as TestMenuElement;
    document.body.appendChild(menu);
    await menu.updateComplete;

    const portal = await openSection(menu, 'view');
    const checked = Array.from(
      portal.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"][aria-checked="true"]')
    ).map(row => row.getAttribute('data-command-id'));

    expect(checked).toEqual(['view.transform-mode-rotate']);
  });
});

describe('Pix3MainMenu flyout submenus', () => {
  it('renders a submenu as one flyout row and does not inline its items in the parent dropdown', async () => {
    registerNodeSectionWithAlignSubmenu();
    const menu = await mountMenu();

    const portal = await openSection(menu, 'node');
    const row = portal.querySelector<HTMLElement>('[data-submenu-row="node/align"]');
    expect(row?.getAttribute('role')).toBe('menuitem');
    expect(row?.getAttribute('aria-haspopup')).toBe('menu');
    expect(row?.getAttribute('aria-expanded')).toBe('false');
    expect(row?.querySelector('.menu-item-label')?.textContent?.trim()).toBe('Align');
    // Chevron comes from IconService, never a text arrow or a Unicode glyph.
    expect(row?.querySelector('.menu-item-caret svg')).not.toBeNull();
    expect(row?.textContent).not.toContain('▸');
    // Same leading check gutter as every other row, so the labels stay aligned.
    expect(row?.querySelector('.menu-item-check')).not.toBeNull();

    // Phase 1 inlined these rows (and their group label) into the parent panel; phase 2 must not.
    expect(portal.querySelectorAll('[data-command-id^="scene.align-2d."]').length).toBe(0);
    expect(portal.querySelector('.menu-group-label')).toBeNull();
    expect(portal.querySelectorAll('[data-submenu-panel]').length).toBe(0);
  });

  it('opens the flyout on click with the submenu items inside it, labelled by its row', async () => {
    registerNodeSectionWithAlignSubmenu();
    const menu = await mountMenu();

    const portal = await openSection(menu, 'node');
    const panel = await openSubmenu(menu, portal, 'node/align');

    expect(panel.getAttribute('role')).toBe('menu');
    const row = portal.querySelector<HTMLElement>('[data-submenu-row="node/align"]');
    expect(row?.getAttribute('aria-expanded')).toBe('true');
    expect(row?.id).toBeTruthy();
    expect(panel.getAttribute('aria-labelledby')).toBe(row?.id);

    expect(rowsOf(panel).map(item => item.getAttribute('data-command-id'))).toEqual([
      'scene.align-2d.container-left',
      'scene.align-2d.container-center-x',
      'scene.align-2d.container-right',
      'scene.align-2d.container-top',
    ]);
  });

  it('focuses the first row when a dropdown opens, so the arrow keys have a starting point', async () => {
    registerNodeSectionWithAlignSubmenu();
    const menu = await mountMenu();

    const portal = await openSection(menu, 'node');
    expect(document.activeElement).toBe(rowsOf(portal)[0]);
  });

  it('opens on Right Arrow with focus moved into the flyout, and Up/Down move inside it', async () => {
    registerNodeSectionWithAlignSubmenu();
    const menu = await mountMenu();

    const portal = await openSection(menu, 'node');
    const row = portal.querySelector<HTMLElement>('[data-submenu-row="node/align"]');
    row?.focus();
    pressKey(row as HTMLElement, 'ArrowRight');

    const panel = portal.querySelector<HTMLElement>('[data-submenu-panel="node/align"]');
    expect(panel).not.toBeNull();
    const items = rowsOf(panel as HTMLElement);
    expect(document.activeElement).toBe(items[0]);

    pressKey(items[0], 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    pressKey(items[1], 'ArrowUp');
    expect(document.activeElement).toBe(items[0]);
  });

  it('closes the flyout on Escape and on Left Arrow, returning focus to its row', async () => {
    registerNodeSectionWithAlignSubmenu();
    const menu = await mountMenu();

    const portal = await openSection(menu, 'node');
    const row = portal.querySelector<HTMLElement>('[data-submenu-row="node/align"]');
    let panel = await openSubmenu(menu, portal, 'node/align');

    pressKey(rowsOf(panel)[0], 'Escape');
    expect(portal.querySelector('[data-submenu-panel="node/align"]')).toBeNull();
    expect(row?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(row);
    // Escape inside the flyout closes only the flyout — the parent dropdown stays open.
    expect(portal.querySelector('.menu-dropdown')).not.toBeNull();

    panel = await openSubmenu(menu, portal, 'node/align');
    pressKey(rowsOf(panel)[0], 'ArrowLeft');
    expect(portal.querySelector('[data-submenu-panel="node/align"]')).toBeNull();
    expect(document.activeElement).toBe(row);

    // Escape on the row that owns an open flyout closes the flyout, not the whole menu — a flyout
    // whose every row is disabled never takes focus, so this is the state a user lands in.
    await openSubmenu(menu, portal, 'node/align');
    pressKey(row as HTMLElement, 'Escape');
    expect(portal.querySelector('[data-submenu-panel="node/align"]')).toBeNull();
    expect(portal.querySelector('.menu-dropdown')).not.toBeNull();
  });

  it('renders exactly what the registry reports for a section — rows, submenu labels and counts', async () => {
    registerNodeSectionWithAlignSubmenu();
    registry.register(
      plainCommand({
        id: 'scene.distribute-2d.horizontal',
        title: 'Distribute horizontally',
        menuPath: 'node/distribute',
        addToMenu: true,
        menuOrder: 100,
      })
    );
    const menu = await mountMenu();

    const expected = registry.buildMenuSections().find(section => section.id === 'node');
    expect(expected).toBeDefined();

    const portal = await openSection(menu, 'node');
    const parentPanel = portal.querySelector<HTMLElement>('.menu-dropdown') as HTMLElement;
    const submenuRows = rowsOf(parentPanel).filter(row => row.dataset.submenuRow);
    const plainRows = rowsOf(parentPanel).filter(row => !row.dataset.submenuRow);

    // One row per parent-level command, one row per group — nothing dropped on the way in.
    expect(plainRows.map(row => row.getAttribute('data-command-id'))).toEqual(
      expected?.items.map(item => item.commandId)
    );
    expect(submenuRows.map(row => row.dataset.submenuRow)).toEqual(
      expected?.groups.map(group => group.id)
    );
    expect(
      submenuRows.map(row => row.querySelector('.menu-item-label')?.textContent?.trim())
    ).toEqual(expected?.groups.map(group => group.label));

    for (const group of expected?.groups ?? []) {
      const panel = await openSubmenu(menu, portal, group.id);
      expect(rowsOf(panel).map(row => row.getAttribute('data-command-id'))).toEqual(
        group.items.map(item => item.commandId)
      );
    }
  });

  it('picks up commands registered after it was connected instead of serving a stale snapshot', async () => {
    const menu = await mountMenu();
    expect(menu.querySelector('.menu-section-button[data-section="node"]')).toBeNull();

    // The live bug this step had to fix: the editor shell keeps registering commands after the menu
    // is connected, so a section (and its submenu) added later must reach both the bar and the
    // dropdown instead of the snapshot taken at `connectedCallback`.
    registerNodeSectionWithAlignSubmenu();
    await flushTimers();
    await menu.updateComplete;

    expect(menu.querySelector('.menu-section-button[data-section="node"]')).not.toBeNull();
    const portal = await openSection(menu, 'node');
    expect(portal.querySelector('[data-submenu-row="node/align"]')).not.toBeNull();
    const panel = await openSubmenu(menu, portal, 'node/align');
    expect(rowsOf(panel).length).toBe(4);
  });
});

describe('Pix3MainMenu submenu row slots', () => {
  /** Rows and auto-separators of a panel, in paint order, as readable tokens. */
  const sequenceOf = (panel: HTMLElement): string[] =>
    Array.from(panel.querySelector('.menu-section')?.children ?? []).map(child => {
      if (child.classList.contains('menu-separator')) {
        return '---';
      }
      const label = child.querySelector('.menu-item-label')?.textContent?.trim() ?? '?';
      return child instanceof HTMLElement && child.dataset.submenuRow ? `${label} >` : label;
    });

  it('places a submenu row in its own slot between the plain rows, not after them', async () => {
    registry.registerMany(
      plainCommand({
        id: 'scene.group-selection',
        title: 'Group Selection',
        menuPath: 'node',
        addToMenu: true,
        menuOrder: 100,
      }),
      plainCommand({
        id: 'scene.fit-group',
        title: 'Fit Group to Contents',
        menuPath: 'node',
        addToMenu: true,
        menuOrder: 110,
      }),
      plainCommand({
        id: 'scene.save-as-prefab',
        title: 'Save Branch as Prefab…',
        menuPath: 'node',
        addToMenu: true,
        menuOrder: 300,
      }),
      // Submenu commands number themselves inside their own path, so the row's slot comes from
      // `SUBMENU_ROWS` (node/align 200, node/distribute 210) — not from these numbers.
      plainCommand({
        id: 'scene.align-2d.container-left',
        title: 'Left Edges',
        menuPath: 'node/align',
        addToMenu: true,
        menuOrder: 100,
      }),
      plainCommand({
        id: 'scene.distribute-2d.horizontal',
        title: 'Horizontal Centers',
        menuPath: 'node/distribute',
        addToMenu: true,
        menuOrder: 100,
      })
    );
    const menu = await mountMenu();

    const portal = await openSection(menu, 'node');
    const panel = portal.querySelector<HTMLElement>('[data-menu-depth="0"]') as HTMLElement;

    // Spec §2.3: 100/110 · 200 Align ▸ / 210 Distribute ▸ · 300 Save Branch as Prefab…
    expect(sequenceOf(panel)).toEqual([
      'Group Selection',
      'Fit Group to Contents',
      '---',
      'Align >',
      'Distribute >',
      '---',
      'Save Branch as Prefab…',
    ]);
  });

  it('renders a submenu with no table entry under a capitalised label, in its items band', async () => {
    registry.registerMany(
      plainCommand({
        id: 'scene.group-selection',
        title: 'Group Selection',
        menuPath: 'node',
        addToMenu: true,
        menuOrder: 100,
      }),
      plainCommand({
        id: 'scene.arrange.front',
        title: 'Bring to Front',
        menuPath: 'node/arrange',
        addToMenu: true,
        menuOrder: 900,
      })
    );
    const menu = await mountMenu();

    const portal = await openSection(menu, 'node');
    const panel = portal.querySelector<HTMLElement>('[data-menu-depth="0"]') as HTMLElement;

    // No `SUBMENU_ROWS` entry: label = capitalised last segment, slot = lowest item order (900),
    // which lands it in the trailing band behind a separator.
    expect(sequenceOf(panel)).toEqual(['Group Selection', '---', 'Arrange >']);

    const submenu = await openSubmenu(menu, portal, 'node/arrange');
    expect(rowsOf(submenu).map(row => row.getAttribute('data-command-id'))).toEqual([
      'scene.arrange.front',
    ]);
  });

  it('gives the Create node-type flyouts the leading band, above Browse All Nodes…', async () => {
    registry.register(
      plainCommand({
        id: 'scene.browse-node-types',
        title: 'Browse All Nodes…',
        menuPath: 'create',
        addToMenu: true,
        menuOrder: 900,
      })
    );
    const menu = await mountMenu();

    const portal = await openSection(menu, 'create');
    const panel = portal.querySelector<HTMLElement>('[data-menu-depth="0"]') as HTMLElement;

    expect(sequenceOf(panel)).toEqual(['2D Nodes >', 'UI Controls >', '---', 'Browse All Nodes…']);
  });
});
