/**
 * The personal ("user") library scope, living at the editor level (survives project
 * switches). Manifests are indexed in IndexedDB; bundle files live in OPFS under
 * `pix3-user-library/<itemId>/<relative-path>`.
 *
 * This mirrors the two proven storage patterns in the codebase:
 *  - IndexedDB index/open-per-op — `GenerationHistoryService`
 *  - OPFS directory tree — `BrowserProjectStorageService` / `CloudProjectCacheService`
 *
 * The `ensurePermission` OPFS blocker (OPFS handles never expose the permission API) is
 * already resolved in `FileSystemAPIService`; OPFS access here is treated as always granted.
 */

import type {
  LibraryBundle,
  LibraryItem,
  LibraryItemManifest,
  LibraryProvider,
} from './library-types';
import { normalizeBundlePath } from './library-path-remap';

type StorageManagerWithDirectory = StorageManager & {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
};

export class LocalLibraryProvider implements LibraryProvider {
  readonly scope = 'user' as const;

  private static readonly DB_NAME = 'pix3-user-library';
  private static readonly DB_VERSION = 1;
  private static readonly STORE = 'items';
  private static readonly INDEX_UPDATED = 'by_updatedAt';
  private static readonly OPFS_ROOT = 'pix3-user-library';

  private readonly listeners = new Set<() => void>();
  private opfsRootPromise: Promise<FileSystemDirectoryHandle> | null = null;
  private readonly previewUrls = new Map<string, string>();

  isSupported(): boolean {
    const storage = globalThis.navigator?.storage as StorageManagerWithDirectory | undefined;
    return typeof indexedDB !== 'undefined' && typeof storage?.getDirectory === 'function';
  }

  async list(): Promise<LibraryItem[]> {
    if (!this.isSupported()) {
      return [];
    }
    const manifests = await this.listManifests();
    return manifests.map(manifest => ({ scope: this.scope, manifest }));
  }

  async getBundle(id: string): Promise<LibraryBundle | null> {
    if (!this.isSupported()) {
      return null;
    }
    const manifest = await this.getManifest(id);
    if (!manifest) {
      return null;
    }
    const itemDir = await this.getItemDirectory(id, false);
    if (!itemDir) {
      return null;
    }
    const files = new Map<string, Blob>();
    for (const relativePath of manifest.files) {
      const normalized = normalizeBundlePath(relativePath);
      const blob = await this.readOpfsFile(itemDir, normalized);
      if (blob) {
        files.set(normalized, blob);
      }
    }
    return { manifest, files };
  }

  async put(bundle: LibraryBundle): Promise<LibraryItem> {
    if (!this.isSupported()) {
      throw new Error('Local library storage is not supported in this environment.');
    }
    const now = Date.now();
    const manifest: LibraryItemManifest = {
      ...bundle.manifest,
      createdAt: bundle.manifest.createdAt || now,
      updatedAt: now,
      files: [...bundle.files.keys()].map(normalizeBundlePath),
    };

    // Replace files: clear any previous bundle dir + stale preview, then write fresh.
    this.revokePreview(manifest.id);
    await this.deleteItemDirectory(manifest.id);
    const itemDir = await this.getItemDirectory(manifest.id, true);
    if (!itemDir) {
      throw new Error('Failed to open OPFS directory for library item.');
    }
    for (const [relativePath, blob] of bundle.files) {
      await this.writeOpfsFile(itemDir, normalizeBundlePath(relativePath), blob);
    }

    await this.putManifest(manifest);
    this.notify();
    return { scope: this.scope, manifest };
  }

  async getPreviewUrl(id: string): Promise<string | null> {
    if (!this.isSupported()) {
      return null;
    }
    const cached = this.previewUrls.get(id);
    if (cached) {
      return cached;
    }
    const manifest = await this.getManifest(id);
    if (!manifest?.preview) {
      return null;
    }
    const itemDir = await this.getItemDirectory(id, false);
    if (!itemDir) {
      return null;
    }
    const blob = await this.readOpfsFile(itemDir, normalizeBundlePath(manifest.preview));
    if (!blob) {
      return null;
    }
    const url = URL.createObjectURL(blob);
    this.previewUrls.set(id, url);
    return url;
  }

