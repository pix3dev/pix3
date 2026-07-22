import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';

const mockApiClient = {
  ApiClientError: class ApiClientError extends Error {
    constructor(
      message: string,
      public status: number
    ) {
      super(message);
    }
  },
  getProjectAccess: vi.fn(),
  downloadFile: vi.fn(),
};

vi.mock('@/services/cloud/ApiClient', () => mockApiClient);

const { CloudProjectService } = await import('@/services/cloud/CloudProjectService');

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('CloudProjectService', () => {
  beforeEach(() => {
    resetAppState();
    vi.clearAllMocks();
    appState.auth.user = {
      id: 'user-1',
      email: 'dev@pix3.local',
      username: 'pix3-dev',
      is_admin: false,
    };
  });

  afterEach(() => {
    resetAppState();
  });

  it('keeps the project in opening state until cloud files are hydrated', async () => {
    const accessDeferred = createDeferred<{
      name: string;
      auth_source: 'member';
      role: 'owner';
      access_mode: 'edit';
      share_enabled: boolean;
    }>();
    const manifest = [
      {
        path: 'Scenes/main.pix3scene',
        kind: 'file' as const,
        size: 24,
        hash: 'scene-hash',
        modified: '2026-04-22T10:00:00.000Z',
      },
    ];

    mockApiClient.getProjectAccess.mockReturnValue(accessDeferred.promise);
    mockApiClient.downloadFile.mockResolvedValue(new Response(new Blob(['scene contents'])));

    const service = new CloudProjectService();
    const projectService = {
      loadProjectManifest: vi.fn().mockResolvedValue({
        version: '1.0.0',
        autoloads: [],
        viewportBaseSize: { width: 1920, height: 1080 },
        metadata: {},
      }),
      addRecentProject: vi.fn(),
    };
    const storage = {
      refreshManifest: vi.fn().mockResolvedValue(undefined),
      getManifestEntries: vi.fn().mockResolvedValue(manifest),
    };
    const editorTabService = {
      focusOrOpenScene: vi.fn().mockResolvedValue(undefined),
    };
    const projectScriptLoader = {
      ensureReady: vi.fn().mockResolvedValue(undefined),
    };
    const cloudCache = {
      reconcileManifest: vi.fn().mockResolvedValue(undefined),
      isEntryFresh: vi.fn().mockResolvedValue(false),
      storeBlobFile: vi.fn().mockResolvedValue(undefined),
    };

    Object.defineProperty(service, 'projectService', { value: projectService, configurable: true });
    Object.defineProperty(service, 'storage', { value: storage, configurable: true });
    Object.defineProperty(service, 'editorTabService', {
      value: editorTabService,
      configurable: true,
    });
    Object.defineProperty(service, 'projectScriptLoader', {
      value: projectScriptLoader,
      configurable: true,
    });
    Object.defineProperty(service, 'cloudCache', { value: cloudCache, configurable: true });
    Object.defineProperty(service, 'connectToProjectRoom', {
      value: vi.fn().mockResolvedValue(undefined),
      configurable: true,
    });
    Object.defineProperty(service, 'ensureActiveSceneBound', {
      value: vi.fn().mockResolvedValue(undefined),
      configurable: true,
    });
    Object.defineProperty(service, 'scheduleHybridSyncRefresh', {
      value: vi.fn(),
      configurable: true,
    });

    const openPromise = service.openProject('project-1');

    expect(appState.project.status).toBe('opening');
    expect(appState.project.openProgress.phase).toBe('fetching-access');

    accessDeferred.resolve({
      name: 'DeepCore',
      auth_source: 'member',
      role: 'owner',
      access_mode: 'edit',
      share_enabled: false,
    });

    await openPromise;

    expect(cloudCache.reconcileManifest).toHaveBeenCalledWith('project-1', manifest);
    expect(mockApiClient.downloadFile).toHaveBeenCalledWith(
      'project-1',
      'Scenes/main.pix3scene',
      undefined
    );
    expect(cloudCache.storeBlobFile).toHaveBeenCalledWith(
      'project-1',
      'Scenes/main.pix3scene',
      expect.any(Blob),
      {
        hash: 'scene-hash',
        modified: '2026-04-22T10:00:00.000Z',
        size: 24,
      }
    );
    expect(projectScriptLoader.ensureReady).toHaveBeenCalledTimes(1);
    expect(editorTabService.focusOrOpenScene).toHaveBeenCalledWith('res://Scenes/main.pix3scene');
    expect(appState.project.status).toBe('ready');
    expect(appState.project.projectName).toBe('DeepCore');
    expect(appState.project.openProgress.phase).toBe('idle');
  });

  it('skips missing manifest files during hydrate when the backend returns 404', async () => {
    const manifest = [
      {
        path: 'scripts/bootstrap.ts',
        kind: 'file' as const,
        size: 12,
        hash: 'bootstrap-hash',
        modified: '2026-04-22T10:00:00.000Z',
      },
      {
        path: 'Scenes/main.pix3scene',
        kind: 'file' as const,
        size: 24,
        hash: 'scene-hash',
        modified: '2026-04-22T10:00:01.000Z',
      },
    ];

    mockApiClient.getProjectAccess.mockResolvedValue({
      name: 'DeepCore',
      auth_source: 'member',
      role: 'owner',
      access_mode: 'edit',
      share_enabled: false,
    });
    mockApiClient.downloadFile
      .mockRejectedValueOnce(new mockApiClient.ApiClientError('Missing file', 404))
      .mockResolvedValueOnce(new Response(new Blob(['scene contents'])));

    const service = new CloudProjectService();
    const projectService = {
      loadProjectManifest: vi.fn().mockResolvedValue({
        version: '1.0.0',
        autoloads: [],
        viewportBaseSize: { width: 1920, height: 1080 },
        metadata: {},
      }),
      addRecentProject: vi.fn(),
    };
    const storage = {
      refreshManifest: vi.fn().mockResolvedValue(undefined),
      getManifestEntries: vi.fn().mockResolvedValue(manifest),
    };
    const editorTabService = {
      focusOrOpenScene: vi.fn().mockResolvedValue(undefined),
    };
    const projectScriptLoader = {
      ensureReady: vi.fn().mockResolvedValue(undefined),
    };
    const cloudCache = {
      reconcileManifest: vi.fn().mockResolvedValue(undefined),
      isEntryFresh: vi.fn().mockResolvedValue(false),
      storeBlobFile: vi.fn().mockResolvedValue(undefined),
      invalidatePath: vi.fn().mockResolvedValue(undefined),
    };

    Object.defineProperty(service, 'projectService', { value: projectService, configurable: true });
    Object.defineProperty(service, 'storage', { value: storage, configurable: true });
    Object.defineProperty(service, 'editorTabService', {
      value: editorTabService,
      configurable: true,
    });
    Object.defineProperty(service, 'projectScriptLoader', {
      value: projectScriptLoader,
      configurable: true,
    });
    Object.defineProperty(service, 'cloudCache', { value: cloudCache, configurable: true });
    Object.defineProperty(service, 'connectToProjectRoom', {
      value: vi.fn().mockResolvedValue(undefined),
      configurable: true,
    });
    Object.defineProperty(service, 'ensureActiveSceneBound', {
      value: vi.fn().mockResolvedValue(undefined),
      configurable: true,
    });
    Object.defineProperty(service, 'scheduleHybridSyncRefresh', {
      value: vi.fn(),
      configurable: true,
    });

    await service.openProject('project-1');

    expect(cloudCache.invalidatePath).toHaveBeenCalledWith('project-1', 'scripts/bootstrap.ts');
    expect(editorTabService.focusOrOpenScene).toHaveBeenCalledWith('res://Scenes/main.pix3scene');
    expect(appState.project.status).toBe('ready');
    expect(appState.project.openProgress.phase).toBe('idle');
  });

  it('hydrates only essential scene, script, and media files', async () => {
    const manifest = [
      {
        path: 'Scenes/main.pix3scene',
        kind: 'file' as const,
        size: 24,
        hash: 'scene-hash',
        modified: '2026-04-22T10:00:00.000Z',
      },
      {
        path: 'scripts/player.ts',
        kind: 'file' as const,
        size: 18,
        hash: 'script-hash',
        modified: '2026-04-22T10:00:01.000Z',
      },
      {
        path: 'scripts/player.css',
        kind: 'file' as const,
        size: 12,
        hash: 'style-hash',
        modified: '2026-04-22T10:00:02.000Z',
      },
      {
        path: 'assets/hero.png',
        kind: 'file' as const,
        size: 128,
        hash: 'image-hash',
        modified: '2026-04-22T10:00:03.000Z',
      },
      {
        path: '.gitignore',
        kind: 'file' as const,
        size: 11,
        hash: 'gitignore-hash',
        modified: '2026-04-22T10:00:04.000Z',
      },
      {
        path: 'package.json',
        kind: 'file' as const,
        size: 32,
        hash: 'package-hash',
        modified: '2026-04-22T10:00:05.000Z',
      },
      {
        path: 'docs/readme.md',
        kind: 'file' as const,
        size: 42,
        hash: 'readme-hash',
        modified: '2026-04-22T10:00:06.000Z',
      },
      {
        path: '.yalc/@pix3/runtime/src/index.ts',
        kind: 'file' as const,
        size: 64,
        hash: 'yalc-hash',
        modified: '2026-04-22T10:00:07.000Z',
      },
    ];

    mockApiClient.getProjectAccess.mockResolvedValue({
      name: 'DeepCore',
      auth_source: 'member',
      role: 'owner',
      access_mode: 'edit',
      share_enabled: false,
    });
    mockApiClient.downloadFile.mockImplementation(
      async () => new Response(new Blob(['file contents']))
    );

    const service = new CloudProjectService();
    const projectService = {
      loadProjectManifest: vi.fn().mockResolvedValue({
        version: '1.0.0',
        autoloads: [],
        viewportBaseSize: { width: 1920, height: 1080 },
        metadata: {},
      }),
      addRecentProject: vi.fn(),
    };
    const storage = {
      refreshManifest: vi.fn().mockResolvedValue(undefined),
      getManifestEntries: vi.fn().mockResolvedValue(manifest),
    };
    const editorTabService = {
      focusOrOpenScene: vi.fn().mockResolvedValue(undefined),
    };
    const projectScriptLoader = {
      ensureReady: vi.fn().mockResolvedValue(undefined),
    };
    const cloudCache = {
      reconcileManifest: vi.fn().mockResolvedValue(undefined),
      isEntryFresh: vi.fn().mockResolvedValue(false),
      storeBlobFile: vi.fn().mockResolvedValue(undefined),
      invalidatePath: vi.fn().mockResolvedValue(undefined),
    };

    Object.defineProperty(service, 'projectService', { value: projectService, configurable: true });
    Object.defineProperty(service, 'storage', { value: storage, configurable: true });
    Object.defineProperty(service, 'editorTabService', {
      value: editorTabService,
      configurable: true,
    });
    Object.defineProperty(service, 'projectScriptLoader', {
      value: projectScriptLoader,
      configurable: true,
    });
    Object.defineProperty(service, 'cloudCache', { value: cloudCache, configurable: true });
    Object.defineProperty(service, 'connectToProjectRoom', {
      value: vi.fn().mockResolvedValue(undefined),
      configurable: true,
    });
    Object.defineProperty(service, 'ensureActiveSceneBound', {
      value: vi.fn().mockResolvedValue(undefined),
      configurable: true,
    });
    Object.defineProperty(service, 'scheduleHybridSyncRefresh', {
      value: vi.fn(),
      configurable: true,
    });

    await service.openProject('project-1');

    const downloadedPaths = (mockApiClient.downloadFile.mock.calls as Array<[string, string]>).map(
      ([, path]) => path
    );
    expect(downloadedPaths).toEqual([
      'Scenes/main.pix3scene',
      'scripts/player.ts',
      'scripts/player.css',
      'assets/hero.png',
    ]);
    expect(cloudCache.invalidatePath).toHaveBeenCalledWith('project-1', '.gitignore');
    expect(cloudCache.invalidatePath).toHaveBeenCalledWith('project-1', 'package.json');
    expect(cloudCache.invalidatePath).toHaveBeenCalledWith('project-1', 'docs/readme.md');
    expect(cloudCache.invalidatePath).toHaveBeenCalledWith(
      'project-1',
      '.yalc/@pix3/runtime/src/index.ts'
    );
  });
});
