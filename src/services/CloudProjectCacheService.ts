import { injectable } from '@/fw/di';
import type { ManifestEntry } from './ApiClient';

const DATABASE_NAME = 'pix3-cloud-cache';
const DATABASE_VERSION = 1;
const STORE_NAME = 'entries';
const OPFS_ROOT_DIRECTORY = 'pix3-cloud-cache';

const TEXT_FILE_EXTENSIONS = new Set([
  'css',
  'frag',
  'glsl',
  'html',
  'js',
  'json',
  'jsx',
  'less',
  'md',
  'pix3scene',
  'scss',
  'svg',
  'ts',
  'tsx',
  'txt',
  'vert',
  'wgsl',
  'yaml',
  'yml',
]);

type CloudCacheStorageKind = 'text' | 'idb-blob' | 'opfs';

interface CloudCacheRecord {
  key: string;
  projectId: string;
  path: string;
  storage: CloudCacheStorageKind;
  hash: string | null;
  modified: string | null;
  size: number | null;
  textContent?: string;
  blobContent?: Blob;
  opfsPath?: string | null;
}

interface CacheEntryMetadata {
  hash?: string | null;
  modified?: string | null;
  size?: number | null;
}

@injectable()
export class CloudProjectCacheService {
  private databasePromise: Promise<IDBDatabase | null> | null = null;
  private opfsRootPromise: Promise<FileSystemDirectoryHandle | null> | null = null;

  async isEntryFresh(projectId: string, entry: ManifestEntry): Promise<boolean> {
    if (entry.kind !== 'file') {
      return true;
    }

    const record = await this.getRecord(projectId, entry.path);
    if (!record) {
      return false;
    }

    if (
      record.hash !== entry.hash ||
      record.modified !== entry.modified ||
      record.size !== entry.size
    ) {
      return false;
    }

    if (record.storage === 'opfs') {
      return await this.opfsFileExists(projectId, record.opfsPath ?? record.path);
    }

    if (record.storage === 'text') {
      return typeof record.textContent === 'string';
    }

    return record.blobContent instanceof Blob;
  }

  async readTextFile(projectId: string, path: string): Promise<string | null> {
    const normalizedPath = this.normalizePath(path);
    const record = await this.getRecord(projectId, normalizedPath);
    if (!record) {
      return null;
    }

    if (record.storage === 'text') {
      return record.textContent ?? '';
    }

    const blob = await this.readBlob(projectId, normalizedPath);
    return blob ? await blob.text() : null;
  }

  async readBlob(projectId: string, path: string): Promise<Blob | null> {
    const normalizedPath = this.normalizePath(path);
    const record = await this.getRecord(projectId, normalizedPath);
    if (!record) {
      return null;
    }

    if (record.storage === 'text') {
      return new Blob([record.textContent ?? ''], { type: 'text/plain' });
    }

    if (record.storage === 'idb-blob') {
      return record.blobContent ?? null;
    }

    return await this.readBlobFromOpfs(projectId, record.opfsPath ?? normalizedPath);
  }

  async storeTextFile(
    projectId: string,
    path: string,
    contents: string,
    metadata: CacheEntryMetadata = {}
  ): Promise<void> {
    const normalizedPath = this.normalizePath(path);
    await this.deleteOpfsFile(projectId, normalizedPath);
    await this.putRecord({
      key: this.buildKey(projectId, normalizedPath),
      projectId,
      path: normalizedPath,
      storage: 'text',
      hash: metadata.hash ?? null,
      modified: metadata.modified ?? null,
      size: metadata.size ?? contents.length,
      textContent: contents,
      opfsPath: null,
    });
  }

