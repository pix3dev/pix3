import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer, ServiceLifetime } from '@/fw/di';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { IconService } from '@/services/editor/IconService';
import { WorkspaceModeService } from '@/services/editor/WorkspaceModeService';
import { SwitchWorkspaceModeCommand } from '@/features/editor/SwitchWorkspaceModeCommand';
import { resetAppState } from '@/state';
import type { Pix3ModeSwitch } from './pix3-mode-switch';

const executed: SwitchWorkspaceModeCommand[] = [];

class FakeCommandDispatcher {
  async execute(command: SwitchWorkspaceModeCommand): Promise<boolean> {
    executed.push(command);
    return true;
  }
}

const container = ServiceContainer.getInstance();

const optionFor = (element: Pix3ModeSwitch, mode: string): HTMLButtonElement =>
  element.querySelector<HTMLButtonElement>(`.mode-switch__option[data-mode='${mode}']`)!;

describe('Pix3ModeSwitch', () => {
  let workspaceMode: WorkspaceModeService;

  beforeAll(async () => {
    container.addService(
      container.getOrCreateToken(CommandDispatcher),
      FakeCommandDispatcher as never,
      ServiceLifetime.Singleton
    );
    container.addService(
      container.getOrCreateToken(IconService),
      IconService,
      ServiceLifetime.Singleton
    );
    container.addService(
      container.getOrCreateToken(WorkspaceModeService),
      WorkspaceModeService,
      ServiceLifetime.Singleton
    );
    await import('./pix3-mode-switch');
  });

  beforeEach(() => {
    resetAppState();
    localStorage.clear();
    executed.length = 0;
    workspaceMode = container.getService<WorkspaceModeService>(
      container.getOrCreateToken(WorkspaceModeService)
    );
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const mount = async (): Promise<Pix3ModeSwitch> => {
    const element = document.createElement('pix3-mode-switch');
    document.body.appendChild(element);
    await element.updateComplete;
    return element;
  };

  it('marks the current mode and keeps the target option mounted', async () => {
    const element = await mount();

    // `data-current` drives the collapse: the mode you are in folds away, the target stays on
    // screen as the glyph you click.
    expect(optionFor(element, 'studio').dataset.current).toBe('true');
    expect(optionFor(element, 'flow').dataset.current).toBe('false');
    // Collapsed is a CSS state, not an unmount — both halves stay tabbable.
    expect(optionFor(element, 'flow').textContent).toContain('Vibe');
  });

  it('switches through the command gateway when the other mode is clicked', async () => {
    const element = await mount();

    optionFor(element, 'flow').click();

    expect(executed).toHaveLength(1);
    expect(executed[0]).toBeInstanceOf(SwitchWorkspaceModeCommand);
  });

  it('does not dispatch when the already-active mode is clicked', async () => {
    const element = await mount();

    optionFor(element, 'studio').click();

    expect(executed).toHaveLength(0);
  });

  it('follows the mode when it changes elsewhere', async () => {
    const element = await mount();

    workspaceMode.set('flow', { persist: false });
    await element.updateComplete;

    expect(optionFor(element, 'flow').dataset.current).toBe('true');
    expect(optionFor(element, 'studio').dataset.current).toBe('false');
  });
});
