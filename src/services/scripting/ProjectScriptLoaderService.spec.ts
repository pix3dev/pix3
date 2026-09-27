import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import { ApiClientError } from '@/services/cloud/ApiClient';
import { sha256 } from '@/services/project/external-merge/hash';
import { FileWatchService } from '@/services/project/FileWatchService';
import { WorkspaceClient } from '@/services/project/workspace/WorkspaceClient';
import {
  WorkspaceEventsClient,
  type WorkspaceSocketLike,
} from '@/services/project/workspace/WorkspaceEventsClient';
import { WorkspaceSessionService } from '@/services/project/workspace/WorkspaceSessionService';
import {
  WORKSPACE_PROTOCOL,
  WorkspaceError,
} from '@/services/project/workspace/workspace-protocol';

const { ProjectScriptLoaderService } = await import(
  '@/services/scripting/ProjectScriptLoaderService'
);

describe('ProjectScriptLoaderService.ensureReady', () => {
  beforeEach(() => {
    resetAppState();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetAppState();
  });

  it('waits for project scripts to finish loading before resolving', async () => {
    appState.project.status = 'ready';
    appState.project.scriptsStatus = 'idle';

    const service = new ProjectScriptLoaderService();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const syncAndBuild = vi.fn(async () => {
      appState.project.scriptsStatus = 'loading';
      window.setTimeout(() => {
        appState.project.scriptsStatus = 'ready';
      }, 0);
    });

    Object.defineProperty(service, 'logger', { value: logger });
    Object.defineProperty(service, 'syncAndBuild', { value: syncAndBuild });

    await service.ensureReady();

    expect(syncAndBuild).toHaveBeenCalledTimes(1);
    expect(appState.project.scriptsStatus).toBe('ready');

    service.dispose();
  });

  it('logs missing bundled dependency fetches with attempted path and importer', async () => {
    const service = new ProjectScriptLoaderService();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const storage = {
      readTextFile: vi.fn().mockRejectedValue(new ApiClientError('Failed to download foo.ts', 404)),
      getFileHandle: vi.fn(),
    };

    Object.defineProperty(service, 'logger', { value: logger });
    Object.defineProperty(service, 'storage', { value: storage });

    const result = await (
      service as unknown as {
        loadBundledDependency: (
          filePath: string,
          context?: { importer: string; requestedImportPath: string; namespace: string }
        ) => Promise<string | null>;
      }
    ).loadBundledDependency('src/assets/textures.ts', {
      importer: 'src/scripts/world/DeepCoreRunner.ts',
      requestedImportPath: '../../assets/textures',
      namespace: 'virtual-fs',
    });

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      'Script dependency fetch failed: tried src/assets/textures.ts while resolving ../../assets/textures from src/scripts/world/DeepCoreRunner.ts',
      {
        attemptedPath: 'src/assets/textures.ts',
        requestedImport: '../../assets/textures',
        importer: 'src/scripts/world/DeepCoreRunner.ts',
        namespace: 'virtual-fs',
        status: 404,
        message: 'Failed to download foo.ts',
      }
    );

    service.dispose();
  });

  it('forwards compiler load context into dependency logging during build', async () => {
    const service = new ProjectScriptLoaderService();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const compiler = {
      bundle: vi.fn(async (_files, _entryFiles, fileLoader) => {
        await fileLoader?.('src/assets/textures.ts', {
          importer: 'src/scripts/systems/AvatarUISystem.ts',
          requestedImportPath: '../../assets/textures',
          namespace: 'virtual-fs',
        });

        return { code: '', warnings: [] };
      }),
    };
    const storage = {
      readTextFile: vi.fn(async (filePath: string) => {
        if (filePath === 'src/scripts/systems/AvatarUISystem.ts') {
          return 'export class AvatarUISystem extends Script {}';
        }

        throw new ApiClientError(`Failed to download ${filePath}`, 404);
      }),
      getFileHandle: vi.fn().mockResolvedValue(null),
    };
    const fileWatchService = {
      watch: vi.fn(),
      unwatch: vi.fn(),
    };
    const scriptRegistry = {
      registerComponent: vi.fn(),
      unregisterComponent: vi.fn(),
    };

    Object.defineProperty(service, 'logger', { value: logger });
    Object.defineProperty(service, 'compiler', { value: compiler });
    Object.defineProperty(service, 'storage', { value: storage });
    Object.defineProperty(service, 'fileWatchService', { value: fileWatchService });
    Object.defineProperty(service, 'scriptRegistry', { value: scriptRegistry });
    Object.defineProperty(service, 'collectScriptFiles', {
      value: vi.fn(async () => ({
        sourceFiles: [
          {
            name: 'AvatarUISystem.ts',
            kind: 'file' as FileSystemHandleKind,
            path: 'src/scripts/systems/AvatarUISystem.ts',
          },
        ],
        checkedDirectories: ['scripts', 'src/scripts'] as const,
      })),
    });
    Object.defineProperty(service, 'loadBundle', {
      value: vi.fn(async () => {}),
    });

    await (
      service as unknown as {
        performSyncAndBuild: () => Promise<void>;
      }
    ).performSyncAndBuild();

    expect(compiler.bundle).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Script dependency fetch failed: tried src/assets/textures.ts while resolving ../../assets/textures from src/scripts/systems/AvatarUISystem.ts',
      {
        attemptedPath: 'src/assets/textures.ts',
        requestedImport: '../../assets/textures',
        importer: 'src/scripts/systems/AvatarUISystem.ts',
        namespace: 'virtual-fs',
        status: 404,
        message: 'Failed to download src/assets/textures.ts',
      }
    );

    service.dispose();
  });
});

