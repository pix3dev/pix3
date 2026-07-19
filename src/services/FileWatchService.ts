import { subscribe } from 'valtio/vanilla';

import { injectable } from '@/fw/di';
import { appState } from '@/state';
import { isDocumentActive } from './page-activity';

/**
 * FileWatchService monitors external changes to opened scene files using polling.
 * When a file is modified externally, it emits a change event that can trigger auto-reload.
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

  /**
   * Polling interval in milliseconds. External edits to an open scene are a
   * human-scale event — each poll costs a `getFile()` per watched file, so a
   * couple of seconds of latency buys a large idle-CPU/battery saving over the
   * old 500ms cadence.
   */
  private readonly pollInterval: number = 2500;
  private isPageActive = isDocumentActive(document);
  private isPlaying = appState.ui.isPlaying;
  private readonly disposePlaySubscription: () => void;

  private readonly handlePageActivityChange = () => {
    this.isPageActive = isDocumentActive(document);
    this.updatePollingState();
  };

  constructor() {
    window.addEventListener('focus', this.handlePageActivityChange);
    window.addEventListener('blur', this.handlePageActivityChange);
    window.addEventListener('pageshow', this.handlePageActivityChange);
    window.addEventListener('pagehide', this.handlePageActivityChange);
    document.addEventListener('visibilitychange', this.handlePageActivityChange);
    // Auto-reload from an external edit mid-play would tear down the running
    // game anyway, so polling during play is pure waste — pause it and catch up
    // with an immediate check when play stops.
    this.disposePlaySubscription = subscribe(appState.ui, () => {
      if (appState.ui.isPlaying !== this.isPlaying) {
        this.isPlaying = appState.ui.isPlaying;
        this.updatePollingState();
      }
    });
  }

  /** True while polling timers should be running at all. */
  private get shouldPoll(): boolean {
    return this.isPageActive && !this.isPlaying;
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

  /**
   * Start watching a scene file for external changes.
   * @param filePath Resource path (e.g., res://scenes/level.pix3scene)
   * @param fileHandle File system handle for the file
   * @param lastModifiedTime Initial modification time
   * @param onChange Callback invoked when file changes externally
   */
  watch(
    filePath: string,
    fileHandle: FileSystemFileHandle | null | undefined,
    lastModifiedTime: number | null | undefined,
    onChange: () => void
  ): void {
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
    }

    // Stop polling if no more listeners
    const intervalId = this.watchers.get(filePath);
    if (intervalId) {
      window.clearInterval(intervalId);
      this.watchers.delete(filePath);
      this.fileHandles.delete(filePath);
      this.lastModifiedTimes.delete(filePath);

      if (import.meta.env.MODE === 'development') {
        console.debug(`[FileWatchService] Stopped watching: ${filePath}`);
      }
    }
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
    this.disposePlaySubscription();
    this.unwatchAll();
  }
}
