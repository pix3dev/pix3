import { injectable } from '@/fw/di';
import { subscribe } from 'valtio/vanilla';
import { appState } from '@/state';
import { resolveProjectService } from './ProjectService';
import { resolveProjectStorageService } from './ProjectStorageService';
import { resolveThumbnailCacheService } from './ThumbnailCacheService';
import { resolveThumbnailGenerator } from './ThumbnailGenerator';
import { resolveSceneThumbnailGenerator } from './SceneThumbnailGenerator';
import { analyzeAudioBlob } from './audio-preview-utils';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'ogg']);
const MODEL_EXTENSIONS = new Set(['glb', 'gltf']);
const SCENE_EXTENSIONS = new Set(['pix3scene', 'pix3prefab']);
const TEXT_PREVIEW_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'md',
  'markdown',
  'yml',
  'yaml',
  'txt',
  'html',
  'css',
  'scss',
  'less',
]);

export type AssetPreviewType = 'image' | 'model' | 'scene' | 'audio' | 'text' | 'icon';
export type AssetThumbnailStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Preview types whose thumbnails are rendered offscreen on demand. */
function isRenderedThumbnailType(previewType: AssetPreviewType): boolean {
  return previewType === 'model' || previewType === 'scene';
}

export interface AssetPreviewItem {
  readonly name: string;
  readonly path: string;
  readonly kind: FileSystemHandleKind;
  readonly previewType: AssetPreviewType;
  readonly thumbnailUrl: string | null;
  readonly previewUrl: string | null;
  readonly previewText: string | null;
  readonly thumbnailStatus: AssetThumbnailStatus;
  readonly iconName: string;
  readonly extension: string;
  readonly sizeBytes: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSeconds: number | null;
  readonly channelCount: number | null;
  readonly sampleRate: number | null;
  readonly lastModified: number | null;
}

export interface AssetsPreviewSnapshot {
  readonly selectedFolderPath: string | null;
  readonly displayPath: string;
  readonly isLoading: boolean;
  readonly errorMessage: string | null;
  readonly selectedItemPath: string | null;
  readonly selectedItem: AssetPreviewItem | null;
  readonly items: readonly AssetPreviewItem[];
}

type AssetsPreviewListener = (snapshot: AssetsPreviewSnapshot) => void;

@injectable()
export class AssetsPreviewService {
  private readonly projectService = resolveProjectService();
  private readonly storage = resolveProjectStorageService();
  private readonly thumbnailCacheService = resolveThumbnailCacheService();
  private readonly thumbnailGenerator = resolveThumbnailGenerator();
  private readonly sceneThumbnailGenerator = resolveSceneThumbnailGenerator();
  private readonly listeners = new Set<AssetsPreviewListener>();
  private readonly objectUrls = new Set<string>();
  private readonly thumbnailQueue: string[] = [];
  private readonly queuedThumbnailVersions = new Map<string, number>();
  private readonly inFlightThumbnails = new Set<string>();
  private readonly state: {
    selectedFolderPath: string | null;
    displayPath: string;
    isLoading: boolean;
    errorMessage: string | null;
    selectedItemPath: string | null;
    selectedItem: AssetPreviewItem | null;
    items: AssetPreviewItem[];
  } = {
    selectedFolderPath: null,
    displayPath: 'res://',
    isLoading: false,
    errorMessage: null,
    selectedItemPath: null,
    selectedItem: null,
    items: [],
  };

  private requestVersion = 0;
  private disposeProjectSubscription?: () => void;
  private thumbnailWorkerPromise: Promise<void> | null = null;

  constructor() {
    this.disposeProjectSubscription = subscribe(appState.project, () => {
      this.handleProjectStateChange();
    });
    this.handleProjectStateChange();
  }

