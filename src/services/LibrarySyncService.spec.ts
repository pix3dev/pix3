import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import type { LibraryItem, LibraryItemManifest } from './library/library-types';

const mockApiClient = {
  ApiClientError: class ApiClientError extends Error {
    constructor(
      message: string,
      public status: number
    ) {
      super(message);
    }
  },
  getLibraryIndex: vi.fn(),
  downloadLibraryFile: vi.fn(),
  uploadLibraryItem: vi.fn(),
  deleteLibraryItem: vi.fn(),
};

vi.mock('./ApiClient', () => mockApiClient);

const { LibrarySyncService } = await import('./LibrarySyncService');

function manifest(id: string, updatedAt: number, files: string[] = ['item.json']): LibraryItemManifest {
  return {
    id,
    slug: id,
    name: id,
    type: 'image',
    tags: [],
    files,
    source: 'imported',
    createdAt: 1,
    updatedAt,
  };
}

function item(id: string, updatedAt: number, files: string[] = ['item.json']): LibraryItem {
  return { scope: 'user', manifest: manifest(id, updatedAt, files) };
}

interface FakeLibrary {
  isUserScopeSupported: () => boolean;
  subscribe: () => () => void;
  listUserItems: ReturnType<typeof vi.fn>;
  listUserTombstones: ReturnType<typeof vi.fn>;
  getUserBundle: ReturnType<typeof vi.fn>;
  storeUserItemFromCloud: ReturnType<typeof vi.fn>;
  removeUserItemFromCloud: ReturnType<typeof vi.fn>;
  clearUserTombstone: ReturnType<typeof vi.fn>;
}

function createService() {
  const library: FakeLibrary = {
    isUserScopeSupported: () => true,
    subscribe: () => () => {},
    listUserItems: vi.fn().mockResolvedValue([]),
    listUserTombstones: vi.fn().mockResolvedValue([]),
    getUserBundle: vi.fn(),
    storeUserItemFromCloud: vi.fn().mockResolvedValue(undefined),
    removeUserItemFromCloud: vi.fn().mockResolvedValue(undefined),
    clearUserTombstone: vi.fn().mockResolvedValue(undefined),
  };
  const service = new LibrarySyncService();
  Object.defineProperty(service, 'library', { value: library, configurable: true });
  return { service, library };
}

