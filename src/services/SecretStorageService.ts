import { injectable } from '@/fw/di';

/**
 * Best-effort secure storage for small client-side secrets (e.g. AI provider API keys).
 *
 * Secrets are encrypted with a per-browser AES-GCM master key and stored in IndexedDB. The
 * master key is generated once with `extractable: false` and persisted as a structured-cloneable
 * `CryptoKey` (never exposed as raw bytes to page scripts). This protects stored keys from casual
 * inspection (DevTools > Application) and from being trivially read out of localStorage.
 *
 * IMPORTANT: this is NOT a substitute for a real secret manager. A malicious script running on the
 * same origin can still call {@link getSecret}. The UI should communicate that browser-stored keys
 * are convenience storage, not hardware-backed secrets.
 */
@injectable()
export class SecretStorageService {
  private static readonly DB_NAME = 'pix3-secrets';
  private static readonly DB_VERSION = 1;
  private static readonly STORE = 'secrets';
  private static readonly MASTER_KEY_ID = '__pix3_master_key__';

  private masterKeyPromise: Promise<CryptoKey> | null = null;

  /** Whether the browser exposes the APIs this service needs. */
  static isSupported(): boolean {
    return (
      typeof indexedDB !== 'undefined' &&
      typeof crypto !== 'undefined' &&
      typeof crypto.subtle !== 'undefined'
    );
  }

  /** Encrypt and persist a secret under `id`, replacing any existing value. */
  async setSecret(id: string, value: string): Promise<void> {
    if (id === SecretStorageService.MASTER_KEY_ID) {
      throw new Error('Cannot use the reserved master-key id as a secret id.');
    }
    const key = await this.getMasterKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(value);
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    await this.put({ id, iv, data });
  }

  /** Decrypt and return a stored secret, or `null` if missing/undecryptable. */
  async getSecret(id: string): Promise<string | null> {
    const record = await this.get<SecretRecord>(id);
    if (!record || !record.data) {
      return null;
    }
    try {
      const key = await this.getMasterKey();
      const iv = record.iv instanceof Uint8Array ? record.iv : new Uint8Array(record.iv);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, record.data);
      return new TextDecoder().decode(decrypted);
    } catch {
      return null;
    }
  }

  /** Whether a secret exists for `id` (does not decrypt it). */
  async hasSecret(id: string): Promise<boolean> {
    const record = await this.get<SecretRecord>(id);
    return Boolean(record && record.data);
  }

  /** Remove a stored secret. No-op if absent. */
  async deleteSecret(id: string): Promise<void> {
    if (id === SecretStorageService.MASTER_KEY_ID) {
      return;
    }
    await this.delete(id);
  }

  /** List all stored secret ids (excludes the internal master key). */
  async listSecretIds(): Promise<string[]> {
    const keys = await this.keys();
    return keys.filter(key => key !== SecretStorageService.MASTER_KEY_ID);
  }

  dispose(): void {
    this.masterKeyPromise = null;
  }

  // -- master key ------------------------------------------------------------

  private getMasterKey(): Promise<CryptoKey> {
    if (!this.masterKeyPromise) {
      this.masterKeyPromise = this.loadOrCreateMasterKey().catch(error => {
        // Allow a later retry if key setup transiently failed.
        this.masterKeyPromise = null;
        throw error;
      });
    }
    return this.masterKeyPromise;
  }

  private async loadOrCreateMasterKey(): Promise<CryptoKey> {
    const existing = await this.get<MasterKeyRecord>(SecretStorageService.MASTER_KEY_ID);
    if (existing?.key) {
      return existing.key;
    }
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    // Use `add` (not `put`) so a concurrent tab that persisted its key first wins the race.
    // If our add hits a ConstraintError, re-read and adopt the existing key instead of
    // overwriting it — overwriting would orphan any secret the winner already encrypted.
    const added = await this.tryAddMasterKey({ id: SecretStorageService.MASTER_KEY_ID, key });
    if (added) {
      return key;
    }
    const winner = await this.get<MasterKeyRecord>(SecretStorageService.MASTER_KEY_ID);
    return winner?.key ?? key;
  }

  private async tryAddMasterKey(record: MasterKeyRecord): Promise<boolean> {
    const db = await this.openDb();
    try {
      return await new Promise<boolean>(resolve => {
        let added = false;
        const tx = db.transaction(SecretStorageService.STORE, 'readwrite');
        const addReq = tx.objectStore(SecretStorageService.STORE).add(record);
        addReq.onsuccess = () => {
          added = true;
        };
        addReq.onerror = event => {
          // Key already exists (ConstraintError): swallow so the transaction is not aborted.
          event.preventDefault();
          added = false;
        };
        tx.oncomplete = () => resolve(added);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      });
    } finally {
      db.close();
    }
  }

  // -- raw IndexedDB access --------------------------------------------------

  private openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(SecretStorageService.DB_NAME, SecretStorageService.DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(SecretStorageService.STORE)) {
            db.createObjectStore(SecretStorageService.STORE, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB open error'));
      } catch (err) {
        reject(err);
      }
    });
  }

  private async put(record: SecretRecord | MasterKeyRecord): Promise<void> {
    const db = await this.openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(SecretStorageService.STORE, 'readwrite');
        tx.objectStore(SecretStorageService.STORE).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction error'));
      });
    } finally {
      db.close();
    }
  }

  private async get<T>(id: string): Promise<T | undefined> {
    const db = await this.openDb();
    try {
      return await new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(SecretStorageService.STORE, 'readonly');
        const getReq = tx.objectStore(SecretStorageService.STORE).get(id);
        getReq.onsuccess = () => resolve(getReq.result as T | undefined);
        getReq.onerror = () => reject(getReq.error ?? new Error('IndexedDB get error'));
      });
    } finally {
      db.close();
    }
  }

  private async delete(id: string): Promise<void> {
    const db = await this.openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(SecretStorageService.STORE, 'readwrite');
        tx.objectStore(SecretStorageService.STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction error'));
      });
    } finally {
      db.close();
    }
  }

  private async keys(): Promise<string[]> {
    const db = await this.openDb();
    try {
      return await new Promise<string[]>((resolve, reject) => {
        const tx = db.transaction(SecretStorageService.STORE, 'readonly');
        const keysReq = tx.objectStore(SecretStorageService.STORE).getAllKeys();
        keysReq.onsuccess = () => resolve((keysReq.result as IDBValidKey[]).map(String));
        keysReq.onerror = () => reject(keysReq.error ?? new Error('IndexedDB getAllKeys error'));
      });
    } finally {
      db.close();
    }
  }
}

interface SecretRecord {
  id: string;
  iv: Uint8Array;
  data: ArrayBuffer;
}

interface MasterKeyRecord {
  id: string;
  key: CryptoKey;
}
