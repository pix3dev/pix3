import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import { ApiClientError } from '@/services/cloud/ApiClient';

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
