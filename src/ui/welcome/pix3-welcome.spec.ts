import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { CloudProjectService } from '@/services/cloud/CloudProjectService';
import { DialogService } from '@/services/editor/DialogService';
import { IconService } from '@/services/editor/IconService';
import { ProjectLifecycleService } from '@/services/project/ProjectLifecycleService';
import { ProjectService } from '@/services/project/ProjectService';
import { type ApiProject } from '@/services/cloud/ApiClient';
import { appState, resetAppState } from '@/state';

type TestWelcomeElement = HTMLElement & { updateComplete: Promise<unknown> };

class ProjectServiceStub {
  getRecentProjects = vi.fn(() => []);
  openProjectViaPicker = vi.fn(async () => undefined);
  openRecentProject = vi.fn(async () => undefined);
  removeRecentProject = vi.fn();
}

class IconServiceStub {
  getIcon = vi.fn(() => '');
}

class DialogServiceStub {
  showConfirmation = vi.fn(async () => true);
}

class ProjectLifecycleServiceStub {
  showCreateDialog = vi.fn(async () => undefined);
}

class CloudProjectServiceStub {
  public loadProjects = vi.fn(async () => undefined);
  public openProject = vi.fn(async () => undefined);
  public deleteProject = vi.fn(async () => undefined);

  private state = {
    projects: [] as ApiProject[],
    isLoading: false,
  };

  private listeners = new Set<(state: { projects: ApiProject[]; isLoading: boolean }) => void>();

