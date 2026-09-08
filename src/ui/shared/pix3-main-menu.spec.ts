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

class NodeRegistryStub {
  getGroupedDropdownItems(): Array<{ label: string; items: unknown[] }> {
    return [];
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