  async storeBlobFile(
    projectId: string,
    path: string,
    blob: Blob,
    metadata: CacheEntryMetadata = {}
  ): Promise<void> {
    const normalizedPath = this.normalizePath(path);

    if (this.isTextPath(normalizedPath)) {
      await this.storeTextFile(projectId, normalizedPath, await blob.text(), {
        hash: metadata.hash ?? null,
        modified: metadata.modified ?? null,
        size: metadata.size ?? blob.size,
      });
      return;
    }

    const opfsPath = await this.writeBlobToOpfs(projectId, normalizedPath, blob);
    await this.putRecord({
      key: this.buildKey(projectId, normalizedPath),
      projectId,
      path: normalizedPath,
      storage: opfsPath ? 'opfs' : 'idb-blob',
      hash: metadata.hash ?? null,
      modified: metadata.modified ?? null,
      size: metadata.size ?? blob.size,
      blobContent: opfsPath ? undefined : blob,
      opfsPath,
    });
  }

  async reconcileManifest(projectId: string, manifest: readonly ManifestEntry[]): Promise<void> {
    const nextPaths = new Set(
      manifest.filter(entry => entry.kind === 'file').map(entry => this.normalizePath(entry.path))
    );
    const keys = await this.listProjectKeys(projectId);
    for (const key of keys) {
      const record = await this.getRecordByKey(key);
      if (!record) {
        continue;
      }

      if (!nextPaths.has(record.path)) {
        await this.deleteRecord(record);
      }
    }
  }

  async invalidatePath(
    projectId: string,
    path: string,
    options: { recursive?: boolean } = {}
  ): Promise<void> {
    const normalizedPath = this.normalizePath(path);
    const keys = await this.listProjectKeys(projectId);
    const shouldDeleteAll = normalizedPath === '.' && options.recursive;
    for (const key of keys) {
      const record = await this.getRecordByKey(key);
      if (!record) {
        continue;
      }

      if (shouldDeleteAll) {
        await this.deleteRecord(record);
        continue;
      }

      if (record.path === normalizedPath) {
        await this.deleteRecord(record);
        continue;
      }

      if (options.recursive && record.path.startsWith(`${normalizedPath}/`)) {
        await this.deleteRecord(record);
      }
    }
  }

  async clearProject(projectId: string): Promise<void> {
    await this.invalidatePath(projectId, '.', { recursive: true });
  }

  dispose(): void {
    const databasePromise = this.databasePromise;
    this.databasePromise = null;
    this.opfsRootPromise = null;
    databasePromise
      ?.then(database => {
        database?.close();
      })
      .catch(() => undefined);
  }

  private isTextPath(path: string): boolean {
    const normalizedPath = this.normalizePath(path);
    if (normalizedPath === 'pix3project.yaml') {
      return true;
    }

    const segments = normalizedPath.split('/');
    const fileName = segments[segments.length - 1] ?? normalizedPath;
    const extension = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : '';
    return Boolean(extension && TEXT_FILE_EXTENSIONS.has(extension));
  }

