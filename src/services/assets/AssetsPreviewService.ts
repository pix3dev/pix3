import { injectable } from '@/fw/di';
import { subscribe } from 'valtio/vanilla';
import { appState } from '@/state';
import { resolveProjectService } from '@/services/project/ProjectService';
import { resolveProjectStorageService } from '@/services/project/ProjectStorageService';
import { resolveThumbnailCacheService } from '@/services/assets/ThumbnailCacheService';
import { resolveThumbnailGenerator } from '@/services/assets/ThumbnailGenerator';
import { resolveSceneThumbnailGenerator } from '@/services/scene/SceneThumbnailGenerator';
import { analyzeAudioBlob } from '@/services/assets/audio-preview-utils';
import { computeDirectoryStats } from '@/services/assets/asset-folder-stats';
import {
  getAnimationFrameTexturePath,
  normalizeAnimationResource,
  type AnimationResource,
} from '@pix3/runtime';
import { isManagedSpriteFolder } from '@/features/scene/animation-asset-utils';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'ogg']);
const MODEL_EXTENSIONS = new Set(['glb', 'gltf']);
const SCENE_EXTENSIONS = new Set(['pix3scene']);
const ANIMATION_EXTENSIONS = new Set(['pix3anim']);
// Script/source files render as a plain file-type icon instead of a code
// preview: a shrunk-down slice of source is unreadable and reads as visual
// noise ("a bunch of compressed strips"). Data/prose text formats below keep
// their preview, where a few lines are actually legible and useful.
const CODE_SCRIPT_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']);
const TEXT_PREVIEW_EXTENSIONS = new Set([
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

export type AssetPreviewType =
  | 'image'
  | 'model'
  | 'scene'
  | 'audio'
  | 'animation'
  | 'text'
  | 'icon';
export type AssetThumbnailStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Preview types whose thumbnails are rendered offscreen on demand. */
function isRenderedThumbnailType(previewType: AssetPreviewType): boolean {
  return previewType === 'model' || previewType === 'scene';
}

/**
 * One flipbook frame, resolved for display: the object URL of its source image
 * plus the UV sub-rect to show. Sequence clips (one PNG per frame) get a full
 * 1×1 rect on their own URL; sheet clips share one URL and differ by rect.
 */
export interface AnimationPreviewFrame {
  readonly url: string;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly repeatX: number;
  readonly repeatY: number;
  readonly durationMultiplier: number;
}

/**
 * Playable preview of a `.pix3anim`'s first clip. Only the first frame is
 * resolved when the folder loads (one blob read per animation, like an image
 * thumbnail); the rest arrive through {@link AssetsPreviewService.requestAnimationFrames}
 * when the user actually starts the preview.
 */
export interface AnimationPreviewData {
  readonly clipName: string;
  readonly fps: number;
  readonly loop: boolean;
  readonly pingPong: boolean;
  readonly frameCount: number;
  readonly frames: readonly AnimationPreviewFrame[];
  readonly framesLoaded: boolean;
}

export interface AssetPreviewItem {
  readonly name: string;
  readonly path: string;
  readonly kind: FileSystemHandleKind;
  /**
   * Set only on a **collapsed managed sprite folder**: the real folder path this
   * item stands in for. The item otherwise behaves exactly like the folder's
   * `.pix3anim` (same `path`, drag payload, double-click target, preview), so a
   * sprite reads as one object instead of a folder full of numbered PNGs. Use
   * this to navigate into the raw files ("Show files").
   */
  readonly spriteFolderPath?: string;
  /** Frame count of a collapsed sprite folder's first clip; badge on the card. */
  readonly spriteFrameCount?: number;
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
  /** Flipbook preview data; non-null only for `previewType === 'animation'`. */
  readonly animation: AnimationPreviewData | null;
}

export interface AssetsPreviewSnapshot {
  readonly selectedFolderPath: string | null;
  readonly displayPath: string;
  readonly isLoading: boolean;
  readonly errorMessage: string | null;
  readonly selectedItemPath: string | null;
  readonly selectedItem: AssetPreviewItem | null;
  readonly items: readonly AssetPreviewItem[];
  /** Recursive nested-item count of the selected folder; null while loading / none. */
  readonly folderItemCount: number | null;
  /** Recursive nested byte size of the selected folder; null while loading / none. */
  readonly folderSizeBytes: number | null;
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
    folderItemCount: number | null;
    folderSizeBytes: number | null;
  } = {
    selectedFolderPath: null,
    displayPath: 'res://',
    isLoading: false,
    errorMessage: null,
    selectedItemPath: null,
    selectedItem: null,
    items: [],
    folderItemCount: null,
    folderSizeBytes: null,
  };

  private requestVersion = 0;
  private disposeProjectSubscription?: () => void;
  private thumbnailWorkerPromise: Promise<void> | null = null;
  /**
   * Collapse managed sprite folders into single sprite cards. On by default
   * (design decision §8.11.6); the Assets panel header toggles it.
   */
  private collapseSpriteFolders = true;
  /**
   * Managed-folder verdicts by folder path (`null` = not managed). The predicate
   * costs a `listDirectory` + one `.pix3anim` read per folder, so it is cached
   * and dropped whenever the folder contents could have changed.
   */
  private readonly spriteFolderCache = new Map<string, string | null>();

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
      folderItemCount: this.state.folderItemCount,
      folderSizeBytes: this.state.folderSizeBytes,
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
    // Contents may have changed — a folder can become (or stop being) managed.
    this.spriteFolderCache.clear();
    await this.loadFolder(this.state.selectedFolderPath);
  }

  /** Whether managed sprite folders render as one sprite card. */
  public getCollapseSpriteFolders(): boolean {
    return this.collapseSpriteFolders;
  }

  public async setCollapseSpriteFolders(collapse: boolean): Promise<void> {
    if (this.collapseSpriteFolders === collapse) {
      return;
    }
    this.collapseSpriteFolders = collapse;
    await this.refreshCurrentFolder();
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
      this.state.folderItemCount = null;
      this.state.folderSizeBytes = null;
      this.spriteFolderCache.clear();
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
    this.state.folderItemCount = null;
    this.state.folderSizeBytes = null;
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
      void this.computeFolderStats(folderPath, requestVersion);
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

  /**
   * Recursively totals the selected folder's nested size + item count and
   * publishes them. Version-guarded the same way as {@link loadFolder}: if the
   * selection advanced (a newer `requestVersion` exists) before the walk
   * resolves, the stale result is discarded.
   */
  private async computeFolderStats(folderPath: string, requestVersion: number): Promise<void> {
    if (requestVersion !== this.requestVersion) {
      return;
    }

    try {
      const stats = await computeDirectoryStats(this.projectService, folderPath);
      if (requestVersion !== this.requestVersion) {
        return;
      }
      this.state.folderItemCount = stats.itemCount;
      this.state.folderSizeBytes = stats.sizeBytes;
      this.notify();
    } catch {
      // Leave the stats null on failure; the folder view still functions.
    }
  }

  /**
   * Collapse a **managed sprite folder** into a single card (§8.2/§8.5 of the
   * sprite-editor design): one folder holding exactly one `.pix3anim` whose frame
   * textures all live beside it *is* one sprite, and showing it as a folder full
   * of numbered PNGs is the Construct-3 illusion breaking.
   *
   * The returned item deliberately carries the `.pix3anim`'s own `path`, so every
   * existing `.pix3anim` behaviour — drag payload, double-click → animation
   * editor, flipbook preview, inspector binding — works with no further wiring.
   * `spriteFolderPath` is how a caller gets back to the raw files.
   *
   * Returns `null` for anything that isn't managed, which keeps hand-organised
   * layouts rendering exactly as before.
   */
  private async tryBuildSpriteFolderItem(
    name: string,
    path: string
  ): Promise<AssetPreviewItem | null> {
    const normalizedPath = this.normalizePath(path);
    const cached = this.spriteFolderCache.get(normalizedPath);
    const animationPath =
      cached !== undefined ? cached : await this.resolveManagedSpriteAnimation(normalizedPath);
    this.spriteFolderCache.set(normalizedPath, animationPath);
    if (!animationPath) {
      return null;
    }

    let blob: Blob | null = null;
    try {
      blob = await this.storage.readBlob(animationPath);
    } catch {
      return null;
    }

    const animation = await this.buildAnimationPreview(blob, 1);
    return {
      name,
      path: animationPath,
      kind: 'file',
      extension: 'pix3anim',
      previewType: 'animation',
      thumbnailUrl: null,
      previewUrl: null,
      previewText: null,
      thumbnailStatus: animation && animation.frames.length > 0 ? 'ready' : 'error',
      iconName: 'film',
      sizeBytes: null,
      width: null,
      height: null,
      durationSeconds: animation ? this.getAnimationDuration(animation) : null,
      channelCount: null,
      sampleRate: null,
      lastModified: blob instanceof File ? blob.lastModified : null,
      animation,
      spriteFolderPath: normalizedPath,
      spriteFrameCount: animation?.frameCount ?? 0,
    };
  }

  /**
   * The `.pix3anim` path of a managed sprite folder, or `null`. Managed means:
   * exactly one `.pix3anim` directly in the folder, and every frame texture it
   * references resolves inside that same folder.
   */
  private async resolveManagedSpriteAnimation(folderPath: string): Promise<string | null> {
    let entries: Awaited<ReturnType<typeof this.projectService.listDirectory>>;
    try {
      entries = await this.projectService.listDirectory(folderPath);
    } catch {
      return null;
    }

    const animations = entries.filter(
      entry => entry.kind === 'file' && this.getExtension(entry.name) === 'pix3anim'
    );
    if (animations.length !== 1) {
      return null;
    }

    const animationPath = animations[0].path;
    try {
      const resource = normalizeAnimationResource(
        JSON.parse(await this.storage.readTextFile(animationPath))
      );
      const framePaths = resource.clips.flatMap(clip =>
        clip.frames.map(frame => getAnimationFrameTexturePath(resource, frame))
      );
      return isManagedSpriteFolder(animationPath, framePaths) ? animationPath : null;
    } catch {
      return null;
    }
  }

  private async buildPreviewItem(
    name: string,
    path: string,
    kind: FileSystemHandleKind
  ): Promise<AssetPreviewItem> {
    const extension = this.getExtension(name);
    if (kind === 'directory') {
      const collapsed = this.collapseSpriteFolders
        ? await this.tryBuildSpriteFolderItem(name, path)
        : null;
      if (collapsed) {
        return collapsed;
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
        iconName: 'folder',
        sizeBytes: null,
        width: null,
        height: null,
        durationSeconds: null,
        channelCount: null,
        sampleRate: null,
        lastModified: null,
        animation: null,
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
          animation: null,
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
          animation: null,
        };
      }
    }

    if (ANIMATION_EXTENSIONS.has(extension)) {
      if (fileBlob) {
        // Only the first frame is resolved here — see AnimationPreviewData.
        const animation = await this.buildAnimationPreview(fileBlob, 1);
        return {
          name,
          path,
          kind,
          extension,
          previewType: 'animation',
          thumbnailUrl: null,
          previewUrl: null,
          previewText: null,
          thumbnailStatus: animation && animation.frames.length > 0 ? 'ready' : 'error',
          iconName: 'activity',
          sizeBytes,
          width: null,
          height: null,
          durationSeconds: animation ? this.getAnimationDuration(animation) : null,
          channelCount: null,
          sampleRate: null,
          lastModified,
          animation,
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
        animation: null,
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
        animation: null,
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
        animation: null,
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
      animation: null,
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

  /**
   * Parses a `.pix3anim` and resolves the first clip's frames for display.
   *
   * `frameLimit` caps how many frames get a loaded image: the folder scan asks
   * for 1 (the card thumbnail), the play affordance asks for all of them. Frames
   * are deduplicated by texture path, so a sheet-based clip costs a single blob
   * read no matter how many frames it has.
   */
  private async buildAnimationPreview(
    fileBlob: Blob,
    frameLimit: number
  ): Promise<AnimationPreviewData | null> {
    let resource: AnimationResource;
    try {
      resource = normalizeAnimationResource(JSON.parse(await fileBlob.text()));
    } catch {
      return null;
    }

    const clip = resource.clips[0];
    if (!clip || clip.frames.length === 0) {
      return null;
    }

    const wanted = Math.max(0, Math.min(frameLimit, clip.frames.length));
    const urlByTexturePath = new Map<string, string | null>();
    const frames: AnimationPreviewFrame[] = [];

    for (const frame of clip.frames.slice(0, wanted)) {
      const texturePath = getAnimationFrameTexturePath(resource, frame);
      if (!texturePath) {
        continue;
      }

      let url = urlByTexturePath.get(texturePath);
      if (url === undefined) {
        url = await this.loadResourceObjectUrl(texturePath);
        urlByTexturePath.set(texturePath, url);
      }
      if (!url) {
        continue;
      }

      // A sequence frame carries no sub-rect (repeat defaults to 0) — show the
      // whole image; a sheet frame carries the UV rect the runtime samples.
      const hasRect = frame.repeat.x > 0 && frame.repeat.y > 0;
      frames.push({
        url,
        offsetX: hasRect ? frame.offset.x : 0,
        offsetY: hasRect ? frame.offset.y : 0,
        repeatX: hasRect ? frame.repeat.x : 1,
        repeatY: hasRect ? frame.repeat.y : 1,
        durationMultiplier: frame.durationMultiplier,
      });
    }

    return {
      clipName: clip.name,
      fps: clip.fps,
      loop: clip.loop,
      pingPong: clip.playbackMode === 'ping-pong',
      frameCount: clip.frames.length,
      frames,
      framesLoaded: frames.length >= clip.frames.length,
    };
  }

  /** Total clip length in seconds, honouring per-frame duration multipliers. */
  private getAnimationDuration(animation: AnimationPreviewData): number | null {
    if (animation.fps <= 0 || animation.frameCount === 0) {
      return null;
    }
    // Only the loaded frames carry their multiplier; assume 1 for the rest so the
    // card can show a length before the full clip is fetched.
    const loadedTotal = animation.frames.reduce(
      (total, frame) => total + frame.durationMultiplier,
      0
    );
    const assumed = Math.max(0, animation.frameCount - animation.frames.length);
    return (loadedTotal + assumed) / animation.fps;
  }

  private async loadResourceObjectUrl(resourcePath: string): Promise<string | null> {
    const relativePath = this.normalizePath(resourcePath.replace(/^res:\/\//, ''));
    try {
      const blob = await this.storage.readBlob(relativePath);
      if (!blob) {
        return null;
      }
      // Deliberately NOT tracked here: the folder scan clears `objectUrls`
      // after building every item, so URLs are registered by `trackBlobUrls`
      // once the new item list is accepted (`requestAnimationFrames` tracks its
      // own).
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  /**
   * Loads the remaining frames of an animation asset so it can actually play.
   * No-op once the clip is fully loaded — the panel calls this every time the
   * user hits play.
   */
  public async requestAnimationFrames(path: string): Promise<void> {
    const normalizedPath = this.normalizePath(path);
    const requestVersion = this.requestVersion;
    const item = this.state.items.find(entry => this.normalizePath(entry.path) === normalizedPath);
    if (!item || item.kind !== 'file' || !item.animation || item.animation.framesLoaded) {
      return;
    }

    let fileBlob: Blob | null = null;
    try {
      fileBlob = await this.storage.readBlob(item.path);
    } catch {
      fileBlob = null;
    }
    if (!fileBlob || requestVersion !== this.requestVersion) {
      return;
    }

    const animation = await this.buildAnimationPreview(fileBlob, Number.POSITIVE_INFINITY);
    if (!animation || requestVersion !== this.requestVersion) {
      return;
    }

    const index = this.state.items.findIndex(
      entry => this.normalizePath(entry.path) === normalizedPath
    );
    if (index < 0) {
      return;
    }

    const next = { ...this.state.items[index], animation };
    // The re-read produced fresh URLs for every frame, including the one the
    // card is showing right now — track them and let the previous frame-0 URL
    // die with the folder (revoking it here would blank the visible thumbnail
    // until Lit's next update).
    this.trackBlobUrls([next]);
    this.state.items = [
      ...this.state.items.slice(0, index),
      next,
      ...this.state.items.slice(index + 1),
    ];
    if (this.state.selectedItemPath === normalizedPath) {
      this.state.selectedItem = next;
    }
    this.notify();
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

    if (CODE_SCRIPT_EXTENSIONS.has(extension)) {
      return 'code';
    }

    if (['json', 'css', 'html', 'md', 'txt', 'yml', 'yaml'].includes(extension)) {
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
      // Frame URLs are deduplicated per texture, so the Set collapses the
      // repeats a sheet-based clip produces.
      for (const frame of item.animation?.frames ?? []) {
        if (frame.url.startsWith('blob:')) {
          this.objectUrls.add(frame.url);
        }
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
      for (const frame of item.animation?.frames ?? []) {
        if (frame.url.startsWith('blob:')) {
          URL.revokeObjectURL(frame.url);
          this.objectUrls.delete(frame.url);
        }
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
