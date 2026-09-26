import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ServiceContainer, ServiceLifetime } from '@/fw/di';
import { appState, resetAppState } from '@/state';
import { CollaborationService } from '@/services/collab/CollaborationService';

const mockApiClient = {
  createDirectory: vi.fn(),
  getManifest: vi.fn(),
  getManifestWithAccess: vi.fn(),
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
};

vi.mock('@/services/cloud/ApiClient', () => mockApiClient);

const { ProjectStorageService } = await import('@/services/project/ProjectStorageService');

class MockCollaborationService {
  readonly ydoc = new Y.Doc();

  getYDoc(): Y.Doc {
    return this.ydoc;
  }

  getLocalOrigin(): string {
    return 'pix3-local';
  }
}

describe('ProjectStorageService', () => {
  let service: InstanceType<typeof ProjectStorageService>;
  let mockFileSystem: Record<string, ReturnType<typeof vi.fn>>;
  let mockCloudCache: Record<string, ReturnType<typeof vi.fn>>;
  let collabService: MockCollaborationService;

  beforeEach(() => {
    resetAppState();
    appState.project.backend = 'cloud';
    appState.project.id = 'project-1';
    ServiceContainer.getInstance().addService(
      ServiceContainer.getInstance().getOrCreateToken(CollaborationService),
      MockCollaborationService,
      ServiceLifetime.Singleton
    );
    collabService = ServiceContainer.getInstance().getService<MockCollaborationService>(
      ServiceContainer.getInstance().getOrCreateToken(CollaborationService)
    );

    service = new ProjectStorageService();
    mockFileSystem = {
      listDirectory: vi.fn(),
      readBlob: vi.fn(),
      writeTextFile: vi.fn(),
      writeBinaryFile: vi.fn(),
      deleteEntry: vi.fn(),
      createDirectory: vi.fn(),
    };
    mockCloudCache = {
      readTextFile: vi.fn(),
      readBlob: vi.fn(),
      storeTextFile: vi.fn(),
      storeBlobFile: vi.fn(),
      reconcileManifest: vi.fn(),
      invalidatePath: vi.fn(),
    };
    Object.defineProperty(service, 'fileSystem', {
      value: mockFileSystem,
      configurable: true,
    });
    Object.defineProperty(service, 'cloudCache', {
      value: mockCloudCache,
      configurable: true,
    });

    mockApiClient.createDirectory.mockReset();
    mockApiClient.downloadFile.mockReset();
    mockApiClient.getManifest.mockReset();
    mockApiClient.getManifestWithAccess.mockReset();
    mockApiClient.uploadFile.mockReset();
    mockApiClient.deleteFile.mockReset();
  });

  afterEach(() => {
    service.dispose();
    resetAppState();
  });

  it('creates cloud directories via the API and refreshes the manifest cache', async () => {
    mockApiClient.createDirectory.mockResolvedValue({ path: 'folder' });
    mockApiClient.getManifestWithAccess.mockResolvedValue({
      files: [{ path: 'folder', kind: 'directory', size: 0, hash: '', modified: '2026-04-03' }],
    });

    await service.createDirectory('folder');

    expect(mockApiClient.createDirectory).toHaveBeenCalledWith('project-1', 'folder');
    expect(mockApiClient.getManifestWithAccess).toHaveBeenCalledWith('project-1', undefined);
    expect(mockCloudCache.reconcileManifest).toHaveBeenCalledWith('project-1', [
      { path: 'folder', kind: 'directory', size: 0, hash: '', modified: '2026-04-03' },
    ]);
    expect(appState.project.lastModifiedDirectoryPath).toBe('.');
    expect(appState.project.fileRefreshSignal).toBe(1);
  });

  it('hydrates cloud text reads into cache and reuses cached content', async () => {
    mockCloudCache.readTextFile.mockResolvedValueOnce(null).mockResolvedValueOnce('cached scene');
    mockApiClient.downloadFile.mockResolvedValue(new Response('remote scene'));

    await expect(service.readTextFile('Scenes/main.pix3scene')).resolves.toBe('remote scene');
    await expect(service.readTextFile('Scenes/main.pix3scene')).resolves.toBe('cached scene');

    expect(mockApiClient.downloadFile).toHaveBeenCalledTimes(1);
    expect(mockCloudCache.storeTextFile).toHaveBeenCalledWith(
      'project-1',
      'Scenes/main.pix3scene',
      'remote scene',
      {}
    );
  });

  it('lists empty cloud directories from manifest entries', async () => {
    mockApiClient.getManifestWithAccess.mockResolvedValue({
      files: [{ path: 'folder', kind: 'directory', size: 0, hash: '', modified: '2026-04-03' }],
    });

    await expect(service.listDirectory('.')).resolves.toEqual([
      { name: 'folder', path: 'folder', kind: 'directory', size: 0 },
    ]);
  });

  it('preserves file size metadata for direct cloud entries', async () => {
    mockApiClient.getManifestWithAccess.mockResolvedValue({
      files: [{ path: 'hero.png', kind: 'file', size: 1536, hash: '', modified: '2026-04-03' }],
    });

    await expect(service.listDirectory('.')).resolves.toEqual([
      { name: 'hero.png', path: 'hero.png', kind: 'file', size: 1536 },
    ]);
  });

  it('moves files through binary copy+delete so asset bytes are preserved', async () => {
    appState.project.backend = 'local';
    const blob = new Blob(['png-bytes']);

    mockFileSystem.listDirectory.mockResolvedValueOnce([
      { name: 'hero.png', path: 'assets/hero.png', kind: 'file' },
    ]);
    mockFileSystem.readBlob.mockResolvedValue(blob);
    mockFileSystem.writeBinaryFile.mockResolvedValue(undefined);
    mockFileSystem.deleteEntry.mockResolvedValue(undefined);

    await service.moveEntry('assets/hero.png', 'icons/hero.png');

    expect(mockFileSystem.readBlob).toHaveBeenCalledWith('assets/hero.png');
    expect(mockFileSystem.writeBinaryFile).toHaveBeenCalledTimes(1);
    expect(mockFileSystem.deleteEntry).toHaveBeenCalledWith('assets/hero.png');
  });

  it('applies remote asset mutations to refresh the active directory', async () => {
    mockApiClient.getManifestWithAccess.mockResolvedValue({
      files: [{ path: 'assets/new.png', kind: 'file', size: 12, hash: '', modified: '2026-04-07' }],
    });

    const assetEvents = collabService.getYDoc().getMap<string>('asset-events');
    assetEvents.set(
      'lastMutation',
      JSON.stringify({
        id: 'evt-1',
        kind: 'write-file',
        path: 'assets/new.png',
        directories: ['assets'],
        occurredAt: Date.now(),
      })
    );

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockApiClient.getManifestWithAccess).toHaveBeenCalledWith('project-1', undefined);
    expect(appState.project.lastModifiedDirectoryPath).toBe('assets');
    expect(appState.project.fileRefreshSignal).toBeGreaterThan(0);
  });

  describe('workspace backend', () => {
    let workspace: Record<string, ReturnType<typeof vi.fn>>;

    beforeEach(() => {
      appState.project.backend = 'workspace';
      appState.project.id = 'ws-1';
      workspace = {
        getCachedManifest: vi.fn().mockReturnValue({ files: [] }),
        getManifest: vi.fn(),
        getManifestEntries: vi.fn().mockReturnValue([
          { path: 'scenes', kind: 'dir', size: 0, mtime: 1 },
          { path: 'scenes/main.pix3scene', kind: 'file', size: 12, mtime: 1700, sha256: 'a' },
          { path: 'scenes/sub', kind: 'dir', size: 0, mtime: 1 },
          { path: 'scenes/sub/deep.pix3scene', kind: 'file', size: 3, mtime: 1, sha256: 'b' },
          { path: 'pix3project.yaml', kind: 'file', size: 5, mtime: 1, sha256: 'c' },
        ]),
        getManifestEntry: vi.fn((path: string) =>
          path === 'scenes/main.pix3scene'
            ? { path, kind: 'file', size: 12, mtime: 1700, sha256: 'a' }
            : null
        ),
        readText: vi.fn().mockResolvedValue('yaml'),
        readBlob: vi.fn().mockResolvedValue(new Blob(['x'])),
        writeFile: vi.fn().mockResolvedValue({ sha256: 'n', size: 1, mtime: 2, seq: 1 }),
        mkdir: vi.fn().mockResolvedValue({ created: true }),
        delete: vi.fn().mockResolvedValue({ kind: 'file' }),
        move: vi.fn().mockResolvedValue({ kind: 'file' }),
      };
      Object.defineProperty(service, 'workspace', { value: workspace, configurable: true });
    });

    it('reports the workspace backend', () => {
      expect(service.getBackend()).toBe('workspace');
    });

    it('lists direct children from the manifest', async () => {
      await expect(service.listDirectory('res://scenes')).resolves.toEqual([
        { name: 'main.pix3scene', kind: 'file', path: 'scenes/main.pix3scene', size: 12 },
        { name: 'sub', kind: 'directory', path: 'scenes/sub', size: null },
      ]);
      expect(mockFileSystem.listDirectory).not.toHaveBeenCalled();
    });

    it('reads and writes through the workspace client, never the FSA service', async () => {
      await expect(service.readTextFile('res://pix3project.yaml')).resolves.toBe('yaml');
      expect(workspace.readText).toHaveBeenCalledWith('pix3project.yaml');

      await service.writeTextFile('scenes/main.pix3scene', 'new');
      expect(workspace.writeFile).toHaveBeenCalledWith('scenes/main.pix3scene', 'new');
      expect(mockFileSystem.writeTextFile).not.toHaveBeenCalled();
      expect(appState.project.lastModifiedDirectoryPath).toBe('scenes');
      expect(appState.project.fileRefreshSignal).toBe(1);
    });

    it('writes .pix3/ bookkeeping without a base when asked, and without a listing refresh', async () => {
      await service.writeTextFile('.pix3/protected.json', '{}', { unconditional: true });
      expect(workspace.writeFile).toHaveBeenCalledWith('.pix3/protected.json', '{}', {
        baseHash: null,
      });
      await service.writeTextFile('.pix3/recovery/a%2Fb.pix3scene/x.pix3scene', 'v');
      expect(appState.project.fileRefreshSignal).toBe(0);
    });

    it('moves with one server rename and deletes recursively', async () => {
      await service.moveEntry('scenes/main.pix3scene', 'levels/main.pix3scene');
      expect(workspace.move).toHaveBeenCalledWith('scenes/main.pix3scene', 'levels/main.pix3scene');
      expect(workspace.readBlob).not.toHaveBeenCalled();

      await service.deleteEntry('scenes/sub');
      expect(workspace.delete).toHaveBeenCalledWith('scenes/sub', { recursive: true });
    });

    it('has no file handles and takes mtime from the manifest', async () => {
      await expect(service.getFileHandle('scenes/main.pix3scene')).resolves.toBeNull();
      await expect(service.getLastModified('res://scenes/main.pix3scene')).resolves.toBe(1700);
      await expect(service.fileExists('scenes/main.pix3scene')).resolves.toBe(true);
      await expect(service.fileExists('scenes/missing.ts')).resolves.toBe(false);
    });

    it('refuses writes while another window holds the lease', async () => {
      appState.project.workspace.lease = 'busy';

      await expect(service.writeTextFile('a.txt', 'x')).rejects.toMatchObject({
        code: 'read_only',
      });
      expect(workspace.writeFile).not.toHaveBeenCalled();
    });
  });
});
