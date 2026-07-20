import { describe, expect, it, vi } from 'vitest';

import { LibraryInsertService } from './LibraryInsertService';
import type { LibraryBundle, LibraryItemManifest } from './library/library-types';

/** Recording ProjectStorageService stand-in; `existing` seeds files already on disk. */
function makeStorage(existing: Record<string, string> = {}) {
  const store: Record<string, string> = { ...existing };
  const textWrites: Record<string, string> = {};
  const binaryWrites: Record<string, number> = {};
  return {
    store,
    textWrites,
    binaryWrites,
    createDirectory: vi.fn(async () => {}),
    getFileHandle: vi.fn(async (path: string) => (path in store ? ({} as object) : null)),
    async readBlob(path: string): Promise<Blob> {
      if (path in store) {
        return new Blob([store[path]], { type: 'text/plain' });
      }
      throw new Error(`not found: ${path}`);
    },
    writeTextFile: vi.fn(async (path: string, content: string) => {
      textWrites[path] = content;
      store[path] = content;
    }),
    writeBinaryFile: vi.fn(async (path: string, buffer: ArrayBuffer) => {
      binaryWrites[path] = buffer.byteLength;
    }),
  };
}

function makeBundle(
  overrides: Partial<LibraryItemManifest>,
  files: Record<string, string | Blob>
): LibraryBundle {
  const map = new Map<string, Blob>();
  for (const [key, value] of Object.entries(files)) {
    map.set(key, value instanceof Blob ? value : new Blob([value], { type: 'text/plain' }));
  }
  const manifest: LibraryItemManifest = {
    id: 'item-1',
    slug: 'enemy',
    name: 'Enemy',
    type: 'prefab',
    tags: [],
    files: Object.keys(files),
    source: 'packed',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
  return { manifest, files: map };
}

function makeService(bundle: LibraryBundle, existing: Record<string, string> = {}) {
  const service = new LibraryInsertService();
  const storage = makeStorage(existing);
  const order: string[] = [];
  const scriptLoader = {
    syncAndBuild: vi.fn(async () => {
      order.push('sync');
    }),
    ensureReady: vi.fn(async () => {
      order.push('ready');
    }),
  };
  const commands = {
    execute: vi.fn(async () => {
      order.push('exec');
      return true;
    }),
  };
  Object.defineProperty(service, 'library', { value: { getItemBundle: async () => bundle } });
  Object.defineProperty(service, 'storage', { value: storage });
  Object.defineProperty(service, 'commands', { value: commands });
  Object.defineProperty(service, 'scriptLoader', { value: scriptLoader });
  return { service, storage, commands, scriptLoader, order };
}

const ENEMY_SCENE = 'root:\n  - type: Sprite2D\n    texture: res://assets/sprites/e.png\n';
const ENEMY_SCRIPT = "export class Enemy extends Script {\n  a() { return 'res://assets/sfx/x.mp3'; }\n}\n";

describe('LibraryInsertService — bucket partition', () => {
  it('namespaces scene files (remapped) and restores original-path scripts verbatim', async () => {
    const bundle = makeBundle(
      { entry: 'prefabs/enemy.pix3scene', originalPathFiles: ['scripts/Enemy.ts'] },
      {
        'prefabs/enemy.pix3scene': ENEMY_SCENE,
        'assets/sprites/e.png': new Blob([new Uint8Array([1, 2, 3])]),
        'scripts/Enemy.ts': ENEMY_SCRIPT,
      }
    );
    const { service, storage } = makeService(bundle);

    const inserted = await service.copyBundleIntoProject('item-1');

    // Scene entry lands under the library folder with its sprite ref remapped there.
    expect(storage.textWrites['assets/library/enemy/prefabs/enemy.pix3scene']).toContain(
      'res://assets/library/enemy/assets/sprites/e.png'
    );
    expect(storage.binaryWrites['assets/library/enemy/assets/sprites/e.png']).toBe(3);

    // Script restored verbatim to its original path — content unchanged (no remap).
    expect(storage.textWrites['scripts/Enemy.ts']).toBe(ENEMY_SCRIPT);
    expect(storage.textWrites['assets/library/enemy/scripts/Enemy.ts']).toBeUndefined();

    expect(inserted!.resourcePaths).toContain('res://assets/library/enemy/prefabs/enemy.pix3scene');
    expect(inserted!.resourcePaths).toContain('res://scripts/Enemy.ts');
    expect(inserted!.warnings).toEqual([]);
  });
});

describe('LibraryInsertService — original-path conflict policy', () => {
  const bundleWith = () =>
    makeBundle(
      { entry: 'prefabs/enemy.pix3scene', originalPathFiles: ['scripts/Enemy.ts'] },
      { 'prefabs/enemy.pix3scene': ENEMY_SCENE, 'scripts/Enemy.ts': ENEMY_SCRIPT }
    );

  it('skips an identical existing file with no warning', async () => {
    const { service, storage } = makeService(bundleWith(), { 'scripts/Enemy.ts': ENEMY_SCRIPT });
    const inserted = await service.copyBundleIntoProject('item-1');
    expect(storage.writeTextFile).not.toHaveBeenCalledWith('scripts/Enemy.ts', expect.anything());
    expect(inserted!.warnings).toEqual([]);
  });

  it('keeps a differing existing file and reports a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { service, storage } = makeService(bundleWith(), {
      'scripts/Enemy.ts': 'export class Enemy extends Script { /* local edit */ }',
    });
    const inserted = await service.copyBundleIntoProject('item-1');
    expect(storage.writeTextFile).not.toHaveBeenCalledWith('scripts/Enemy.ts', expect.anything());
    expect(inserted!.warnings).toHaveLength(1);
    expect(inserted!.warnings[0]).toContain('scripts/Enemy.ts');
    warn.mockRestore();
  });
});

