import { injectable, inject } from '@/fw/di';
import { ServiceContainer } from '@/fw/di';
import { appState } from '@/state';
import { subscribe } from 'valtio/vanilla';
import type * as Y from 'yjs';
import { FileSystemAPIService, type FileDescriptor } from '@/services/project/FileSystemAPIService';
import { CloudProjectCacheService } from '@/services/cloud/CloudProjectCacheService';
import { CollaborationService } from '@/services/collab/CollaborationService';
import * as ApiClient from '@/services/cloud/ApiClient';
import { WorkspaceClient } from '@/services/project/workspace/WorkspaceClient';
import { WorkspaceError } from '@/services/project/workspace/workspace-protocol';
import { isPix3InternalPath } from '@/services/project/coauthoring/coauthoring-paths';

type CloudManifestEntry = ApiClient.ManifestEntry;
export type StorageBackendKind = 'local' | 'cloud' | 'workspace';
type AssetMutationKind = 'create-directory' | 'write-file' | 'delete-entry' | 'move-entry';

interface AssetMutationEvent {
  readonly id: string;
  readonly kind: AssetMutationKind;
  readonly path: string;
  readonly directories: readonly string[];
  readonly occurredAt: number;
}

@injectable()
export class ProjectStorageService {
  @inject(FileSystemAPIService)
  private readonly fileSystem!: FileSystemAPIService;

  @inject(CloudProjectCacheService)
  private readonly cloudCache!: CloudProjectCacheService;

  @inject(WorkspaceClient)
  private readonly workspace!: WorkspaceClient;

  private cachedProjectId: string | null = null;
  private cachedManifest: CloudManifestEntry[] | null = null;
  private disposeCollaborationSubscription?: () => void;
  private observedAssetEventsMap: Y.Map<string> | null = null;
  private assetEventsObserver?: (event: Y.YMapEvent<string>) => void;

  constructor() {
    this.disposeCollaborationSubscription = subscribe(appState.collaboration, () => {
      this.rebindCollaborationAssetEvents();
    });
    this.rebindCollaborationAssetEvents();
  }

  getBackend(): StorageBackendKind {
    // Browser-storage projects live in an OPFS FileSystemDirectoryHandle, so
    // they route through the same on-disk path as 'local'. 'cloud' uses the
    // manifest/cache path; 'workspace' is a `pix3 serve` folder over HTTP.
    const backend = appState.project.backend;
    if (backend === 'cloud' || backend === 'workspace') {
      return backend;
    }
    return 'local';
  }

  async listDirectory(path = '.'): Promise<FileDescriptor[]> {
    const backend = this.getBackend();
    if (backend === 'local') {
      return this.fileSystem.listDirectory(path);
    }
    if (backend === 'workspace') {
      return this.listWorkspaceDirectory(path);
    }

    const normalizedPath = this.normalizePath(path);
    const manifest = await this.getManifestEntries();
    const entries = new Map<string, FileDescriptor>();

    for (const entry of manifest) {
      const relative = this.getRelativeToDirectory(entry.path, normalizedPath);
      if (!relative) {
        continue;
      }

      const [head, ...rest] = relative.split('/');
      if (!head) {
        continue;
      }

      const childPath = normalizedPath === '.' ? head : `${normalizedPath}/${head}`;
      const kind: FileSystemHandleKind = rest.length > 0 ? 'directory' : entry.kind;
      const existing = entries.get(childPath);
      const size = rest.length === 0 ? (entry.kind === 'file' ? entry.size : 0) : null;

      if (!existing || existing.kind === 'file') {
        entries.set(childPath, {
          name: head,
          kind,
          path: childPath,
          size,
        });
      }
    }

    return Array.from(entries.values());
  }

  async readTextFile(path: string): Promise<string> {
    const backend = this.getBackend();
    if (backend === 'local') {
      return this.fileSystem.readTextFile(path);
    }
    if (backend === 'workspace') {
      return this.workspace.readText(this.normalizePath(path));
    }

    const projectId = this.requireProjectId();
    const normalizedPath = this.normalizePath(path);
    const cached = await this.cloudCache.readTextFile(projectId, normalizedPath);
    if (cached !== null) {
      return cached;
    }

    const response = await ApiClient.downloadFile(
      projectId,
      normalizedPath,
      appState.collaboration.shareToken ?? undefined
    );
    const contents = await response.text();
    await this.cloudCache.storeTextFile(
      projectId,
      normalizedPath,
      contents,
      this.getManifestEntryMetadata(normalizedPath)
    );
    return contents;
  }

