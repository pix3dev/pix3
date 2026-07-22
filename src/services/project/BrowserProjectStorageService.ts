import { injectable } from '@/fw/di';

const OPFS_ROOT_DIRECTORY = 'pix3-browser-projects';

type StorageManagerWithDirectory = StorageManager & {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  persist?: () => Promise<boolean>;
};

/**
 * Stores "browser" projects inside the Origin Private File System (OPFS).
 *
 * Each project lives in `pix3-browser-projects/<projectSessionId>/` and is a
 * plain {@link FileSystemDirectoryHandle} — identical in shape to a handle
 * returned by the directory picker — so the rest of the file stack
 * (FileSystemAPIService → ProjectStorageService → scenes/assets) works against
 * it unchanged. This backend needs no directory picker and no authentication,
 * which is what makes "instant start" possible.
 */
@injectable()
export class BrowserProjectStorageService {
  private rootPromise: Promise<FileSystemDirectoryHandle> | null = null;

  /** Whether OPFS is available in this environment. */
  isSupported(): boolean {
    if (typeof navigator === 'undefined') {
      return false;
    }
    const storage = navigator.storage as StorageManagerWithDirectory | undefined;
    return typeof storage?.getDirectory === 'function';
  }

  /** Resolve (creating if needed) the shared `pix3-browser-projects` root. */
  async getRoot(): Promise<FileSystemDirectoryHandle> {
    if (!this.isSupported()) {
      throw new Error('Origin Private File System is not available in this browser.');
    }

    if (!this.rootPromise) {
      const storage = navigator.storage as StorageManagerWithDirectory;
      this.rootPromise = storage.getDirectory!()
        .then(root => root.getDirectoryHandle(OPFS_ROOT_DIRECTORY, { create: true }))
        .catch(error => {
          // Don't cache a rejected promise; a later call should retry.
          this.rootPromise = null;
          throw error;
        });
    }

    return this.rootPromise;
  }

  /**
   * Create a fresh project directory. Throws if a directory already exists for
   * this id, so callers never silently overwrite an existing project.
   */
  async createProjectDirectory(id: string): Promise<FileSystemDirectoryHandle> {
    const root = await this.getRoot();
    const existing = await this.tryGetChild(root, id);
    if (existing) {
      throw new Error(`A browser project with id "${id}" already exists.`);
    }
    return root.getDirectoryHandle(this.dirName(id), { create: true });
  }

  /** Resolve an existing project directory, or `null` if it no longer exists. */
  async getProjectDirectory(id: string): Promise<FileSystemDirectoryHandle | null> {
    if (!this.isSupported()) {
      return null;
    }
    const root = await this.getRoot();
    return this.tryGetChild(root, id);
  }

  /** Delete a project's directory tree from OPFS. No-op if already gone. */
  async deleteProject(id: string): Promise<void> {
    if (!this.isSupported()) {
      return;
    }
    const root = await this.getRoot();
    try {
      await root.removeEntry(this.dirName(id), { recursive: true });
    } catch (error) {
      if ((error as DOMException | undefined)?.name !== 'NotFoundError') {
        throw error;
      }
    }
  }

  /**
   * Best-effort request for persistent storage so the browser is less likely to
   * evict OPFS data under storage pressure. Failures are swallowed.
   */
  async requestPersistence(): Promise<void> {
    try {
      if (typeof navigator === 'undefined') {
        return;
      }
      const storage = navigator.storage as StorageManagerWithDirectory | undefined;
      if (typeof storage?.persist === 'function') {
        await storage.persist();
      }
    } catch {
      // best-effort; ignore
    }
  }

  private dirName(id: string): string {
    return encodeURIComponent(id);
  }

  private async tryGetChild(
    root: FileSystemDirectoryHandle,
    id: string
  ): Promise<FileSystemDirectoryHandle | null> {
    try {
      return await root.getDirectoryHandle(this.dirName(id));
    } catch (error) {
      if ((error as DOMException | undefined)?.name === 'NotFoundError') {
        return null;
      }
      throw error;
    }
  }
}
