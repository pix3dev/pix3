import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TextureAtlasService } from '@/services/atlas/TextureAtlasService';

interface FakeEntry {
  text: string;
  sha?: string;
}

/** Minimal ProjectStorageService stand-in: a flat file map plus an optional manifest hash. */
function createFakeFs(files: Record<string, FakeEntry>) {
  const reads: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fs = {
    async listDirectory(directory: string) {
      const prefix = directory === '.' ? '' : `${directory}/`;
      const children = new Map<
        string,
        { name: string; kind: 'file' | 'directory'; path: string }
      >();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const [head, ...rest] = path.slice(prefix.length).split('/');
        const childPath = `${prefix}${head}`;
        children.set(childPath, {
          name: head,
          kind: rest.length > 0 ? 'directory' : 'file',
          path: childPath,
        });
      }
      return [...children.values()];
    },
    async readTextFile(path: string) {
      reads.push(path);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight--;
      const entry = files[path];
      if (!entry) throw new Error(`missing ${path}`);
      return entry.text;
    },
    getManifestContentHash(path: string) {
      return files[path]?.sha;
    },
  };
  return { fs, reads, maxInFlight: () => maxInFlight };
}

function createService(fs: unknown): TextureAtlasService {
  const service = new TextureAtlasService();
  Object.defineProperty(service, 'fs', { value: fs });
  return service;
}

type Scan = { include: string[]; excluded: string[] };
const scan = (service: TextureAtlasService): Promise<Scan> =>
  (service as unknown as { scanAndClassify(): Promise<Scan> }).scanAndClassify();

const SCENE = `root:
  - id: a
    type: Sprite2D
    properties:
      texture: res://assets/ui/a.png
  - id: b
    type: Sprite3D
    properties:
      texture: res://assets/ui/b.png
`;

describe('TextureAtlasService scan', () => {
  it('classifies scenes and scripts with parallel reads', async () => {
    const files: Record<string, FakeEntry> = {
      'scenes/main.pix3scene': { text: SCENE },
      'assets/ui/a.png': { text: '' },
      'assets/ui/b.png': { text: '' },
      'assets/fx/enemy/air/1.png': { text: '' },
      'assets/fx/enemy/air/2.png': { text: '' },
    };
    for (let i = 0; i < 20; i++) {
      files[`src/scripts/S${i}.ts`] = { text: `const DIR = 'res://assets/fx/enemy/air';` };
    }
    files['src/scripts/Skip.spec.ts'] = { text: `'res://assets/ui/b.png'` };
    const fake = createFakeFs(files);

    const result = await scan(createService(fake.fs));

    expect(result.include).toEqual([
      'res://assets/fx/enemy/air/1.png',
      'res://assets/fx/enemy/air/2.png',
      'res://assets/ui/a.png',
    ]);
    expect(fake.reads).not.toContain('src/scripts/Skip.spec.ts');
    expect(fake.maxInFlight()).toBeGreaterThan(1);
  });

  it('skips re-reading files whose manifest hash is unchanged', async () => {
    const files: Record<string, FakeEntry> = {
      'scenes/main.pix3scene': { text: SCENE, sha: 'h1' },
      'src/scripts/Game.ts': { text: `'res://assets/ui/c.png'`, sha: 'h2' },
      'src/scripts/NoHash.ts': { text: `'res://assets/ui/d.png'` },
    };
    const fake = createFakeFs(files);
    const service = createService(fake.fs);

    const first = await scan(service);
    fake.reads.length = 0;
    const second = await scan(service);

    expect(second).toEqual(first);
    expect(fake.reads).toEqual(['src/scripts/NoHash.ts']);

    files['src/scripts/Game.ts'] = { text: `'res://assets/ui/e.png'`, sha: 'h3' };
    fake.reads.length = 0;
    const third = await scan(service);
    expect(fake.reads.sort()).toEqual(['src/scripts/Game.ts', 'src/scripts/NoHash.ts']);
    expect(third.include).toContain('res://assets/ui/e.png');
    expect(third.include).not.toContain('res://assets/ui/c.png');
  });
});