  async readBlob(path: string): Promise<Blob> {
    const backend = this.getBackend();
    if (backend === 'local') {
      return this.fileSystem.readBlob(path);
    }
    if (backend === 'workspace') {
      return this.workspace.readBlob(this.normalizePath(path));
    }

    const projectId = this.requireProjectId();
    const normalizedPath = this.normalizePath(path);
    const cached = await this.cloudCache.readBlob(projectId, normalizedPath);
    if (cached) {
      return cached;
    }

    const response = await ApiClient.downloadFile(
      projectId,
      normalizedPath,
      appState.collaboration.shareToken ?? undefined
    );
    const blob = await response.blob();
    await this.cloudCache.storeBlobFile(
      projectId,
      normalizedPath,
      blob,
      this.getManifestEntryMetadata(normalizedPath)
    );
    return blob;
  }

  /**
   * `options.unconditional`: on a workspace, write without an `If-Match` base. Only for files the
   * editor owns outright (`.pix3/protected.json`) — never for project content, where the base is
   * what stops a save from overwriting an agent's newer version.
   */
  async writeTextFile(
    path: string,
    contents: string,
    options: { readonly unconditional?: boolean } = {}
  ): Promise<void> {
    const normalizedPath = this.normalizePath(path);
    await this.writeTextFileInternal(normalizedPath, contents, options.unconditional === true);
    await this.publishAssetMutation({
      kind: 'write-file',
      path: normalizedPath,
      directories: [this.getParentDirectory(normalizedPath)],
    });
  }

  async writeBinaryFile(path: string, data: ArrayBuffer): Promise<void> {
    const normalizedPath = this.normalizePath(path);
    await this.writeBinaryFileInternal(normalizedPath, data);
    await this.publishAssetMutation({
      kind: 'write-file',
      path: normalizedPath,
      directories: [this.getParentDirectory(normalizedPath)],
    });
  }

  async deleteEntry(path: string): Promise<void> {
    const normalizedPath = this.normalizePath(path);
    const entry = await this.getEntryDescriptor(normalizedPath);

    await this.deleteEntryInternal(normalizedPath);
    await this.publishAssetMutation({
      kind: 'delete-entry',
      path: normalizedPath,
      directories: this.getDirectoriesAffectedByDeletion(normalizedPath, entry?.kind),
    });
  }

  async createDirectory(path: string): Promise<void> {
    const normalizedPath = this.normalizePath(path);
    await this.createDirectoryInternal(normalizedPath);
    await this.publishAssetMutation({
      kind: 'create-directory',
      path: normalizedPath,
      directories: [this.getParentDirectory(normalizedPath), normalizedPath],
    });
  }

  async moveEntry(sourcePath: string, targetPath: string): Promise<void> {
    const normalizedSourcePath = this.normalizePath(sourcePath);
    const normalizedTargetPath = this.normalizePath(targetPath);

    if (normalizedSourcePath === normalizedTargetPath) {
      return;
    }

    if (this.getBackend() === 'workspace') {
      // The server moves atomically (rename), keeps bytes and creates missing parents.
      this.ensureWriteAllowed();
      await this.workspace.move(normalizedSourcePath, normalizedTargetPath);
      await this.publishAssetMutation({
        kind: 'move-entry',
        path: normalizedTargetPath,
        directories: this.getUniqueDirectories([
          this.getParentDirectory(normalizedSourcePath),
          this.getParentDirectory(normalizedTargetPath),
        ]),
      });
      return;
    }

    const sourceEntry = await this.getEntryDescriptor(normalizedSourcePath);
    if (!sourceEntry) {
      throw new Error(`Source entry not found: ${sourcePath}`);
    }

    if (sourceEntry.kind === 'file') {
      const blob = await this.readBlob(normalizedSourcePath);
      await this.writeBinaryFileInternal(normalizedTargetPath, await blob.arrayBuffer());
      await this.deleteEntryInternal(normalizedSourcePath);
      await this.refreshManifest();
      await this.publishAssetMutation({
        kind: 'move-entry',
        path: normalizedTargetPath,
        directories: this.getUniqueDirectories([
          this.getParentDirectory(normalizedSourcePath),
          this.getParentDirectory(normalizedTargetPath),
        ]),
      });
      return;
    }

    await this.copyDirectory(normalizedSourcePath, normalizedTargetPath);
    await this.deleteEntryInternal(normalizedSourcePath);
    await this.refreshManifest();
    await this.publishAssetMutation({
      kind: 'move-entry',
      path: normalizedTargetPath,
      directories: this.getUniqueDirectories([
        this.getParentDirectory(normalizedSourcePath),
        this.getParentDirectory(normalizedTargetPath),
      ]),
    });
  }

