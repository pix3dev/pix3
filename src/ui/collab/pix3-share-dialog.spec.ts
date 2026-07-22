import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { appState, resetAppState } from '@/state';
import { CloudProjectService } from '@/services/cloud/CloudProjectService';
import { CollabSessionService } from '@/services/collab/CollabSessionService';
import { DialogService } from '@/services/editor/DialogService';

type TestShareDialogElement = HTMLElement & {
  updateComplete: Promise<unknown>;
  openDialog: () => void;
};

class CloudProjectServiceStub {
  generateShareToken = vi.fn(async () => 'generated-share-token');
  revokeShareToken = vi.fn(async () => undefined);
}

class CollabSessionServiceStub {
  buildInviteLink = vi.fn((projectId: string, sceneId: string, shareToken?: string) => {
    const tokenPart = shareToken ? `&token=${shareToken}` : '';
    return `https://pix3.test/#editor?collab=${projectId}&scene=${sceneId}${tokenPart}`;
  });
}

class DialogServiceStub {
  showConfirmation = vi.fn(async () => true);
}

beforeAll(async () => {
  await import('./pix3-share-dialog');
});

afterEach(() => {
  document.body.innerHTML = '';
  resetAppState();
  vi.restoreAllMocks();
});

function setupShareDialogDependencies() {
  const container = ServiceContainer.getInstance();
  container.addService(
    container.getOrCreateToken(CloudProjectService),
    CloudProjectServiceStub,
    'singleton'
  );
  container.addService(
    container.getOrCreateToken(CollabSessionService),
    CollabSessionServiceStub,
    'singleton'
  );
  container.addService(container.getOrCreateToken(DialogService), DialogServiceStub, 'singleton');

  return {
    cloudProjectService: container.getService<CloudProjectServiceStub>(
      container.getOrCreateToken(CloudProjectService)
    ),
    dialogService: container.getService<DialogServiceStub>(
      container.getOrCreateToken(DialogService)
    ),
  };
}

async function openDialog(dialog: TestShareDialogElement): Promise<void> {
  dialog.openDialog();
  await Promise.resolve();
  await Promise.resolve();
  await dialog.updateComplete;
}

describe('Pix3ShareDialog', () => {
  it('derives Selected users scope from explicit project members', async () => {
    const membersResponse = {
      members: [
        {
          user_id: 'owner-1',
          email: 'owner@example.com',
          username: 'owner',
          role: 'owner',
        },
        {
          user_id: 'editor-2',
          email: 'editor@example.com',
          username: 'editor',
          role: 'editor',
        },
      ],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/members')) {
          return new Response(JSON.stringify(membersResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        throw new Error(`Unexpected fetch: ${url}`);
      })
    );

    setupShareDialogDependencies();

    appState.project.id = 'project-1';
    appState.project.backend = 'cloud';
    appState.project.status = 'ready';
    appState.scenes.activeSceneId = 'scene-1';
    appState.auth.user = {
      id: 'owner-1',
      email: 'owner@example.com',
      username: 'owner',
      is_admin: false,
    };
    appState.auth.isAuthenticated = true;
    appState.collaboration.role = 'owner';
    appState.collaboration.shareEnabled = false;
    appState.collaboration.shareToken = null;

    const dialog = document.createElement('pix3-share-dialog') as TestShareDialogElement;
    document.body.appendChild(dialog);
    await dialog.updateComplete;

    await openDialog(dialog);

    await vi.waitFor(() => {
      const scopeSelect = dialog.querySelector('#sharedForSelect') as HTMLSelectElement;
      expect(scopeSelect.value).toBe('selected');
    });
    expect(dialog.textContent).toContain('editor@example.com');
    expect(dialog.textContent).toContain('Selected Users');
  });

  it('switches to Only me by revoking the link and removing non-owner members', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes('/members/non-owner') && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true, removed_count: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.includes('/members')) {
        return new Response(
          JSON.stringify({
            members: [
              {
                user_id: 'owner-1',
                email: 'owner@example.com',
                username: 'owner',
                role: 'owner',
              },
              {
                user_id: 'viewer-2',
                email: 'viewer@example.com',
                username: 'viewer',
                role: 'viewer',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const { cloudProjectService, dialogService } = setupShareDialogDependencies();

    appState.project.id = 'project-1';
    appState.project.backend = 'cloud';
    appState.project.status = 'ready';
    appState.scenes.activeSceneId = 'scene-1';
    appState.auth.user = {
      id: 'owner-1',
      email: 'owner@example.com',
      username: 'owner',
      is_admin: false,
    };
    appState.auth.isAuthenticated = true;
    appState.collaboration.role = 'owner';
    appState.collaboration.shareEnabled = true;
    appState.collaboration.shareToken = 'existing-token';

    const dialog = document.createElement('pix3-share-dialog') as TestShareDialogElement;
    document.body.appendChild(dialog);
    await dialog.updateComplete;

    await openDialog(dialog);

    const scopeSelect = dialog.querySelector('#sharedForSelect') as HTMLSelectElement;
    scopeSelect.value = 'private';
    scopeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    await dialog.updateComplete;

    await vi.waitFor(() => {
      expect(dialogService.showConfirmation).toHaveBeenCalledTimes(1);
      expect(cloudProjectService.revokeShareToken).toHaveBeenCalledWith('project-1');
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/projects/project-1/members/non-owner'),
        expect.objectContaining({ method: 'DELETE' })
      );
      expect((dialog.querySelector('#sharedForSelect') as HTMLSelectElement).value).toBe('private');
      expect(dialog.textContent).not.toContain('viewer@example.com');
    });
  });
});