  public subscribe(listener: AssetsPreviewListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  public getSnapshot(): AssetsPreviewSnapshot {
    return {
      selectedFolderPath: this.state.selectedFolderPath,
      displayPath: this.state.displayPath,
      isLoading: this.state.isLoading,
      errorMessage: this.state.errorMessage,
      selectedItemPath: this.state.selectedItemPath,
      selectedItem: this.state.selectedItem,
      items: this.state.items,
    };
  }

  public selectItem(path: string): void {
    const normalizedPath = this.normalizePath(path);
    this.state.selectedItemPath = normalizedPath;
    this.state.selectedItem =
      this.state.items.find(item => this.normalizePath(item.path) === normalizedPath) ?? null;
    this.notify();
  }

  public requestThumbnail(path: string): void {
    const normalizedPath = this.normalizePath(path);
    const item = this.state.items.find(entry => this.normalizePath(entry.path) === normalizedPath);
    if (!item || !isRenderedThumbnailType(item.previewType) || item.kind !== 'file') {
      return;
    }

    if (item.thumbnailUrl && item.thumbnailStatus === 'ready') {
      return;
    }

    if (
      item.thumbnailStatus === 'loading' &&
      (this.inFlightThumbnails.has(normalizedPath) || this.thumbnailQueue.includes(normalizedPath))
    ) {
      return;
    }

    this.enqueueThumbnailGeneration(normalizedPath, this.requestVersion, true);
  }

  public clearSelectedItem(): void {
    if (!this.state.selectedItemPath && !this.state.selectedItem) {
      return;
    }
    this.state.selectedItemPath = null;
    this.state.selectedItem = null;
    this.notify();
  }

  public async syncFromAssetSelection(path: string, kind: FileSystemHandleKind): Promise<void> {
    if (appState.project.status !== 'ready') {
      return;
    }

    const normalizedPath = this.normalizePath(path);
    const selectedFolderPath =
      kind === 'directory' ? normalizedPath : this.getParentPath(normalizedPath);
    const normalizedFolderPath = this.normalizePath(selectedFolderPath);

    if (this.state.selectedFolderPath === normalizedFolderPath) {
      if (kind === 'file') {
        this.selectItem(normalizedPath);
      } else {
        this.clearSelectedItem();
      }
      return;
    }

    this.state.selectedItemPath = kind === 'file' ? normalizedPath : null;
    this.state.selectedItem =
      kind === 'file'
        ? (this.state.items.find(item => this.normalizePath(item.path) === normalizedPath) ?? null)
        : null;
    await this.setSelectedFolder(normalizedFolderPath);
  }

  public async refreshCurrentFolder(): Promise<void> {
    if (!this.state.selectedFolderPath) {
      return;
    }
    await this.loadFolder(this.state.selectedFolderPath);
  }

  public dispose(): void {
    this.disposeProjectSubscription?.();
    this.disposeProjectSubscription = undefined;
    this.requestVersion += 1;
    this.thumbnailQueue.length = 0;
    this.queuedThumbnailVersions.clear();
    this.inFlightThumbnails.clear();
    this.clearObjectUrls();
    this.listeners.clear();
  }

  private handleProjectStateChange(): void {
    if (appState.project.status !== 'ready') {
      this.requestVersion += 1;
      this.clearObjectUrls();
      this.state.selectedFolderPath = null;
      this.state.displayPath = 'res://';
      this.state.errorMessage = null;
      this.state.selectedItemPath = null;
      this.state.selectedItem = null;
      this.state.items = [];
      this.state.isLoading = false;
      this.notify();
      return;
    }

    if (!this.state.selectedFolderPath) {
      void this.setSelectedFolder('.');
      return;
    }

    const modifiedDirectory = appState.project.lastModifiedDirectoryPath;
    if (modifiedDirectory && this.shouldRefreshForDirectory(modifiedDirectory)) {
      void this.refreshCurrentFolder();
    }
  }

  private shouldRefreshForDirectory(modifiedDirectory: string): boolean {
    if (!this.state.selectedFolderPath) {
      return false;
    }

    const currentPath = this.normalizePath(this.state.selectedFolderPath);
    const modifiedPath = this.normalizePath(modifiedDirectory);

    if (modifiedPath === '.') {
      return true;
    }

    return (
      currentPath === modifiedPath ||
      currentPath.startsWith(`${modifiedPath}/`) ||
      modifiedPath.startsWith(`${currentPath}/`)
    );
  }

  private async setSelectedFolder(folderPath: string): Promise<void> {
    const normalized = this.normalizePath(folderPath);
    this.state.selectedFolderPath = normalized;
    this.state.displayPath = this.toResourcePath(normalized);
    this.notify();
    await this.loadFolder(normalized);
  }

  private async loadFolder(folderPath: string): Promise<void> {
    const requestVersion = ++this.requestVersion;
    this.state.isLoading = true;
    this.state.errorMessage = null;
    this.notify();

    try {
      const entries = await this.projectService.listDirectory(
        folderPath === '.' ? '.' : folderPath
      );
      const filteredEntries = entries
        .filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules')
        .sort((a, b) => {
          const kindOrder = Number(b.kind === 'directory') - Number(a.kind === 'directory');
          if (kindOrder !== 0) {
            return kindOrder;
          }
          return a.name.localeCompare(b.name);
        });

      const items: AssetPreviewItem[] = [];
      for (const entry of filteredEntries) {
        items.push(await this.buildPreviewItem(entry.name, entry.path, entry.kind));
      }

      if (requestVersion !== this.requestVersion) {
        this.revokeBlobUrls(items);
        return;
      }

      this.clearObjectUrls();
      this.trackBlobUrls(items);

      this.state.items = items;
      if (this.state.selectedItemPath) {
        this.state.selectedItem =
          items.find(item => this.normalizePath(item.path) === this.state.selectedItemPath) ?? null;
        if (!this.state.selectedItem) {
          this.state.selectedItemPath = null;
        }
      }
      this.state.errorMessage = null;
      this.notify();
      this.enqueueMissingModelThumbnails(items, requestVersion);
    } catch (error) {
      if (requestVersion !== this.requestVersion) {
        return;
      }

      this.clearObjectUrls();
      this.state.items = [];
      this.state.selectedItemPath = null;
      this.state.selectedItem = null;
      this.state.errorMessage =
        error instanceof Error ? error.message : 'Failed to load assets preview for folder.';
    } finally {
      if (requestVersion === this.requestVersion) {
        this.state.isLoading = false;
      }
      this.notify();
    }
  }

  private async buildPreviewItem(
    name: string,
    path: string,
    kind: FileSystemHandleKind
  ): Promise<AssetPreviewItem> {
    const extension = this.getExtension(name);
    if (kind === 'directory') {
      return {
        name,
        path,
        kind,
        extension,
        previewType: 'icon',
        thumbnailUrl: null,
        previewUrl: null,
        previewText: null,
        thumbnailStatus: 'idle',
        iconName: 'folder',
        sizeBytes: null,
        width: null,
        height: null,
        durationSeconds: null,
        channelCount: null,
        sampleRate: null,
        lastModified: null,
      };
    }

    let fileBlob: Blob | null = null;
    try {
      fileBlob = await this.storage.readBlob(path);
    } catch {
      fileBlob = null;
    }

    const sizeBytes = fileBlob?.size ?? null;
    const lastModified = fileBlob instanceof File ? fileBlob.lastModified : null;

    if (IMAGE_EXTENSIONS.has(extension)) {
      if (fileBlob) {
        const thumbnailUrl = URL.createObjectURL(fileBlob);
        const dimensions = await this.getImageDimensions(fileBlob, thumbnailUrl);
        return {
          name,
          path,
          kind,
          extension,
          previewType: 'image',
          thumbnailUrl,
          previewUrl: thumbnailUrl,
          previewText: null,
          thumbnailStatus: 'ready',
          iconName: 'image',
          sizeBytes,
          width: dimensions.width,
          height: dimensions.height,
          durationSeconds: null,
          channelCount: null,
          sampleRate: null,
          lastModified,
        };
      }
    }

    if (AUDIO_EXTENSIONS.has(extension)) {
      if (fileBlob) {
        const previewUrl = URL.createObjectURL(fileBlob);
        const analysis = await analyzeAudioBlob(fileBlob);

        return {
          name,
          path,
          kind,
          extension,
          previewType: 'audio',
          thumbnailUrl: analysis.waveformUrl,
          previewUrl,
          previewText: null,
          thumbnailStatus: analysis.waveformUrl ? 'ready' : 'error',
          iconName: 'music',
          sizeBytes,
          width: null,
          height: null,
          durationSeconds: analysis.durationSeconds,
          channelCount: analysis.channelCount,
          sampleRate: analysis.sampleRate,
          lastModified,
        };
      }
    }

    if (TEXT_PREVIEW_EXTENSIONS.has(extension)) {
      const previewText = fileBlob ? await this.buildTextPreview(fileBlob) : null;

      return {
        name,
        path,
        kind,
        extension,
        previewType: 'text',
        thumbnailUrl: null,
        previewUrl: null,
        previewText,
        thumbnailStatus: previewText !== null ? 'ready' : 'error',
        iconName: 'file-text',
        sizeBytes,
        width: null,
        height: null,
        durationSeconds: null,
        channelCount: null,
        sampleRate: null,
        lastModified,
      };
    }

    if (MODEL_EXTENSIONS.has(extension)) {
      const cacheKey = this.buildThumbnailCacheKey(path, lastModified, sizeBytes);
      const cachedThumbnail = cacheKey ? await this.thumbnailCacheService.get(cacheKey) : null;

      return {
        name,
        path,
        kind,
        extension,
        previewType: 'model',
        thumbnailUrl: cachedThumbnail,
        previewUrl: null,
        previewText: null,
        thumbnailStatus: cachedThumbnail ? 'ready' : fileBlob ? 'loading' : 'idle',
        iconName: 'box',
        sizeBytes,
        width: null,
        height: null,
        durationSeconds: null,
        channelCount: null,
        sampleRate: null,
        lastModified,
      };
    }

    if (SCENE_EXTENSIONS.has(extension)) {
      const cacheKey = this.buildThumbnailCacheKey(path, lastModified, sizeBytes);
      const cachedThumbnail = cacheKey ? await this.thumbnailCacheService.get(cacheKey) : null;

      return {
        name,
        path,
        kind,
        extension,
        previewType: 'scene',
        thumbnailUrl: cachedThumbnail,
        previewUrl: null,
        previewText: null,
        thumbnailStatus: cachedThumbnail ? 'ready' : fileBlob ? 'loading' : 'idle',
        iconName: 'film',
        sizeBytes,
        width: null,
        height: null,
        durationSeconds: null,
        channelCount: null,
        sampleRate: null,
        lastModified,
      };
    }

    return {
      name,
      path,
      kind,
      extension,
      previewType: 'icon',
      thumbnailUrl: null,
      previewUrl: null,
      previewText: null,
      thumbnailStatus: 'idle',
      iconName: this.resolveIconForExtension(extension),
      sizeBytes,
      width: null,
      height: null,
      durationSeconds: null,
      channelCount: null,
      sampleRate: null,
      lastModified,
    };
  }

  private enqueueMissingModelThumbnails(
    items: readonly AssetPreviewItem[],
    requestVersion: number
  ): void {
    for (const item of items) {
      if (
        item.kind !== 'file' ||
        !isRenderedThumbnailType(item.previewType) ||
        item.thumbnailStatus === 'ready'
      ) {
        continue;
      }

      this.enqueueThumbnailGeneration(item.path, requestVersion, false);
    }
  }

  private enqueueThumbnailGeneration(
    path: string,
    requestVersion: number,
    prioritize: boolean
  ): void {
    const normalizedPath = this.normalizePath(path);
    this.queuedThumbnailVersions.set(normalizedPath, requestVersion);

    if (!this.inFlightThumbnails.has(normalizedPath)) {
      const existingIndex = this.thumbnailQueue.findIndex(entry => entry === normalizedPath);
      if (existingIndex >= 0) {
        this.thumbnailQueue.splice(existingIndex, 1);
      }

      if (prioritize) {
        this.thumbnailQueue.unshift(normalizedPath);
      } else {
        this.thumbnailQueue.push(normalizedPath);
      }
    }

    if (!this.thumbnailWorkerPromise) {
      this.thumbnailWorkerPromise = this.processThumbnailQueue();
    }
  }

  private async processThumbnailQueue(): Promise<void> {
    try {
      while (this.thumbnailQueue.length > 0) {
        const path = this.thumbnailQueue.shift();
        if (!path) {
          continue;
        }

        const requestVersion = this.queuedThumbnailVersions.get(path);
        this.queuedThumbnailVersions.delete(path);
        if (requestVersion === undefined || this.inFlightThumbnails.has(path)) {
          continue;
        }

        this.inFlightThumbnails.add(path);
        try {
          await this.waitForNextFrame();
          await this.generateThumbnailForPath(path, requestVersion);
        } finally {
          this.inFlightThumbnails.delete(path);
        }
      }
    } finally {
      this.thumbnailWorkerPromise = null;
      if (this.thumbnailQueue.length > 0) {
        this.thumbnailWorkerPromise = this.processThumbnailQueue();
      }
    }
  }

  private async generateThumbnailForPath(path: string, requestVersion: number): Promise<void> {
    if (requestVersion !== this.requestVersion) {
      return;
    }

    const normalizedPath = this.normalizePath(path);
    const item = this.state.items.find(entry => this.normalizePath(entry.path) === normalizedPath);
    if (
      !item ||
      item.kind !== 'file' ||
      !isRenderedThumbnailType(item.previewType) ||
      item.thumbnailUrl
    ) {
      return;
    }

    const previewType = item.previewType;

    try {
      const fileBlob = await this.storage.readBlob(path);
      const sizeBytes = fileBlob.size ?? item.sizeBytes;
      const lastModified = fileBlob instanceof File ? fileBlob.lastModified : item.lastModified;
      const cacheKey = this.buildThumbnailCacheKey(path, lastModified, sizeBytes);

      if (cacheKey) {
        const cachedThumbnail = await this.thumbnailCacheService.get(cacheKey);
        if (cachedThumbnail) {
          this.updateItem(path, currentItem => ({
            ...currentItem,
            thumbnailUrl: cachedThumbnail,
            thumbnailStatus: 'ready',
            lastModified,
            sizeBytes,
          }));
          return;
        }
      }

      const thumbnailUrl =
        previewType === 'scene'
          ? await this.sceneThumbnailGenerator.generate(fileBlob, path)
          : await this.thumbnailGenerator.generate(fileBlob, path);
      if (cacheKey) {
        await this.thumbnailCacheService.set(cacheKey, thumbnailUrl);
      }

      if (requestVersion !== this.requestVersion) {
        return;
      }

      this.updateItem(path, currentItem => ({
        ...currentItem,
        thumbnailUrl,
        thumbnailStatus: 'ready',
        lastModified,
        sizeBytes,
      }));
    } catch {
      if (requestVersion !== this.requestVersion) {
        return;
      }

      this.updateItem(path, currentItem => ({
        ...currentItem,
        thumbnailStatus: 'error',
      }));
    }
  }

  private updateItem(path: string, updater: (item: AssetPreviewItem) => AssetPreviewItem): void {
    const normalizedPath = this.normalizePath(path);
    let didUpdate = false;

    this.state.items = this.state.items.map(item => {
      if (this.normalizePath(item.path) !== normalizedPath) {
        return item;
      }

      didUpdate = true;
      return updater(item);
    });

    if (!didUpdate) {
      return;
    }

    if (this.state.selectedItemPath) {
      this.state.selectedItem =
        this.state.items.find(
          item => this.normalizePath(item.path) === this.state.selectedItemPath
        ) ?? null;
    }

    this.notify();
  }

  private buildThumbnailCacheKey(
    path: string,
    lastModified: number | null,
    sizeBytes: number | null
  ): string | null {
    if (lastModified === null || sizeBytes === null) {
      return null;
    }

    return `${this.normalizePath(path)}::${lastModified}::${sizeBytes}`;
  }

  private async getImageDimensions(
    blob: Blob,
    objectUrl: string
  ): Promise<{ width: number | null; height: number | null }> {
    try {
      const bitmapFactory = (
        globalThis as { createImageBitmap?: (source: ImageBitmapSource) => Promise<ImageBitmap> }
      ).createImageBitmap;
      if (bitmapFactory) {
        const bitmap = await bitmapFactory(blob);
        const dimensions = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return dimensions;
      }
    } catch {
      // fall back to HTMLImageElement
    }

    return new Promise(resolve => {
      const image = new Image();
      image.onload = () => {
        resolve({
          width: image.naturalWidth || null,
          height: image.naturalHeight || null,
        });
      };
      image.onerror = () => resolve({ width: null, height: null });
      image.src = objectUrl;
    });
  }

  private async buildTextPreview(blob: Blob): Promise<string> {
    const rawText = await blob.text();
    const normalized = rawText.replace(/\r\n/g, '\n').replace(/\t/g, '  ').trim();

    if (!normalized) {
      return 'Empty file';
    }

    const lines = normalized.split('\n').slice(0, 6);
    const snippet = lines.join('\n');
    return snippet.length > 280 ? `${snippet.slice(0, 277)}...` : snippet;
  }

  private getExtension(name: string): string {
    const lastDot = name.lastIndexOf('.');
    if (lastDot < 0 || lastDot === name.length - 1) {
      return '';
    }
    return name.slice(lastDot + 1).toLowerCase();
  }

  private resolveIconForExtension(extension: string): string {
    if (!extension) {
      return 'file';
    }

    if (['ts', 'js', 'json', 'css', 'html', 'md', 'txt', 'yml', 'yaml'].includes(extension)) {
      return 'file-text';
    }

    if (['glb', 'gltf', 'fbx', 'obj'].includes(extension)) {
      return 'box';
    }

    if (['wav', 'mp3', 'ogg'].includes(extension)) {
      return 'music';
    }

    if (['mp4', 'webm', 'mov'].includes(extension)) {
      return 'film';
    }

    return 'file';
  }

  private normalizePath(path: string): string {
    const normalized = path
      .replace(/\\+/g, '/')
      .replace(/^\.\//, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    return normalized.length > 0 ? normalized : '.';
  }

  private getParentPath(path: string): string {
    const normalized = this.normalizePath(path);
    if (normalized === '.') {
      return '.';
    }

    const parts = normalized.split('/');
    if (parts.length <= 1) {
      return '.';
    }
    return parts.slice(0, -1).join('/');
  }

  private toResourcePath(path: string): string {
    if (path === '.') {
      return 'res://';
    }
    return `res://${path}`;
  }

  private waitForNextFrame(): Promise<void> {
    return new Promise(resolve => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => resolve());
        return;
      }

      setTimeout(resolve, 0);
    });
  }

  private trackBlobUrls(items: readonly AssetPreviewItem[]): void {
    for (const item of items) {
      if (item.thumbnailUrl?.startsWith('blob:')) {
        this.objectUrls.add(item.thumbnailUrl);
      }
      if (item.previewUrl?.startsWith('blob:')) {
        this.objectUrls.add(item.previewUrl);
      }
    }
  }

  private revokeBlobUrls(items: readonly AssetPreviewItem[]): void {
    for (const item of items) {
      if (item.thumbnailUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(item.thumbnailUrl);
      }
      if (item.previewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(item.previewUrl);
      }
    }
  }

  private clearObjectUrls(): void {
    for (const url of this.objectUrls) {
      URL.revokeObjectURL(url);
    }
    this.objectUrls.clear();
  }

  private notify(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