describe('ProjectScriptLoaderService — build input hashes', () => {
  it('records the hash of every source a build read, bundled modules included', async () => {
    const service = new ProjectScriptLoaderService();
    const sources: Record<string, string> = {
      'src/scripts/Runner.ts':
        "import { Chunk } from '../world/Chunk';\nexport class Runner extends Script {}",
      'src/world/Chunk.ts': 'export class Chunk {}',
      'src/generated/catalog.ts': 'export const catalog = {};',
    };
    const compiler = {
      bundle: vi.fn(async (_files, _entryFiles, fileLoader) => {
        await fileLoader?.('src/world/Chunk.ts', { namespace: 'virtual-fs' });
        await fileLoader?.('src/generated/catalog.ts', { namespace: 'virtual-fs' });
        return { code: '', warnings: [] };
      }),
    };
    const storage = {
      readTextFile: vi.fn(async (filePath: string) => sources[filePath] ?? ''),
      getFileHandle: vi.fn().mockResolvedValue(null),
      // The workspace ETag of the read (here: a marker, so the test sees it is used as is).
      getKnownContentHash: vi.fn((filePath: string) =>
        filePath === 'src/world/Chunk.ts' ? 'e'.repeat(64) : null
      ),
    };
    Object.defineProperty(service, 'logger', {
      value: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    Object.defineProperty(service, 'compiler', { value: compiler });
    Object.defineProperty(service, 'storage', { value: storage });
    Object.defineProperty(service, 'fileWatchService', {
      value: { watch: vi.fn(), unwatch: vi.fn(), isPushMode: () => true },
    });
    Object.defineProperty(service, 'scriptRegistry', {
      value: { registerComponent: vi.fn(), unregisterComponent: vi.fn() },
    });
    Object.defineProperty(service, 'collectScriptFiles', {
      value: vi.fn(async () => ({
        sourceFiles: [
          {
            name: 'Runner.ts',
            kind: 'file' as FileSystemHandleKind,
            path: 'src/scripts/Runner.ts',
          },
        ],
        checkedDirectories: ['scripts', 'src/scripts'] as const,
      })),
    });
    Object.defineProperty(service, 'loadBundle', { value: vi.fn(async () => {}) });

    await (
      service as unknown as { performSyncAndBuild: () => Promise<void> }
    ).performSyncAndBuild();

    const hashes = service.getCollectedFileHashes();
    expect([...hashes.keys()].sort()).toEqual(Object.keys(sources).sort());
    expect(hashes.get('src/world/Chunk.ts')).toBe('e'.repeat(64));
    expect(hashes.get('src/scripts/Runner.ts')).toBe(
      await sha256(sources['src/scripts/Runner.ts'])
    );
    service.dispose();
  });
});

// --- Build recovery and workspace switches -----------------------------------------------------

type LoaderInstance = InstanceType<typeof ProjectScriptLoaderService>;

interface LoaderStorageStub {
  listDirectory: (path: string) => Promise<Array<{ name: string; kind: string; path: string }>>;
  getFileHandle?: (path: string) => Promise<null>;
  readTextFile?: (path: string) => Promise<string>;
}

function createLoader(storage: LoaderStorageStub): {
  loader: LoaderInstance;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
} {
  const loader = new ProjectScriptLoaderService();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  Object.defineProperty(loader, 'logger', { value: logger });
  Object.defineProperty(loader, 'storage', {
    value: {
      getFileHandle: vi.fn(async () => null),
      readTextFile: vi.fn(async () => ''),
      ...storage,
    },
  });
  Object.defineProperty(loader, 'fileWatchService', {
    value: { watch: vi.fn(), unwatch: vi.fn(), isPushMode: () => true },
  });
  Object.defineProperty(loader, 'scriptRegistry', {
    value: { registerComponent: vi.fn(), unregisterComponent: vi.fn() },
  });
  Object.defineProperty(loader, 'compiler', {
    value: { bundle: vi.fn(async () => ({ code: '', warnings: [] })) },
  });
  Object.defineProperty(loader, 'sceneManager', {
    value: { resolvePendingComponents: vi.fn(() => 0) },
  });
  return { loader, logger };
}

/** What `compile_scripts` (AgentToolRegistry.compileScripts) does with the loader. */
async function compileScriptsLikeTheAgentTool(loader: LoaderInstance): Promise<void> {
  await loader.syncAndBuild({ force: true });
  await loader.ensureReady();
}

function openWorkspaceState(id: string): void {
  appState.project.id = id;
  appState.project.backend = 'workspace';
  appState.project.status = 'ready';
  appState.project.workspace.status = 'connected';
}

describe('ProjectScriptLoaderService — recovery from a failed build', () => {
  beforeEach(() => {
    resetAppState();
  });

  afterEach(() => {
    resetAppState();
  });

  it('settles on error when storage throws "No workspace is connected", then builds again', async () => {
    openWorkspaceState('ws-b');
    const listDirectory = vi
      .fn<LoaderStorageStub['listDirectory']>()
      .mockRejectedValueOnce(new WorkspaceError('connection_failed', 'No workspace is connected.'))
      .mockResolvedValue([]);
    const { loader, logger } = createLoader({ listDirectory });

    await loader.syncAndBuild({ force: true });

    expect(appState.project.scriptsStatus).toBe('error');
    expect(loader.getLastBuildError()?.message).toBe('No workspace is connected.');
    expect(logger.error).toHaveBeenCalledWith('Failed to compile scripts', expect.anything());

    // ensureReady answers at once (no 15 s wait on a `loading` nothing will finish).
    const started = Date.now();
    await loader.ensureReady();
    expect(Date.now() - started).toBeLessThan(1000);

    await loader.syncAndBuild({ force: true });
    expect(appState.project.scriptsStatus).toBe('ready');
    expect(loader.getLastBuildError()).toBeNull();

    loader.dispose();
  });

  it('compile_scripts after a build that hung runs a new build instead of hanging', async () => {
    openWorkspaceState('ws-b');
    let hang = true;
    const listDirectory = vi.fn<LoaderStorageStub['listDirectory']>(async () => {
      if (hang) {
        return new Promise(() => undefined); // a request into a dead tunnel
      }
      return [];
    });
    const { loader } = createLoader({ listDirectory });
    loader.buildTimeoutMs = 50;

    await compileScriptsLikeTheAgentTool(loader);
    expect(appState.project.scriptsStatus).toBe('error');
    expect(loader.getLastBuildError()?.message).toMatch(/did not finish/);

    hang = false;
    const callsBefore = listDirectory.mock.calls.length;
    await compileScriptsLikeTheAgentTool(loader);

    expect(listDirectory.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(appState.project.scriptsStatus).toBe('ready');

    loader.dispose();
  });

  it('answers compile_scripts at once while the workspace is down, and builds when it reconnects', async () => {
    openWorkspaceState('ws-b');
    appState.project.workspace.status = 'reconnecting';
    const listDirectory = vi.fn<LoaderStorageStub['listDirectory']>(async () => []);
    const { loader } = createLoader({ listDirectory });

    await compileScriptsLikeTheAgentTool(loader);

    expect(listDirectory).not.toHaveBeenCalled();
    expect(appState.project.scriptsStatus).toBe('error');
    expect(loader.getLastBuildError()?.message).toMatch(/not connected/);

    appState.project.workspace.status = 'connected';
    await vi.waitFor(() => expect(appState.project.scriptsStatus).toBe('ready'), {
      timeout: 2000,
    });
    expect(listDirectory).toHaveBeenCalled();

    loader.dispose();
  });
});

/** Minimal `pix3 serve` event socket: hello after auth, a granted lease after acquire. */
class SwitchFakeSocket implements WorkspaceSocketLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(private readonly serving: () => string) {}

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    const workspaceId = this.serving();
    if (frame.type === 'auth') {
      this.receive({
        type: 'hello',
        workspaceId,
        serverSession: `session-${workspaceId}`,
        protocol: WORKSPACE_PROTOCOL,
        cliVersion: '1.6.0',
        revision: 'rev-1',
        seq: 0,
        root: `/srv/${workspaceId}`,
        projectId: workspaceId,
        projectName: workspaceId === 'ws-a' ? 'Game A' : 'DeepCore',
        lease: 'free',
      });
    } else if (frame.type === 'lease' && frame.action === 'acquire') {
      this.receive({
        type: 'lease',
        state: 'granted',
        leaseId: `l-${workspaceId}`,
        resumed: false,
      });
    }
  }

  close(): void {
    this.readyState = 3;
  }

  private receive(frame: Record<string, unknown>): void {
    queueMicrotask(() =>
      this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }))
    );
  }
}

