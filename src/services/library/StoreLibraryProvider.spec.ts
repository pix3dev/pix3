import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LibraryItem, LibraryItemManifest } from '@/services/library/library-types';

const mockApiClient = {
  getStoreIndex: vi.fn(),
  getStoreItem: vi.fn(),
  uploadStoreItem: vi.fn(),
  patchStoreItemMeta: vi.fn(),
  deleteStoreItem: vi.fn(),
  pingStoreDownload: vi.fn(),
  getStoreCategories: vi.fn(),
  storeFileUrl: (itemId: string, path: string) =>
    `/api/library/store/items/${itemId}/files/${path}`,
};

vi.mock('@/services/cloud/ApiClient', () => mockApiClient);

const { StoreLibraryProvider } = await import('@/services/library/StoreLibraryProvider');
const { BuiltinLibraryProvider } = await import('@/services/library/BuiltinLibraryProvider');

function manifest(id: string, overrides: Partial<LibraryItemManifest> = {}): LibraryItemManifest {
  return {
    id,
    slug: id,
    name: id,
    type: 'image',
    tags: [],
    files: ['pic.png'],
    source: 'imported',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

/** A builtin pack stub standing in for `public/library/` (the store's offline fallback). */
function createFallback(items: LibraryItem[]) {
  const fallback = new BuiltinLibraryProvider();
  vi.spyOn(fallback, 'isSupported').mockReturnValue(true);
  vi.spyOn(fallback, 'list').mockResolvedValue(items);
  vi.spyOn(fallback, 'getBundle').mockResolvedValue(null);
  vi.spyOn(fallback, 'getPreviewUrl').mockResolvedValue(null);
  return fallback;
}

function packItem(id: string, name: string): LibraryItem {
  return { scope: 'builtin', manifest: manifest(id, { name }) };
}

function serverEntry(id: string, name: string, files = ['pic.png']) {
  return {
    id,
    manifest: { ...manifest(id, { name, files }) } as unknown as Record<string, unknown>,
    updatedAt: 2,
    status: 'published' as const,
    categoryPath: null,
    featured: false,
    downloads: 0,
    publishedAt: null,
  };
}

describe('StoreLibraryProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiClient.getStoreIndex.mockResolvedValue({ items: [] });
    mockApiClient.pingStoreDownload.mockResolvedValue({ downloads: 1 });
    mockApiClient.deleteStoreItem.mockResolvedValue({ ok: true });
    mockApiClient.uploadStoreItem.mockResolvedValue({ id: 'a', updatedAt: 5, status: 'draft' });
    mockApiClient.getStoreCategories.mockResolvedValue({ categories: [] });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(new Blob(['data']), { status: 200 }))
    );
  });

  it('merges the server index over the fallback pack, server winning by id', async () => {
    mockApiClient.getStoreIndex.mockResolvedValue({
      items: [serverEntry('a', 'Server A'), serverEntry('c', 'Server C')],
    });
    const provider = new StoreLibraryProvider(
      createFallback([packItem('a', 'Pack A'), packItem('b', 'Pack B')])
    );

    const items = await provider.list();

    expect(items.map(item => `${item.manifest.id}:${item.manifest.name}`).sort()).toEqual([
      'a:Server A',
      'b:Pack B',
      'c:Server C',
    ]);
    // Fallback items are re-emitted as store content, never as a fourth source.
    expect(items.every(item => item.scope === 'store')).toBe(true);
  });

  it('degrades to the fallback pack when the server is unreachable', async () => {
    mockApiClient.getStoreIndex.mockRejectedValue(new Error('offline'));
    const provider = new StoreLibraryProvider(createFallback([packItem('b', 'Pack B')]));

    const items = await provider.list();

    expect(items).toHaveLength(1);
    expect(items[0]!.manifest.id).toBe('b');
    expect(items[0]!.scope).toBe('store');
  });

  it('caches the index until a write invalidates it', async () => {
    const provider = new StoreLibraryProvider(createFallback([]));
    await provider.list();
    await provider.list();
    expect(mockApiClient.getStoreIndex).toHaveBeenCalledTimes(1);

    const listener = vi.fn();
    provider.subscribe(listener);
    await provider.delete('a');

    expect(mockApiClient.deleteStoreItem).toHaveBeenCalledWith('a');
    expect(listener).toHaveBeenCalledTimes(1);
    await provider.list();
    expect(mockApiClient.getStoreIndex).toHaveBeenCalledTimes(2);
  });

  it('invalidates the cache and notifies after an upload', async () => {
    const provider = new StoreLibraryProvider(createFallback([]));
    await provider.list();
    const listener = vi.fn();
    provider.subscribe(listener);

    const item = await provider.put({
      manifest: manifest('a', { files: [] }),
      files: new Map([['pic.png', new Blob(['x'])]]),
    });

    expect(mockApiClient.uploadStoreItem).toHaveBeenCalledTimes(1);
    expect(mockApiClient.uploadStoreItem.mock.calls[0]![0]).toBe('a');
    // The bundle's real file list wins over whatever the caller's manifest claimed.
    expect(item.manifest.files).toEqual(['pic.png']);
    expect(item.manifest.status).toBe('draft');
    expect(listener).toHaveBeenCalledTimes(1);
    await provider.list();
    expect(mockApiClient.getStoreIndex).toHaveBeenCalledTimes(2);
  });

  it('downloads a server bundle and pings the download counter', async () => {
    mockApiClient.getStoreItem.mockResolvedValue({ item: serverEntry('a', 'Server A') });
    const provider = new StoreLibraryProvider(createFallback([]));

    const bundle = await provider.getBundle('a');

    expect(bundle?.files.has('pic.png')).toBe(true);
    expect(mockApiClient.pingStoreDownload).toHaveBeenCalledWith('a');
  });

  it('survives a failing download ping (fire-and-forget, never unhandled)', async () => {
    mockApiClient.getStoreItem.mockResolvedValue({ item: serverEntry('a', 'Server A') });
    mockApiClient.pingStoreDownload.mockRejectedValue(new Error('500'));
    const provider = new StoreLibraryProvider(createFallback([]));

    const bundle = await provider.getBundle('a');
    await Promise.resolve();

    expect(bundle?.manifest.id).toBe('a');
  });

  it('falls back to the pack bundle when the server does not have the item', async () => {
    mockApiClient.getStoreItem.mockRejectedValue(new Error('404'));
    const fallback = createFallback([packItem('b', 'Pack B')]);
    const packBundle = { manifest: manifest('b'), files: new Map<string, Blob>() };
    vi.spyOn(fallback, 'getBundle').mockResolvedValue(packBundle);
    const provider = new StoreLibraryProvider(fallback);

    await expect(provider.getBundle('b')).resolves.toBe(packBundle);
    expect(mockApiClient.pingStoreDownload).not.toHaveBeenCalled();
  });

  it('resolves previews to a direct URL for server items and delegates for pack items', async () => {
    mockApiClient.getStoreIndex.mockResolvedValue({
      items: [
        {
          ...serverEntry('a', 'Server A'),
          manifest: {
            ...manifest('a', { preview: 'preview.webp' }),
          } as unknown as Record<string, unknown>,
        },
      ],
    });
    const fallback = createFallback([packItem('b', 'Pack B')]);
    vi.spyOn(fallback, 'getPreviewUrl').mockResolvedValue('/library/b/preview.png');
    const provider = new StoreLibraryProvider(fallback);

    await expect(provider.getPreviewUrl('a')).resolves.toBe(
      '/api/library/store/items/a/files/preview.webp'
    );
    await expect(provider.getPreviewUrl('b')).resolves.toBe('/library/b/preview.png');
  });

  it('patches metadata through the server and returns the stored item', async () => {
    mockApiClient.patchStoreItemMeta.mockResolvedValue({
      item: serverEntry('a', 'Renamed'),
    });
    const provider = new StoreLibraryProvider(createFallback([]));
    const listener = vi.fn();
    provider.subscribe(listener);

    const item = await provider.patchMeta('a', { status: 'published', featured: true });

    expect(mockApiClient.patchStoreItemMeta).toHaveBeenCalledWith('a', {
      status: 'published',
      categoryPath: undefined,
      featured: true,
      manifestPatch: undefined,
    });
    expect(item.manifest.name).toBe('Renamed');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('returns no categories when the taxonomy endpoint fails', async () => {
    mockApiClient.getStoreCategories.mockRejectedValue(new Error('offline'));
    const provider = new StoreLibraryProvider(createFallback([]));
    await expect(provider.listCategories()).resolves.toEqual([]);
  });
});