  async getFileHandle(path: string): Promise<FileSystemFileHandle | null> {
    if (this.getBackend() === 'local') {
      return this.fileSystem.getFileHandle(path);
    }
    void path;
    return null;
  }

  async getLastModified(path: string): Promise<number | null> {
    const backend = this.getBackend();
    if (backend === 'local') {
      const fileHandle = await this.fileSystem.getFileHandle(path);
      const file = await fileHandle.getFile();
      return file.lastModified;
    }
    if (backend === 'workspace') {
      await this.ensureWorkspaceManifest();
      return this.workspace.getManifestEntry(this.normalizePath(path))?.mtime ?? null;
    }

    const normalizedPath = this.normalizePath(path);
    const manifest = await this.getManifestEntries();
    const entry = manifest.find(item => item.path === normalizedPath);
    if (!entry) {
      return null;
    }

    const parsed = Date.parse(entry.modified);
    return Number.isNaN(parsed) ? null : parsed;
  }

  /** Whether a FILE exists at `path` (directories answer false). */
  async fileExists(path: string): Promise<boolean> {
    const backend = this.getBackend();
    if (backend === 'local') {
      try {
        await this.fileSystem.getFileHandle(path);
        return true;
      } catch {
        return false;
      }
    }
    if (backend === 'workspace') {
      await this.ensureWorkspaceManifest();
      return this.workspace.getManifestEntry(this.normalizePath(path))?.kind === 'file';
    }
    const manifest = await this.getManifestEntries();
    const normalizedPath = this.normalizePath(path);
    return manifest.some(entry => entry.path === normalizedPath && entry.kind === 'file');
  }

  normalizeResourcePath(path: string): string {
    if (this.getBackend() === 'local') {
      return this.fileSystem.normalizeResourcePath(path);
    }
    return this.normalizePath(path);
  }

  async getManifestEntries(forceRefresh = false): Promise<CloudManifestEntry[]> {
    if (this.getBackend() !== 'cloud') {
      return [];
    }

    const projectId = this.requireProjectId();
    if (!forceRefresh && this.cachedManifest && this.cachedProjectId === projectId) {
      return this.cachedManifest;
    }

    const { files } = await ApiClient.getManifestWithAccess(
      projectId,
      appState.collaboration.shareToken ?? undefined
    );
    this.cachedProjectId = projectId;
    this.cachedManifest = files;
    await this.cloudCache.reconcileManifest(projectId, files);
    return files;
  }

  async refreshManifest(): Promise<void> {
    const backend = this.getBackend();
    if (backend === 'cloud') {
      await this.getManifestEntries(true);
    } else if (backend === 'workspace') {
      await this.workspace.getManifest(true);
    }
  }

  dispose(): void {
    this.disposeCollaborationSubscription?.();
    this.disposeCollaborationSubscription = undefined;
    this.detachAssetEventsObserver();
  }

  private async ensureWorkspaceManifest(): Promise<void> {
    if (!this.workspace.getCachedManifest()) {
      await this.workspace.getManifest();
    }
  }

