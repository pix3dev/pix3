import { inject, injectable, ServiceContainer } from '@/fw/di';
import { appState } from '@/state';
import { FileWatchService } from '@/services/project/FileWatchService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { WorkspaceSessionService } from '@/services/project/workspace/WorkspaceSessionService';
import { ExternalChangeService } from '@/services/project/coauthoring/ExternalChangeService';
import { SceneDiskStateService } from '@/services/project/coauthoring/SceneDiskStateService';
import {
  isPix3InternalPath,
  toProjectPath,
} from '@/services/project/coauthoring/coauthoring-paths';
import { readDiskVersion } from '@/services/project/coauthoring/disk-version';
import { sha256 } from '@/services/project/external-merge/hash';
import { PROJECT_SCRIPT_DIRECTORIES } from '@pix3/runtime';

/** Upper bound of `syncNow()`'s wait for the stabilisation window (a file mid-write, a reload). */
const SYNC_SETTLE_TIMEOUT_MS = 15_000;
/** Directories the tree scan never descends into. */
const SKIPPED_SCAN_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'out', 'coverage']);
const SCRIPT_DIRECTORIES: readonly string[] = PROJECT_SCRIPT_DIRECTORIES;
const inScriptDirectory = (path: string): boolean =>
  SCRIPT_DIRECTORIES.some(directory => path.startsWith(`${directory}/`));
const SCRIPT_SOURCE = /\.(?:ts|js)$/i;

/** Structural subset of `ProjectScriptLoaderService` that `syncNow` uses. */
export interface SyncScriptLoader {
  getCollectedFiles(): ReadonlyMap<string, string>;
  syncAndBuild(options?: { force?: boolean }): Promise<void>;
  ensureReady(): Promise<void>;
}

export interface ProjectSyncDialogInstance {
  id: string;
  resolve: () => void;
}

/**
 * Two jobs under one name:
 * - the hybrid-sync dialog (local folder ↔ cloud copy): {@link showDialog} / {@link subscribe};
 * - {@link syncNow}: the explicit co-authoring barrier of plan §5 C6 — "make the editor catch up
 *   with the disk now, and tell me which versions it has".
 */
@injectable()
export class ProjectSyncService {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(FileWatchService)
  private readonly fileWatch!: FileWatchService;

  @inject(ExternalChangeService)
  private readonly externalChanges!: ExternalChangeService;

  @inject(SceneDiskStateService)
  private readonly diskState!: SceneDiskStateService;

  @inject(WorkspaceSessionService)
  private readonly workspaceSession!: WorkspaceSessionService;

  private scriptLoaderOverride: SyncScriptLoader | null = null;
  private activeDialog: ProjectSyncDialogInstance | null = null;
  private listeners = new Set<(activeDialog: ProjectSyncDialogInstance | null) => void>();
  private nextId = 0;

  public async showDialog(): Promise<void> {
    if (this.activeDialog) {
      return;
    }

    return new Promise(resolve => {
      const id = `project-sync-${this.nextId++}`;
      this.activeDialog = {
        id,
        resolve: () => {
          this.activeDialog = null;
          this.notifyListeners();
          resolve();
        },
      };

      this.notifyListeners();
    });
  }

  public close(): void {
    if (this.activeDialog) {
      this.activeDialog.resolve();
    }
  }