describe('LibrarySyncService', () => {
  beforeEach(() => {
    resetAppState();
    vi.clearAllMocks();
    appState.auth.isAuthenticated = true;
    mockApiClient.getLibraryIndex.mockResolvedValue({ items: [] });
    mockApiClient.uploadLibraryItem.mockResolvedValue({ id: 'x', updatedAt: 1 });
    mockApiClient.deleteLibraryItem.mockResolvedValue({ ok: true, deletedAt: 1 });
    mockApiClient.downloadLibraryFile.mockResolvedValue(new Response(new Blob(['data'])));
  });

  afterEach(() => resetAppState());

  it('does nothing when signed out', async () => {
    appState.auth.isAuthenticated = false;
    const { service } = createService();
    await service.syncNow();
    expect(mockApiClient.getLibraryIndex).not.toHaveBeenCalled();
    expect(service.getState().status).toBe('disabled');
  });

  it('pulls a remote-only item', async () => {
    const { service, library } = createService();
    mockApiClient.getLibraryIndex.mockResolvedValue({
      items: [{ id: 'a', visibility: 'private', manifest: manifest('a', 100, ['pic.png']), updatedAt: 100, deleted: false }],
    });
    await service.syncNow();
    expect(mockApiClient.downloadLibraryFile).toHaveBeenCalledWith('a', 'pic.png');
    expect(library.storeUserItemFromCloud).toHaveBeenCalledTimes(1);
    expect(mockApiClient.uploadLibraryItem).not.toHaveBeenCalled();
  });

  it('pushes a local-only item', async () => {
    const { service, library } = createService();
    library.listUserItems.mockResolvedValue([item('a', 100)]);
    library.getUserBundle.mockResolvedValue({
      manifest: manifest('a', 100),
      files: new Map([['item.json', new Blob(['{}'])]]),
    });
    await service.syncNow();
    expect(mockApiClient.uploadLibraryItem).toHaveBeenCalledTimes(1);
    expect(mockApiClient.uploadLibraryItem.mock.calls[0]![0]).toBe('a');
    expect(library.storeUserItemFromCloud).not.toHaveBeenCalled();
  });

  it('last-write-wins: pushes when the local copy is newer', async () => {
    const { service, library } = createService();
    library.listUserItems.mockResolvedValue([item('a', 200)]);
    library.getUserBundle.mockResolvedValue({
      manifest: manifest('a', 200),
      files: new Map([['item.json', new Blob(['{}'])]]),
    });
    mockApiClient.getLibraryIndex.mockResolvedValue({
      items: [{ id: 'a', visibility: 'private', manifest: manifest('a', 100), updatedAt: 100, deleted: false }],
    });
    await service.syncNow();
    expect(mockApiClient.uploadLibraryItem).toHaveBeenCalledTimes(1);
    expect(library.storeUserItemFromCloud).not.toHaveBeenCalled();
  });

  it('last-write-wins: pulls when the remote copy is newer', async () => {
    const { service, library } = createService();
    library.listUserItems.mockResolvedValue([item('a', 100)]);
    mockApiClient.getLibraryIndex.mockResolvedValue({
      items: [{ id: 'a', visibility: 'private', manifest: manifest('a', 200), updatedAt: 200, deleted: false }],
    });
    await service.syncNow();
    expect(library.storeUserItemFromCloud).toHaveBeenCalledTimes(1);
    expect(mockApiClient.uploadLibraryItem).not.toHaveBeenCalled();
  });

  it('applies a remote deletion that is newer than the local copy', async () => {
    const { service, library } = createService();
    library.listUserItems.mockResolvedValue([item('a', 100)]);
    mockApiClient.getLibraryIndex.mockResolvedValue({
      items: [{ id: 'a', visibility: 'private', manifest: null, updatedAt: 300, deleted: true }],
    });
    await service.syncNow();
    expect(library.removeUserItemFromCloud).toHaveBeenCalledWith('a');
    expect(mockApiClient.uploadLibraryItem).not.toHaveBeenCalled();
  });

  it('pushes a local deletion that is newer than the remote copy', async () => {
    const { service, library } = createService();
    library.listUserTombstones.mockResolvedValue([{ id: 'a', deletedAt: 200 }]);
    mockApiClient.getLibraryIndex.mockResolvedValue({
      items: [{ id: 'a', visibility: 'private', manifest: manifest('a', 100), updatedAt: 100, deleted: false }],
    });
    await service.syncNow();
    expect(mockApiClient.deleteLibraryItem).toHaveBeenCalledWith('a', 200);
    expect(library.clearUserTombstone).toHaveBeenCalledWith('a');
  });

  it('drops a tombstone the server never knew about', async () => {
    const { service, library } = createService();
    library.listUserTombstones.mockResolvedValue([{ id: 'a', deletedAt: 50 }]);
    await service.syncNow();
    expect(mockApiClient.deleteLibraryItem).not.toHaveBeenCalled();
    expect(library.clearUserTombstone).toHaveBeenCalledWith('a');
  });

  it('reports idle with a timestamp after a successful sync', async () => {
    const { service } = createService();
    await service.syncNow();
    expect(service.getState().status).toBe('idle');
    expect(service.getState().lastSyncedAt).toBeTypeOf('number');
  });

  it('treats a 401 as signed-out rather than an error', async () => {
    const { service } = createService();
    mockApiClient.getLibraryIndex.mockRejectedValue(new mockApiClient.ApiClientError('nope', 401));
    await service.syncNow();
    expect(service.getState().status).toBe('disabled');
  });
});