  private normalizePath(path: string): string {
    if (!path || path === '.') {
      return '.';
    }

    return (
      path
        .replace(/^res:\/\//i, '')
        .replace(/^\.\/+/, '')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')
        .replace(/\\+/g, '/') || '.'
    );
  }

  private buildKey(projectId: string, path: string): string {
    return `${projectId}:${this.normalizePath(path)}`;
  }

  private async openDatabase(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') {
      return null;
    }

    if (!this.databasePromise) {
      this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

        request.onupgradeneeded = event => {
          const database = (event.target as IDBOpenDBRequest).result;
          if (!database.objectStoreNames.contains(STORE_NAME)) {
            database.createObjectStore(STORE_NAME, { keyPath: 'key' });
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

  private async getRecord(projectId: string, path: string): Promise<CloudCacheRecord | null> {
    return this.getRecordByKey(this.buildKey(projectId, path));
  }

  private async getRecordByKey(key: string): Promise<CloudCacheRecord | null> {
    const database = await this.openDatabase();
    if (!database) {
      return null;
    }

    return await new Promise<CloudCacheRecord | null>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);

      request.onsuccess = () => {
        const result = request.result;
        resolve(result ? (result as CloudCacheRecord) : null);
      };
      request.onerror = () => reject(request.error ?? new Error('IndexedDB get error'));
    });
  }

  private async putRecord(record: CloudCacheRecord): Promise<void> {
    const database = await this.openDatabase();
    if (!database) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(record);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('IndexedDB put error'));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('IndexedDB transaction error'));
    });
  }

  private async deleteRecord(record: CloudCacheRecord): Promise<void> {
    if (record.storage === 'opfs') {
      await this.deleteOpfsFile(record.projectId, record.opfsPath ?? record.path);
    }

    const database = await this.openDatabase();
    if (!database) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(record.key);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('IndexedDB delete error'));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('IndexedDB transaction error'));
    });
  }

  private async listProjectKeys(projectId: string): Promise<string[]> {
    const database = await this.openDatabase();
    if (!database) {
      return [];
    }

    const prefix = `${projectId}:`;
    return await new Promise<string[]>((resolve, reject) => {
      const keys: string[] = [];
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
      const request = store.openCursor(range);

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(keys);
          return;
        }

        keys.push(String(cursor.primaryKey));
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor error'));
    });
  }

  private async getOpfsRoot(): Promise<FileSystemDirectoryHandle | null> {
    if (typeof navigator === 'undefined') {
      return null;
    }

    if (!this.opfsRootPromise) {
      this.opfsRootPromise = (async () => {
        const storageManager = navigator.storage as StorageManager & {
          getDirectory?: () => Promise<FileSystemDirectoryHandle>;
        };
        if (typeof storageManager?.getDirectory !== 'function') {
          return null;
        }

        try {
          const root = await storageManager.getDirectory();
          return await root.getDirectoryHandle(OPFS_ROOT_DIRECTORY, { create: true });
        } catch {
          return null;
        }
      })();
    }

    return this.opfsRootPromise;
  }

  private async getOpfsProjectDirectory(
    projectId: string,
    options: { create?: boolean } = {}
  ): Promise<FileSystemDirectoryHandle | null> {
    const root = await this.getOpfsRoot();
    if (!root) {
      return null;
    }

    try {
      return await root.getDirectoryHandle(encodeURIComponent(projectId), {
        create: options.create ?? false,
      });
    } catch {
      return null;
    }
  }

  private async writeBlobToOpfs(
    projectId: string,
    path: string,
    blob: Blob
  ): Promise<string | null> {
    const directory = await this.getOpfsProjectDirectory(projectId, { create: true });
    if (!directory) {
      return null;
    }

    const segments = this.normalizePath(path).split('/').filter(Boolean);
    if (segments.length === 0) {
      return null;
    }

    let currentDirectory = directory;
    for (const segment of segments.slice(0, -1)) {
      currentDirectory = await currentDirectory.getDirectoryHandle(segment, { create: true });
    }

    const fileName = segments[segments.length - 1];
    const fileHandle = await currentDirectory.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(blob);
    } finally {
      await writable.close();
    }

    return this.normalizePath(path);
  }

  private async readBlobFromOpfs(projectId: string, path: string): Promise<Blob | null> {
    const directory = await this.getOpfsProjectDirectory(projectId);
    if (!directory) {
      return null;
    }

    const segments = this.normalizePath(path).split('/').filter(Boolean);
    if (segments.length === 0) {
      return null;
    }

    try {
      let currentDirectory = directory;
      for (const segment of segments.slice(0, -1)) {
        currentDirectory = await currentDirectory.getDirectoryHandle(segment);
      }

      const fileHandle = await currentDirectory.getFileHandle(segments[segments.length - 1]);
      return await fileHandle.getFile();
    } catch {
      return null;
    }
  }

  private async opfsFileExists(projectId: string, path: string): Promise<boolean> {
    const blob = await this.readBlobFromOpfs(projectId, path);
    return blob instanceof Blob;
  }

  private async deleteOpfsFile(projectId: string, path: string): Promise<void> {
    const directory = await this.getOpfsProjectDirectory(projectId);
    if (!directory) {
      return;
    }

    const segments = this.normalizePath(path).split('/').filter(Boolean);
    if (segments.length === 0) {
      return;
    }

    try {
      let currentDirectory = directory;
      for (const segment of segments.slice(0, -1)) {
        currentDirectory = await currentDirectory.getDirectoryHandle(segment);
      }

      await currentDirectory.removeEntry(segments[segments.length - 1]);
    } catch {
      // Cache invalidation should stay best-effort.
    }
  }
}
