import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeDocumentService } from './CodeDocumentService';

describe('CodeDocumentService', () => {
  const createService = () => {
    const service = new CodeDocumentService();
    const storage = {
      readTextFile: vi.fn(),
      writeTextFile: vi.fn(),
      getLastModified: vi.fn(),
      getFileHandle: vi.fn(),
      getBackend: vi.fn().mockReturnValue('local' as const),
    };
    const dialogService = {
      showChoice: vi.fn(),
    };
    const fileWatchService = {
      watch: vi.fn(),
      unwatch: vi.fn(),
      setLastKnownModifiedTime: vi.fn(),
    };
    const projectScriptLoader = {
      syncAndBuild: vi.fn().mockResolvedValue(undefined),
    };

    Object.defineProperty(service, 'storage', { value: storage });
    Object.defineProperty(service, 'dialogService', { value: dialogService });
    Object.defineProperty(service, 'fileWatchService', { value: fileWatchService });
    Object.defineProperty(service, 'projectScriptLoader', { value: projectScriptLoader });

    return { service, storage, dialogService, fileWatchService, projectScriptLoader };
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads, tracks dirty state, and saves local code documents', async () => {
    const { service, storage, fileWatchService } = createService();
    storage.readTextFile.mockResolvedValue('const value = 1;');
    storage.getLastModified.mockResolvedValue(123);
    storage.getFileHandle.mockResolvedValue({
      getFile: vi.fn(),
    } as unknown as FileSystemFileHandle);

    const snapshot = await service.ensureLoaded('res://scripts/player.ts');
    expect(snapshot.isDirty).toBe(false);
    expect(snapshot.language).toBe('typescript');

    await service.updateContent('res://scripts/player.ts', 'const value = 2;');
    expect(service.getDocument('res://scripts/player.ts')?.isDirty).toBe(true);

    await service.save('res://scripts/player.ts');

    expect(storage.writeTextFile).toHaveBeenCalledWith(
      'res://scripts/player.ts',
      'const value = 2;'
    );
    expect(fileWatchService.setLastKnownModifiedTime).toHaveBeenCalledWith(
      'res://scripts/player.ts',
      123
    );
    expect(service.getDocument('res://scripts/player.ts')?.isDirty).toBe(false);
  });

  it('rebuilds project scripts only for saved .ts/.js files inside script directories', async () => {
    const { service, storage, projectScriptLoader } = createService();
    storage.readTextFile.mockResolvedValue('export class Player {}');
    storage.getLastModified.mockResolvedValue(10);
    storage.getFileHandle.mockResolvedValue(null);

    await service.ensureLoaded('res://scripts/player.ts');
    await service.updateContent('res://scripts/player.ts', 'export class Player {}');
    await service.save('res://scripts/player.ts');

    await service.ensureLoaded('res://config.json');
    await service.updateContent('res://config.json', '{"name":"pix3"}');
    await service.save('res://config.json');

    expect(projectScriptLoader.syncAndBuild).toHaveBeenCalledTimes(1);
  });

  it('allows saving code documents in cloud-backed projects', async () => {
    const { service, storage } = createService();
    storage.getBackend.mockReturnValue('cloud');
    storage.readTextFile.mockResolvedValue('console.log("hi");');
    storage.getLastModified.mockResolvedValue(77);
    storage.getFileHandle.mockResolvedValue(null);

    await service.ensureLoaded('res://scripts/bootstrap.js');
    await service.updateContent('res://scripts/bootstrap.js', 'console.log("updated");');
    await service.save('res://scripts/bootstrap.js');

    expect(storage.writeTextFile).toHaveBeenCalledWith(
      'res://scripts/bootstrap.js',
      'console.log("updated");'
    );
  });
});
