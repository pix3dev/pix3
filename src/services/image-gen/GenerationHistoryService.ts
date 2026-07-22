import { injectable } from '@/fw/di';

/** A persisted AI image generation, kept for later reuse. */
export interface GenerationRecord {
  id: string;
  createdAt: number;
  providerId: string;
  modelId: string;
  prompt: string;
  aspectRatio?: string;
  imageSize?: string;
  mimeType: string;
  /** The generated image (structured-cloneable, stored directly in IndexedDB). */
  blob: Blob;
  width?: number;
  height?: number;
  /** Small thumbnails of the reference images used, if any. */
  referenceThumbs?: Blob[];
}

/**
 * Persists AI image generations in IndexedDB so the user can browse and reuse past results without
 * re-generating (and re-paying). This is a local cache keyed by a generated id, independent of the
 * project files — saving a generation into the project is a separate, explicit action.
 */
@injectable()
export class GenerationHistoryService {
  private static readonly DB_NAME = 'pix3-asset-gen';
  private static readonly DB_VERSION = 1;
  private static readonly STORE = 'generations';
  private static readonly INDEX_CREATED = 'by_createdAt';

  private readonly listeners = new Set<() => void>();

  static isSupported(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  async add(
    record: Omit<GenerationRecord, 'id' | 'createdAt'> &
      Partial<Pick<GenerationRecord, 'id' | 'createdAt'>>
  ): Promise<GenerationRecord> {
    const full: GenerationRecord = {
      ...record,
      id: record.id ?? this.newId(),
      createdAt: record.createdAt ?? Date.now(),
    };
    await this.put(full);
    this.notify();
    return full;
  }

  /** List records, newest first, capped to `limit`. */
  async list(limit = 200): Promise<GenerationRecord[]> {
    const db = await this.openDb();
    try {
      return await new Promise<GenerationRecord[]>((resolve, reject) => {
        const tx = db.transaction(GenerationHistoryService.STORE, 'readonly');
        const store = tx.objectStore(GenerationHistoryService.STORE);
        const index = store.index(GenerationHistoryService.INDEX_CREATED);
        const results: GenerationRecord[] = [];
        const cursorReq = index.openCursor(null, 'prev');
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor && results.length < limit) {
            results.push(cursor.value as GenerationRecord);
            cursor.continue();
          } else {
            resolve(results);
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error ?? new Error('IndexedDB cursor error'));
      });
    } finally {
      db.close();
    }
  }

  async get(id: string): Promise<GenerationRecord | undefined> {
    const db = await this.openDb();
    try {
      return await new Promise<GenerationRecord | undefined>((resolve, reject) => {
        const tx = db.transaction(GenerationHistoryService.STORE, 'readonly');
        const getReq = tx.objectStore(GenerationHistoryService.STORE).get(id);
        getReq.onsuccess = () => resolve(getReq.result as GenerationRecord | undefined);
        getReq.onerror = () => reject(getReq.error ?? new Error('IndexedDB get error'));
      });
    } finally {
      db.close();
    }
  }

  async delete(id: string): Promise<void> {
    const db = await this.openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(GenerationHistoryService.STORE, 'readwrite');
        tx.objectStore(GenerationHistoryService.STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction error'));
      });
    } finally {
      db.close();
    }
    this.notify();
  }

  async clear(): Promise<void> {
    const db = await this.openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(GenerationHistoryService.STORE, 'readwrite');
        tx.objectStore(GenerationHistoryService.STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction error'));
      });
    } finally {
      db.close();
    }
    this.notify();
  }

  /** Notified whenever the history changes (add/delete/clear). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
  }

  // -- internals -------------------------------------------------------------

  private newId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `gen-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }

  private openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(
          GenerationHistoryService.DB_NAME,
          GenerationHistoryService.DB_VERSION
        );
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(GenerationHistoryService.STORE)) {
            const store = db.createObjectStore(GenerationHistoryService.STORE, { keyPath: 'id' });
            store.createIndex(GenerationHistoryService.INDEX_CREATED, 'createdAt');
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB open error'));
      } catch (err) {
        reject(err);
      }
    });
  }

  private async put(record: GenerationRecord): Promise<void> {
    const db = await this.openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(GenerationHistoryService.STORE, 'readwrite');
        tx.objectStore(GenerationHistoryService.STORE).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction error'));
      });
    } finally {
      db.close();
    }
  }

  private notify(): void {
    this.listeners.forEach(listener => {
      try {
        listener();
      } catch {
        // ignore listener errors
      }
    });
  }
}