  /** Direct children of `path` from the (cached, event-patched) workspace manifest. */
  private async listWorkspaceDirectory(path: string): Promise<FileDescriptor[]> {
    await this.ensureWorkspaceManifest();
    const normalizedPath = this.normalizePath(path);
    const entries: FileDescriptor[] = [];
    for (const entry of this.workspace.getManifestEntries()) {
      const relative = this.getRelativeToDirectory(entry.path, normalizedPath);
      if (!relative || relative.includes('/')) {
        continue;
      }
      entries.push({
        name: relative,
        kind: entry.kind === 'dir' ? 'directory' : 'file',
        path: entry.path,
        size: entry.kind === 'file' ? entry.size : null,
      });
    }
    return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  private async getEntryDescriptor(path: string): Promise<FileDescriptor | null> {
    const parentPath = this.getParentDirectory(path);
    const name = this.getBaseName(path);
    const entries = await this.listDirectory(parentPath);
    return entries.find(entry => entry.name === name) ?? null;
  }

  private async copyDirectory(sourcePath: string, targetPath: string): Promise<void> {
    await this.createDirectoryInternal(targetPath);
    const entries = await this.listDirectory(sourcePath);
    for (const entry of entries) {
      const childSourcePath = `${sourcePath}/${entry.name}`;
      const childTargetPath = `${targetPath}/${entry.name}`;
      if (entry.kind === 'directory') {
        await this.copyDirectory(childSourcePath, childTargetPath);
        continue;
      }

      const blob = await this.readBlob(childSourcePath);
      await this.writeBinaryFileInternal(childTargetPath, await blob.arrayBuffer());
    }
  }

  private async writeTextFileInternal(
    path: string,
    contents: string,
    unconditional = false
  ): Promise<void> {
    const backend = this.getBackend();
    if (backend === 'local') {
      await this.fileSystem.writeTextFile(path, contents);
      return;
    }
    if (backend === 'workspace') {
      this.ensureWriteAllowed();
      if (unconditional) {
        await this.workspace.writeFile(path, contents, { baseHash: null });
      } else {
        await this.workspace.writeFile(path, contents);
      }
      return;
    }

    this.ensureWriteAllowed();
    const projectId = this.requireProjectId();
    await ApiClient.uploadFile(projectId, path, contents);
    await this.refreshManifest();
    await this.cloudCache.storeTextFile(
      projectId,
      path,
      contents,
      this.getManifestEntryMetadata(path)
    );
  }

  private async writeBinaryFileInternal(path: string, data: ArrayBuffer): Promise<void> {
    const backend = this.getBackend();
    if (backend === 'local') {
      await this.fileSystem.writeBinaryFile(path, data);
      return;
    }
    if (backend === 'workspace') {
      this.ensureWriteAllowed();
      await this.workspace.writeFile(path, data);
      return;
    }

    this.ensureWriteAllowed();
    const projectId = this.requireProjectId();
    await ApiClient.uploadFile(projectId, path, data);
    await this.refreshManifest();
    await this.cloudCache.storeBlobFile(
      projectId,
      path,
      new Blob([data]),
      this.getManifestEntryMetadata(path)
    );
  }

  private async deleteEntryInternal(path: string): Promise<void> {
    const backend = this.getBackend();
    if (backend === 'local') {
      await this.fileSystem.deleteEntry(path);
      return;
    }
    if (backend === 'workspace') {
      this.ensureWriteAllowed();
      // Same semantics as the FSA path (`removeEntry(..., { recursive: true })`).
      await this.workspace.delete(path, { recursive: true });
      return;
    }

    this.ensureWriteAllowed();
    const projectId = this.requireProjectId();
    await ApiClient.deleteFile(projectId, path);
    await this.cloudCache.invalidatePath(projectId, path, { recursive: true });
    await this.refreshManifest();
  }

  private async createDirectoryInternal(path: string): Promise<void> {
    const backend = this.getBackend();
    if (backend === 'local') {
      await this.fileSystem.createDirectory(path);
      return;
    }
    if (backend === 'workspace') {
      this.ensureWriteAllowed();
      await this.workspace.mkdir(path);
      return;
    }

    this.ensureWriteAllowed();
    await ApiClient.createDirectory(this.requireProjectId(), path);
    await this.refreshManifest();
  }

  private async publishAssetMutation(
    event: Omit<AssetMutationEvent, 'id' | 'occurredAt'>
  ): Promise<void> {
    const normalizedDirectories = this.getUniqueDirectories(event.directories);
    const mutation: AssetMutationEvent = {
      id: this.createMutationId(),
      occurredAt: Date.now(),
      ...event,
      directories: normalizedDirectories,
    };

    if (this.getBackend() === 'cloud') {
      const collaborationService = this.tryGetCollaborationService();
      const ydoc = collaborationService?.getYDoc();
      if (collaborationService && ydoc) {
        const assetEvents = ydoc.getMap<string>('asset-events');
        ydoc.transact(() => {
          assetEvents.set('lastMutation', JSON.stringify(mutation));
        }, collaborationService.getLocalOrigin());
      }
    }

    this.applyAssetMutationSignal(mutation.directories);
  }

  private applyAssetMutationSignal(directories: readonly string[]): void {
    // `.pix3/` is editor bookkeeping (recovery journal, protected set): the asset browser hides it,
    // and an autosave every second must not make every listing refresh.
    if (directories.length > 0 && directories.every(directory => isPix3InternalPath(directory))) {
      return;
    }
    appState.project.lastModifiedDirectoryPath = this.coalesceDirectories(directories);
    appState.project.fileRefreshSignal = (appState.project.fileRefreshSignal || 0) + 1;
  }

  private coalesceDirectories(directories: readonly string[]): string {
    const normalized = this.getUniqueDirectories(directories);
    if (normalized.length === 0) {
      return '.';
    }

    return normalized.length === 1 ? normalized[0] : '.';
  }

  private getDirectoriesAffectedByDeletion(
    path: string,
    kind: FileSystemHandleKind | undefined
  ): string[] {
    if (kind === 'directory') {
      return [this.getParentDirectory(path), path];
    }
    return [this.getParentDirectory(path)];
  }

  private getUniqueDirectories(directories: readonly string[]): string[] {
    return Array.from(new Set(directories.map(path => this.normalizePath(path))));
  }

  private createMutationId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }

