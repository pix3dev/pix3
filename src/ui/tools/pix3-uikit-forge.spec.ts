import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { IconService } from '@/services/editor/IconService';
import { UIKIT_FORGE_URL } from '@/core/tool-routes';
import { appState, resetAppState } from '@/state';

type TestElement = HTMLElement & { updateComplete: Promise<unknown> };

class IconServiceStub {
  getIcon = vi.fn(() => '');
}

const mount = async (): Promise<TestElement> => {
  const container = ServiceContainer.getInstance();
  container.addService(container.getOrCreateToken(IconService), IconServiceStub, 'singleton');
  const element = document.createElement('pix3-uikit-forge') as TestElement;
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
};

beforeAll(async () => {
  await import('./pix3-uikit-forge');
});

afterEach(() => {
  document.body.innerHTML = '';
  window.location.hash = '';
  resetAppState();
  vi.restoreAllMocks();
});

describe('Pix3UiKitForge', () => {
  it('frames the standalone tool page without a sandbox', async () => {
    const element = await mount();
    const frame = element.querySelector('iframe');

    expect(frame?.getAttribute('src')).toBe(UIKIT_FORGE_URL);
    // The tool exports through `showDirectoryPicker()` and anchor downloads — both die under a
    // `sandbox` attribute, which is why the frame deliberately carries none.
    expect(frame?.hasAttribute('sandbox')).toBe(false);
  });

  it('leaves to the welcome screen when no project is open', async () => {
    const element = await mount();
    element.querySelector<HTMLButtonElement>('.uikit-forge__back')?.click();

    expect(window.location.hash).toBe('#welcome');
  });

  it('leaves back into the shell the open project is using', async () => {
    appState.project.status = 'ready';
    appState.ui.workspaceMode = 'flow';

    const element = await mount();
    element.querySelector<HTMLButtonElement>('.uikit-forge__back')?.click();

    expect(window.location.hash).toBe('#flow');
  });
});