describe('ProjectScriptLoaderService — switching between two workspaces', () => {
  /** Which workspace the one address (same port, restarted `pix3 serve`) serves right now. */
  let serving: 'ws-a' | 'ws-b';
  let session: WorkspaceSessionService;
  let client: WorkspaceClient;
  let fileWatch: FileWatchService;

  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  const identity = () => ({
    workspaceId: serving,
    serverSession: `session-${serving}`,
    protocol: WORKSPACE_PROTOCOL,
    cliVersion: '1.6.0',
    root: `/srv/${serving}`,
    revision: 'rev-1',
    seq: 0,
  });

  /** The same steps as `ProjectService.openWorkspaceProject`. */
  async function openWorkspace(token: string): Promise<void> {
    const { hello } = await session.connect('http://localhost:8490', token);
    appState.project.id = hello.workspaceId;
    appState.project.backend = 'workspace';
    appState.project.directoryHandle = null;
    appState.project.projectName = hello.projectName;
    appState.project.status = 'ready';
    appState.project.errorMessage = null;
    session.attachToProject(hello.workspaceId);
  }

  beforeEach(() => {
    resetAppState();
    sessionStorage.clear();
    serving = 'ws-a';
    client = new WorkspaceClient(async (input: string) => {
      if (input.endsWith('/ws/status')) {
        // A real round trip through a forwarded port: longer than the loader's 300 ms debounce,
        // so a build triggered while connecting would reach the listing mid-switch.
        await new Promise(resolve => setTimeout(resolve, 400));
        return json({ ...identity(), pid: 1, port: 8490, leased: false });
      }
      if (input.endsWith('/ws/manifest')) {
        return json({
          ...identity(),
          files: [{ path: 'scripts', kind: 'dir', size: 0, mtime: 1 }],
        });
      }
      return new Response('{}', { status: 404 });
    });
    fileWatch = new FileWatchService();
    session = new WorkspaceSessionService();
    Object.defineProperty(session, 'client', { value: client });
    Object.defineProperty(session, 'fileWatch', { value: fileWatch });
    session.setEventsClientFactory(
      () =>
        new WorkspaceEventsClient({
          createSocket: () => {
            const socket = new SwitchFakeSocket(() => serving);
            queueMicrotask(() => {
              socket.readyState = 1;
              socket.onopen?.(new Event('open'));
            });
            return socket;
          },
        })
    );
  });

  afterEach(() => {
    session.dispose();
    fileWatch.dispose();
    resetAppState();
  });

  it('does not list the project before the new session is connected and switched to', async () => {
    await openWorkspace('token-a');
    const listings: Array<{ project: string | null; workspace: string; configured: boolean }> = [];
    const { loader, logger } = createLoader({
      listDirectory: async () => {
        listings.push({
          project: appState.project.id,
          workspace: appState.project.workspace.status,
          configured: client.isConfigured(),
        });
        await client.getManifest(); // what ProjectStorageService.listDirectory does
        return [];
      },
    });
    await loader.syncAndBuild({ force: true });
    expect(appState.project.scriptsStatus).toBe('ready');
    listings.length = 0;

    // `pix3 serve` restarted on the same port in project B; the user connects to it.
    serving = 'ws-b';
    const opening = openWorkspace('token-b');
    // An edit in project A lands while B is connecting (a watcher, the agent, a file refresh).
    void loader.syncAndBuild();
    await opening;
    await vi.waitFor(
      () => {
        expect(appState.project.scriptsStatus).toBe('ready');
        expect(listings.length).toBeGreaterThan(0);
      },
      { timeout: 3000 }
    );

    expect(listings.every(call => call.project === 'ws-b')).toBe(true);
    expect(listings.every(call => call.workspace === 'connected' && call.configured)).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();

    // compile_scripts right after the switch builds B, it does not wait on anything.
    await compileScriptsLikeTheAgentTool(loader);
    expect(appState.project.scriptsStatus).toBe('ready');

    loader.dispose();
  });
});
