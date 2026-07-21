import { describe, expect, it, vi } from 'vitest';

import { PublishToLibraryService } from './PublishToLibraryService';
import type { LibraryBundle } from './library/library-types';

/**
 * In-memory ProjectStorageService stand-in: a flat path→content map that also derives
 * `listDirectory` children so the script-class index can recurse `scripts/`.
 */
function makeStorage(files: Record<string, string | Blob>) {
  const paths = () => Object.keys(files);
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.?\//, '');
  return {
    async readBlob(path: string): Promise<Blob> {
      const file = files[norm(path)];
      if (file === undefined) {
        throw new Error(`not found: ${path}`);
      }
      return file instanceof Blob ? file : new Blob([file], { type: 'text/plain' });
    },
    async readTextFile(path: string): Promise<string> {
      const file = files[norm(path)];
      if (file === undefined) {
        throw new Error(`not found: ${path}`);
      }
      return file instanceof Blob ? await file.text() : file;
    },
    async listDirectory(dir: string) {
      const prefix = dir === '.' || dir === '' ? '' : `${dir.replace(/\/$/, '')}/`;
      const children = new Map<
        string,
        { name: string; kind: 'file' | 'directory'; path: string }
      >();
      for (const p of paths()) {
        if (prefix && !p.startsWith(prefix)) {
          continue;
        }
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          children.set(rest, { name: rest, kind: 'file', path: `${prefix}${rest}` });
        } else {
          const name = rest.slice(0, slash);
          children.set(name, { name, kind: 'directory', path: `${prefix}${name}` });
        }
      }
      return [...children.values()];
    },
  };
}

/** Build a service wired to the given storage; returns the captured `putUserItem` bundle. */
function makeService(files: Record<string, string | Blob>) {
  const service = new PublishToLibraryService();
  let captured: LibraryBundle | null = null;
  const library = {
    suggestSlug: vi.fn(async (name: string) => name.toLowerCase()),
    putUserItem: vi.fn(async (bundle: LibraryBundle) => {
      captured = bundle;
      return { scope: 'user' as const, manifest: bundle.manifest };
    }),
  };
  Object.defineProperty(service, 'storage', { value: makeStorage(files) });
  Object.defineProperty(service, 'library', { value: library });
  // No WebGL in happy-dom → force the graceful no-preview path.
  Object.defineProperty(service, 'thumbnails', {
    value: { generate: vi.fn(async () => Promise.reject(new Error('no webgl'))) },
  });
  return { service, getBundle: () => captured };
}

const ENEMY_SCENE = [
  'version: 1.0.0',
  'root:',
  '  - type: Sprite2D',
  '    properties:',
  '      texture: res://assets/sprites/e.png',
  '    components:',
  '      - type: user:Enemy',
  '      - type: core:Juice',
].join('\n');

describe('PublishToLibraryService.publishAssetPath — script + code-asset packing', () => {
  it('bundles user: scripts, their imports, and code-referenced assets as original-path files', async () => {
    const { service, getBundle } = makeService({
      'prefabs/enemy.pix3scene': ENEMY_SCENE,
      'assets/sprites/e.png': new Blob([new Uint8Array([1, 2, 3])]),
      'scripts/Enemy.ts': [
        "import { Helper } from './lib/helper';",
        'export class Enemy extends Script {',
        "  fire() { this.scene.audio.play('res://assets/sfx/shoot.mp3'); }",
        '}',
      ].join('\n'),
      'scripts/lib/helper.ts': 'export class Helper {}',
      'assets/sfx/shoot.mp3': new Blob([new Uint8Array([9, 9])]),
    });

    await service.publishAssetPath('res://prefabs/enemy.pix3scene');
    const bundle = getBundle();
    expect(bundle).not.toBeNull();

    const fileKeys = [...bundle!.files.keys()].sort();
    expect(fileKeys).toEqual([
      'assets/sfx/shoot.mp3',
      'assets/sprites/e.png',
      'prefabs/enemy.pix3scene',
      'scripts/Enemy.ts',
      'scripts/lib/helper.ts',
    ]);

    expect(bundle!.manifest.originalPathFiles).toEqual([
      'assets/sfx/shoot.mp3',
      'scripts/Enemy.ts',
      'scripts/lib/helper.ts',
    ]);
    // The scene-level sprite stays namespaced (not original-path).
    expect(bundle!.manifest.originalPathFiles).not.toContain('assets/sprites/e.png');
  });

  it('publishes anyway (no throw) and warns when a user: class is not found', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { service, getBundle } = makeService({
      'prefabs/ghost.pix3scene': [
        'version: 1.0.0',
        'root:',
        '  - type: Node2D',
        '    components:',
        '      - type: user:Ghost',
      ].join('\n'),
    });

    const item = await service.publishAssetPath('res://prefabs/ghost.pix3scene');
    expect(item).not.toBeNull();
    expect(getBundle()!.manifest.originalPathFiles).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('user:Ghost'));
    warn.mockRestore();
  });

  it('lists a file referenced from both scene and script once, in the original bucket', async () => {
    const { service, getBundle } = makeService({
      'prefabs/shared.pix3scene': [
        'version: 1.0.0',
        'root:',
        '  - type: Sprite2D',
        '    properties:',
        '      texture: res://assets/shared.png',
        '    components:',
        '      - type: user:Uses',
      ].join('\n'),
      'assets/shared.png': new Blob([new Uint8Array([4])]),
      'scripts/Uses.ts': [
        'export class Uses extends Script {',
        "  load() { return 'res://assets/shared.png'; }",
        '}',
      ].join('\n'),
    });

    await service.publishAssetPath('res://prefabs/shared.pix3scene');
    const bundle = getBundle()!;
    const sharedCount = [...bundle.files.keys()].filter(k => k === 'assets/shared.png').length;
    expect(sharedCount).toBe(1);
    expect(bundle.manifest.originalPathFiles).toContain('assets/shared.png');
  });

  it('terminates on an import cycle between two scripts and bundles both', async () => {
    const { service, getBundle } = makeService({
      'prefabs/cycle.pix3scene': [
        'version: 1.0.0',
        'root:',
        '  - type: Node2D',
        '    components:',
        '      - type: user:A',
      ].join('\n'),
      'scripts/A.ts': ["import { B } from './B';", 'export class A extends Script {}'].join('\n'),
      'scripts/B.ts': ["import { A } from './A';", 'export class B extends Script {}'].join('\n'),
    });

    await service.publishAssetPath('res://prefabs/cycle.pix3scene');
    const bundle = getBundle()!;
    expect([...bundle.files.keys()].sort()).toEqual([
      'prefabs/cycle.pix3scene',
      'scripts/A.ts',
      'scripts/B.ts',
    ]);
    expect(bundle.manifest.originalPathFiles).toEqual(['scripts/A.ts', 'scripts/B.ts']);
  });
});
