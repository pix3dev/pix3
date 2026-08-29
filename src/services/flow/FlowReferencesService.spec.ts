import { beforeEach, describe, expect, it } from 'vitest';

import type { FileDescriptor } from '@/services/project/FileSystemAPIService';
import {
  FLOW_REFERENCES_INDEX_PATH,
  FlowReferencesService,
  classifyReferenceKind,
  firstMeaningfulLine,
  parseReferencesIndex,
  uniqueFileName,
} from './FlowReferencesService';

/**
 * A whole-project storage double: a flat path→content map, with directory listings derived from it
 * the way a real file system does. Deriving rather than declaring the listings is the point — the
 * service walks `references/**` recursively, and a hand-written listing would agree with whatever
 * the walk happened to do.
 */
class StorageStub {
  readonly texts = new Map<string, string>();
  readonly blobs = new Map<string, Blob>();
  readonly modified = new Map<string, number>();
  readonly created: string[] = [];

  async listDirectory(path: string): Promise<FileDescriptor[]> {
    const prefix = path === '.' ? '' : `${path}/`;
    const known = [...this.texts.keys(), ...this.blobs.keys()];
    if (path !== '.' && !known.some(file => file.startsWith(prefix))) {
      throw new Error(`missing directory ${path}`);
    }
    const entries = new Map<string, FileDescriptor>();
    for (const file of known) {
      if (!file.startsWith(prefix)) {
        continue;
      }
      const [head, ...rest] = file.slice(prefix.length).split('/');
      const childPath = `${prefix}${head}`;
      entries.set(childPath, {
        name: head,
        kind: rest.length > 0 ? 'directory' : 'file',
        path: childPath,
        size: rest.length > 0 ? null : this.sizeOf(file),
      });
    }
    return [...entries.values()];
  }

  async readTextFile(path: string): Promise<string> {
    const value = this.texts.get(path);
    if (value === undefined) {
      throw new Error(`missing ${path}`);
    }
    return value;
  }

  async readBlob(path: string): Promise<Blob> {
    const blob = this.blobs.get(path);
    if (!blob) {
      throw new Error(`missing ${path}`);
    }
    return blob;
  }

  async writeTextFile(path: string, contents: string): Promise<void> {
    this.texts.set(path, contents);
  }

  async writeBinaryFile(path: string, data: ArrayBuffer): Promise<void> {
    this.blobs.set(path, new Blob([data]));
  }

  async deleteEntry(path: string): Promise<void> {
    this.texts.delete(path);
    this.blobs.delete(path);
  }

  async createDirectory(path: string): Promise<void> {
    this.created.push(path);
  }

  async getLastModified(path: string): Promise<number | null> {
    return this.modified.get(path) ?? null;
  }

  private sizeOf(path: string): number {
    const text = this.texts.get(path);
    return text !== undefined ? text.length : (this.blobs.get(path)?.size ?? 0);
  }
}

const buildService = (storage: StorageStub): FlowReferencesService => {
  const service = new FlowReferencesService();
  Object.defineProperty(service, 'storage', { value: storage, configurable: true });
  return service;
};

let storage: StorageStub;
let service: FlowReferencesService;

beforeEach(() => {
  storage = new StorageStub();
  service = buildService(storage);
});

describe('classifyReferenceKind', () => {
  it('sorts a file by extension, and everything unknown into `other`', () => {
    expect(classifyReferenceKind('mood-1.PNG')).toBe('image');
    expect(classifyReferenceKind('sketch.webp')).toBe('image');
    expect(classifyReferenceKind('notes.md')).toBe('markdown');
    expect(classifyReferenceKind('balance.csv')).toBe('text');
    expect(classifyReferenceKind('level.yaml')).toBe('text');
    expect(classifyReferenceKind('pitch.pdf')).toBe('other');
    expect(classifyReferenceKind('pack.zip')).toBe('other');
    expect(classifyReferenceKind('hero.glb')).toBe('other');
    expect(classifyReferenceKind('README')).toBe('other');
  });
});

