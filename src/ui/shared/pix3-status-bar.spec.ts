import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { DialogService } from '@/services/editor/DialogService';
import { LoggingService } from '@/services/core/LoggingService';
import { UpdateCheckService, type UpdateCheckState } from '@/services/editor/UpdateCheckService';
import { appState, resetAppState } from '@/state';

type TestStatusBarElement = HTMLElement & { updateComplete: Promise<unknown> };

class UpdateCheckServiceStub {
  private state: UpdateCheckState = {
    status: 'idle',
    currentVersion: { version: '0.0.1', build: 7, displayVersion: 'v0.0.1 (build 7)' },
    latestVersion: null,
  };

  subscribe(listener: (state: UpdateCheckState) => void): () => void {
    listener(this.state);
    return () => undefined;
  }

  setState(state: UpdateCheckState): void {
    this.state = state;
  }
}

class DialogServiceStub {
  showConfirmation = vi.fn(async () => false);
}

beforeAll(async () => {
  vi.mock('golden-layout', () => ({}));
  await import('./pix3-status-bar');
});

afterEach(() => {
  document.body.innerHTML = '';
  resetAppState();
  vi.restoreAllMocks();
});

describe('Pix3StatusBar', () => {
  it('renders current version in the status area', async () => {
    const container = ServiceContainer.getInstance();

    container.addService(
      container.getOrCreateToken(UpdateCheckService),
      UpdateCheckServiceStub,
      'singleton'
    );
    container.addService(container.getOrCreateToken(DialogService), DialogServiceStub, 'singleton');
    container.addService(container.getOrCreateToken(LoggingService), LoggingService, 'singleton');

    const statusBar = document.createElement('pix3-status-bar') as TestStatusBarElement;
    document.body.appendChild(statusBar);
    await statusBar.updateComplete;

    expect(statusBar.textContent).toContain('v0.0.1 (build 7)');
  });

  it('shows update indicator only when update is available', async () => {
    const container = ServiceContainer.getInstance();

    container.addService(
      container.getOrCreateToken(UpdateCheckService),
      class extends UpdateCheckServiceStub {
        constructor() {
          super();
          this.setState({
            status: 'update-available',
            currentVersion: { version: '0.0.1', build: 7, displayVersion: 'v0.0.1 (build 7)' },
            latestVersion: { version: '0.0.1', build: 8, displayVersion: 'v0.0.1 (build 8)' },
          });
        }
      },
      'singleton'
    );
    container.addService(container.getOrCreateToken(DialogService), DialogServiceStub, 'singleton');
    container.addService(container.getOrCreateToken(LoggingService), LoggingService, 'singleton');

    const statusBar = document.createElement('pix3-status-bar') as TestStatusBarElement;
    document.body.appendChild(statusBar);
    await statusBar.updateComplete;

    expect(statusBar.textContent).toContain('Update available: v0.0.1 (build 8)');
    expect(statusBar.textContent).toContain('v0.0.1 (build 7)');
  });

  it('keeps existing project and play mode indicators', async () => {
    const container = ServiceContainer.getInstance();
    container.addService(
      container.getOrCreateToken(UpdateCheckService),
      UpdateCheckServiceStub,
      'singleton'
    );
    container.addService(container.getOrCreateToken(DialogService), DialogServiceStub, 'singleton');
    container.addService(container.getOrCreateToken(LoggingService), LoggingService, 'singleton');

    appState.project.projectName = 'Demo Project';
    appState.ui.isPlaying = true;

    const statusBar = document.createElement('pix3-status-bar') as TestStatusBarElement;
    document.body.appendChild(statusBar);
    await statusBar.updateComplete;

    expect(statusBar.textContent).toContain('Playing');
    expect(statusBar.textContent).toContain('Demo Project');
  });

  it('opens a reload confirmation dialog and reloads when user confirms', async () => {
    const container = ServiceContainer.getInstance();
    const showConfirmation = vi.fn(async () => true);

    container.addService(
      container.getOrCreateToken(UpdateCheckService),
      class extends UpdateCheckServiceStub {
        constructor() {
          super();
          this.setState({
            status: 'update-available',
            currentVersion: { version: '0.0.1', build: 7, displayVersion: 'v0.0.1 (build 7)' },
            latestVersion: { version: '0.0.1', build: 8, displayVersion: 'v0.0.1 (build 8)' },
          });
        }
      },
      'singleton'
    );
    container.addService(
      container.getOrCreateToken(DialogService),
      class extends DialogServiceStub {
        showConfirmation = showConfirmation;
      },
      'singleton'
    );
    container.addService(container.getOrCreateToken(LoggingService), LoggingService, 'singleton');

    const replaceSpy = vi.spyOn(window.location, 'replace').mockImplementation(() => undefined);

    const statusBar = document.createElement('pix3-status-bar') as TestStatusBarElement;
    document.body.appendChild(statusBar);
    await statusBar.updateComplete;

    const button = statusBar.querySelector('.status-update-button') as HTMLButtonElement;
    expect(button).toBeTruthy();

    button.click();
    await Promise.resolve();

    expect(showConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Update Available',
        confirmLabel: 'Reload Now',
        cancelLabel: 'Later',
      })
    );
    expect(replaceSpy).toHaveBeenCalledWith(expect.stringContaining('pix3_refresh='));
  });
});