    return `asset-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private rebindCollaborationAssetEvents(): void {
    const collaborationService = this.tryGetCollaborationService();
    const ydoc = collaborationService?.getYDoc();
    const assetEvents = ydoc?.getMap<string>('asset-events') ?? null;

    if (assetEvents === this.observedAssetEventsMap) {
      return;
    }

    this.detachAssetEventsObserver();

    if (!assetEvents) {
      return;
    }

    this.assetEventsObserver = event => {
      void this.handleAssetEventsUpdated(event);
    };
    this.observedAssetEventsMap = assetEvents;
    assetEvents.observe(this.assetEventsObserver);
  }

  private detachAssetEventsObserver(): void {
    if (this.observedAssetEventsMap && this.assetEventsObserver) {
      this.observedAssetEventsMap.unobserve(this.assetEventsObserver);
    }

    this.observedAssetEventsMap = null;
    this.assetEventsObserver = undefined;
  }

  private async handleAssetEventsUpdated(event: Y.YMapEvent<string>): Promise<void> {
    const collaborationService = this.tryGetCollaborationService();
    if (
      !collaborationService ||
      event.transaction.origin === collaborationService.getLocalOrigin()
    ) {
      return;
    }

    if (!event.keysChanged.has('lastMutation')) {
      return;
    }

    const rawMutation = event.target.get('lastMutation');
    if (!rawMutation) {
      return;
    }

    try {
      const mutation = JSON.parse(rawMutation) as AssetMutationEvent;
      if (this.getBackend() === 'cloud') {
        const projectId = this.requireProjectId();
        await this.refreshManifest();
        await this.cloudCache.invalidatePath(projectId, mutation.path, {
          recursive: mutation.kind === 'delete-entry',
        });
      }
      this.applyAssetMutationSignal(mutation.directories);
    } catch (error) {
      console.warn('[ProjectStorageService] Failed to process remote asset mutation', error);
    }
  }

  private getManifestEntryMetadata(path: string): {
    hash?: string | null;
    modified?: string | null;
    size?: number | null;
  } {
    const manifest = this.cachedManifest;
    if (!manifest || this.cachedProjectId !== appState.project.id) {
      return {};
    }

    const normalizedPath = this.normalizePath(path);
    const entry = manifest.find(item => item.path === normalizedPath);
    if (!entry || entry.kind !== 'file') {
      return {};
    }

    return {
      hash: entry.hash,
      modified: entry.modified,
      size: entry.size,
    };
  }

  private tryGetCollaborationService(): CollaborationService | null {
    try {
      return ServiceContainer.getInstance().getService<CollaborationService>(
        ServiceContainer.getInstance().getOrCreateToken(CollaborationService)
      );
    } catch {
      return null;
    }
  }

  private requireProjectId(): string {
    const projectId = appState.project.id;
    if (!projectId) {
      throw new Error('Project ID is not available.');
    }
    return projectId;
  }

  private ensureWriteAllowed(): void {
    if (this.getBackend() === 'workspace') {
      const lease = appState.project.workspace.lease;
      if (lease === 'busy' || lease === 'lost') {
        throw new WorkspaceError(
          'read_only',
          'This window is read-only: another Pix3 window holds the workspace edit lease. ' +
            'Use "Take over" to edit here.'
        );
      }
      return;
    }
    if (appState.collaboration.isReadOnly) {
      throw new Error('Project is open in read-only collaboration mode.');
    }
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

  private getRelativeToDirectory(filePath: string, directoryPath: string): string | null {
    if (directoryPath === '.') {
      return filePath;
    }

    if (filePath === directoryPath) {
      return '';
    }

    if (!filePath.startsWith(`${directoryPath}/`)) {
      return null;
    }

    return filePath.slice(directoryPath.length + 1);
  }

  private getParentDirectory(path: string): string {
    if (!path || path === '.') {
      return '.';
    }

    const segments = path.split('/').filter(Boolean);
    if (segments.length <= 1) {
      return '.';
    }

    return segments.slice(0, -1).join('/');
  }

  private getBaseName(path: string): string {
    const segments = path.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? path;
  }
}

export const resolveProjectStorageService = (): ProjectStorageService =>
  ServiceContainer.getInstance().getService<ProjectStorageService>(
    ServiceContainer.getInstance().getOrCreateToken(ProjectStorageService)
  );
