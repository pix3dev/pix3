/**
 * Where the recovery journal goes when the project folder refuses `.pix3/recovery/` (a read-only
 * folder, a revoked permission): IndexedDB of this browser profile, or memory where even that is
 * unavailable (tests, locked-down profiles). Same records as the on-disk journal.
 */
export interface RecoveryFallbackRecord {
  /** `${projectId}|${scenePath}|${stamp}|${hash8}` */
  readonly key: string;
  readonly projectId: string;
  readonly scenePath: string;
  /** Milliseconds since epoch. */
  readonly createdAt: number;
  readonly hash: string;
  readonly content: string;
}

export interface RecoveryFallbackStore {
  put(record: RecoveryFallbackRecord): Promise<void>;
  list(projectId: string): Promise<RecoveryFallbackRecord[]>;
  delete(key: string): Promise<void>;
}

export class MemoryRecoveryFallbackStore implements RecoveryFallbackStore {
  private readonly records = new Map<string, RecoveryFallbackRecord>();

  async put(record: RecoveryFallbackRecord): Promise<void> {
    this.records.set(record.key, record);
  }

  async list(projectId: string): Promise<RecoveryFallbackRecord[]> {
    return Array.from(this.records.values()).filter(r => r.projectId === projectId);
  }

  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }
}

const DB_NAME = 'pix3-recovery-journal';
const DB_VERSION = 1;
const STORE_NAME = 'versions';

/** Raw IndexedDB, one object store keyed by `key`, with a memory fallback when IDB is missing. */
export class IndexedDbRecoveryFallbackStore implements RecoveryFallbackStore {
  private readonly memory = new MemoryRecoveryFallbackStore();

  async put(record: RecoveryFallbackRecord): Promise<void> {
    const db = await openDb();
    if (!db) {
      await this.memory.put(record);
      return;
    }
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record);
      await transactionDone(tx);
    } catch (error) {
      console.warn(
        '[RecoveryJournal] IndexedDB write failed; keeping the version in memory',
        error
      );
      await this.memory.put(record);
    } finally {
      db.close();
    }
  }

  async list(projectId: string): Promise<RecoveryFallbackRecord[]> {
    const fromMemory = await this.memory.list(projectId);
    const db = await openDb();
    if (!db) {
      return fromMemory;
    }
    try {
      const all = await requestToPromise<RecoveryFallbackRecord[]>(
        db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll()
      );
      return [...all.filter(r => r.projectId === projectId), ...fromMemory];
    } catch {
      return fromMemory;
    } finally {
      db.close();
    }
  }

  async delete(key: string): Promise<void> {
    await this.memory.delete(key);
    const db = await openDb();
    if (!db) {
      return;
    }
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      await transactionDone(tx);
    } catch {
      // best-effort
    } finally {
      db.close();
    }
  }
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  return new Promise(resolve => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function requestToPromise<T>(request: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}
