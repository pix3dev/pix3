import { injectable, inject } from '@/fw/di';
import { ServiceContainer } from '@/fw/di';
import { appState } from '@/state';
import { subscribe } from 'valtio/vanilla';
import * as Y from 'yjs';
import { FileSystemAPIService, type FileDescriptor } from './FileSystemAPIService';
import { CloudProjectCacheService } from './CloudProjectCacheService';
import { CollaborationService } from './CollaborationService';
import * as ApiClient from './ApiClient';

type CloudManifestEntry = ApiClient.ManifestEntry;
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

  getBackend(): 'local' | 'cloud' {
    // Browser-storage projects live in an OPFS FileSystemDirectoryHandle, so
    // they route through the same on-disk path as 'local'. Only 'cloud' uses
    // the manifest/cache path.
    return appState.project.backend === 'cloud' ? 'cloud' : 'local';
  }

  async listDirectory(path = '.'): Promise<FileDescriptor[]> {
    if (this.getBackend() === 'local') {
      return this.fileSystem.listDirectory(path);
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
    if (this.getBackend() === 'local') {
      return this.fileSystem.readTextFile(path);
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
    if (this.getBackend() === 'local') {
      return this.fileSystem.readBlob(path);
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

  async writeTextFile(path: string, contents: string): Promise<void> {
    const normalizedPath = this.normalizePath(path);
    await this.writeTextFileInternal(normalizedPath, contents);
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
    if (this.getBackend() === 'local') {
      const fileHandle = await this.fileSystem.getFileHandle(path);
      const file = await fileHandle.getFile();
      return file.lastModified;
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

  normalizeResourcePath(path: string): string {
    if (this.getBackend() === 'local') {
      return this.fileSystem.normalizeResourcePath(path);
    }
    return this.normalizePath(path);
  }

  async getManifestEntries(forceRefresh = false): Promise<CloudManifestEntry[]> {
    if (this.getBackend() === 'local') {
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
    if (this.getBackend() === 'cloud') {
      await this.getManifestEntries(true);
    }
  }

  dispose(): void {
    this.disposeCollaborationSubscription?.();
    this.disposeCollaborationSubscription = undefined;
    this.detachAssetEventsObserver();
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

  private async writeTextFileInternal(path: string, contents: string): Promise<void> {
    if (this.getBackend() === 'local') {
      await this.fileSystem.writeTextFile(path, contents);
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
    if (this.getBackend() === 'local') {
      await this.fileSystem.writeBinaryFile(path, data);
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
    if (this.getBackend() === 'local') {
      await this.fileSystem.deleteEntry(path);
      return;
    }

    this.ensureWriteAllowed();
    const projectId = this.requireProjectId();
    await ApiClient.deleteFile(projectId, path);
    await this.cloudCache.invalidatePath(projectId, path, { recursive: true });
    await this.refreshManifest();
  }

  private async createDirectoryInternal(path: string): Promise<void> {
    if (this.getBackend() === 'local') {
      await this.fileSystem.createDirectory(path);
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
