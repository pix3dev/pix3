import { injectable } from '@/fw/di';
import { isDocumentVisible } from '@/services/core/page-activity';
import { ACK_FILE, isPix3InternalPath } from '@/services/project/coauthoring/coauthoring-paths';

/**
 * FileWatchService monitors external changes to opened scene files.
 *
 * Two sources of change, one listener API:
 * - **polling** (File System Access): a watched path with a `FileSystemFileHandle` is polled with
 *   `getFile()` and compared by `lastModified`.
 * - **push** (`pix3 serve` workspace): with {@link setPushMode} on, a path may be watched without
 *   a handle; the workspace session reports changes through {@link notifyExternalChange} as the
 *   server's `change` frames arrive. Nothing is polled for those paths.
 *
 * Either way a detected change invokes the same listeners; the editor shell routes scene changes
 * through `ExternalChangeService` (stabilisation window, batch, own-hash skip) into
 * `ExternalMergeService` (merge with the protected set, or reload), so it does not care where the
 * change came from.
 *
 * Polling runs while the document is **visible**, focused or not (an editor beside the agent's
 * terminal must see the agent's edits), and keeps running during play: a change is detected and
 * reported, and `ExternalChangeService` marks the editor `stale` instead of reloading mid-game.
 * `.pix3/` (recovery journal, protected set, challenge files) is never reported, except
 * `.pix3/ack.json`, which `AckService` watches explicitly.
 */
@injectable()
export class FileWatchService {
  /** Map of watched file paths to their file handles. */
  private readonly fileHandles = new Map<string, FileSystemFileHandle>();

  /** Map of watched file paths to their polling interval IDs. */
  private readonly watchers = new Map<string, number>();

  /** Map of watched file paths to their last known modification times. */
  private readonly lastModifiedTimes = new Map<string, number>();

  /** Callbacks invoked when a watched file is modified externally. */
  private readonly changeListeners = new Map<string, Set<() => void>>();

  /** Handle-less watches are accepted (changes arrive by push, see {@link notifyExternalChange}). */
  private pushMode = false;

  /** Last content hash reported or written per watched path (push mode dedup). */
  private readonly lastKnownHashes = new Map<string, string>();

  /**
   * Polling interval in milliseconds. Each poll costs one `getFile()` (metadata only) per watched
   * file. The co-authoring budget is "an agent's edit shows up within ~3 s in an unfocused
   * window": this interval plus the 2 x 300 ms stabilisation window of `ExternalChangeService`.
   */
  private readonly pollInterval: number = 1000;
  private isPageVisible = isDocumentVisible(document);

  private readonly handlePageActivityChange = () => {
    this.isPageVisible = isDocumentVisible(document);
    this.updatePollingState();
  };

  constructor() {
    window.addEventListener('focus', this.handlePageActivityChange);
    window.addEventListener('blur', this.handlePageActivityChange);
    window.addEventListener('pageshow', this.handlePageActivityChange);
    window.addEventListener('pagehide', this.handlePageActivityChange);
    document.addEventListener('visibilitychange', this.handlePageActivityChange);
  }

  /**
   * True while polling timers should be running: the document is visible. Focus does not matter,
   * and neither does play mode (changes are detected then and turned into a `stale` flag).
   */
  private get shouldPoll(): boolean {
    return this.isPageVisible;
  }

  /** Check every polled file now (the explicit `syncNow()` path). Resolves when all were read. */
  async checkAllNow(): Promise<void> {
    await Promise.all(
      Array.from(this.fileHandles.entries()).map(([filePath, fileHandle]) =>
        this.checkFileChange(filePath, fileHandle)
      )
    );
  }

  /** Start/stop all pollers to match {@link shouldPoll}; checks immediately on resume. */
  private updatePollingState(): void {
    if (this.shouldPoll) {
      this.resumePolling();
      for (const [filePath, fileHandle] of this.fileHandles.entries()) {
        void this.checkFileChange(filePath, fileHandle);
      }
      return;
    }

    this.pausePolling();
  }

  /**
   * Update the last-known modification time for a watched file.
   * Useful to prevent internal writes (Save/Save As) from being treated as external changes.
   */
  setLastKnownModifiedTime(filePath: string, lastModifiedTime: number | null | undefined): void {
    if (lastModifiedTime === null || lastModifiedTime === undefined) {
      return;
    }
    this.lastModifiedTimes.set(filePath, lastModifiedTime);
  }

