import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import { ServiceContainer, ServiceLifetime } from '@/fw/di';

/** Minimal directory handle: identity is `isSameEntry`, exactly as the real picker gives it. */
class FakeDirectoryHandle {
  readonly kind = 'directory' as const;

  constructor(public readonly name: string) {}

  async isSameEntry(other: FileSystemDirectoryHandle): Promise<boolean> {
    return (other as unknown as FakeDirectoryHandle) === this;
  }
}

const fsStub = {
  requestProjectDirectory: vi.fn(),
  setProjectDirectory: vi.fn(),
  ensurePermission: vi.fn(async () => true),
};

vi.mock('@/services/project/FileSystemAPIService', () => ({
  resolveFileSystemAPIService: () => fsStub,
}));

vi.mock('@/services/project/ProjectStorageService', () => ({
  ProjectStorageService: class {
    readTextFile = vi.fn(async () => {
      throw new Error('no manifest');
    });
  },
}));

vi.mock('@/services/project/BrowserProjectStorageService', () => ({
  BrowserProjectStorageService: class {},
}));

const { ProjectStorageService } = await import('@/services/project/ProjectStorageService');
const { BrowserProjectStorageService } = await import(
  '@/services/project/BrowserProjectStorageService'
);
const { ProjectService } = await import('@/services/project/ProjectService');

// `ProjectService` resolves its storage collaborators at field-init time, so they must be in the
// container before the first `new ProjectService()`.
const container = ServiceContainer.getInstance();
container.addService(
  container.getOrCreateToken(ProjectStorageService),
  ProjectStorageService,
  ServiceLifetime.Singleton
);
container.addService(
  container.getOrCreateToken(BrowserProjectStorageService),
  BrowserProjectStorageService,
  ServiceLifetime.Singleton
);

describe('ProjectService — local project identity', () => {
  let service: InstanceType<typeof ProjectService>;
  /** Stands in for the IndexedDB handle store, so the spec needs no real IndexedDB. */
  let handleStore: Map<string, FileSystemDirectoryHandle>;

  beforeEach(() => {
    resetAppState();
    localStorage.clear();
    vi.clearAllMocks();

    handleStore = new Map();
    service = new ProjectService();
    vi.spyOn(service, 'persistProjectDirectoryHandle').mockImplementation(async (id, handle) => {
      handleStore.set(id, handle);
    });
    vi.spyOn(service, 'getPersistedProjectDirectoryHandle').mockImplementation(
      async id => handleStore.get(id) ?? null
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses the session id when the same folder is picked again', async () => {
    const handle = new FakeDirectoryHandle('my-game') as unknown as FileSystemDirectoryHandle;
    fsStub.requestProjectDirectory.mockResolvedValue(handle);

    await service.openProjectViaPicker();
    const firstId = appState.project.id;
    expect(firstId).toBeTruthy();

    await service.openProjectViaPicker();

    // Same id → the workspace mode, tabs and asset-browser state keyed by it survive the reopen.
    expect(appState.project.id).toBe(firstId);
    expect(service.getRecentProjects()).toHaveLength(1);
  });

  it('mints a fresh session id for a folder it has never seen', async () => {
    const first = new FakeDirectoryHandle('game-a') as unknown as FileSystemDirectoryHandle;
    fsStub.requestProjectDirectory.mockResolvedValue(first);
    await service.openProjectViaPicker();
    const firstId = appState.project.id;

    const second = new FakeDirectoryHandle('game-b') as unknown as FileSystemDirectoryHandle;
    fsStub.requestProjectDirectory.mockResolvedValue(second);
    await service.openProjectViaPicker();

    expect(appState.project.id).not.toBe(firstId);
    expect(service.getRecentProjects()).toHaveLength(2);
  });

  it('ignores a recents entry whose persisted handle is gone', async () => {
    service.addRecentProject({
      id: 'stale-id',
      name: 'stale',
      backend: 'local',
      lastOpenedAt: Date.now(),
    });

    const handle = new FakeDirectoryHandle('fresh') as unknown as FileSystemDirectoryHandle;
    fsStub.requestProjectDirectory.mockResolvedValue(handle);
    await service.openProjectViaPicker();

    expect(appState.project.id).not.toBe('stale-id');
  });
});
