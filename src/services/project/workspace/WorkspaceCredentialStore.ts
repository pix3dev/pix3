import { injectable } from '@/fw/di';

const DB_NAME = 'pix3-workspace-credentials';
const DB_VERSION = 1;
const STORE_NAME = 'tokens';

interface TokenRecord {
  readonly workspaceId: string;
  readonly token: string;
  readonly savedAt: number;
}

/**
 * Pairing tokens of `pix3 serve` workspaces, keyed by the server's `workspaceId`
 * (`.plans/external-agent-authoring.md` §11.1: "в браузере — IndexedDB").
 *
 * Raw IndexedDB, one object store. Where IndexedDB is unavailable (tests, a locked-down profile)
 * it falls back to memory for the page's lifetime: the connection still works, the next session
 * just asks for the token again. The token is never written to `localStorage` or the URL.
 */
@injectable()
export class WorkspaceCredentialStore {
  private readonly memory = new Map<string, string>();

  async get(workspaceId: string): Promise<string | null> {
    const db = await this.openDb();
    if (!db) {
      return this.memory.get(workspaceId) ?? null;
    }
    try {
      const record = await requestToPromise<TokenRecord | undefined>(
        db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(workspaceId)
      );
      return record?.token ?? this.memory.get(workspaceId) ?? null;
    } catch {
      return this.memory.get(workspaceId) ?? null;
    } finally {
      db.close();
    }
  }

  async set(workspaceId: string, token: string): Promise<void> {
    this.memory.set(workspaceId, token);
    const db = await this.openDb();
    if (!db) {
      return;
    }
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({
        workspaceId,
        token,
        savedAt: Date.now(),
      } satisfies TokenRecord);
      await transactionDone(tx);
    } catch (error) {
      console.warn('[WorkspaceCredentialStore] Could not persist the workspace token', error);
    } finally {
      db.close();
    }
  }

  async delete(workspaceId: string): Promise<void> {
    this.memory.delete(workspaceId);
    const db = await this.openDb();
    if (!db) {
      return;
    }
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(workspaceId);
      await transactionDone(tx);
    } catch {
      // best-effort
    } finally {
      db.close();
    }
  }

  private openDb(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') {
      return Promise.resolve(null);
    }
    return new Promise(resolve => {
      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'workspaceId' });
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