  /** Turn push mode on (a workspace is connected) or off (it is gone). */
  setPushMode(enabled: boolean): void {
    this.pushMode = enabled;
    if (!enabled) {
      this.lastKnownHashes.clear();
    }
  }

  /** True while watches without a file handle are accepted (changes are pushed, not polled). */
  isPushMode(): boolean {
    return this.pushMode;
  }

  /**
   * Record the content hash this editor itself last wrote or read for `filePath`, so a pushed
   * change carrying the same hash is recognised as nothing new.
   */
  setLastKnownHash(filePath: string, sha256: string | null | undefined): void {
    const key = normalizeWatchPath(filePath);
    if (sha256) {
      this.lastKnownHashes.set(key, sha256);
    } else {
      this.lastKnownHashes.delete(key);
    }
  }

  /**
   * A pushed external change (workspace `change` frame). Invokes the listeners of every watched
   * path that names the same file — watched keys are `res://…` for scenes and bare relative paths
   * for scripts, so matching is on the normalised form. A change whose `sha256` equals the last
   * known hash of that path is ignored. Returns true when at least one listener ran.
   */
  notifyExternalChange(filePath: string, info: { readonly sha256?: string | null } = {}): boolean {
    const key = normalizeWatchPath(filePath);
    // `.pix3/` is editor-private — except the agent's read confirmations, watched explicitly.
    if (isPix3InternalPath(key) && key !== ACK_FILE) {
      return false;
    }
    const sha256 = info.sha256 ?? null;
    if (sha256 !== null && this.lastKnownHashes.get(key) === sha256) {
      return false;
    }
    if (sha256 !== null) {
      this.lastKnownHashes.set(key, sha256);
    } else {
      this.lastKnownHashes.delete(key);
    }

    let notified = false;
    for (const [watchedPath, listeners] of Array.from(this.changeListeners.entries())) {
      if (normalizeWatchPath(watchedPath) !== key) {
        continue;
      }
      for (const callback of Array.from(listeners)) {
        notified = true;
        try {
          callback();
        } catch (error) {
          console.error('[FileWatchService] Change listener error:', error);
        }
      }
    }
    return notified;
  }

  /** Whether any listener watches `filePath` (in any of its spellings). */
  isWatching(filePath: string): boolean {
    const key = normalizeWatchPath(filePath);
    for (const watchedPath of this.changeListeners.keys()) {
      if (normalizeWatchPath(watchedPath) === key) {
        return true;
      }
    }
    return false;
  }

  /**
   * Start watching a scene file for external changes.
   * @param filePath Resource path (e.g., res://scenes/level.pix3scene)
   * @param fileHandle File system handle for the file; may be null in push mode
   * @param lastModifiedTime Initial modification time
   * @param onChange Callback invoked when file changes externally
   */
  watch(
    filePath: string,
    fileHandle: FileSystemFileHandle | null | undefined,
    lastModifiedTime: number | null | undefined,
    onChange: () => void
  ): void {
    if (!fileHandle && this.pushMode) {
      if (!this.changeListeners.has(filePath)) {
        this.changeListeners.set(filePath, new Set());
      }
      this.changeListeners.get(filePath)!.add(onChange);
      return;
    }

    if (!fileHandle) {
      console.warn(`[FileWatchService] Cannot watch ${filePath}: no file handle provided`);
      return;
    }

    if (typeof fileHandle.getFile !== 'function') {
      console.warn(`[FileWatchService] Cannot watch ${filePath}: invalid file handle provided`);
      return;
    }

    // Register change listener
    if (!this.changeListeners.has(filePath)) {
      this.changeListeners.set(filePath, new Set());
    }
    this.changeListeners.get(filePath)!.add(onChange);

    // If already watching, don't start a new poller
    if (this.watchers.has(filePath)) {
      return;
    }

    // Store file handle and initial modification time
    this.fileHandles.set(filePath, fileHandle);
    if (lastModifiedTime !== null && lastModifiedTime !== undefined) {
      this.lastModifiedTimes.set(filePath, lastModifiedTime);
    }

    if (this.shouldPoll) {
      this.startPolling(filePath);
    }
  }

