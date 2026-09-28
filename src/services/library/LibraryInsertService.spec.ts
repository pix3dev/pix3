import { describe, expect, it, vi } from 'vitest';

import { LibraryInsertService } from '@/services/library/LibraryInsertService';
import type { LibraryBundle, LibraryItemManifest } from '@/services/library/library-types';

/**
 * Recording ProjectStorageService stand-in; `existing` seeds files already on disk. `hashed`
 * emulates a backend with a hashed manifest (`pix3 serve`/cloud); otherwise it behaves like local
 * FSA (`getContentHashIndex` → null).
 */
function makeStorage(existing: Record<string, string | Uint8Array> = {}, hashed = false) {
  const store: Record<string, string | Uint8Array> = { ...existing };
  const textWrites: Record<string, string> = {};
  const binaryWrites: Record<string, number> = {};
  /** Every write in call order — for write-ordering assertions. */
  const writeOrder: string[] = [];
  let batchDepth = 0;
  const writesOutsideBatch: string[] = [];
  const record = (path: string) => {
    writeOrder.push(path);
    if (batchDepth === 0) {
      writesOutsideBatch.push(path);
    }
  };
  return {
    store,
    textWrites,
    binaryWrites,
    writeOrder,
    writesOutsideBatch,
    createDirectory: vi.fn(async () => {}),
    getFileHandle: vi.fn(async (path: string) => (path in store ? ({} as object) : null)),
    async readBlob(path: string): Promise<Blob> {
      if (path in store) {
        return new Blob([store[path] as BlobPart], { type: 'text/plain' });
      }
      throw new Error(`not found: ${path}`);
    },
    writeTextFile: vi.fn(async (path: string, content: string) => {
      record(path);
      textWrites[path] = content;
      store[path] = content;
    }),
    writeBinaryFile: vi.fn(async (path: string, buffer: ArrayBuffer) => {
      record(path);
      binaryWrites[path] = buffer.byteLength;
      store[path] = new Uint8Array(buffer);
    }),
    getContentHashIndex: vi.fn(async () => {
      if (!hashed) {
        return null;
      }
      const index = new Map<string, string[]>();
      for (const [path, content] of Object.entries(existing).sort(([a], [b]) =>
        a.localeCompare(b)
      )) {
        const hash = await hashOf(content);
        index.set(hash, [...(index.get(hash) ?? []), path]);
      }
      return index;
    }),
    batchMutations: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => {
      batchDepth += 1;
      try {
        return await fn();
      } finally {
        batchDepth -= 1;
      }
    }),
  };
}

