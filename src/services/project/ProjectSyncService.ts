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

/** The project manifest; the editor reads it once on open, so the barrier must check it. */
export const PROJECT_MANIFEST_PATH = 'pix3project.yaml';

/** Structural subset of `ProjectScriptLoaderService` that `syncNow` uses. */
export interface SyncScriptLoader {
  getCollectedFiles(): ReadonlyMap<string, string>;
  /** sha256 of the bytes behind each collected file, recorded when the build read it. */
  getCollectedFileHashes?(): ReadonlyMap<string, string>;
  syncAndBuild(options?: { force?: boolean }): Promise<void>;
  ensureReady(): Promise<void>;
}

/** Structural subset of `ProjectService`: the `pix3project.yaml` the editor runs with. */
export interface SyncManifestSource {
  /** sha256 of the manifest bytes the editor last read or wrote; null when it has none. */
  getLoadedManifestHash(): string | null;
  /** Re-read `pix3project.yaml` into `appState.project.manifest`. */
  reloadProjectManifest(): Promise<void>;
}

/** What the agent channel's sync barrier reports: every input of the game and its version. */
export interface BarrierRevision {
  /**
   * `{ <project path>: <sha256> }` — every open scene/prefab, every source the last script build
   * read (entry scripts and every module the bundle pulled in) and `pix3project.yaml`.
   */
  readonly loaded: Record<string, string>;
  /** Inputs the editor cannot vouch for (the barrier reports them as load errors). */
  readonly problems: ReadonlyArray<{ readonly file: string | null; readonly message: string }>;
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
  private manifestSourceOverride: SyncManifestSource | null = null;
  /** sha256 of a collected source's text, memoised per path while the text is the same. */
  private readonly textHashes = new Map<string, { content: string; hash: string }>();
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

  /** Tests: a fake manifest source. */
  setManifestSource(source: SyncManifestSource | null): void {
    this.manifestSourceOverride = source;
  }

  /**
   * Explicit synchronisation (plan §5 C6, the barrier of §5 D):
   * 1. immediate tree scan — the workspace manifest (`rescan`) or, for a local folder, a poll of
   *    every watched file plus a walk comparing script sources with the last build;
   * 2. every open scene whose disk bytes differ from the version the editor has is reported to the
   *    stabilisation window, and the call waits until it settled (stable → reloaded, or reported
   *    as unreadable);
   * 3. `pix3project.yaml` re-read when the disk holds another version than the editor's;
   * 4. script compilation finished (`ProjectScriptLoaderService.ensureReady()`).
   *
   * Resolves to `{ <project path>: <sha256> }` of the version of each open scene the editor now
   * holds (what it last read or wrote). The agent channel's `sync_barrier` uses
   * {@link barrierRevision}, which adds the build inputs and the manifest.
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
        const diskHash = await this.currentDiskHash(path);
        if (!diskHash) continue;
        // A pending path is re-read even when its disk hash is the known one: a broken version
        // put back to exactly the editor's bytes must clear the pending/unreadable state.
        if (!this.diskState.isKnownHash(path, diskHash) || this.externalChanges.isPending(path)) {
          this.externalChanges.report(path);
        }
      } catch (error) {
        console.warn(`[ProjectSyncService] syncNow could not read ${path}`, error);
      }
    }

    await this.catchUpManifest();

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
   * The barrier's revision (plan §5 D step 2): {@link syncNow}, then the version of every input
   * the game will run from — each open scene/prefab (whatever its path), each source of the last
   * script build ({@link builtScriptHashes}) and `pix3project.yaml`. An open scene the editor
   * holds no disk version of is a problem, never silently left out: a revision without it would
   * vouch for a game it does not describe.
   */
  async barrierRevision(): Promise<BarrierRevision> {
    if (appState.project.status !== 'ready') {
      return {
        loaded: {},
        problems: [{ file: null, message: 'No project is open in the Pix3 editor.' }],
      };
    }
    const scenes = await this.syncNow();
    const loaded: Record<string, string> = { ...(await this.builtScriptHashes()) };
    const manifestHash = (await this.resolveManifestSource())?.getLoadedManifestHash() ?? null;
    if (manifestHash) loaded[PROJECT_MANIFEST_PATH] = manifestHash;
    Object.assign(loaded, scenes);

    const problems: Array<{ file: string | null; message: string }> = [];
    for (const path of this.openScenePaths()) {
      if (path in scenes) continue;
      let exists = false;
      try {
        exists = await this.storage.fileExists(path);
      } catch {
        exists = true;
      }
      // A scene that was never saved has no disk version to verify; it is not a disk input.
      if (!exists) continue;
      problems.push({
        file: path,
        message:
          'The editor holds no verified disk version of this open scene (it did not settle on ' +
          'the file on disk). Reopen the scene in the editor, then call again.',
      });
    }
    return { loaded, problems };
  }

