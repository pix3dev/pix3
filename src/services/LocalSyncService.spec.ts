import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import { appState, resetAppState } from '@/state';
import type { ProjectManifest } from '@/core/ProjectManifest';

const mockApiClient = {
  ApiClientError: class ApiClientError extends Error {
    constructor(
      message: string,
      public status: number
    ) {
      super(message);
    }
  },
  PROJECT_UPLOAD_FILE_SIZE_LIMIT_BYTES: 100 * 1024 * 1024,
  formatUploadLimitBytes: (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`,
  getManifestWithAccess: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  downloadFile: vi.fn(),
};

vi.mock('./ApiClient', () => mockApiClient);

const { LocalSyncService } = await import('./LocalSyncService');

interface FileNode {
  kind: 'file';
  name: string;
  bytes: Uint8Array;
  lastModified: number;
}

interface DirectoryNode {
  kind: 'directory';
  name: string;
  entries: Map<string, FileNode | DirectoryNode>;
}

class FakeFileHandle {
  readonly kind = 'file' as const;

  constructor(
    public readonly name: string,
    private readonly node: FileNode
  ) {}

  async getFile(): Promise<File> {
    return new File([this.node.bytes], this.name, { lastModified: this.node.lastModified });
  }

  async createWritable(): Promise<{
    write: (data: ArrayBuffer | Uint8Array | Blob | string) => Promise<void>;
    close: () => Promise<void>;
  }> {
    return {
      write: async data => {
        this.node.bytes = await toUint8Array(data);
        this.node.lastModified += 1;
      },
      close: async () => undefined,
    };
  }
}

class FakeDirectoryHandle {
  readonly kind = 'directory' as const;

  constructor(
    public readonly name: string,
    private readonly node: DirectoryNode
  ) {}

  async *entries(): AsyncIterable<[string, FakeFileHandle | FakeDirectoryHandle]> {
    for (const [name, entry] of this.node.entries) {
      yield [name, wrapNode(entry)];
    }
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<FakeDirectoryHandle> {
    const existing = this.node.entries.get(name);
    if (existing?.kind === 'directory') {
      return new FakeDirectoryHandle(name, existing);
    }

    if (options?.create) {
      const created: DirectoryNode = {
        kind: 'directory',
        name,
        entries: new Map(),
      };
      this.node.entries.set(name, created);
      return new FakeDirectoryHandle(name, created);
    }

    throw new Error(`Directory not found: ${name}`);
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    const existing = this.node.entries.get(name);
    if (existing?.kind === 'file') {
      return new FakeFileHandle(name, existing);
    }

    if (options?.create) {
      const created: FileNode = {
        kind: 'file',
        name,
        bytes: new Uint8Array(),
        lastModified: Date.now(),
      };
      this.node.entries.set(name, created);
      return new FakeFileHandle(name, created);
    }

    throw new Error(`File not found: ${name}`);
  }

  async removeEntry(name: string): Promise<void> {
    this.node.entries.delete(name);
  }
}

function wrapNode(node: FileNode | DirectoryNode): FakeFileHandle | FakeDirectoryHandle {
  return node.kind === 'file'
    ? new FakeFileHandle(node.name, node)
    : new FakeDirectoryHandle(node.name, node);
}

function createDirectoryTree(files: Record<string, string>): FakeDirectoryHandle {
  const root: DirectoryNode = {
    kind: 'directory',
    name: '.',
    entries: new Map(),
  };

  for (const [path, contents] of Object.entries(files)) {
    const segments = path.split('/').filter(Boolean);
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      const existing = current.entries.get(segment);
      if (existing?.kind === 'directory') {
        current = existing;
        continue;
      }

      const created: DirectoryNode = {
        kind: 'directory',
        name: segment,
        entries: new Map(),
      };
      current.entries.set(segment, created);
      current = created;
    }

    current.entries.set(segments[segments.length - 1], {
      kind: 'file',
      name: segments[segments.length - 1],
      bytes: new TextEncoder().encode(contents),
      lastModified: Date.now(),
    });
  }

  return new FakeDirectoryHandle('.', root);
}

async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function toUint8Array(data: ArrayBuffer | Uint8Array | Blob | string): Promise<Uint8Array> {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }

  if (data instanceof Uint8Array) {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  return new Uint8Array(await data.arrayBuffer());
}

function createManifest(metadata: Record<string, unknown> = {}): ProjectManifest {
  return {
    version: '1.0.0',
    autoloads: [],
    ambientOcclusion: 'baked',
    viewportBaseSize: {
      width: 1920,
      height: 1080,
    },
    metadata,
  };
}

describe('LocalSyncService', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      },
    });
    resetAppState();
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detects local-only changes for a linked local project', async () => {
    const localRoot = createDirectoryTree({
      'src/app.txt': 'changed locally',
    });

    appState.project.id = 'local-1';
    appState.project.backend = 'local';
    appState.project.status = 'ready';
    appState.project.directoryHandle = localRoot as unknown as FileSystemDirectoryHandle;
    appState.project.projectName = 'Hybrid Project';
    appState.project.manifest = createManifest({
      pix3Hybrid: {
        cloudProjectId: 'cloud-1',
      },
    });
    appState.auth.isAuthenticated = true;

    localStorage.setItem(
      'pix3.hybridBaseline:v1:cloud-1:local-1',
      JSON.stringify({
        'src/app.txt': await hashText('original'),
      })
    );

    mockApiClient.getManifestWithAccess.mockResolvedValue({
      files: [
        {
          path: 'src/app.txt',
          kind: 'file',
          size: 8,
          hash: await hashText('original'),
          modified: '2026-04-09T10:00:00.000Z',
        },
      ],
    });

    const projectService = {
      syncProjectMetadata: vi.fn(),
      getPersistedProjectDirectoryHandle: vi.fn(),
    };

    const service = new LocalSyncService();
    Object.defineProperty(service, 'projectService', { value: projectService });
    Object.defineProperty(service, 'dialogService', {
      value: { showConfirmation: vi.fn(), showChoice: vi.fn() },
    });
    Object.defineProperty(service, 'fileSystem', { value: { ensurePermission: vi.fn() } });
    Object.defineProperty(service, 'cloudProjectService', { value: { createProject: vi.fn() } });
    Object.defineProperty(service, 'logger', {
      value: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await service.refreshCurrentProjectStatus();

    expect(appState.project.hybridSync.linkedCloudProjectId).toBe('cloud-1');
    expect(appState.project.hybridSync.status).toBe('local-changes');
    expect(appState.project.hybridSync.localChangeCount).toBe(1);
    expect(projectService.syncProjectMetadata).toHaveBeenCalled();
  });

  it('creates a cloud project from the current local folder and records the hybrid link', async () => {
    const localRoot = createDirectoryTree({
      'pix3project.yaml': stringify(createManifest()),
      'src/app.txt': 'hello hybrid',
    });

    appState.project.id = 'local-1';
    appState.project.backend = 'local';
    appState.project.status = 'ready';
    appState.project.directoryHandle = localRoot as unknown as FileSystemDirectoryHandle;
    appState.project.projectName = 'Hybrid Project';
    appState.project.manifest = createManifest();
    appState.auth.isAuthenticated = true;

    const saveProjectManifest = vi.fn(async (manifest: ProjectManifest) => {
      appState.project.manifest = manifest;
      const nextYaml = stringify(manifest);
      const fileHandle = await (localRoot as unknown as FakeDirectoryHandle).getFileHandle(
        'pix3project.yaml',
        {
          create: true,
        }
      );
      const writable = await fileHandle.createWritable();
      await writable.write(nextYaml);
      await writable.close();
    });

    const projectService = {
      saveProjectManifest,
      syncProjectMetadata: vi.fn(),
      addRecentProject: vi.fn(),
    };
    const cloudProjectService = {
      createProject: vi.fn(async () => ({ id: 'cloud-2' })),
    };

    const service = new LocalSyncService();
    Object.defineProperty(service, 'projectService', { value: projectService });
    Object.defineProperty(service, 'dialogService', {
      value: { showConfirmation: vi.fn(), showChoice: vi.fn() },
    });
    Object.defineProperty(service, 'fileSystem', { value: { ensurePermission: vi.fn() } });
    Object.defineProperty(service, 'cloudProjectService', { value: cloudProjectService });
    Object.defineProperty(service, 'logger', {
      value: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await service.syncCurrentLocalProjectToCloud();

    expect(cloudProjectService.createProject).toHaveBeenCalledWith('Hybrid Project');
    expect(saveProjectManifest).toHaveBeenCalledTimes(1);
    expect(projectService.addRecentProject).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'cloud-2',
        backend: 'cloud',
        linkedLocalSessionId: 'local-1',
      })
    );
    expect(appState.project.hybridSync.linkedCloudProjectId).toBe('cloud-2');
    expect(appState.project.hybridSync.status).toBe('up-to-date');

    const uploadCalls = mockApiClient.uploadFile.mock.calls as Array<[string, string, ArrayBuffer]>;
    expect(uploadCalls.map(([, path]) => path).sort()).toEqual(['pix3project.yaml', 'src/app.txt']);

    const uploadedManifest = uploadCalls.find(([, path]) => path === 'pix3project.yaml');
    expect(uploadedManifest).toBeDefined();
    const uploadedManifestText = new TextDecoder().decode(uploadedManifest![2]);
    expect(uploadedManifestText).toContain('cloudProjectId: cloud-2');

    const storedLinks = JSON.parse(localStorage.getItem('pix3.hybridLinks:v1') ?? '[]') as Array<{
      cloudProjectId: string;
      localSessionId: string;
    }>;
    expect(storedLinks).toEqual([
      expect.objectContaining({
        cloudProjectId: 'cloud-2',
        localSessionId: 'local-1',
      }),
    ]);
  });

  it('skips oversized files and continues uploading the rest', async () => {
    appState.project.id = 'local-1';
    appState.project.backend = 'local';
    appState.project.status = 'ready';
    appState.project.directoryHandle = createDirectoryTree(
      {}
    ) as unknown as FileSystemDirectoryHandle;
    appState.project.projectName = 'Hybrid Project';
    appState.project.manifest = createManifest();
    appState.auth.isAuthenticated = true;

    const saveProjectManifest = vi.fn(async (manifest: ProjectManifest) => {
      appState.project.manifest = manifest;
    });
    const projectService = {
      saveProjectManifest,
      syncProjectMetadata: vi.fn(),
      addRecentProject: vi.fn(),
    };
    const cloudProjectService = {
      createProject: vi.fn(async () => ({ id: 'cloud-3' })),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    mockApiClient.uploadFile.mockImplementation(async (_projectId: string, filePath: string) => {
      if (filePath === 'design_assets/screenshot.png') {
        throw new Error('File design_assets/screenshot.png exceeds the upload limit of 100 MB.');
      }
      return { path: filePath, size: 4 };
    });

    const service = new LocalSyncService();
    Object.defineProperty(service, 'projectService', { value: projectService });
    Object.defineProperty(service, 'dialogService', {
      value: { showConfirmation: vi.fn(), showChoice: vi.fn() },
    });
    Object.defineProperty(service, 'fileSystem', { value: { ensurePermission: vi.fn() } });
    Object.defineProperty(service, 'cloudProjectService', { value: cloudProjectService });
    Object.defineProperty(service, 'logger', { value: logger });
    Object.defineProperty(service, 'buildLocalManifest', {
      value: vi.fn(
        async () =>
          new Map([
            [
              'design_assets/screenshot.png',
              {
                hash: 'big-hash',
                modified: 1,
                size: 110 * 1024 * 1024,
              },
            ],
            [
              'src/app.txt',
              {
                hash: 'small-hash',
                modified: 1,
                size: 128,
              },
            ],
          ])
      ),
    });
    Object.defineProperty(service, 'readFile', {
      value: vi.fn(
        async (_handle: FileSystemDirectoryHandle, filePath: string) =>
          new TextEncoder().encode(filePath).buffer
      ),
    });
    Object.defineProperty(service, 'isUploadTooLargeError', {
      value: vi.fn(
        (error: unknown) => error instanceof Error && error.message.includes('upload limit')
      ),
    });

    await service.syncCurrentLocalProjectToCloud();

    expect(mockApiClient.uploadFile).toHaveBeenCalledWith(
      'cloud-3',
      'src/app.txt',
      expect.any(ArrayBuffer)
    );
    expect(appState.project.hybridSync.status).toBe('local-changes');
    expect(appState.project.hybridSync.errorMessage).toContain('upload limit is 100 MB');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('allows syncing into a Git-only folder and keeps cloud .gitignore files', async () => {
    const localRoot = createDirectoryTree({
      '.git/config': '[core]\n  repositoryformatversion = 0\n',
      '.gitignore': 'node_modules/\n',
    });

    const cloudGitignore = 'dist/\n.cache/\n';
    const sceneContents = 'root:\n  id: scene-1\n';
    const cloudManifest = stringify(
      createManifest({
        pix3Hybrid: {
          cloudProjectId: 'cloud-1',
        },
      })
    );

    appState.project.id = 'cloud-1';
    appState.project.backend = 'cloud';
    appState.project.status = 'ready';
    appState.project.projectName = 'Cloud Hybrid';
    appState.project.manifest = createManifest();
    appState.auth.isAuthenticated = true;

    mockApiClient.getManifestWithAccess.mockResolvedValue({
      files: [
        {
          path: '.gitignore',
          kind: 'file',
          size: cloudGitignore.length,
          hash: await hashText(cloudGitignore),
          modified: '2026-04-09T10:00:00.000Z',
        },
        {
          path: 'pix3project.yaml',
          kind: 'file',
          size: cloudManifest.length,
          hash: await hashText(cloudManifest),
          modified: '2026-04-09T10:00:01.000Z',
        },
        {
          path: 'Scenes/main.pix3scene',
          kind: 'file',
          size: sceneContents.length,
          hash: await hashText(sceneContents),
          modified: '2026-04-09T10:00:02.000Z',
        },
      ],
    });

    mockApiClient.downloadFile.mockImplementation(async (_projectId: string, filePath: string) => {
      switch (filePath) {
        case '.gitignore':
          return new Response(new Blob([cloudGitignore]));
        case 'pix3project.yaml':
          return new Response(new Blob([cloudManifest]));
        case 'Scenes/main.pix3scene':
          return new Response(new Blob([sceneContents]));
        default:
          throw new Error(`Unexpected download: ${filePath}`);
      }
    });

    const saveProjectManifest = vi.fn(async (manifest: ProjectManifest) => {
      appState.project.manifest = manifest;
    });
    const projectService = {
      saveProjectManifest,
      createProjectSessionId: vi.fn(() => 'local-session-1'),
      persistProjectDirectoryHandle: vi.fn().mockResolvedValue(undefined),
      addRecentProject: vi.fn(),
      syncProjectMetadata: vi.fn(),
    };
    const fileSystem = {
      requestProjectDirectory: vi.fn().mockResolvedValue(localRoot),
      ensurePermission: vi.fn().mockResolvedValue(undefined),
    };

    const service = new LocalSyncService();
    Object.defineProperty(service, 'projectService', { value: projectService });
    Object.defineProperty(service, 'dialogService', {
      value: { showConfirmation: vi.fn(), showChoice: vi.fn() },
    });
    Object.defineProperty(service, 'fileSystem', { value: fileSystem });
    Object.defineProperty(service, 'cloudProjectService', { value: { createProject: vi.fn() } });
    Object.defineProperty(service, 'logger', {
      value: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await service.syncCurrentCloudProjectToLocalFolder();

    const gitignoreHandle = await (localRoot as unknown as FakeDirectoryHandle).getFileHandle(
      '.gitignore'
    );
    expect(await (await gitignoreHandle.getFile()).text()).toBe(cloudGitignore);

    const sceneHandle = await (
      await (localRoot as unknown as FakeDirectoryHandle).getDirectoryHandle('Scenes')
    ).getFileHandle('main.pix3scene');
    expect(await (await sceneHandle.getFile()).text()).toBe(sceneContents);
    expect(projectService.addRecentProject).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'local-session-1',
        backend: 'local',
        linkedCloudProjectId: 'cloud-1',
      })
    );
  });
});
