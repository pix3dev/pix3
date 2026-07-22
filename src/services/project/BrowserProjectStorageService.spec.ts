import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserProjectStorageService } from '@/services/project/BrowserProjectStorageService';

class FakeFile {
  readonly kind = 'file' as const;
  data = new Uint8Array();
  constructor(public name: string) {}
  async getFile(): Promise<File> {
    return new File([this.data], this.name);
  }
}

class FakeDir {
  readonly kind = 'directory' as const;
  children = new Map<string, FakeDir | FakeFile>();
  constructor(public name: string) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDir> {
    const existing = this.children.get(name);
    if (existing?.kind === 'directory') {
      return existing;
    }
    if (existing) {
      throw new DOMException(`${name} is not a directory`, 'TypeMismatchError');
    }
    if (options?.create) {
      const dir = new FakeDir(name);
      this.children.set(name, dir);
      return dir;
    }
    throw new DOMException(`${name} not found`, 'NotFoundError');
  }

  async removeEntry(name: string, _options?: { recursive?: boolean }): Promise<void> {
    if (!this.children.has(name)) {
      throw new DOMException(`${name} not found`, 'NotFoundError');
    }
    this.children.delete(name);
  }
}

describe('BrowserProjectStorageService', () => {
  let opfsRoot: FakeDir;
  let getDirectory: ReturnType<typeof vi.fn>;
  let persist: ReturnType<typeof vi.fn>;

  const installStorage = (value: unknown): void => {
    Object.defineProperty(globalThis.navigator, 'storage', {
      configurable: true,
      value,
    });
  };

  beforeEach(() => {
    opfsRoot = new FakeDir('<opfs-root>');
    getDirectory = vi.fn(async () => opfsRoot);
    persist = vi.fn(async () => true);
    installStorage({ getDirectory, persist });
  });

  afterEach(() => {
    // Remove the stubbed storage so it doesn't leak into other suites.
    Object.defineProperty(globalThis.navigator, 'storage', {
      configurable: true,
      value: undefined,
    });
    vi.restoreAllMocks();
  });

  it('reports support based on navigator.storage.getDirectory', () => {
    const service = new BrowserProjectStorageService();
    expect(service.isSupported()).toBe(true);

    installStorage(undefined);
    expect(new BrowserProjectStorageService().isSupported()).toBe(false);
  });

  it('creates the project under the pix3-browser-projects root', async () => {
    const service = new BrowserProjectStorageService();
    await service.createProjectDirectory('abc');

    const root = opfsRoot.children.get('pix3-browser-projects');
    expect(root?.kind).toBe('directory');
    expect((root as FakeDir).children.has('abc')).toBe(true);
  });

  it('throws when creating a project that already exists', async () => {
    const service = new BrowserProjectStorageService();
    await service.createProjectDirectory('dup');
    await expect(service.createProjectDirectory('dup')).rejects.toThrow(/already exists/);
  });

  it('returns null for a missing project and a handle for an existing one', async () => {
    const service = new BrowserProjectStorageService();
    expect(await service.getProjectDirectory('missing')).toBeNull();

    await service.createProjectDirectory('present');
    const handle = await service.getProjectDirectory('present');
    expect(handle).not.toBeNull();
  });

  it('deletes a project and is a no-op when it is already gone', async () => {
    const service = new BrowserProjectStorageService();
    await service.createProjectDirectory('gone');
    await service.deleteProject('gone');
    expect(await service.getProjectDirectory('gone')).toBeNull();

    // Second delete must not throw.
    await expect(service.deleteProject('gone')).resolves.toBeUndefined();
  });

  it('requests persistence best-effort and swallows failures', async () => {
    const service = new BrowserProjectStorageService();
    await service.requestPersistence();
    expect(persist).toHaveBeenCalledTimes(1);

    persist.mockRejectedValueOnce(new Error('nope'));
    await expect(service.requestPersistence()).resolves.toBeUndefined();
  });
});