describe('uniqueFileName', () => {
  it('suffixes before the extension rather than overwriting', () => {
    const taken = new Set(['hero.png', 'hero-2.png']);
    expect(uniqueFileName('other.png', taken)).toBe('other.png');
    expect(uniqueFileName('hero.png', taken)).toBe('hero-3.png');
    expect(uniqueFileName('LICENSE', new Set(['LICENSE']))).toBe('LICENSE-2');
  });
});

describe('parseReferencesIndex', () => {
  it('degrades to an empty index instead of throwing on anything malformed', () => {
    expect(parseReferencesIndex('not json')).toEqual({});
    expect(parseReferencesIndex('[]')).toEqual({});
    expect(parseReferencesIndex('null')).toEqual({});
  });

  it('keeps recognised fields and drops the rest', () => {
    const index = parseReferencesIndex(
      JSON.stringify({
        'a.png': { role: 'style-candidate', origin: 'agent', caption: 'flat vector', prompt: 'p' },
        'b.png': { role: 'nonsense', origin: 'someone-else', extra: 1 },
        'c.png': 'not an object',
      })
    );

    expect(index['a.png']).toEqual({
      role: 'style-candidate',
      origin: 'agent',
      caption: 'flat vector',
      prompt: 'p',
    });
    expect(index['b.png']).toEqual({});
    expect(index['c.png']).toBeUndefined();
  });
});

describe('firstMeaningfulLine', () => {
  it('skips blanks and strips markdown markers', () => {
    expect(firstMeaningfulLine('\n\n# Ant Wars\n\nbody')).toBe('Ant Wars');
    expect(firstMeaningfulLine('> a quote')).toBe('a quote');
    expect(firstMeaningfulLine('   \n')).toBeNull();
  });
});

describe('FlowReferencesService.list', () => {
  it('pins the document, lists references recursively and marks sources read-only', async () => {
    storage.texts.set('design/gdd.md', '# Ant Wars\n\n**Pitch:** dig tunnels\n');
    storage.texts.set('design/source/brief-from-user.md', '# Notes\n\nthe boss is a robot\n');
    storage.blobs.set('references/mood-1.png', new Blob(['aaa']));
    storage.blobs.set('references/nested/sketch.jpg', new Blob(['bb']));
    storage.texts.set('references/balance.csv', 'wave,count\n1,4\n');
    storage.texts.set(
      FLOW_REFERENCES_INDEX_PATH,
      JSON.stringify({
        'mood-1.png': { role: 'style-candidate', origin: 'agent', caption: 'flat' },
      })
    );

    const list = await service.list();

    expect(list.document).toMatchObject({
      path: 'design/gdd.md',
      pinned: true,
      missing: false,
      kind: 'markdown',
      previewLine: 'Ant Wars',
    });
    // The index describes the folder; it is metadata, not one of the artefacts in it.
    expect(list.references.map(item => item.path).sort()).toEqual([
      'references/balance.csv',
      'references/mood-1.png',
      'references/nested/sketch.jpg',
    ]);
    expect(list.references.find(item => item.name === 'mood-1.png')).toMatchObject({
      kind: 'image',
      origin: 'agent',
      role: 'style-candidate',
      caption: 'flat',
    });
    // No index entry: the file is still a normal file, with a guessed role and a user origin.
    expect(list.references.find(item => item.name === 'sketch.jpg')).toMatchObject({
      origin: 'user',
      role: 'style',
    });
    // Roles belong to pictures — a csv gets no chip.
    expect(list.references.find(item => item.name === 'balance.csv')?.role).toBeNull();
    expect(list.sources).toHaveLength(1);
    expect(list.sources[0]).toMatchObject({
      path: 'design/source/brief-from-user.md',
      readOnly: true,
      previewLine: 'Notes',
    });
  });

  it('lists the rest of design/ beside the gdd, by name, without a delete affordance', async () => {
    storage.texts.set('design/gdd.md', '# Ant Wars\n');
    storage.texts.set('design/plan.md', '# Plan\n\n1. Scene and camera\n');
    storage.texts.set('design/decisions.md', '# Decisions\n');
    // The Sources group owns this subtree — it must not also show up as a design document.
    storage.texts.set('design/source/brief-from-user.md', '# Notes\n');

    const list = await service.list();

    expect(list.design.map(item => item.path)).toEqual(['design/decisions.md', 'design/plan.md']);
    expect(list.design[1]).toMatchObject({
      name: 'plan.md',
      group: 'design',
      origin: 'agent',
      kind: 'markdown',
      previewLine: 'Plan',
      // The agent's own working memory: shown, opened, but never deleted from this column. Not
      // pinned — the highlight belongs to the gdd anchor alone.
      pinned: false,
      readOnly: true,
    });
  });

  it('still lists the document when the file does not exist yet', async () => {
    const list = await service.list();

    expect(list.document).toMatchObject({ path: 'design/gdd.md', pinned: true, missing: true });
    expect(list.design).toEqual([]);
    expect(list.references).toEqual([]);
    expect(list.sources).toEqual([]);
  });

  it('sorts each group newest first, with unknown timestamps last', async () => {
    storage.blobs.set('references/old.png', new Blob(['a']));
    storage.blobs.set('references/new.png', new Blob(['a']));
    storage.blobs.set('references/undated.png', new Blob(['a']));
    storage.modified.set('references/old.png', 1000);
    storage.modified.set('references/new.png', 5000);

    const list = await service.list();

    expect(list.references.map(item => item.name)).toEqual(['new.png', 'old.png', 'undated.png']);
  });

  it('survives a malformed index rather than showing an empty column', async () => {
    storage.blobs.set('references/mood-1.png', new Blob(['a']));
    storage.texts.set(FLOW_REFERENCES_INDEX_PATH, '{ this is not json');

    const list = await service.list();

    expect(list.references).toHaveLength(1);
    expect(list.references[0]).toMatchObject({ origin: 'user' });
  });
});