async function hashOf(content: string | Uint8Array): Promise<string> {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
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

function makeService(
  bundle: LibraryBundle,
  existing: Record<string, string | Uint8Array> = {},
  hashed = false
) {
  const service = new LibraryInsertService();
  const storage = makeStorage(existing, hashed);
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
const ENEMY_SCRIPT =
  "export class Enemy extends Script {\n  a() { return 'res://assets/sfx/x.mp3'; }\n}\n";

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

/** A Seven-shaped character: synthetic entry → prefab → flipbook → frames (bundle layout). */
const FRAME_A = new Uint8Array([1, 1, 1]);
const FRAME_B = new Uint8Array([2, 2, 2, 2]);
const ANIM = [
  'clips:',
  '  - frames:',
  '      - texturePath: res://sprites/goblin/a_0001.png',
  '      - texturePath: res://sprites/goblin/a_0002.png',
].join('\n');
const PREFAB =
  'root:\n  - type: AnimatedSprite2D\n    animationResourcePath: res://sprites/goblin/goblin.pix3anim\n';
const ENTRY = 'root:\n  - id: goblin-1\n    instance: res://prefabs/Goblin.pix3scene\n';

function characterBundle(): LibraryBundle {
  return makeBundle(
    { slug: 'goblin', name: 'Goblin', entry: 'prefab.pix3scene', preview: 'preview.webp' },
    {
      'prefab.pix3scene': ENTRY,
      'prefabs/Goblin.pix3scene': PREFAB,
      'sprites/goblin/goblin.pix3anim': ANIM,
      'sprites/goblin/a_0001.png': new Blob([FRAME_A]),
      'sprites/goblin/a_0002.png': new Blob([FRAME_B]),
      'preview.webp': new Blob([new Uint8Array([9])]),
    }
  );
}

describe('LibraryInsertService — write order', () => {
  it('writes frames, then the flipbook, then the prefab, the entry last — all in one batch', async () => {
    const { service, storage } = makeService(characterBundle());

    await service.copyBundleIntoProject('item-1');

    const at = (path: string) => storage.writeOrder.indexOf(`assets/library/goblin/${path}`);
    expect(storage.writeOrder).toHaveLength(5);
    expect(at('sprites/goblin/a_0001.png')).toBeLessThan(at('sprites/goblin/goblin.pix3anim'));
    expect(at('sprites/goblin/a_0002.png')).toBeLessThan(at('sprites/goblin/goblin.pix3anim'));
    expect(at('sprites/goblin/goblin.pix3anim')).toBeLessThan(at('prefabs/Goblin.pix3scene'));
    expect(at('prefab.pix3scene')).toBe(4);
    expect(storage.writesOutsideBatch).toEqual([]);
    // Each directory is created once, not once per file.
    const dirs = storage.createDirectory.mock.calls.map(call => (call as unknown[])[0]);
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it('copies a reference cycle into the target folder instead of stalling', async () => {
    const bundle = makeBundle(
      { entry: 'a.pix3scene' },
      {
        'a.pix3scene': 'instance: res://b.pix3scene\n',
        'b.pix3scene': 'instance: res://a.pix3scene\n',
      }
    );
    const { service, storage } = makeService(bundle);
    const inserted = await service.copyBundleIntoProject('item-1');
    expect(storage.textWrites['assets/library/enemy/a.pix3scene']).toBe(
      'instance: res://assets/library/enemy/b.pix3scene\n'
    );
    expect(storage.textWrites['assets/library/enemy/b.pix3scene']).toBe(
      'instance: res://assets/library/enemy/a.pix3scene\n'
    );
    expect(inserted!.entryResourcePath).toBe('res://assets/library/enemy/a.pix3scene');
  });
});

describe('LibraryInsertService — content dedup', () => {
  const sourceProject = {
    'prefabs/Goblin.pix3scene': PREFAB,
    'sprites/goblin/goblin.pix3anim': ANIM,
    'sprites/goblin/a_0001.png': FRAME_A,
    'sprites/goblin/a_0002.png': FRAME_B,
  };

  it('back into its source project: reuses everything, writes only the synthetic entry', async () => {
    const { service, storage } = makeService(characterBundle(), sourceProject, true);

    const inserted = await service.copyBundleIntoProject('item-1');

    expect(storage.writeOrder).toEqual(['assets/library/goblin/prefab.pix3scene']);
    expect(storage.textWrites['assets/library/goblin/prefab.pix3scene']).toContain(
      'instance: res://prefabs/Goblin.pix3scene'
    );
    expect(inserted!.resourcePaths).toContain('res://sprites/goblin/a_0001.png');
    expect(inserted!.resourcePaths).toContain('res://prefabs/Goblin.pix3scene');
  });

  it('matches by hash wherever the file lives, remapping referrers to the existing path', async () => {
    const { service, storage } = makeService(
      characterBundle(),
      { 'art/other/place/frame.png': FRAME_A },
      true
    );

    await service.copyBundleIntoProject('item-1');

    expect(storage.binaryWrites['assets/library/goblin/sprites/goblin/a_0001.png']).toBeUndefined();
    expect(storage.binaryWrites['assets/library/goblin/sprites/goblin/a_0002.png']).toBe(4);
    const anim = storage.textWrites['assets/library/goblin/sprites/goblin/goblin.pix3anim'];
    expect(anim).toContain('res://art/other/place/frame.png');
    expect(anim).toContain('res://assets/library/goblin/sprites/goblin/a_0002.png');
  });

  it('keeps a file on its own path when other files share its content', async () => {
    // A looping flipbook repeats frames: a_0002 has a byte-identical twin that sorts first.
    const { service, storage } = makeService(
      characterBundle(),
      { ...sourceProject, 'sprites/goblin/a_0000.png': FRAME_B },
      true
    );
    await service.copyBundleIntoProject('item-1');
    // Nothing remapped, so the flipbook and prefab still match the project's and are reused.
    expect(storage.writeOrder).toEqual(['assets/library/goblin/prefab.pix3scene']);
  });

  it('local backend (no hashed manifest): reuses identical files at their original paths', async () => {
    const { service, storage } = makeService(characterBundle(), sourceProject, false);
    await service.copyBundleIntoProject('item-1');
    expect(storage.writeOrder).toEqual(['assets/library/goblin/prefab.pix3scene']);
  });

  it('copies a same-path file whose content differs', async () => {
    const { service, storage } = makeService(
      characterBundle(),
      { ...sourceProject, 'sprites/goblin/a_0002.png': new Uint8Array([7, 7, 7, 7]) },
      false
    );
    await service.copyBundleIntoProject('item-1');
    expect(storage.binaryWrites['assets/library/goblin/sprites/goblin/a_0002.png']).toBe(4);
    // The flipbook now differs from the project's (one frame moved), so it is copied too.
    expect(storage.textWrites['assets/library/goblin/sprites/goblin/goblin.pix3anim']).toContain(
      'res://sprites/goblin/a_0001.png'
    );
  });
});
