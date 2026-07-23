import { injectable } from '@/fw/di';
import type { SculptSpec } from '@/services/model-gen/SculptSpec';
import type {
  ComplexityHint,
  LlmUsageAggregate,
  ModelGenMode,
  PassId,
} from '@/services/model-gen/model-gen-types';

/** A per-pass snapshot kept in a history record: the pass id, its label, and its final score. */
export interface ModelGenRecordPass {
  id: PassId;
  label: string;
  score: number | null;
}

/** A persisted Model Lab generation job, kept for later browse / reuse. */
export interface ModelGenRecord {
  id: string;
  createdAt: number;
  /** The reconstructed object's class (e.g. "office chair"). */
  objectClass: string;
  /** The user's optional intent prompt for the run. */
  prompt?: string;
  complexity: ComplexityHint;
  mode: ModelGenMode;
  /** The sculpt spec that drove the run. */
  spec: SculptSpec;
  /** The final procedural factory source. */
  factoryCode: string;
  /** One entry per pass in the run's pass plan. */
  passes: ModelGenRecordPass[];
  /** The last passed pass's fidelity score, or null when review was disabled. */
  finalScore: number | null;
  /** Token usage accumulated across the whole job. */
  usage: LlmUsageAggregate;
  /** The reference image, stored raw (structured-cloneable). */
  referenceThumb?: Blob;
  /** A rendered 3/4 preview of the result, stored raw. */
  thumb?: Blob;
  /** Set later when the user saves a GLB from this job. */
  savedPath?: string;
}

/**
 * Persists Model Lab generation jobs in IndexedDB so the user can browse and reopen past results
 * (rebuild a saved factory, or regenerate from a saved spec) without re-paying for codegen. A local
 * cache keyed by a generated id, independent of the project files — saving a GLB into the project is
 * a separate, explicit action. Mirrors {@link
 * import('@/services/image-gen/GenerationHistoryService').GenerationHistoryService} in structure, but
 * uses its own database (`pix3-model-gen`) so the two histories never collide.
 */
@injectable()
export class Model3DGenHistoryService {
  private static readonly DB_NAME = 'pix3-model-gen';
  private static readonly DB_VERSION = 1;
  private static readonly STORE = 'jobs';
  private static readonly INDEX_CREATED = 'by_createdAt';

  private readonly listeners = new Set<() => void>();

  static isSupported(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  async add(
    record: Omit<ModelGenRecord, 'id' | 'createdAt'> &
      Partial<Pick<ModelGenRecord, 'id' | 'createdAt'>>
  ): Promise<ModelGenRecord> {
    const full: ModelGenRecord = {
      ...record,
      id: record.id ?? this.newId(),
      createdAt: record.createdAt ?? Date.now(),
    };
    await this.put(full);
    this.notify();
    return full;
  }

  /** List records, newest first, capped to `limit`. */
  async list(limit = 200): Promise<ModelGenRecord[]> {
    const db = await this.openDb();
    try {
      return await new Promise<ModelGenRecord[]>((resolve, reject) => {
        const tx = db.transaction(Model3DGenHistoryService.STORE, 'readonly');
        const store = tx.objectStore(Model3DGenHistoryService.STORE);
        const index = store.index(Model3DGenHistoryService.INDEX_CREATED);
        const results: ModelGenRecord[] = [];
        const cursorReq = index.openCursor(null, 'prev');
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor && results.length < limit) {
            results.push(cursor.value as ModelGenRecord);
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

  async get(id: string): Promise<ModelGenRecord | undefined> {
    const db = await this.openDb();
    try {
      return await new Promise<ModelGenRecord | undefined>((resolve, reject) => {
        const tx = db.transaction(Model3DGenHistoryService.STORE, 'readonly');
        const getReq = tx.objectStore(Model3DGenHistoryService.STORE).get(id);
        getReq.onsuccess = () => resolve(getReq.result as ModelGenRecord | undefined);
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
        const tx = db.transaction(Model3DGenHistoryService.STORE, 'readwrite');
        tx.objectStore(Model3DGenHistoryService.STORE).delete(id);
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
        const tx = db.transaction(Model3DGenHistoryService.STORE, 'readwrite');
        tx.objectStore(Model3DGenHistoryService.STORE).clear();
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
    return `model-gen-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }

  private openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(
          Model3DGenHistoryService.DB_NAME,
          Model3DGenHistoryService.DB_VERSION
        );
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(Model3DGenHistoryService.STORE)) {
            const store = db.createObjectStore(Model3DGenHistoryService.STORE, { keyPath: 'id' });
            store.createIndex(Model3DGenHistoryService.INDEX_CREATED, 'createdAt');
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB open error'));
      } catch (err) {
        reject(err);
      }
    });
  }

  private async put(record: ModelGenRecord): Promise<void> {
    const db = await this.openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(Model3DGenHistoryService.STORE, 'readwrite');
        tx.objectStore(Model3DGenHistoryService.STORE).put(record);
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