  /**
   * Stop watching a scene file for changes.
   * @param filePath Resource path
   * @param onChange Optional callback to remove (if provided, only removes this specific listener)
   */
  unwatch(filePath: string, onChange?: () => void): void {
    if (onChange) {
      // Remove specific listener
      const listeners = this.changeListeners.get(filePath);
      if (listeners) {
        listeners.delete(onChange);
        if (listeners.size === 0) {
          this.changeListeners.delete(filePath);
        } else {
          // Still have other listeners, keep watching
          return;
        }
      }
    } else {
      this.changeListeners.delete(filePath);
    }
    this.lastKnownHashes.delete(normalizeWatchPath(filePath));

    // Stop polling if no more listeners. The handle is dropped even while polling is paused
    // (hidden tab / play mode), or `resumePolling` would bring an unwatched path back.
    const intervalId = this.watchers.get(filePath);
    if (intervalId) {
      window.clearInterval(intervalId);
      this.watchers.delete(filePath);
    }
    if (this.fileHandles.delete(filePath) && import.meta.env.MODE === 'development') {
      console.debug(`[FileWatchService] Stopped watching: ${filePath}`);
    }
    this.lastModifiedTimes.delete(filePath);
  }

  /**
   * Stop watching all files.
   */
  unwatchAll(): void {
    this.pausePolling();
    this.watchers.clear();
    this.fileHandles.clear();
    this.lastModifiedTimes.clear();
    this.changeListeners.clear();
    this.lastKnownHashes.clear();
  }

  private startPolling(filePath: string): void {
    if (this.watchers.has(filePath)) {
      return;
    }

    const intervalId = window.setInterval(() => {
      const handle = this.fileHandles.get(filePath);
      if (!handle) {
        this.unwatch(filePath);
        return;
      }
      void this.checkFileChange(filePath, handle);
    }, this.pollInterval);

    this.watchers.set(filePath, intervalId);

    if (import.meta.env.MODE === 'development') {
      console.debug(`[FileWatchService] Started watching: ${filePath}`);
    }
  }

  private pausePolling(): void {
    for (const intervalId of this.watchers.values()) {
      window.clearInterval(intervalId);
    }
    this.watchers.clear();
  }

  private resumePolling(): void {
    for (const filePath of this.fileHandles.keys()) {
      this.startPolling(filePath);
    }
  }

  /**
   * Check if a file has been modified externally by comparing modification times.
   */
  private async checkFileChange(filePath: string, fileHandle: FileSystemFileHandle): Promise<void> {
    try {
      const file = await fileHandle.getFile();
      const currentModifiedTime = file.lastModified;
      let lastKnownTime = this.lastModifiedTimes.get(filePath);

      if (lastKnownTime === undefined || lastKnownTime === null) {
        // Initialize the last known time on the first check if it wasn't provided
        this.lastModifiedTimes.set(filePath, currentModifiedTime);
        lastKnownTime = currentModifiedTime;
      }

      if (currentModifiedTime > lastKnownTime) {
        // File was modified externally
        this.lastModifiedTimes.set(filePath, currentModifiedTime);

        if (import.meta.env.MODE === 'development') {
          console.debug(`[FileWatchService] External change detected: ${filePath}`, {
            lastKnownTime,
            currentModifiedTime,
          });
        }

        // Invoke all registered change callbacks
        const listeners = this.changeListeners.get(filePath);
        if (listeners) {
          for (const callback of listeners) {
            try {
              callback();
            } catch (error) {
              console.error('[FileWatchService] Change listener error:', error);
            }
          }
        }
      }
    } catch (error) {
      // File may have been deleted or access lost; stop watching
      console.warn(`[FileWatchService] Error checking file changes for ${filePath}:`, error);
      this.unwatch(filePath);
    }
  }

  dispose(): void {
    window.removeEventListener('focus', this.handlePageActivityChange);
    window.removeEventListener('blur', this.handlePageActivityChange);
    window.removeEventListener('pageshow', this.handlePageActivityChange);
    window.removeEventListener('pagehide', this.handlePageActivityChange);
    document.removeEventListener('visibilitychange', this.handlePageActivityChange);
    this.unwatchAll();
  }
}

/** `res://scenes/a.pix3scene`, `./scenes/a.pix3scene`, `/scenes/a.pix3scene` → `scenes/a.pix3scene`. */
function normalizeWatchPath(path: string): string {
  return path
    .replace(/^res:\/\//i, '')
    .replace(/\\+/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '');
}