  /**
   * `{ <project path>: <sha256> }` of every source the last build read — the entry scripts and
   * every module the bundle pulled in (anywhere under the project, e.g. `src/**`). The hash is the
   * one the loader recorded while reading (the workspace ETag of that read: the exact bytes that
   * were built), else the hash of the built text. No file is read here.
   */
  async builtScriptHashes(): Promise<Record<string, string>> {
    const loader = await this.resolveScriptLoader();
    const hashes: Record<string, string> = {};
    if (!loader) return hashes;
    const recorded = loader.getCollectedFileHashes?.();
    for (const [rawPath, content] of loader.getCollectedFiles()) {
      hashes[toProjectPath(rawPath)] =
        recorded?.get(rawPath) ?? (await this.textHash(rawPath, content));
    }
    return hashes;
  }

  private async textHash(path: string, content: string): Promise<string> {
    const cached = this.textHashes.get(path);
    if (cached && cached.content === content) return cached.hash;
    const hash = await sha256(content);
    this.textHashes.set(path, { content, hash });
    return hash;
  }

  /** The editor reads `pix3project.yaml` once: re-read it when the disk holds another version. */
  private async catchUpManifest(): Promise<void> {
    const source = await this.resolveManifestSource();
    if (!source) return;
    try {
      const diskHash = await this.currentDiskHash(PROJECT_MANIFEST_PATH);
      if (diskHash && diskHash !== source.getLoadedManifestHash()) {
        await source.reloadProjectManifest();
      }
    } catch (error) {
      console.warn('[ProjectSyncService] syncNow could not check pix3project.yaml', error);
    }
  }

  /** The disk's hash of `path` now: the workspace manifest when it has one, else the bytes. */
  private async currentDiskHash(path: string): Promise<string | null> {
    const fromManifest = this.storage.getManifestContentHash(path);
    if (fromManifest !== undefined) return fromManifest;
    return (await readDiskVersion(this.storage, path))?.hash ?? null;
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

  /**
   * Any script source added, removed or edited since the last build? A workspace answers from its
   * manifest (just re-scanned) against the hashes recorded at build time — no file is read, and
   * every build input counts, not only the ones under the script directories. A local folder
   * compares the text of each script source with what was built.
   */
  private async scriptsDifferFromLastBuild(loader: SyncScriptLoader): Promise<boolean> {
    const built = loader.getCollectedFiles();
    const current = await this.listScriptSources();

    if (this.storage.getBackend() === 'workspace') {
      const recorded = loader.getCollectedFileHashes?.();
      const builtPaths = new Set<string>();
      for (const [rawPath, content] of built) {
        const path = toProjectPath(rawPath);
        builtPaths.add(path);
        const diskHash = this.storage.getManifestContentHash(path);
        if (diskHash === null) return true; // deleted
        if (diskHash === undefined) {
          // No hash in the manifest for it: compare the text.
          try {
            if ((await this.storage.readTextFile(path)) !== content) return true;
          } catch {
            return true;
          }
          continue;
        }
        const builtHash = recorded?.get(rawPath) ?? (await this.textHash(rawPath, content));
        if (builtHash !== diskHash) return true;
      }
      for (const path of current) {
        if (!builtPaths.has(path)) return true; // a new source file
      }
      return false;
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

  /** Script sources (`.ts`/`.js`) under the script directories, as the storage lists them now. */
  private async listScriptSources(): Promise<Set<string>> {
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
    return current;
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

  private async resolveManifestSource(): Promise<SyncManifestSource | null> {
    if (this.manifestSourceOverride) {
      return this.manifestSourceOverride;
    }
    try {
      const { ProjectService } = await import('@/services/project/ProjectService');
      const container = ServiceContainer.getInstance();
      return container.getService<SyncManifestSource>(container.getOrCreateToken(ProjectService));
    } catch (error) {
      console.warn('[ProjectSyncService] Project service unavailable for syncNow', error);
      return null;
    }
  }

  public dispose(): void {
    this.activeDialog = null;
    this.listeners.clear();
  }
}