describe('FlowReferencesService.addFiles', () => {
  it('writes any file type into references/ and records the user as its origin', async () => {
    const result = await service.addFiles([
      new File(['pdf bytes'], 'Pitch Deck.pdf', { type: 'application/pdf' }),
      new File(['png bytes'], 'hero.png', { type: 'image/png' }),
    ]);

    expect(result.added).toEqual(['references/Pitch-Deck.pdf', 'references/hero.png']);
    expect(storage.blobs.has('references/Pitch-Deck.pdf')).toBe(true);
    // The parent directory is created first: writeTextFile does NOT create it, and the index write
    // used to fail silently because of exactly that.
    expect(storage.created).toContain('references');

    const index = await service.readIndex();
    expect(index['Pitch-Deck.pdf']).toEqual({ origin: 'user' });
    // A picture gets the same guessed role prompt intake would give it.
    expect(index['hero.png']).toEqual({ origin: 'user', role: 'content' });
  });

  it('suffixes a name collision instead of overwriting', async () => {
    storage.blobs.set('references/hero.png', new Blob(['original']));

    const result = await service.addFiles([
      new File(['second'], 'hero.png', { type: 'image/png' }),
    ]);

    expect(result.added).toEqual(['references/hero-2.png']);
    expect(await (await storage.readBlob('references/hero.png')).text()).toBe('original');
  });
});

describe('FlowReferencesService index writes', () => {
  it('merges rather than rebuilds, so keys written elsewhere survive', async () => {
    storage.texts.set(
      FLOW_REFERENCES_INDEX_PATH,
      JSON.stringify({
        'a.png': { origin: 'user', role: 'style' },
        'b.png': { origin: 'agent', caption: 'painterly' },
      })
    );

    await service.setRole('a.png', 'layout');

    const index = await service.readIndex();
    expect(index['a.png']).toEqual({ origin: 'user', role: 'layout' });
    expect(index['b.png']).toEqual({ origin: 'agent', caption: 'painterly' });
  });

  it('removes one entry and leaves the others alone', async () => {
    storage.texts.set(
      FLOW_REFERENCES_INDEX_PATH,
      JSON.stringify({ 'a.png': { origin: 'user' }, 'b.png': { origin: 'agent' } })
    );

    await service.removeEntry('a.png');
    // A key that is not there is not an error: the panel deletes files that never had an entry.
    await service.removeEntry('missing.png');

    expect(await service.readIndex()).toEqual({ 'b.png': { origin: 'agent' } });
  });
});
