import { ServiceContainer, injectable } from '@/fw/di';
import type { AtlasManifest } from '@pix3/runtime';

const DATABASE_NAME = 'pix3-atlas-cache';
const STORE_NAME = 'atlases';
const DATABASE_VERSION = 1;
/** Keep a small window of recent texture-set snapshots per machine. */
const MAX_ENTRIES = 8;

export interface AtlasCacheEntry {
  manifest: AtlasManifest;
  /** One PNG blob per sheet, index-aligned with `manifest.sheets`. */
  sheets: Blob[];
}

interface StoredAtlasEntry extends AtlasCacheEntry {
  storedAt: number;
}

/**
 * Content-addressed IndexedDB store for packed atlases, modeled on
 * {@link ThumbnailCacheService}: one object store keyed by the content hash,
 * values are structured-clone-friendly (manifest JSON + PNG blobs), with an
 * in-memory fallback when IndexedDB is unavailable and an LRU cap so a churning
 * texture set does not grow the store without bound.
 */
@injectable()
export class AtlasCacheStore {
  private databasePromise: Promise<IDBDatabase | null> | null = null;
  private readonly memoryFallback = new Map<string, StoredAtlasEntry>();

  async get(key: string): Promise<AtlasCacheEntry | null> {
    try {
      const database = await this.openDatabase();
      if (!database) {
        return this.fromMemory(key);
      }

      return await new Promise<AtlasCacheEntry | null>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const request = transaction.objectStore(STORE_NAME).get(key);
        request.onsuccess = () => {
          const result = request.result as StoredAtlasEntry | undefined;
          resolve(result ? { manifest: result.manifest, sheets: result.sheets } : null);
        };
        request.onerror = () => reject(request.error ?? new Error('IndexedDB get error'));
      });
    } catch {
      return this.fromMemory(key);
    }
  }

  async set(key: string, entry: AtlasCacheEntry): Promise<void> {
    const stored: StoredAtlasEntry = { ...entry, storedAt: Date.now() };
    this.memoryFallback.set(key, stored);

    try {
      const database = await this.openDatabase();
      if (!database) {
        this.pruneMemory();
        return;
      }

      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const request = transaction.objectStore(STORE_NAME).put(stored, key);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error('IndexedDB put error'));
        transaction.onerror = () =>
          reject(transaction.error ?? new Error('IndexedDB transaction error'));
      });
      await this.pruneDatabase(database);
    } catch {
      // Keep the in-memory cache warm even if IndexedDB is unavailable.
      this.pruneMemory();
    }
  }

  dispose(): void {
    const current = this.databasePromise;
    this.databasePromise = null;
    this.memoryFallback.clear();
    current?.then(database => database?.close()).catch(() => undefined);
  }

  private fromMemory(key: string): AtlasCacheEntry | null {
    const entry = this.memoryFallback.get(key);
    return entry ? { manifest: entry.manifest, sheets: entry.sheets } : null;
  }

  private pruneMemory(): void {
    if (this.memoryFallback.size <= MAX_ENTRIES) {
      return;
    }
    const ordered = [...this.memoryFallback.entries()].sort(
      (a, b) => a[1].storedAt - b[1].storedAt
    );
    for (const [key] of ordered.slice(0, ordered.length - MAX_ENTRIES)) {
      this.memoryFallback.delete(key);
    }
  }

  private async pruneDatabase(database: IDBDatabase): Promise<void> {
    await new Promise<void>(resolve => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const entries: Array<{ key: IDBValidKey; storedAt: number }> = [];
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          const value = cursor.value as StoredAtlasEntry;
          entries.push({ key: cursor.key, storedAt: value.storedAt ?? 0 });
          cursor.continue();
          return;
        }
        if (entries.length > MAX_ENTRIES) {
          entries.sort((a, b) => a.storedAt - b.storedAt);
          for (const { key } of entries.slice(0, entries.length - MAX_ENTRIES)) {
            store.delete(key);
          }
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      cursorRequest.onerror = () => resolve();
    });
  }

  private openDatabase(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') {
      return Promise.resolve(null);
    }
    if (!this.databasePromise) {
      this.databasePromise = new Promise<IDBDatabase | null>((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = event => {
          const database = (event.target as IDBOpenDBRequest).result;
          if (!database.objectStoreNames.contains(STORE_NAME)) {
            database.createObjectStore(STORE_NAME);
          }
        };
        request.onsuccess = event => resolve((event.target as IDBOpenDBRequest).result);
        request.onerror = () => {
          this.databasePromise = null;
          reject(request.error ?? new Error('IndexedDB open error'));
        };
      });
    }
    return this.databasePromise;
  }
}

export function resolveAtlasCacheStore(): AtlasCacheStore {
  const container = ServiceContainer.getInstance();
  return container.getService<AtlasCacheStore>(container.getOrCreateToken(AtlasCacheStore));
}
