import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileSystemAPIError, FileSystemAPIService } from '@/services/project/FileSystemAPIService';

class FakeFileHandle {
  readonly kind = 'file' as const;
  data = new Uint8Array();
  constructor(public name: string) {}
  async getFile(): Promise<File> {
    return new File([this.data as BlobPart], this.name);
  }
  async createWritable(): Promise<{
    write: (chunk: ArrayBuffer | Uint8Array | Blob | string) => Promise<void>;
    close: () => Promise<void>;
  }> {
    return {
      write: async chunk => {
        if (chunk instanceof ArrayBuffer) {
          this.data = new Uint8Array(chunk);
        } else if (chunk instanceof Uint8Array) {
          this.data = chunk;
        } else if (chunk instanceof Blob) {
          this.data = new Uint8Array(await chunk.arrayBuffer());
        } else {
          this.data = new TextEncoder().encode(chunk);
        }
      },
      close: async () => undefined,
    };
  }
}

class FakeDirectoryHandle {
  readonly kind = 'directory' as const;
  children = new Map<string, FakeDirectoryHandle | FakeFileHandle>();
  constructor(public name: string) {}

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<FakeDirectoryHandle> {
    const existing = this.children.get(name);
    if (existing?.kind === 'directory') {
      return existing;
    }
    if (!existing && options?.create) {
      const dir = new FakeDirectoryHandle(name);
      this.children.set(name, dir);
      return dir;
    }
    throw new DOMException(`${name} not found`, 'NotFoundError');
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    const existing = this.children.get(name);
    if (existing?.kind === 'file') {
      return existing;
    }
    if (!existing && options?.create) {
      const file = new FakeFileHandle(name);
      this.children.set(name, file);
      return file;
    }
    throw new DOMException(`${name} not found`, 'NotFoundError');
  }

  async *entries(): AsyncIterableIterator<[string, FakeDirectoryHandle | FakeFileHandle]> {
    for (const [name, handle] of this.children) {
      yield [name, handle];
    }
  }

  async *keys(): AsyncIterableIterator<string> {
    for (const name of this.children.keys()) {
      yield name;
    }
  }
}

const asHandle = (handle: FakeDirectoryHandle): FileSystemDirectoryHandle =>
  handle as unknown as FileSystemDirectoryHandle;

describe('FileSystemAPIService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats a handle without the permission API as granted (OPFS/Firefox/Safari)', async () => {
    const service = new FileSystemAPIService();
    const handleWithoutPermissionApi = { kind: 'directory', name: 'opfs' };
    await expect(
      service.ensurePermission(
        handleWithoutPermissionApi as unknown as FileSystemDirectoryHandle,
        'readwrite'
      )
    ).resolves.toBeUndefined();
  });

  it('still enforces permission when the API is present and denied', async () => {
    const service = new FileSystemAPIService();
    const handle = {
      kind: 'directory',
      name: 'picked',
      queryPermission: vi.fn().mockResolvedValue('prompt'),
      requestPermission: vi.fn().mockResolvedValue('denied'),
    };
    await expect(
      service.ensurePermission(handle as unknown as FileSystemDirectoryHandle, 'readwrite')
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('pickDirectory returns a handle without adopting it as the project directory', async () => {
    const picked = new FakeDirectoryHandle('picked');
    const service = new FileSystemAPIService({
      directoryPicker: vi
        .fn<() => Promise<FileSystemDirectoryHandle>>()
        .mockResolvedValue(asHandle(picked)),
    });

    const result = await service.pickDirectory('readwrite');
    expect(result).toBe(asHandle(picked));
    // Unlike requestProjectDirectory, the active directory must be untouched.
    expect(service.getProjectDirectory()).toBeNull();
  });

  it('isDirectoryEmpty reflects directory contents', async () => {
    const service = new FileSystemAPIService();
    const empty = new FakeDirectoryHandle('empty');
    expect(await service.isDirectoryEmpty(asHandle(empty))).toBe(true);

    await empty.getFileHandle('a.txt', { create: true });
    expect(await service.isDirectoryEmpty(asHandle(empty))).toBe(false);
  });

  it('copyDirectoryContents copies nested trees binary-safe', async () => {
    const service = new FileSystemAPIService();
    const source = new FakeDirectoryHandle('src');
    const nested = await source.getDirectoryHandle('assets', { create: true });
    const binary = await nested.getFileHandle('sprite.bin', { create: true });
    // Bytes that are not valid UTF-8 — round-tripping through text would corrupt them.
    binary.data = new Uint8Array([0x00, 0xff, 0x80, 0x7f, 0xfe]);
    const text = await source.getFileHandle('scene.pix3scene', { create: true });
    text.data = new TextEncoder().encode('nodes: []');

    const target = new FakeDirectoryHandle('dst');
    await service.copyDirectoryContents(asHandle(source), asHandle(target));

    const copiedText = target.children.get('scene.pix3scene');
    expect(copiedText?.kind).toBe('file');
    expect(new TextDecoder().decode((copiedText as FakeFileHandle).data)).toBe('nodes: []');

    const copiedDir = target.children.get('assets');
    expect(copiedDir?.kind).toBe('directory');
    const copiedBinary = (copiedDir as FakeDirectoryHandle).children.get('sprite.bin');
    expect(Array.from((copiedBinary as FakeFileHandle).data)).toEqual([
      0x00, 0xff, 0x80, 0x7f, 0xfe,
    ]);
  });

  it('treats VS Code integrated browser picker aborts as unsupported', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.121.0 Chrome/142.0.7444.265 Electron/39.8.8 Safari/537.36'
    );

    const service = new FileSystemAPIService({
      directoryPicker: vi
        .fn<() => Promise<FileSystemDirectoryHandle>>()
        .mockRejectedValue(
          new DOMException(
            "Failed to execute 'showDirectoryPicker' on 'Window': The user aborted a request.",
            'AbortError'
          )
        ),
    });

    await expect(service.requestProjectDirectory('readwrite')).rejects.toBeInstanceOf(
      FileSystemAPIError
    );
    await expect(service.requestProjectDirectory('readwrite')).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(service.requestProjectDirectory('readwrite')).rejects.toThrow(
      /VS Code integrated browser/
    );
  });
});