  public subscribe(listener: (activeDialog: ProjectSyncDialogInstance | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.activeDialog);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener(this.activeDialog);
    }
  }

  /** Tests: a fake script loader. */
  setScriptLoader(loader: SyncScriptLoader | null): void {
    this.scriptLoaderOverride = loader;
  }

  /**
   * Explicit synchronisation (plan §5 C6, the barrier of §5 D):
   * 1. immediate tree scan — the workspace manifest (`rescan`) or, for a local folder, a poll of
   *    every watched file plus a walk comparing script sources with the last build;
   * 2. every open scene whose disk bytes differ from the version the editor has is reported to the
   *    stabilisation window, and the call waits until it settled (stable → reloaded, or reported
   *    as unreadable);
   * 3. script compilation finished (`ProjectScriptLoaderService.ensureReady()`).
   *
   * Resolves to `{ <project path>: <sha256> }` of the version of each open scene the editor now
   * holds (what it last read or wrote). The agent channel's `sync_barrier` adds the script
   * sources of the last build ({@link builtScriptHashes}).
   */
  async syncNow(): Promise<Record<string, string>> {
    if (appState.project.status !== 'ready') {
      return {};
    }
    const loader = await this.resolveScriptLoader();
    let scriptsChanged = false;

    if (this.storage.getBackend() === 'workspace') {
      await this.workspaceSession.rescan();
    } else {
      await this.fileWatch.checkAllNow();
    }
    // Also for a workspace: a pushed `modify` only schedules a (debounced) rebuild, and the
    // barrier must not report a build that is about to be replaced.
    if (loader) {
      scriptsChanged = await this.scriptsDifferFromLastBuild(loader);
    }

    for (const path of this.openScenePaths()) {
      try {
        const version = await readDiskVersion(this.storage, path);
        if (!version) continue;
        if (!this.diskState.isKnownHash(path, version.hash)) {
          this.externalChanges.report(path);
        }
      } catch (error) {
        console.warn(`[ProjectSyncService] syncNow could not read ${path}`, error);
      }
    }

    await Promise.race([
      this.externalChanges.whenSettled(),
      new Promise<void>(resolve => setTimeout(resolve, SYNC_SETTLE_TIMEOUT_MS)),
    ]);

    if (loader) {
      if (scriptsChanged) {
        await loader.syncAndBuild({ force: true });
      }
      await loader.ensureReady();
    }

    const hashes: Record<string, string> = {};
    for (const path of this.openScenePaths()) {
      const known = this.diskState.getKnown(path);
      if (known) hashes[path] = known.hash;
    }
    return hashes;
  }

  /**
   * `{ <project path>: <sha256> }` of every script source the last build compiled. The hash is of
   * the disk BYTES when the file still decodes to exactly the text that was built (so a BOM does
   * not read as a difference), else of the built text — which then differs from the disk, as it
   * should.
   */
  async builtScriptHashes(): Promise<Record<string, string>> {
    const loader = await this.resolveScriptLoader();
    const hashes: Record<string, string> = {};
    if (!loader) return hashes;
    for (const [rawPath, content] of loader.getCollectedFiles()) {
      const path = toProjectPath(rawPath);
      let hash: string | null = null;
      try {
        const version = await readDiskVersion(this.storage, path);
        if (version && version.text === content) hash = version.hash;
      } catch {
        hash = null;
      }
      hashes[path] = hash ?? (await sha256(content));
    }
    return hashes;
  }

  private openScenePaths(): string[] {
    const paths = new Set<string>();
    for (const descriptor of Object.values(appState.scenes.descriptors)) {
      if (descriptor?.filePath?.startsWith('res://')) {
        paths.add(toProjectPath(descriptor.filePath));
      }
    }
    return Array.from(paths);
  }

  /** Local folders: any script source added, removed or edited since the last build? */
  private async scriptsDifferFromLastBuild(loader: SyncScriptLoader): Promise<boolean> {
    const built = loader.getCollectedFiles();
    const current = new Set<string>();
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await this.storage.listDirectory(directory);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.kind === 'directory') {
          if (
            entry.name.startsWith('.') ||
            SKIPPED_SCAN_DIRECTORIES.has(entry.name) ||
            isPix3InternalPath(entry.path)
          ) {
            continue;
          }
          await walk(entry.path);
        } else if (SCRIPT_SOURCE.test(entry.name)) {
          current.add(toProjectPath(entry.path));
        }
      }
    };
    for (const directory of SCRIPT_DIRECTORIES) {
      await walk(directory);
    }

    const builtScripts = new Map<string, string>();
    for (const [path, content] of built) {
      const key = toProjectPath(path);
      if (SCRIPT_SOURCE.test(key) && inScriptDirectory(key)) builtScripts.set(key, content);
    }
    for (const path of current) {
      const content = builtScripts.get(path);
      if (content === undefined) {
        return true; // a new source file
      }
      try {
        if ((await this.storage.readTextFile(path)) !== content) return true;
      } catch {
        return true;
      }
    }
    for (const path of builtScripts.keys()) {
      if (!current.has(path)) return true;
    }
    return false;
  }

  private async resolveScriptLoader(): Promise<SyncScriptLoader | null> {
    if (this.scriptLoaderOverride) {
      return this.scriptLoaderOverride;
    }
    try {
      const { ProjectScriptLoaderService } = await import(
        '@/services/scripting/ProjectScriptLoaderService'
      );
      const container = ServiceContainer.getInstance();
      return container.getService<SyncScriptLoader>(
        container.getOrCreateToken(ProjectScriptLoaderService)
      );
    } catch (error) {
      console.warn('[ProjectSyncService] Script loader unavailable for syncNow', error);
      return null;
    }
  }

  public dispose(): void {
    this.activeDialog = null;
    this.listeners.clear();
  }
}