  async delete(id: string): Promise<void> {
    if (!this.isSupported()) {
      return;
    }
    this.revokePreview(id);
    await this.deleteManifest(id);
    await this.deleteItemDirectory(id);
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
    for (const url of this.previewUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this.previewUrls.clear();
  }

  private revokePreview(id: string): void {
    const url = this.previewUrls.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      this.previewUrls.delete(id);
    }
  }

  // -- IndexedDB index -------------------------------------------------------

  private openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(LocalLibraryProvider.DB_NAME, LocalLibraryProvider.DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(LocalLibraryProvider.STORE)) {
            const store = db.createObjectStore(LocalLibraryProvider.STORE, { keyPath: 'id' });
            store.createIndex(LocalLibraryProvider.INDEX_UPDATED, 'updatedAt');
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB open error'));
      } catch (err) {
        reject(err);
      }
    });
  }

  private async listManifests(): Promise<LibraryItemManifest[]> {
    const db = await this.openDb();
    try {
      return await new Promise<LibraryItemManifest[]>((resolve, reject) => {
        const tx = db.transaction(LocalLibraryProvider.STORE, 'readonly');
        const index = tx
          .objectStore(LocalLibraryProvider.STORE)
          .index(LocalLibraryProvider.INDEX_UPDATED);
        const results: LibraryItemManifest[] = [];
        const cursorReq = index.openCursor(null, 'prev');
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            results.push(cursor.value as LibraryItemManifest);
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

  private async getManifest(id: string): Promise<LibraryItemManifest | null> {
    const db = await this.openDb();
    try {
      return await new Promise<LibraryItemManifest | null>((resolve, reject) => {
        const tx = db.transaction(LocalLibraryProvider.STORE, 'readonly');
        const getReq = tx.objectStore(LocalLibraryProvider.STORE).get(id);
        getReq.onsuccess = () =>
          resolve((getReq.result as LibraryItemManifest | undefined) ?? null);
        getReq.onerror = () => reject(getReq.error ?? new Error('IndexedDB get error'));
      });
    } finally {
      db.close();
    }
  }

  private async putManifest(manifest: LibraryItemManifest): Promise<void> {
    const db = await this.openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(LocalLibraryProvider.STORE, 'readwrite');
        tx.objectStore(LocalLibraryProvider.STORE).put(manifest);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction error'));
      });
    } finally {
      db.close();
    }
  }

  private async deleteManifest(id: string): Promise<void> {
    const db = await this.openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(LocalLibraryProvider.STORE, 'readwrite');
        tx.objectStore(LocalLibraryProvider.STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction error'));
      });
    } finally {
      db.close();
    }
  }

  // -- OPFS bundle files -----------------------------------------------------

  private getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
    if (!this.opfsRootPromise) {
      const storage = globalThis.navigator.storage as StorageManagerWithDirectory;
      this.opfsRootPromise = storage.getDirectory!()
        .then(root => root.getDirectoryHandle(LocalLibraryProvider.OPFS_ROOT, { create: true }))
        .catch(err => {
          this.opfsRootPromise = null;
          throw err;
        });
    }
    return this.opfsRootPromise;
  }

  private async getItemDirectory(
    id: string,
    create: boolean
  ): Promise<FileSystemDirectoryHandle | null> {
    const root = await this.getOpfsRoot();
    try {
      return await root.getDirectoryHandle(encodeURIComponent(id), { create });
    } catch {
      return null;
    }
  }

  private async writeOpfsFile(
    itemDir: FileSystemDirectoryHandle,
    relativePath: string,
    blob: Blob
  ): Promise<void> {
    const segments = relativePath.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (!fileName) {
      return;
    }
    let dir = itemDir;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(blob);
    } finally {
      await writable.close();
    }
  }

  private async readOpfsFile(
    itemDir: FileSystemDirectoryHandle,
    relativePath: string
  ): Promise<Blob | null> {
    const segments = relativePath.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (!fileName) {
      return null;
    }
    let dir = itemDir;
    try {
      for (const segment of segments) {
        dir = await dir.getDirectoryHandle(segment, { create: false });
      }
      const fileHandle = await dir.getFileHandle(fileName, { create: false });
      return await fileHandle.getFile();
    } catch {
      return null;
    }
  }

  private async deleteItemDirectory(id: string): Promise<void> {
    try {
      const root = await this.getOpfsRoot();
      await root.removeEntry(encodeURIComponent(id), { recursive: true });
    } catch {
      // NotFoundError (nothing to delete) or unsupported — ignore.
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
