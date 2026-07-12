import { parse } from 'yaml';

import { injectable, ServiceContainer } from '@/fw/di';

export type FileSystemAPIErrorCode =
  | 'not-initialized'
  | 'permission-denied'
  | 'not-found'
  | 'invalid-path'
  | 'unsupported'
  | 'parse-error'
  | 'unknown';

export class FileSystemAPIError extends Error {
  readonly code: FileSystemAPIErrorCode;
  readonly cause?: unknown;

  constructor(code: FileSystemAPIErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'FileSystemAPIError';
    this.code = code;
    this.cause = cause;
  }
}

export interface FileDescriptor {
  readonly name: string;
  readonly kind: FileSystemHandleKind;
  readonly path: string;
  readonly size?: number | null;
}

export interface FileSystemAPIServiceOptions {
  readonly directoryPicker?: () => Promise<FileSystemDirectoryHandle>;
  readonly yamlParser?: (contents: string) => unknown;
  readonly logger?: (message: string, error?: unknown) => void;
  readonly resourcePrefix?: string;
}

export interface ReadSceneResult<TScene = unknown> {
  readonly scene: TScene;
  readonly raw: string;
}

const DEFAULT_RESOURCE_PREFIX = 'res://';
const VSCODE_INTEGRATED_BROWSER_DIRECTORY_PICKER_MESSAGE =
  'Opening local folders is not supported in the VS Code integrated browser. Open Pix3 in Chrome or another standalone Chromium browser to choose a project directory.';

type PermissionMode = 'read' | 'readwrite';
export type { PermissionMode };
type PermissionState = 'prompt' | 'granted' | 'denied';

// IDB Helper for Service Worker sharing
const DB_NAME = 'pix3-db';
const STORE_NAME = 'handles';
const HANDLE_KEY = 'project-root';

