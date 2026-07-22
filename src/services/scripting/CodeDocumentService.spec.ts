import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CodeDocumentService,
  getCodeDocumentLanguageForExtension,
  isCodeDocumentExtension,
} from '@/services/scripting/CodeDocumentService';

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

  it('resolves Monaco languages for text and markdown file extensions', () => {
    const { service } = createService();

    expect(service.resolveLanguage('res://scripts/player.ts')).toBe('typescript');
    expect(service.resolveLanguage('res://config.json')).toBe('json');
    expect(service.resolveLanguage('res://README.md')).toBe('markdown');
    expect(service.resolveLanguage('res://docs/notes.txt')).toBe('plaintext');
    expect(service.resolveLanguage('res://settings.yaml')).toBe('yaml');
    expect(service.resolveLanguage('res://styles/main.css')).toBe('css');
    // Dotfiles keep their whole suffix as the extension.
    expect(service.resolveLanguage('res://.gitignore')).toBe('plaintext');
    // Unknown extensions still open, as plain text.
    expect(service.resolveLanguage('res://data/unknown.xyz')).toBe('plaintext');
  });

  it('reports which paths and extensions are editable as code documents', () => {
    const { service } = createService();

    expect(service.isSupportedResourcePath('res://README.md')).toBe(true);
    expect(service.isSupportedResourcePath('res://scripts/player.ts')).toBe(true);
    expect(service.isSupportedResourcePath('res://audio/sound.wav')).toBe(false);
    expect(service.isSupportedResourcePath('res://textures/atlas.png')).toBe(false);

    expect(isCodeDocumentExtension('MD')).toBe(true);
    expect(isCodeDocumentExtension('wav')).toBe(false);
    expect(getCodeDocumentLanguageForExtension('markdown')).toBe('markdown');
    expect(getCodeDocumentLanguageForExtension('bin')).toBeUndefined();
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