  subscribe(listener: (state: { projects: ApiProject[]; isLoading: boolean }) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  setState(projects: ApiProject[], isLoading = false): void {
    this.state = { projects, isLoading };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

beforeAll(async () => {
  await import('./pix3-welcome');
});

afterEach(() => {
  document.body.innerHTML = '';
  resetAppState();
  vi.restoreAllMocks();
});

describe('Pix3Welcome', () => {
  it('shows delete only for projects owned by the current user', async () => {
    resetAppState();
    appState.auth.user = {
      id: 'owner-1',
      email: 'owner@example.com',
      username: 'owner',
      is_admin: false,
    };
    appState.auth.isAuthenticated = true;

    const container = ServiceContainer.getInstance();
    container.addService(
      container.getOrCreateToken(ProjectService),
      ProjectServiceStub,
      'singleton'
    );
    container.addService(container.getOrCreateToken(IconService), IconServiceStub, 'singleton');
    container.addService(container.getOrCreateToken(DialogService), DialogServiceStub, 'singleton');
    container.addService(
      container.getOrCreateToken(ProjectLifecycleService),
      ProjectLifecycleServiceStub,
      'singleton'
    );
    container.addService(
      container.getOrCreateToken(CloudProjectService),
      CloudProjectServiceStub,
      'singleton'
    );

    const cloudProjectService = container.getService<CloudProjectServiceStub>(
      container.getOrCreateToken(CloudProjectService)
    );
    cloudProjectService.setState([
      {
        id: 'project-owned',
        owner_id: 'owner-1',
        name: 'Owned Project',
        share_token: null,
        created_at: '2026-04-25T10:00:00.000Z',
        updated_at: '2026-04-25T10:00:00.000Z',
      },
      {
        id: 'project-shared',
        owner_id: 'owner-2',
        name: 'Shared Project',
        share_token: null,
        created_at: '2026-04-25T11:00:00.000Z',
        updated_at: '2026-04-25T11:00:00.000Z',
      },
    ]);

    const welcome = document.createElement('pix3-welcome') as TestWelcomeElement;
    document.body.appendChild(welcome);
    await welcome.updateComplete;

    const deleteButtons = Array.from(
      welcome.querySelectorAll('.cloud-project-delete')
    ) as HTMLButtonElement[];

    expect(deleteButtons).toHaveLength(1);
    expect(deleteButtons[0]?.getAttribute('data-cloud-delete-id')).toBe('project-owned');
  });

  it('requests project-name confirmation before deleting an owned cloud project', async () => {
    resetAppState();
    appState.auth.user = {
      id: 'owner-1',
      email: 'owner@example.com',
      username: 'owner',
      is_admin: false,
    };
    appState.auth.isAuthenticated = true;

    const container = ServiceContainer.getInstance();
    container.addService(
      container.getOrCreateToken(ProjectService),
      ProjectServiceStub,
      'singleton'
    );
    container.addService(container.getOrCreateToken(IconService), IconServiceStub, 'singleton');
    container.addService(
      container.getOrCreateToken(ProjectLifecycleService),
      ProjectLifecycleServiceStub,
      'singleton'
    );
    container.addService(
      container.getOrCreateToken(CloudProjectService),
      CloudProjectServiceStub,
      'singleton'
    );

    const showConfirmation = vi.fn(async () => true);
    container.addService(
      container.getOrCreateToken(DialogService),
      class extends DialogServiceStub {
        showConfirmation = showConfirmation;
      },
      'singleton'
    );

    const cloudProjectService = container.getService<CloudProjectServiceStub>(
      container.getOrCreateToken(CloudProjectService)
    );
    cloudProjectService.setState([
      {
        id: 'project-owned',
        owner_id: 'owner-1',
        name: 'Owned Project',
        share_token: null,
        created_at: '2026-04-25T10:00:00.000Z',
        updated_at: '2026-04-25T10:00:00.000Z',
      },
    ]);

    const welcome = document.createElement('pix3-welcome') as TestWelcomeElement;
    document.body.appendChild(welcome);
    await welcome.updateComplete;

    const deleteButton = welcome.querySelector('.cloud-project-delete') as HTMLButtonElement;
    expect(deleteButton).toBeTruthy();

    deleteButton.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(showConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Delete Cloud Project',
        confirmLabel: 'Delete Project',
        cancelLabel: 'Keep Project',
        isDangerous: true,
        requiredInputValue: 'Owned Project',
        requiredInputPlaceholder: 'Owned Project',
        disclaimer: 'Deleted cloud projects cannot be restored.',
      })
    );
    expect(cloudProjectService.deleteProject).toHaveBeenCalledWith('project-owned');
  });

  it('renders project open errors from app state', async () => {
    resetAppState();

    const container = ServiceContainer.getInstance();
    container.addService(
      container.getOrCreateToken(ProjectService),
      ProjectServiceStub,
      'singleton'
    );
    container.addService(container.getOrCreateToken(IconService), IconServiceStub, 'singleton');
    container.addService(container.getOrCreateToken(DialogService), DialogServiceStub, 'singleton');
    container.addService(
      container.getOrCreateToken(ProjectLifecycleService),
      ProjectLifecycleServiceStub,
      'singleton'
    );
    container.addService(
      container.getOrCreateToken(CloudProjectService),
      CloudProjectServiceStub,
      'singleton'
    );

    const welcome = document.createElement('pix3-welcome') as TestWelcomeElement;
    document.body.appendChild(welcome);
    await welcome.updateComplete;

    appState.project.status = 'error';
    appState.project.errorMessage =
      'Opening local folders is not supported in the VS Code integrated browser.';
    await Promise.resolve();
    await welcome.updateComplete;

    const errorMessage = welcome.querySelector('.welcome-error');
    expect(errorMessage?.textContent).toContain('VS Code integrated browser');
  });

  it('renders picker failures from the open button without leaking the rejection', async () => {
    resetAppState();

    const pickerFailure = new Error('Directory picker failed');
    const container = ServiceContainer.getInstance();
    container.addService(
      container.getOrCreateToken(ProjectService),
      class extends ProjectServiceStub {
        openProjectViaPicker = vi.fn(async () => {
          throw pickerFailure;
        });
      },
      'singleton'
    );
    container.addService(container.getOrCreateToken(IconService), IconServiceStub, 'singleton');
    container.addService(container.getOrCreateToken(DialogService), DialogServiceStub, 'singleton');
    container.addService(
      container.getOrCreateToken(ProjectLifecycleService),
      ProjectLifecycleServiceStub,
      'singleton'
    );
    container.addService(
      container.getOrCreateToken(CloudProjectService),
      CloudProjectServiceStub,
      'singleton'
    );

    const welcome = document.createElement('pix3-welcome') as TestWelcomeElement;
    document.body.appendChild(welcome);
    await welcome.updateComplete;

    const openButton = welcome.querySelector('.action-btn') as HTMLButtonElement;
    openButton.click();
    await Promise.resolve();
    await Promise.resolve();
    await welcome.updateComplete;

    const errorMessage = welcome.querySelector('.welcome-error');
    expect(errorMessage?.textContent).toContain('Directory picker failed');
  });
});