async function saveHandleToDB(handle: FileSystemDirectoryHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = event => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = event => {
      const db = (event.target as IDBOpenDBRequest).result;
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(handle, HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

@injectable()
export class FileSystemAPIService {
  private directoryHandle: FileSystemDirectoryHandle | null = null;
  private readonly directoryPicker: () => Promise<FileSystemDirectoryHandle>;
  private readonly parseYaml: (contents: string) => unknown;
  private readonly logger?: (message: string, error?: unknown) => void;
  private readonly resourcePrefix: string;

  constructor(options: FileSystemAPIServiceOptions = {}) {
    this.directoryPicker = options.directoryPicker ?? this.getDefaultDirectoryPicker();
    this.parseYaml = options.yamlParser ?? ((contents: string) => parse(contents));
    this.logger = options.logger;
    this.resourcePrefix = options.resourcePrefix ?? DEFAULT_RESOURCE_PREFIX;
  }

  dispose(): void {
    this.directoryHandle = null;
  }

  setProjectDirectory(handle: FileSystemDirectoryHandle): void {
    this.directoryHandle = handle;
    saveHandleToDB(handle).catch(err => this.logger?.('Failed to save project handle to IDB', err));
  }

  getProjectDirectory(): FileSystemDirectoryHandle | null {
    return this.directoryHandle;
  }

  async requestProjectDirectory(
    mode: PermissionMode = 'readwrite'
  ): Promise<FileSystemDirectoryHandle> {
    try {
      const handle = await this.directoryPicker();
      await this.ensurePermission(handle, mode);
      this.directoryHandle = handle;
      return handle;
    } catch (error) {
      throw this.normalizeDirectoryPickerError(error);
    }
  }

  /**
   * Open the directory picker WITHOUT adopting the result as the active project
   * directory. Used by flows that need a second folder handle (e.g. moving a
   * browser project to disk) while the current project stays loaded.
   */
  async pickDirectory(mode: PermissionMode = 'readwrite'): Promise<FileSystemDirectoryHandle> {
    try {
      const handle = await this.directoryPicker();
      await this.ensurePermission(handle, mode);
      return handle;
    } catch (error) {
      throw this.normalizeDirectoryPickerError(error);
    }
  }

  async ensurePermission(
    handle: FileSystemHandle | null = this.directoryHandle,
    mode: PermissionMode = 'read'
  ): Promise<void> {
    if (!handle) {
      throw new FileSystemAPIError('not-initialized', 'Project directory has not been set.');
    }

    const permissionHandle = handle as FileSystemHandle & {
      queryPermission?: (descriptor: { mode: PermissionMode }) => Promise<PermissionState>;
      requestPermission?: (descriptor: { mode: PermissionMode }) => Promise<PermissionState>;
    };

    if (!permissionHandle.queryPermission || !permissionHandle.requestPermission) {
      // Handles without the permission API are always accessible: OPFS
      // (browser-storage) handles never expose it, and Firefox/Safari omit it
      // even for picked directories. Treat the absence as an implicit grant.
      return;
    }

    const queryResult = await permissionHandle.queryPermission({ mode });

    if (queryResult === 'granted') {
      return;
    }

    const requestResult = await permissionHandle.requestPermission({ mode });

    if (requestResult !== 'granted') {
      throw new FileSystemAPIError(
        'permission-denied',
        'Permission denied for requested operation.'
      );
    }
  }

  async readTextFile(path: string, options?: { mode?: PermissionMode }): Promise<string> {
    const fileHandle = await this.resolveFileHandle(path, options?.mode ?? 'read');
    try {
      const file = await fileHandle.getFile();
      return await file.text();
    } catch (error) {
      throw this.normalizeError(error, `Failed to read file at ${path}`);
    }
  }

  async readBlob(path: string, options?: { mode?: PermissionMode }): Promise<Blob> {
    const fileHandle = await this.resolveFileHandle(path, options?.mode ?? 'read');
    try {
      return await fileHandle.getFile();
    } catch (error) {
      throw this.normalizeError(error, `Failed to read blob at ${path}`);
    }
  }

  async readScene<TScene = unknown>(
    path: string,
    options?: { mode?: PermissionMode }
  ): Promise<ReadSceneResult<TScene>> {
    const text = await this.readTextFile(path, options);
    try {
      const scene = this.parseYaml(text) as TScene;
      return { scene, raw: text };
    } catch (error) {
      throw new FileSystemAPIError('parse-error', `Failed to parse YAML at ${path}`, error);
    }
  }

  async listDirectory(path = '.', options?: { mode?: PermissionMode }): Promise<FileDescriptor[]> {
    const directory = await this.resolveDirectoryHandle(path, options?.mode ?? 'read');
    const entries: FileDescriptor[] = [];
    const mode = options?.mode ?? 'read';

    try {
      const directoryWithEntries = directory as FileSystemDirectoryHandle & {
        entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
        values?: () => AsyncIterableIterator<FileSystemHandle & { name?: string }>;
      };

      if (directoryWithEntries.entries) {
        for await (const [name, handle] of directoryWithEntries.entries()) {
          entries.push(await this.describeEntry(handle, name, this.joinPath(path, name), mode));
        }
        return entries;
      }

      if (directoryWithEntries.values) {
        let index = 0;
        for await (const handle of directoryWithEntries.values()) {
          const name = (handle as FileSystemHandle).name ?? `entry-${index}`;
          entries.push({
            ...(await this.describeEntry(handle, name, this.joinPath(path, name), mode)),
          });
          index += 1;
        }
        return entries;
      }
    } catch (error) {
      throw this.normalizeError(error, `Failed to list directory at ${path}`);
    }

    return entries;
  }

  private async describeEntry(
    handle: FileSystemHandle,
    name: string,
    path: string,
    mode: PermissionMode
  ): Promise<FileDescriptor> {
    if (handle.kind === 'file') {
      const fileHandle = handle as FileSystemFileHandle;
      await this.ensurePermission(fileHandle, mode);
      const file = await fileHandle.getFile();
      return {
        name,
        kind: handle.kind,
        path,
        size: file.size,
      };
    }

    return {
      name,
      kind: handle.kind,
      path,
      size: null,
    };
  }

  async getFileHandle(
    path: string,
    options?: { mode?: PermissionMode }
  ): Promise<FileSystemFileHandle> {
    return this.resolveFileHandle(path, options?.mode ?? 'read');
  }

  /**
   * Get a directory handle for a given path (e.g., res://path/to/directory or res://scenes/).
   * This resolves the directory path and returns its handle.
   */
  async getDirectoryHandleForPath(
    path: string,
    options?: { mode?: PermissionMode }
  ): Promise<FileSystemDirectoryHandle> {
    return this.resolveDirectoryHandle(path, options?.mode ?? 'read');
  }

  normalizeResourcePath(path: string): string {
    if (path.startsWith(this.resourcePrefix)) {
      return path.slice(this.resourcePrefix.length);
    }
    return path;
  }

  private getDefaultDirectoryPicker(): () => Promise<FileSystemDirectoryHandle> {
    return async () => {
      const globalWindow =
        typeof window === 'undefined'
          ? undefined
          : (window as Window &
              typeof globalThis & {
                showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
              });

      const picker = globalWindow?.showDirectoryPicker;
      if (typeof picker !== 'function') {
        if (this.isVsCodeElectronEnvironment()) {
          throw new FileSystemAPIError(
            'unsupported',
            VSCODE_INTEGRATED_BROWSER_DIRECTORY_PICKER_MESSAGE
          );
        }
        throw new FileSystemAPIError(
          'unsupported',
          'showDirectoryPicker is not available in this environment.'
        );
      }
      return await picker.call(globalWindow);
    };
  }

  private async resolveFileHandle(
    path: string,
    mode: PermissionMode
  ): Promise<FileSystemFileHandle> {
    const directory = await this.resolveDirectoryHandle(this.getDirectoryPart(path), mode);
    const fileName = this.getFileName(path);

    try {
      const handle = await directory.getFileHandle(fileName);
      await this.ensurePermission(handle, mode);
      return handle;
    } catch (error) {
      throw this.normalizeResolutionError(error, path, 'file');
    }
  }

  private async resolveDirectoryHandle(
    path: string,
    mode: PermissionMode
  ): Promise<FileSystemDirectoryHandle> {
    const normalizedPath = this.normalizeResourcePath(path);
    const segments = this.splitPath(normalizedPath).filter(segment => segment.length > 0);

    const root = this.directoryHandle;
    if (!root) {
      throw new FileSystemAPIError('not-initialized', 'Project directory has not been set.');
    }

    let current: FileSystemDirectoryHandle = root;
    await this.ensurePermission(current, mode);

    for (const segment of segments) {
      try {
        current = await current.getDirectoryHandle(segment);
        await this.ensurePermission(current, mode);
      } catch (error) {
        throw this.normalizeResolutionError(error, path, 'directory');
      }
    }

    return current;
  }

  private splitPath(path: string): string[] {
    return path
      .replace(/^[\\/]+/, '')
      .replace(/\\+/g, '/')
      .split('/')
      .filter(segment => segment.length > 0 && segment !== '.');
  }

  private getDirectoryPart(path: string): string {
    const normalizedPath = this.normalizeResourcePath(path);
    const segments = this.splitPath(normalizedPath);
    return segments.slice(0, -1).join('/') || '.';
  }

  private getFileName(path: string): string {
    const normalizedPath = this.normalizeResourcePath(path);
    const segments = this.splitPath(normalizedPath);
    if (!segments.length) {
      throw new FileSystemAPIError('invalid-path', 'File path must include a file name.');
    }
    return segments[segments.length - 1];
  }

  private joinPath(base: string, name: string): string {
    if (base === '.' || base === '') {
      return name;
    }
    return `${base.replace(/\\+/g, '/').replace(/\/$/, '')}/${name}`;
  }

  private normalizeDirectoryPickerError(error: unknown): FileSystemAPIError {
    if (
      error instanceof DOMException &&
      error.name === 'AbortError' &&
      this.isVsCodeElectronEnvironment()
    ) {
      return new FileSystemAPIError(
        'unsupported',
        VSCODE_INTEGRATED_BROWSER_DIRECTORY_PICKER_MESSAGE,
        error
      );
    }

    return this.normalizeError(error, 'Failed to request project directory');
  }

  private isVsCodeElectronEnvironment(): boolean {
    if (typeof navigator === 'undefined') {
      return false;
    }

    const userAgent = navigator.userAgent ?? '';
    return userAgent.includes('Code/') && userAgent.includes('Electron/');
  }

  private normalizeError(error: unknown, message: string): FileSystemAPIError {
    if (error instanceof FileSystemAPIError) {
      return error;
    }

    // Surface the underlying cause in the message — a bare "Failed to write
    // file at X" hides whether it was permissions, a missing parent directory,
    // or a name the browser refused.
    const detail =
      error instanceof DOMException
        ? ` (${error.name}: ${error.message})`
        : error instanceof Error
          ? ` (${error.message})`
          : '';
    const detailedMessage = `${message}${detail}`;

    if (error instanceof DOMException) {
      if (error.name === 'NotAllowedError') {
        return new FileSystemAPIError('permission-denied', detailedMessage, error);
      }
      if (error.name === 'NotFoundError') {
        return new FileSystemAPIError('not-found', detailedMessage, error);
      }
    }

    this.logger?.(detailedMessage, error);
    return new FileSystemAPIError('unknown', detailedMessage, error);
  }

  private normalizeResolutionError(
    error: unknown,
    path: string,
    type: 'file' | 'directory'
  ): FileSystemAPIError {
    const message = `Unable to resolve ${type} at ${path}`;
    const normalized = this.normalizeError(error, message);
    if (normalized.code === 'unknown') {
      return new FileSystemAPIError('not-found', message, error);
    }
    return normalized;
  }

  /**
   * Create a directory at the given project-relative path. The path may be nested.
   * Example: 'assets/levels/newFolder'
   */
  async createDirectory(path: string): Promise<void> {
    try {
      console.log(`[FileSystemAPIService] Creating directory: ${path}`);
      const normalizedPath = this.normalizeResourcePath(path);
      const segments = this.splitPath(normalizedPath).filter(segment => segment.length > 0);
      console.log(`[FileSystemAPIService] Path segments:`, segments);

      const root = this.directoryHandle;
      if (!root) {
        throw new FileSystemAPIError('not-initialized', 'Project directory has not been set.');
      }

      let current: FileSystemDirectoryHandle = root;
      await this.ensurePermission(current, 'readwrite');

      // Create each directory segment in the path
      for (const segment of segments) {
        console.log(`[FileSystemAPIService] Creating segment: ${segment}`);
        current = await current.getDirectoryHandle(segment, { create: true });
        await this.ensurePermission(current, 'readwrite');
      }
      console.log(`[FileSystemAPIService] Successfully created directory: ${path}`);
    } catch (error) {
      console.error(`[FileSystemAPIService] Error creating directory ${path}:`, error);
      throw this.normalizeError(error, `Failed to create directory at ${path}`);
    }
  }

  async writeTextFile(path: string, contents: string): Promise<void> {
    try {
      const directory = await this.resolveDirectoryHandle(this.getDirectoryPart(path), 'readwrite');
      const fileName = this.getFileName(path);
      const handle = await directory.getFileHandle(fileName, { create: true });
      await this.ensurePermission(handle, 'readwrite');
      const writable = await handle.createWritable();
      await writable.write(contents);
      await writable.close();
    } catch (error) {
      throw this.normalizeError(error, `Failed to write file at ${path}`);
    }
  }

  async writeBinaryFile(path: string, data: ArrayBuffer): Promise<void> {
    try {
      const directory = await this.resolveDirectoryHandle(this.getDirectoryPart(path), 'readwrite');
      const fileName = this.getFileName(path);
      const handle = await directory.getFileHandle(fileName, { create: true });
      await this.ensurePermission(handle, 'readwrite');
      const writable = await handle.createWritable();
      await writable.write(data);
      await writable.close();
    } catch (error) {
      throw this.normalizeError(error, `Failed to write binary file at ${path}`);
    }
  }

  async deleteEntry(path: string): Promise<void> {
    try {
      const parentPath = this.getDirectoryPart(path);
      const entryName = this.getFileName(path);
      const parentHandle = await this.resolveDirectoryHandle(parentPath, 'readwrite');
      await parentHandle.removeEntry(entryName, { recursive: true });
    } catch (error) {
      throw this.normalizeError(error, `Failed to delete entry at ${path}`);
    }
  }

  /**
   * Move a file or directory from source to target path.
   * Uses copy + delete approach since File System API doesn't provide native move.
   */
  async moveEntry(sourcePath: string, targetPath: string): Promise<void> {
    try {
      const sourceDesc = await this.getEntryDescription(sourcePath);
      if (!sourceDesc) {
        throw new Error(`Source entry not found at ${sourcePath}`);
      }

      if (sourceDesc.kind === 'file') {
        // For files: read, write, delete
        const content = await this.readTextFile(sourcePath);
        await this.writeTextFile(targetPath, content);
        await this.deleteEntry(sourcePath);
      } else {
        // For directories: recursive copy then delete
        await this.copyDirectory(sourcePath, targetPath);
        await this.deleteEntry(sourcePath);
      }
    } catch (error) {
      throw this.normalizeError(error, `Failed to move entry from ${sourcePath} to ${targetPath}`);
    }
  }

  /**
   * Recursively copy a directory structure
   */
  private async copyDirectory(sourceDir: string, targetDir: string): Promise<void> {
    // Create target directory
    await this.createDirectory(targetDir);

    // List source directory contents
    const entries = await this.listDirectory(sourceDir);

    // Copy each entry
    for (const entry of entries) {
      const sourcePath = `${sourceDir}/${entry.name}`;
      const targetPath = `${targetDir}/${entry.name}`;

      if (entry.kind === 'file') {
        const content = await this.readTextFile(sourcePath);
        await this.writeTextFile(targetPath, content);
      } else {
        await this.copyDirectory(sourcePath, targetPath);
      }
    }
  }

  /** Whether a directory handle has no children. */
  async isDirectoryEmpty(handle: FileSystemDirectoryHandle): Promise<boolean> {
    const dir = handle as FileSystemDirectoryHandle & {
      keys?: () => AsyncIterableIterator<string>;
    };
    if (typeof dir.keys !== 'function') {
      return true;
    }
    const first = await dir.keys().next();
    return Boolean(first.done);
  }

  /**
   * Recursively copy the contents of one directory handle into another,
   * binary-safe. Operates directly on the supplied handles (not the active
   * project handle), so it works between arbitrary locations — e.g. copying an
   * OPFS browser-project directory into a user-picked folder on disk.
   */
  async copyDirectoryContents(
    source: FileSystemDirectoryHandle,
    target: FileSystemDirectoryHandle
  ): Promise<void> {
    const dir = source as FileSystemDirectoryHandle & {
      entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
      values?: () => AsyncIterableIterator<FileSystemHandle & { name?: string }>;
    };

    const forEachChild = async (
      handler: (name: string, handle: FileSystemHandle) => Promise<void>
    ): Promise<void> => {
      if (dir.entries) {
        for await (const [name, handle] of dir.entries()) {
          await handler(name, handle);
        }
        return;
      }
      if (dir.values) {
        for await (const handle of dir.values()) {
          await handler((handle as { name?: string }).name ?? '', handle);
        }
      }
    };

    await forEachChild(async (name, handle) => {
      if (!name) {
        return;
      }
      if (handle.kind === 'directory') {
        const childTarget = await target.getDirectoryHandle(name, { create: true });
        await this.copyDirectoryContents(handle as FileSystemDirectoryHandle, childTarget);
      } else {
        const file = await (handle as FileSystemFileHandle).getFile();
        const dest = await target.getFileHandle(name, { create: true });
        const writable = await dest.createWritable();
        await writable.write(await file.arrayBuffer());
        await writable.close();
      }
    });
  }

  /**
   * Get description of an entry (file or directory)
   */
  private async getEntryDescription(path: string): Promise<FileDescriptor | null> {
    try {
      const entries = await this.listDirectory(this.getDirectoryPart(path));
      const name = this.getFileName(path);
      return entries.find(e => e.name === name) || null;
    } catch {
      return null;
    }
  }

  /**
   * Check if a fileHandle is within the project directory.
   * Uses isSameEntry API if available to verify containment.
   */
  async isHandleInProject(fileHandle: FileSystemFileHandle): Promise<boolean> {
    try {
      if (!this.directoryHandle) {
        return false;
      }

      const projectDirWithEntries = this.directoryHandle as FileSystemDirectoryHandle & {
        resolve?: (handle: FileSystemHandle) => Promise<string[]>;
      };

      if (projectDirWithEntries.resolve) {
        try {
          // resolve() returns the path from project root to the file
          const pathSegments = await projectDirWithEntries.resolve(fileHandle);
          console.debug('[FileSystemAPIService] File is within project', {
            pathSegments,
            isInProject: pathSegments && pathSegments.length > 0,
          });
          return !!(pathSegments && pathSegments.length > 0);
        } catch (error) {
          // resolve not supported or file is outside project
          console.debug('[FileSystemAPIService] Unable to resolve file path relative to project', {
            error,
          });
          return false;
        }
      }

      return false;
    } catch (error) {
      console.debug('[FileSystemAPIService] Error checking if handle is in project', { error });
      return false;
    }
  }

  /**
   * Resolve a file handle to a project-relative `res://` resource path.
   * Returns null if the handle is not within the current project or resolution is unsupported.
   */
  async resolveHandleToResourcePath(fileHandle: FileSystemFileHandle): Promise<string | null> {
    if (!this.directoryHandle) {
      return null;
    }

    const projectDirWithResolve = this.directoryHandle as FileSystemDirectoryHandle & {
      resolve?: (handle: FileSystemHandle) => Promise<string[]>;
    };

    if (!projectDirWithResolve.resolve) {
      return null;
    }

    try {
      const pathSegments = await projectDirWithResolve.resolve(fileHandle);
      if (!pathSegments || pathSegments.length === 0) {
        return null;
      }
      return `${this.resourcePrefix}${pathSegments.join('/')}`;
    } catch {
      return null;
    }
  }
}

export const resolveFileSystemAPIService = (): FileSystemAPIService => {
  return ServiceContainer.getInstance().getService(
    ServiceContainer.getInstance().getOrCreateToken(FileSystemAPIService)
  ) as FileSystemAPIService;
};
