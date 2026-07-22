import { ServiceContainer, injectable } from '@/fw/di';

const DATABASE_NAME = 'pix3-thumbnail-cache';
const STORE_NAME = 'thumbnails';
const DATABASE_VERSION = 1;

@injectable()
export class ThumbnailCacheService {
  private databasePromise: Promise<IDBDatabase> | null = null;
  private readonly memoryFallback = new Map<string, string>();

  public async get(key: string): Promise<string | null> {
    try {
      const database = await this.openDatabase();
      if (!database) {
        return this.memoryFallback.get(key) ?? null;
      }

      return await new Promise<string | null>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(key);

        request.onsuccess = () => {
          const result = request.result;
          resolve(typeof result === 'string' ? result : null);
        };
        request.onerror = () => reject(request.error ?? new Error('IndexedDB get error'));
      });
    } catch {
      return this.memoryFallback.get(key) ?? null;
    }
  }

  public async set(key: string, dataUrl: string): Promise<void> {
    this.memoryFallback.set(key, dataUrl);

    try {
      const database = await this.openDatabase();
      if (!database) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(dataUrl, key);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error('IndexedDB put error'));
        transaction.onerror = () =>
          reject(transaction.error ?? new Error('IndexedDB transaction error'));
      });
    } catch {
      // Keep the in-memory cache warm even if IndexedDB is unavailable.
    }
  }

  public dispose(): void {
    const currentPromise = this.databasePromise;
    this.databasePromise = null;
    this.memoryFallback.clear();
    currentPromise
      ?.then(database => {
        database.close();
      })
      .catch(() => undefined);
  }

  private openDatabase(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') {
      return Promise.resolve(null);
    }

    if (!this.databasePromise) {
      this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

        request.onupgradeneeded = event => {
          const database = (event.target as IDBOpenDBRequest).result;
          if (!database.objectStoreNames.contains(STORE_NAME)) {
            database.createObjectStore(STORE_NAME);
          }
        };

        request.onsuccess = event => {
          resolve((event.target as IDBOpenDBRequest).result);
        };

        request.onerror = () => {
          this.databasePromise = null;
          reject(request.error ?? new Error('IndexedDB open error'));
        };
      });
    }

    return this.databasePromise;
  }
}

export function resolveThumbnailCacheService(): ThumbnailCacheService {
  const container = ServiceContainer.getInstance();
  return container.getService<ThumbnailCacheService>(
    container.getOrCreateToken(ThumbnailCacheService)
  );
}
