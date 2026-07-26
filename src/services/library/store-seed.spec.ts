import { describe, expect, it, vi } from 'vitest';

import {
  STORE_SEED_CATEGORY_ID,
  normalizeStoreLicense,
  seedStoreFromBuiltinPack,
  type StoreSeedDeps,
  type StoreSeedPriorItem,
} from '@/services/library/store-seed';
import type {
  LibraryBundle,
  LibraryItem,
  LibraryItemManifest,
} from '@/services/library/library-types';

/** A pack manifest that clears the publish gate once its license is normalized. */
function packManifest(id: string, overrides: Partial<LibraryItemManifest> = {}) {
  return {
    id,
    slug: id,
    name: id,
    type: 'image' as const,
    tags: ['ui'],
    description: 'A bundled item.',
    preview: 'preview.png',
    files: ['preview.png'],
    source: 'packed' as const,
    license: 'CC0',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

interface Harness {
  deps: StoreSeedDeps;
  uploaded: LibraryBundle[];
  categories: Array<{ id: string; label: string }>;
}

function createHarness(
  manifests: LibraryItemManifest[],
  options: {
    prior?: StoreSeedPriorItem[];
    categoryFails?: boolean;
    failUploadFor?: string;
  } = {}
): Harness {
  const uploaded: LibraryBundle[] = [];
  const categories: Array<{ id: string; label: string }> = [];
  const packItems: LibraryItem[] = manifests.map(manifest => ({ scope: 'builtin', manifest }));

  const deps: StoreSeedDeps = {
    listPackItems: async () => packItems,
    getPackBundle: async id => {
      const manifest = manifests.find(candidate => candidate.id === id);
      return manifest ? { manifest, files: new Map([['preview.png', new Blob(['x'])]]) } : null;
    },
    listServerItems: async () => options.prior ?? [],
    ensureCategory: async input => {
      if (options.categoryFails) {
        throw new Error('403');
      }
      categories.push(input);
    },
    putStoreItem: async bundle => {
      if (bundle.manifest.id === options.failUploadFor) {
        throw new Error('upload exploded');
      }
      uploaded.push(bundle);
      return { scope: 'store', manifest: bundle.manifest };
    },
  };

  return { deps, uploaded, categories };
}

describe('normalizeStoreLicense', () => {
  it('maps bare pack ids onto their whitelisted SPDX form', () => {
    expect(normalizeStoreLicense('CC0')).toBe('CC0-1.0');
    expect(normalizeStoreLicense('CC-BY')).toBe('CC-BY-4.0');
    expect(normalizeStoreLicense('OFL')).toBe('OFL-1.1');
    expect(normalizeStoreLicense('MIT')).toBe('MIT');
  });

  it('passes through an already-normalized id and leaves unknown ones for the gate', () => {
    expect(normalizeStoreLicense('CC0-1.0')).toBe('CC0-1.0');
    expect(normalizeStoreLicense('WTFPL')).toBe('WTFPL');
    expect(normalizeStoreLicense(undefined)).toBeUndefined();
  });
});

describe('seedStoreFromBuiltinPack', () => {
  it('files fresh items under the seed category and publishes them', async () => {
    const { deps, uploaded, categories } = createHarness([packManifest('builtin-a')]);

    const result = await seedStoreFromBuiltinPack(deps);

    expect(categories).toEqual([{ id: STORE_SEED_CATEGORY_ID, label: expect.any(String) }]);
    expect(result.categoryReady).toBe(true);
    expect(result.outcomes).toEqual([
      { id: 'builtin-a', name: 'builtin-a', result: 'created', status: 'published' },
    ]);
    expect(uploaded[0]?.manifest).toMatchObject({
      license: 'CC0-1.0',
      categoryPath: STORE_SEED_CATEGORY_ID,
      status: 'published',
      version: '1.0.0',
      publisherName: 'Pix3 Team',
    });
  });

  it('keeps the curation an admin already applied to a seeded item', async () => {
    const { deps, uploaded } = createHarness([packManifest('builtin-a')], {
      prior: [{ id: 'builtin-a', status: 'unlisted', categoryPath: 'ui/panels' }],
    });

    const result = await seedStoreFromBuiltinPack(deps);

    expect(result.outcomes[0]).toMatchObject({ result: 'updated', status: 'unlisted' });
    expect(uploaded[0]?.manifest).toMatchObject({
      status: 'unlisted',
      categoryPath: 'ui/panels',
    });
  });

  it('downgrades an item that cannot pass the publish gate to a draft', async () => {
    // No description ⇒ the gate rejects publishing, and the server would 400 the whole upload.
    const { deps, uploaded } = createHarness([
      packManifest('builtin-a', { description: undefined }),
    ]);

    const result = await seedStoreFromBuiltinPack(deps);

    expect(result.outcomes[0]).toMatchObject({ result: 'created', status: 'draft' });
    expect(uploaded[0]?.manifest.status).toBe('draft');
  });

  it('uploads uncategorized drafts when the taxonomy write is refused', async () => {
    const { deps, uploaded } = createHarness([packManifest('builtin-a')], { categoryFails: true });

    const result = await seedStoreFromBuiltinPack(deps);

    expect(result.categoryReady).toBe(false);
    expect(uploaded[0]?.manifest.categoryPath).toBeUndefined();
    expect(uploaded[0]?.manifest.status).toBe('draft');
  });

  it('reports a per-item failure and still seeds the rest of the pack', async () => {
    const { deps, uploaded } = createHarness(
      [packManifest('builtin-a'), packManifest('builtin-b')],
      { failUploadFor: 'builtin-a' }
    );

    const result = await seedStoreFromBuiltinPack(deps);

    expect(result.outcomes.map(outcome => [outcome.id, outcome.result])).toEqual([
      ['builtin-a', 'failed'],
      ['builtin-b', 'created'],
    ]);
    expect(result.outcomes[0]?.error).toContain('upload exploded');
    expect(uploaded.map(bundle => bundle.manifest.id)).toEqual(['builtin-b']);
  });

  it('does nothing (and touches no taxonomy) when the pack is empty', async () => {
    const { deps, categories } = createHarness([]);
    const ensureCategory = vi.spyOn(deps, 'ensureCategory');

    const result = await seedStoreFromBuiltinPack(deps);

    expect(result).toEqual({ outcomes: [], categoryReady: false });
    expect(ensureCategory).not.toHaveBeenCalled();
    expect(categories).toEqual([]);
  });

  it('still attempts the uploads when the server index cannot be read', async () => {
    const { deps, uploaded } = createHarness([packManifest('builtin-a')]);
    vi.spyOn(deps, 'listServerItems').mockRejectedValue(new Error('offline'));

    const result = await seedStoreFromBuiltinPack(deps);

    expect(result.outcomes[0]?.result).toBe('created');
    expect(uploaded).toHaveLength(1);
  });
});