describe('LibraryInsertService — script rebuild ordering', () => {
  it('rebuilds scripts before dispatching the scene command', async () => {
    const bundle = makeBundle(
      { entry: 'prefabs/enemy.pix3scene', originalPathFiles: ['scripts/Enemy.ts'] },
      { 'prefabs/enemy.pix3scene': ENEMY_SCENE, 'scripts/Enemy.ts': ENEMY_SCRIPT }
    );
    const { service, order, scriptLoader, commands } = makeService(bundle);

    await service.insert('item-1');

    expect(scriptLoader.syncAndBuild).toHaveBeenCalledWith({ force: true });
    expect(scriptLoader.ensureReady).toHaveBeenCalled();
    expect(commands.execute).toHaveBeenCalled();
    expect(order).toEqual(['sync', 'ready', 'exec']);
  });

  it('does not rebuild scripts when the bundle carries none', async () => {
    const bundle = makeBundle(
      { entry: 'prefabs/plain.pix3scene' },
      { 'prefabs/plain.pix3scene': ENEMY_SCENE }
    );
    const { service, scriptLoader } = makeService(bundle);
    await service.insert('item-1');
    expect(scriptLoader.syncAndBuild).not.toHaveBeenCalled();
  });
});

describe('LibraryInsertService — legacy manifests', () => {
  it('keeps today behavior: everything namespaced, preview skipped, no warnings', async () => {
    const bundle = makeBundle(
      { entry: 'prefab.pix3scene', preview: 'preview.webp' },
      {
        'prefab.pix3scene': 'root:\n  - type: Node2D\n',
        'preview.webp': new Blob([new Uint8Array([7, 7])]),
      }
    );
    const { service, storage, scriptLoader } = makeService(bundle);

    const inserted = await service.copyBundleIntoProject('item-1');

    expect(storage.textWrites['assets/library/enemy/prefab.pix3scene']).toBeDefined();
    // Preview is library chrome — never copied into the project.
    expect(storage.binaryWrites['assets/library/enemy/preview.webp']).toBeUndefined();
    expect(inserted!.resourcePaths).not.toContain('res://assets/library/enemy/preview.webp');
    expect(inserted!.warnings).toEqual([]);
    expect(scriptLoader.syncAndBuild).not.toHaveBeenCalled();
  });
});
