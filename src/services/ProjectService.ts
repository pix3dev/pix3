import { injectable, ServiceContainer } from '@/fw/di';
import {
  appState,
  createInitialHybridSyncState,
  type AssetBrowserViewMode,
  type ProjectBackend,
} from '@/state';
import { createInitialProjectOpenProgressState } from '@/state';
import {
  groupedDirectoryExpansionKey,
  splitGroupedDirectoryExpansionKey,
} from '@/core/asset-categories';
import { resolveFileSystemAPIService, type FileDescriptor } from './FileSystemAPIService';
import { ProjectStorageService } from './ProjectStorageService';
import { BrowserProjectStorageService } from './BrowserProjectStorageService';
import { parse, stringify } from 'yaml';
import { ref } from 'valtio/vanilla';
import { ProjectTemplateService } from './ProjectTemplateService';
import { SceneStateUpdater } from '@/core/SceneStateUpdater';
import {
  createDefaultProjectManifest,
  normalizeProjectManifest,
  type ProjectManifest,
} from '@/core/ProjectManifest';
import {
  SceneManager,
  setProjectAODefault,
  setProjectTextureFiltering,
  type SceneGraph,
} from '@pix3/runtime';
import { CURRENT_EDITOR_VERSION } from '@/version';
import type * as Y from 'yjs';
import { EditorTabService } from './EditorTabService';
import { CollaborationService } from './CollaborationService';

const RECENTS_KEY = 'pix3.recentProjects:v1';
const PROJECT_MANIFEST_PATH = 'pix3project.yaml';
const ASSET_BROWSER_STORAGE_PREFIX = 'pix3.assetBrowser:v1:';

export interface AssetBrowserPersistedState {
  expandedPaths: string[];
  selectedPath: string | null;
  viewMode: AssetBrowserViewMode;
  groupedExpandedKeys: string[];
  /** Assets content-pane thumbnail tile size in px. */
  thumbnailSize?: number;
  /** Assets content-pane layout: thumbnail grid or details list. */
  contentView?: 'grid' | 'list';
  /** Width in px of the unified Assets panel's folder-tree pane (Phase 4). */
  treePaneWidth?: number;
}

export interface RecentProjectEntry {
  readonly id?: string;
  readonly name: string;
  readonly backend: ProjectBackend;
  readonly localAbsolutePath?: string;
  readonly linkedCloudProjectId?: string;
  readonly linkedLocalSessionId?: string;
  readonly lastOpenedAt: number;
}

export interface CreateProjectOptions {
  readonly name: string;
  readonly manifest: ProjectManifest;
  /** Bundled project template to scaffold from; falls back to the default template. */
  readonly templateId?: string;
  /**
   * Storage backend for the new project. `'local'` opens the directory picker;
   * `'browser'` provisions an OPFS directory with no picker or auth. Defaults to
   * `'local'`. (Cloud projects are created via {@link CloudProjectService}.)
   */
  readonly backend?: 'local' | 'browser';
}

export interface ActivateProjectOptions {
  readonly beforeActivate?: () => Promise<void>;
}

@injectable()
export class ProjectService {
  static readonly STARTUP_SCENE_PATH = 'scenes/main.pix3scene';
  static readonly STARTUP_SCENE_RESOURCE_PATH = `res://${ProjectService.STARTUP_SCENE_PATH}`;

  private readonly fs = resolveFileSystemAPIService();
  private readonly storage = ServiceContainer.getInstance().getService<ProjectStorageService>(
    ServiceContainer.getInstance().getOrCreateToken(ProjectStorageService)
  );
  private readonly browserStore =
    ServiceContainer.getInstance().getService<BrowserProjectStorageService>(
      ServiceContainer.getInstance().getOrCreateToken(BrowserProjectStorageService)
    );

  constructor() {}

  getRecentProjects(): RecentProjectEntry[] {
    try {
      const raw = localStorage.getItem(RECENTS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as RecentProjectEntry[];
      if (!Array.isArray(parsed)) return [];
      // ensure entries have timestamp and sort by lastOpenedAt desc
      return parsed
        .map<RecentProjectEntry>(p => ({
          id: p.id,
          name: p.name,
          backend: p.backend === 'cloud' ? 'cloud' : p.backend === 'browser' ? 'browser' : 'local',
          localAbsolutePath: p.localAbsolutePath,
          linkedCloudProjectId:
            typeof p.linkedCloudProjectId === 'string' ? p.linkedCloudProjectId : undefined,
          linkedLocalSessionId:
            typeof p.linkedLocalSessionId === 'string' ? p.linkedLocalSessionId : undefined,
          lastOpenedAt: typeof p.lastOpenedAt === 'number' ? p.lastOpenedAt : 0,
        }))
        .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    } catch {
      return [];
    }
  }

  private saveRecentProjects(list: RecentProjectEntry[]): void {
    try {
      localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 10)));
    } catch {
      // ignore
    }
  }

  /**
   * Saves asset browser state to localStorage. Accepts a partial patch that is
   * merged with the currently stored record, so callers updating one view mode's
   * expansion state don't clobber the other's.
   */
  saveAssetBrowserState(patch: Partial<AssetBrowserPersistedState>): void {
    const projectId = appState.project.id;
    if (!projectId) return;

    try {
      const key = `${ASSET_BROWSER_STORAGE_PREFIX}${projectId}`;
      const current = this.loadAssetBrowserState();
      const state = {
        expandedPaths: patch.expandedPaths ?? current?.expandedPaths ?? [],
        selectedPath:
          patch.selectedPath !== undefined ? patch.selectedPath : (current?.selectedPath ?? null),
        viewMode: patch.viewMode ?? current?.viewMode ?? 'folders',
        groupedExpandedKeys: patch.groupedExpandedKeys ?? current?.groupedExpandedKeys ?? [],
        thumbnailSize: patch.thumbnailSize ?? current?.thumbnailSize ?? 104,
        contentView: patch.contentView ?? current?.contentView ?? 'grid',
        treePaneWidth: patch.treePaneWidth ?? current?.treePaneWidth,
        savedAt: Date.now(),
      };
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // ignore storage errors
    }
  }

  /**
   * Loads asset browser state from localStorage. Returns null if no state is
   * saved for the current project; legacy records get defaults for new fields.
   */
  loadAssetBrowserState(): AssetBrowserPersistedState | null {
    const projectId = appState.project.id;
    if (!projectId) return null;

    try {
      const key = `${ASSET_BROWSER_STORAGE_PREFIX}${projectId}`;
      const raw = localStorage.getItem(key);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;

      return {
        expandedPaths: Array.isArray(parsed.expandedPaths) ? parsed.expandedPaths : [],
        selectedPath: typeof parsed.selectedPath === 'string' ? parsed.selectedPath : null,
        viewMode: parsed.viewMode === 'by-type' ? 'by-type' : 'folders',
        groupedExpandedKeys: Array.isArray(parsed.groupedExpandedKeys)
          ? parsed.groupedExpandedKeys.filter(
              (entry: unknown): entry is string => typeof entry === 'string'
            )
          : [],
        thumbnailSize:
          typeof parsed.thumbnailSize === 'number' && Number.isFinite(parsed.thumbnailSize)
            ? parsed.thumbnailSize
            : 104,
        contentView: parsed.contentView === 'list' ? 'list' : 'grid',
        treePaneWidth:
          typeof parsed.treePaneWidth === 'number' && Number.isFinite(parsed.treePaneWidth)
            ? parsed.treePaneWidth
            : undefined,
      };
    } catch {
      return null;
    }
  }

  removeRecentProject(idOrName: { id?: string; name?: string }): void {
    try {
      const list = this.getRecentProjects();
      const filtered = list.filter(r => {
        if (idOrName.id) return r.id !== idOrName.id;
        if (idOrName.name) return r.name !== idOrName.name;
        return true;
      });
      this.saveRecentProjects(filtered);
      try {
        appState.project.recentProjects = filtered.map(r => r.name);
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }
  }

  addRecentProject(entry: RecentProjectEntry): void {
    const list = this.getRecentProjects();
    const filtered = list.filter(r => (entry.id ? r.id !== entry.id : r.name !== entry.name));
    const toAdd: RecentProjectEntry = {
      id: entry.id,
      name: entry.name,
      backend: entry.backend,
      localAbsolutePath: entry.localAbsolutePath,
      linkedCloudProjectId: entry.linkedCloudProjectId,
      linkedLocalSessionId: entry.linkedLocalSessionId,
      lastOpenedAt: entry.lastOpenedAt ?? Date.now(),
    };
    filtered.unshift(toAdd);
    this.saveRecentProjects(filtered);
    // reflect recents into app state for UI subscriptions (store names as identifiers for now)
    try {
      appState.project.recentProjects = filtered.map(r => r.name);
    } catch {
      // ignore
    }
  }

  /**
   * Syncs current project metadata (name, local path) back to recent projects storage.
   */
  syncProjectMetadata(): void {
    if (appState.project.status !== 'ready' || !appState.project.id) return;

    this.addRecentProject({
      id: appState.project.id,
      name: appState.project.projectName ?? 'Untitled Project',
      backend: appState.project.backend,
      localAbsolutePath: appState.project.localAbsolutePath ?? undefined,
      linkedCloudProjectId: appState.project.hybridSync.linkedCloudProjectId ?? undefined,
      linkedLocalSessionId: appState.project.hybridSync.linkedLocalSessionId ?? undefined,
      lastOpenedAt: Date.now(),
    });
  }

  createProjectSessionId(): string {
    const hasRandomUUID =
      typeof crypto !== 'undefined' &&
      typeof (crypto as unknown as { randomUUID?: unknown }).randomUUID === 'function';
    return hasRandomUUID
      ? (crypto as unknown as { randomUUID: () => string }).randomUUID()
      : `handle-${Date.now()}`;
  }

  persistProjectDirectoryHandle(id: string, handle: FileSystemDirectoryHandle): Promise<void> {
    return this.saveHandleToIndexedDB(id, handle);
  }

  getPersistedProjectDirectoryHandle(id: string): Promise<FileSystemDirectoryHandle | null> {
    return this.getHandleFromIndexedDB(id);
  }

  async openProjectViaPicker(): Promise<void> {
    try {
      const handle = await this.fs.requestProjectDirectory('readwrite');
      // try to persist the handle and associate it with a recent entry id
      // prefer secure randomUUID when available; otherwise fallback to timestamp-based id
      const id = this.createProjectSessionId();

      appState.project.id = id;
      appState.project.backend = 'local';
      appState.project.directoryHandle = ref(handle);
      appState.project.projectName = handle.name ?? 'Untitled Project';
      appState.project.hybridSync = createInitialHybridSyncState();
      appState.project.status = 'ready';
      appState.project.errorMessage = null;
      appState.project.manifest = await this.loadProjectManifest();

      // save recent entry with id and persist handle to IndexedDB (best-effort)
      this.addRecentProject({
        id,
        name: appState.project.projectName ?? 'Untitled Project',
        backend: 'local',
        lastOpenedAt: Date.now(),
      });
      this.persistProjectDirectoryHandle(id, handle).catch(() => {
        // ignore persistence errors; fallback behavior remains functional
      });
      this.scheduleHybridSyncRefresh();
    } catch (error) {
      // propagate error after recording state
      appState.project.status = 'error';
      appState.project.manifest = null;
      appState.project.errorMessage =
        error instanceof Error ? error.message : String(error ?? 'Failed to open project');
      throw error;
    }
  }

  /**
   * Try to open a recent project using a previously persisted directory handle.
   * If the persisted handle is unavailable or permission is denied, fall back to showing the picker.
   */
  async openRecentProject(entry: RecentProjectEntry): Promise<void> {
    if (entry.backend === 'cloud') {
      if (!entry.id) {
        throw new Error('Cloud recent project is missing its project ID.');
      }

      const cloudProjectService = ServiceContainer.getInstance().getService(
        ServiceContainer.getInstance().getOrCreateToken(
          (await import('./CloudProjectService')).CloudProjectService
        )
      ) as import('./CloudProjectService').CloudProjectService;

      await cloudProjectService.openProject(entry.id);
      return;
    }

    if (entry.backend === 'browser') {
      await this.openBrowserProject(entry);
      return;
    }

    if (entry.id) {
      try {
        const handle = await this.getPersistedProjectDirectoryHandle(entry.id);
        if (handle) {
          // ensure we have permission and then activate project
          try {
            await this.fs.ensurePermission(handle, 'readwrite');
            this.fs.setProjectDirectory(handle);
            appState.project.id = entry.id || null;
            appState.project.backend = 'local';
            appState.project.directoryHandle = ref(handle);
            appState.project.projectName = handle.name ?? entry.name;
            appState.project.localAbsolutePath = entry.localAbsolutePath ?? null;
            appState.project.hybridSync = createInitialHybridSyncState();
            appState.project.status = 'ready';
            appState.project.errorMessage = null;
            appState.project.manifest = await this.loadProjectManifest();
            // update timestamp in recents
            this.addRecentProject({
              id: entry.id,
              name: appState.project.projectName ?? entry.name,
              backend: 'local',
              localAbsolutePath: appState.project.localAbsolutePath ?? undefined,
              lastOpenedAt: Date.now(),
            });
            this.scheduleHybridSyncRefresh();
            return;
          } catch {
            // permission problem - fall through to picker
          }
        }
      } catch {
        // retrieval error - fall back to picker
      }
    }

    // fallback to picker which will create a new persisted mapping
    await this.openProjectViaPicker();
  }

  /**
   * Activate a browser-storage (OPFS) project. Unlike local projects there is no
   * picker fallback: the data lives in this browser or nowhere, so a missing
   * directory means the recents entry is stale and is dropped.
   */
  private async openBrowserProject(entry: RecentProjectEntry): Promise<void> {
    if (!entry.id) {
      throw new Error('Browser recent project is missing its project ID.');
    }

    // Prefer the persisted handle; re-derive from OPFS if it was never stored.
    let handle = await this.getPersistedProjectDirectoryHandle(entry.id).catch(() => null);
    if (!handle) {
      handle = await this.browserStore.getProjectDirectory(entry.id);
    }

    if (!handle) {
      this.removeRecentProject({ id: entry.id, name: entry.name });
      throw new Error('Project data was removed from browser storage.');
    }

    this.fs.setProjectDirectory(handle);
    appState.project.id = entry.id;
    appState.project.backend = 'browser';
    appState.project.directoryHandle = ref(handle);
    appState.project.projectName = entry.name;
    appState.project.localAbsolutePath = null;
    appState.project.hybridSync = createInitialHybridSyncState();
    appState.project.status = 'ready';
    appState.project.errorMessage = null;
    appState.project.manifest = await this.loadProjectManifest();
    this.addRecentProject({
      id: entry.id,
      name: appState.project.projectName ?? entry.name,
      backend: 'browser',
      lastOpenedAt: Date.now(),
    });
    this.scheduleHybridSyncRefresh();
  }

  /**
   * Directly open a local session by ID, returning false instead of falling back to picker
   * if permissions have been dropped (used by Router/Deep Linking)
   */
  async openLocalSession(sessionId: string): Promise<boolean> {
    const handle = await this.getHandleFromIndexedDB(sessionId);
    if (!handle) {
      throw new Error('Local session not found in IndexedDB.');
    }

    // Browser-storage sessions persist their handle here too; recover the
    // backend from recents so the session reactivates as 'browser', not 'local'.
    const existing = this.getRecentProjects().find(r => r.id === sessionId);
    const backend: ProjectBackend = existing?.backend === 'browser' ? 'browser' : 'local';
    // OPFS handles have no meaningful name, so prefer the stored project name.
    const projectName = backend === 'browser' ? (existing?.name ?? handle.name) : handle.name;

    try {
      // With 'silent' request it only checks if we have permission.
      // Wait, ensurePermission in FileSystemAPIService might prompt.
      // Let's assume it checks first, and if it prompts without user gesture it will throw.
      // (For browser/OPFS handles ensurePermission is a no-op — always granted.)
      await this.fs.ensurePermission(handle, 'readwrite');

      this.fs.setProjectDirectory(handle);
      appState.project.id = sessionId;
      appState.project.backend = backend;
      appState.project.directoryHandle = ref(handle);
      appState.project.projectName = projectName;
      appState.project.hybridSync = createInitialHybridSyncState();
      appState.project.status = 'ready';
      appState.project.errorMessage = null;
      appState.project.manifest = await this.loadProjectManifest();

      if (existing) {
        this.addRecentProject({
          ...existing,
          lastOpenedAt: Date.now(),
        });
      }

      this.scheduleHybridSyncRefresh();

      return true;
    } catch {
      // Silent permission denied (or missing user gesture)
      appState.project.directoryHandle = ref(handle);
      appState.project.id = sessionId;
      appState.project.projectName = projectName;
      return false;
    }
  }

  async reactivateLocalSession(sessionId: string): Promise<boolean> {
    const handle = appState.project.directoryHandle;
    if (!handle) return false;

    try {
      // This call is usually tied to a user gesture, so the browser prompt can appear.
      await this.fs.ensurePermission(handle, 'readwrite');

      this.fs.setProjectDirectory(handle);
      appState.project.backend = 'local';
      appState.project.hybridSync = createInitialHybridSyncState();
      appState.project.status = 'ready';
      appState.project.errorMessage = null;
      appState.project.manifest = await this.loadProjectManifest();

      const recents = this.getRecentProjects();
      const existing = recents.find(r => r.id === sessionId);
      if (existing) {
        this.addRecentProject({
          ...existing,
          lastOpenedAt: Date.now(),
        });
      }

      this.scheduleHybridSyncRefresh();

      return true;
    } catch {
      return false;
    }
  }

  private saveHandleToIndexedDB(id: string, handle: FileSystemDirectoryHandle): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open('pix3-file-handles', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('handles')) {
            db.createObjectStore('handles', { keyPath: 'id' });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('handles', 'readwrite');
          const store = tx.objectStore('handles');
          // store structured-cloneable handle
          store.put({ id, handle });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error ?? new Error('IndexedDB transaction error'));
          };
        };
        req.onerror = () => reject(req.error ?? new Error('IndexedDB open error'));
      } catch (err) {
        reject(err);
      }
    });
  }

  private getHandleFromIndexedDB(id: string): Promise<FileSystemDirectoryHandle | null> {
    return new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open('pix3-file-handles', 1);
        req.onupgradeneeded = () => {
          // no existing DB; nothing to return
          req.transaction?.abort();
        };
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('handles')) {
            db.close();
            resolve(null);
            return;
          }
          const tx = db.transaction('handles', 'readonly');
          const store = tx.objectStore('handles');
          // store keys are strings; pass id directly
          const getReq = store.get(id);
          getReq.onsuccess = () => {
            const result = getReq.result as
              | { id: string; handle?: FileSystemDirectoryHandle }
              | undefined;
            db.close();
            resolve(result?.handle ?? null);
          };
          getReq.onerror = () => {
            db.close();
            reject(getReq.error ?? new Error('IndexedDB get error'));
          };
        };
        req.onerror = () => reject(req.error ?? new Error('IndexedDB open error'));
      } catch (err) {
        reject(err);
      }
    });
  }

  async listProjectRoot(): Promise<FileDescriptor[]> {
    if (appState.project.backend !== 'cloud' && !appState.project.directoryHandle) return [];
    try {
      return await this.storage.listDirectory('.');
    } catch {
      return [];
    }
  }

  async createDirectory(path: string): Promise<void> {
    await this.storage.createDirectory(path);
  }

  async writeFile(path: string, contents: string): Promise<void> {
    await this.storage.writeTextFile(path, contents);
  }

  async writeBinaryFile(path: string, data: ArrayBuffer): Promise<void> {
    await this.storage.writeBinaryFile(path, data);
  }

  async deleteEntry(path: string): Promise<void> {
    await this.storage.deleteEntry(path);
  }

  listDirectory(path = '.'): Promise<FileDescriptor[]> {
    return this.storage.listDirectory(path);
  }

  async moveItem(sourcePath: string, targetPath: string): Promise<void> {
    const normalizedSourcePath = this.normalizeProjectPath(sourcePath);
    const normalizedTargetPath = this.normalizeProjectPath(targetPath);

    if (
      !normalizedSourcePath ||
      normalizedSourcePath === '.' ||
      !normalizedTargetPath ||
      normalizedTargetPath === '.'
    ) {
      throw new Error('Invalid source or target path');
    }

    if (normalizedSourcePath === normalizedTargetPath) {
      return;
    }

    const sourceEntry = await this.getProjectEntry(normalizedSourcePath);
    if (!sourceEntry) {
      throw new Error(`Source entry not found: ${sourcePath}`);
    }

    if (
      sourceEntry.kind === 'directory' &&
      normalizedTargetPath.startsWith(`${normalizedSourcePath}/`)
    ) {
      throw new Error('Cannot move a directory into itself.');
    }

    try {
      await this.storage.moveEntry(normalizedSourcePath, normalizedTargetPath);
      await this.updateProjectReferencesAfterMove(
        normalizedSourcePath,
        normalizedTargetPath,
        sourceEntry.kind
      );
    } catch (error) {
      console.error('[ProjectService] Error moving item:', error);
      throw error;
    }
  }

  async createNewProject(): Promise<void> {
    return this.createNewProjectWithOptions({
      name: 'New Project',
      manifest: createDefaultProjectManifest(),
    });
  }

  async createNewProjectWithOptions(
    options: CreateProjectOptions,
    activateOptions?: ActivateProjectOptions
  ): Promise<void> {
    const backend = options.backend ?? 'local';
    try {
      // Browser projects need their id up front (it names the OPFS directory);
      // local projects pick a folder first, then mint an id.
      let handle: FileSystemDirectoryHandle;
      let id: string;
      if (backend === 'browser') {
        id = this.createProjectSessionId();
        handle = await this.browserStore.createProjectDirectory(id);
        this.fs.setProjectDirectory(handle);
      } else {
        handle = await this.fs.requestProjectDirectory('readwrite');
        id = this.createProjectSessionId();
      }
      appState.project.backend = backend;

      // Check if directory is empty
      const entries = await this.fs.listDirectory('.');
      if (entries.length > 0) {
        throw new Error(
          'Selected folder is not empty. Please choose an empty folder for a new project.'
        );
      }

      // Create base project structure
      await this.createProjectStructure(options.name, options.manifest, options.templateId);

      await activateOptions?.beforeActivate?.();

      // Set up project state
      appState.project.directoryHandle = ref(handle);
      appState.project.id = id;
      appState.project.backend = backend;
      appState.project.projectName = options.name.trim() || handle.name || 'New Project';
      appState.project.hybridSync = createInitialHybridSyncState();
      appState.project.status = 'ready';
      appState.project.errorMessage = null;
      appState.project.manifest = options.manifest;
      appState.project.lastOpenedScenePath = ProjectService.STARTUP_SCENE_RESOURCE_PATH;
      appState.scenes.pendingScenePaths = [ProjectService.STARTUP_SCENE_RESOURCE_PATH];

      // Save to recent projects
      this.addRecentProject({
        id,
        name: appState.project.projectName ?? (options.name || 'New Project'),
        backend,
        lastOpenedAt: Date.now(),
      });
      this.persistProjectDirectoryHandle(id, handle).catch(() => {
        // ignore persistence errors; fallback behavior remains functional
      });
      this.scheduleHybridSyncRefresh();
    } catch (error) {
      // Propagate error after recording state
      appState.project.status = 'error';
      appState.project.manifest = null;
      appState.project.errorMessage =
        error instanceof Error ? error.message : String(error ?? 'Failed to create new project');
      throw error;
    }
  }

  private async createProjectStructure(
    name: string,
    manifest: ProjectManifest,
    templateId?: string
  ): Promise<void> {
    const templateService = ServiceContainer.getInstance().getService<ProjectTemplateService>(
      ServiceContainer.getInstance().getOrCreateToken(ProjectTemplateService)
    );
    const template =
      (templateId ? templateService.getTemplate(templateId) : null) ??
      templateService.getDefaultTemplate();

    // Core structure: a failure here genuinely breaks the project, so it aborts
    // creation with the underlying cause in the error.
    // Flat, user-friendly base layout. Other asset-type folders (models, fonts,
    // …) are created on demand as those assets are added.
    const directories = new Set<string>([
      'design',
      'scenes',
      'sprites',
      'scripts',
      'audio',
      ...template.directories,
    ]);

    const ensuredDirectories = new Set<string>();
    for (const dir of directories) {
      await this.ensureDirectoryPath(dir, ensuredDirectories);
    }

    await this.saveProjectManifest(manifest);

    const projectName = name.trim() || 'Pix3 Project';
    for (const [relativePath, contents] of template.textFiles) {
      await this.ensureParentDirectories(relativePath, ensuredDirectories);
      await this.storage.writeTextFile(
        relativePath,
        this.renderTemplateText(contents, projectName)
      );
    }

    // Companion layer (design/, agent skills, template metadata): the project
    // must still open if any of this fails — the chosen folder is no longer
    // empty at this point, so aborting would leave the user unable to retry.
    const companionWarnings: string[] = [];
    const writeCompanionFile = async (relativePath: string, contents: string): Promise<void> => {
      try {
        await this.ensureParentDirectories(relativePath, ensuredDirectories);
        await this.storage.writeTextFile(relativePath, contents);
      } catch (error) {
        companionWarnings.push(relativePath);
        console.error(`[ProjectService] Failed to write "${relativePath}":`, error);
      }
    };

    for (const dir of ['design', 'design/references']) {
      try {
        await this.ensureDirectoryPath(dir, ensuredDirectories);
      } catch (error) {
        companionWarnings.push(dir);
        console.error(`[ProjectService] Failed to create "${dir}":`, error);
      }
    }

    for (const [relativePath, contents] of templateService.getAgentOverlayFiles()) {
      await writeCompanionFile(relativePath, this.renderTemplateText(contents, projectName));
    }

    for (const [relativePath, url] of template.binaryFiles) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        await this.ensureParentDirectories(relativePath, ensuredDirectories);
        await this.storage.writeBinaryFile(relativePath, await response.arrayBuffer());
      } catch (error) {
        companionWarnings.push(relativePath);
        console.error(`[ProjectService] Failed to copy template asset "${relativePath}":`, error);
      }
    }

    await writeCompanionFile(
      '.pix3/template.json',
      JSON.stringify(
        {
          templateId: template.id,
          editorVersion: CURRENT_EDITOR_VERSION.version,
          createdAt: new Date().toISOString(),
        },
        null,
        2
      ) + '\n'
    );

    if (companionWarnings.length > 0) {
      console.warn(
        `[ProjectService] Project created, but ${companionWarnings.length} companion ` +
          `file(s) could not be written: ${companionWarnings.join(', ')}. ` +
          'See errors above for the underlying cause.'
      );
    }
  }

  /** Substitute template placeholders in copied text files. */
  private renderTemplateText(contents: string, projectName: string): string {
    return contents.replaceAll('{{PROJECT_NAME}}', projectName);
  }

  private async ensureParentDirectories(
    filePath: string,
    ensuredDirectories: Set<string>
  ): Promise<void> {
    const separatorIndex = filePath.lastIndexOf('/');
    if (separatorIndex <= 0) {
      return;
    }
    await this.ensureDirectoryPath(filePath.slice(0, separatorIndex), ensuredDirectories);
  }

  private async ensureDirectoryPath(
    directory: string,
    ensuredDirectories: Set<string>
  ): Promise<void> {
    if (ensuredDirectories.has(directory)) {
      return;
    }
    // createDirectory creates the whole nested chain and is a no-op for
    // existing directories — errors are real failures and must surface.
    await this.fs.createDirectory(directory);
    ensuredDirectories.add(directory);
  }

  async loadProjectManifest(): Promise<ProjectManifest> {
    try {
      const yaml = await this.storage.readTextFile(PROJECT_MANIFEST_PATH);
      const parsed = parse(yaml);
      const manifest = normalizeProjectManifest(parsed);
      // Push the project-tier AO default so scenes set to `inherit` resolve it.
      setProjectAODefault(manifest.ambientOcclusion);
      // Push the 2D texture filtering mode so texture loads pick it up.
      setProjectTextureFiltering(manifest.textureFiltering);
      return manifest;
    } catch {
      const fallback = createDefaultProjectManifest();
      setProjectAODefault(fallback.ambientOcclusion);
      setProjectTextureFiltering(fallback.textureFiltering);
      return fallback;
    }
  }

  async saveProjectManifest(manifest: ProjectManifest): Promise<void> {
    const normalized = normalizeProjectManifest(manifest);
    const payload = {
      version: normalized.version,
      defaultExportScenePath: normalized.defaultExportScenePath,
      viewportBaseSize: {
        width: normalized.viewportBaseSize.width,
        height: normalized.viewportBaseSize.height,
      },
      ambientOcclusion: normalized.ambientOcclusion,
      textureFiltering: normalized.textureFiltering,
      projectType: normalized.projectType,
      targetPlatform: normalized.targetPlatform,
      quality: {
        antialias: normalized.quality.antialias,
        shadows: normalized.quality.shadows,
        maxPixelRatio: normalized.quality.maxPixelRatio,
      },
      // Only emit the block when localization is configured (absent ⇒ inert).
      ...(normalized.localization
        ? {
            localization: {
              defaultLocale: normalized.localization.defaultLocale,
              ...(normalized.localization.fallbackLocale
                ? { fallbackLocale: normalized.localization.fallbackLocale }
                : {}),
              locales: [...normalized.localization.locales],
            },
          }
        : {}),
      metadata: normalized.metadata ?? {},
      autoloads: normalized.autoloads.map(entry => ({
        scriptPath: entry.scriptPath,
        singleton: entry.singleton,
        enabled: entry.enabled,
      })),
    };
    const yaml = stringify(payload, { indent: 2 });
    await this.storage.writeTextFile(PROJECT_MANIFEST_PATH, yaml);
    appState.project.manifest = normalized;
  }

  private async updateProjectReferencesAfterMove(
    sourcePath: string,
    targetPath: string,
    movedKind: FileSystemHandleKind
  ): Promise<void> {
    const projectFiles = await this.listAllProjectFiles('.');
    await this.rewriteSceneFilesAfterMove(projectFiles, sourcePath, targetPath, movedKind);
    await this.updateProjectManifestAfterMove(sourcePath, targetPath, movedKind);
    await this.updateOpenScenesAfterMove(sourcePath, targetPath, movedKind);
    this.updateProjectStatePathsAfterMove(sourcePath, targetPath, movedKind);
    this.updateCollaborationReferencesAfterMove(sourcePath, targetPath, movedKind);

    const editorTabService = ServiceContainer.getInstance().getService<EditorTabService>(
      ServiceContainer.getInstance().getOrCreateToken(EditorTabService)
    );
    editorTabService.remapSceneTabs(resourcePath =>
      this.remapResourcePath(resourcePath, sourcePath, targetPath, movedKind)
    );

    appState.project.lastModifiedDirectoryPath = '.';
    appState.project.fileRefreshSignal = (appState.project.fileRefreshSignal || 0) + 1;
  }

  private async rewriteSceneFilesAfterMove(
    projectFiles: FileDescriptor[],
    sourcePath: string,
    targetPath: string,
    movedKind: FileSystemHandleKind
  ): Promise<void> {
    const sceneFiles = projectFiles.filter(
      entry => entry.kind === 'file' && entry.path.endsWith('.pix3scene')
    );

    for (const sceneFile of sceneFiles) {
      const contents = await this.storage.readTextFile(sceneFile.path);
      const nextContents = this.rewriteResourceReferencesInText(
        contents,
        sourcePath,
        targetPath,
        movedKind
      );

      if (nextContents !== contents) {
        await this.storage.writeTextFile(sceneFile.path, nextContents);
      }
    }
  }

  private async updateProjectManifestAfterMove(
    sourcePath: string,
    targetPath: string,
    movedKind: FileSystemHandleKind
  ): Promise<void> {
    const manifest = await this.loadProjectManifest();
    const nextMetadata = this.rewriteUnknownValuePaths(manifest.metadata ?? {}, value =>
      this.remapResourcePath(value, sourcePath, targetPath, movedKind)
    ) as ProjectManifest['metadata'];

    let didChange = nextMetadata !== (manifest.metadata ?? {});
    const nextDefaultExportScenePath =
      this.remapProjectPath(manifest.defaultExportScenePath, sourcePath, targetPath, movedKind) ??
      manifest.defaultExportScenePath;
    if (nextDefaultExportScenePath !== manifest.defaultExportScenePath) {
      didChange = true;
    }
    const nextAutoloads = manifest.autoloads.map(entry => {
      const nextScriptPath =
        this.remapProjectPath(entry.scriptPath, sourcePath, targetPath, movedKind) ??
        entry.scriptPath;
      if (nextScriptPath !== entry.scriptPath) {
        didChange = true;
      }

      return {
        ...entry,
        scriptPath: nextScriptPath,
      };
    });

    if (!didChange) {
      return;
    }

    await this.saveProjectManifest({
      ...manifest,
      defaultExportScenePath: nextDefaultExportScenePath,
      metadata: nextMetadata,
      autoloads: nextAutoloads,
    });
  }

  private async updateOpenScenesAfterMove(
    sourcePath: string,
    targetPath: string,
    movedKind: FileSystemHandleKind
  ): Promise<void> {
    const sceneManager = ServiceContainer.getInstance().getService<SceneManager>(
      ServiceContainer.getInstance().getOrCreateToken(SceneManager)
    );

    const nextDescriptors: typeof appState.scenes.descriptors = {};
    const nextHierarchies: typeof appState.scenes.hierarchies = {};
    const nextEditorCameraStates: typeof appState.scenes.editorCameraStates = {};
    const nextNavigation2DCameraStates: typeof appState.scenes.navigation2DCameraStates = {};
    let nextActiveSceneId = appState.scenes.activeSceneId;

    for (const [sceneId, descriptor] of Object.entries(appState.scenes.descriptors)) {
      const nextFilePath =
        this.remapResourcePath(descriptor.filePath, sourcePath, targetPath, movedKind) ??
        descriptor.filePath;
      const nextSceneId = this.deriveSceneIdFromResource(nextFilePath);
      const graph = sceneManager.getSceneGraph(sceneId);
      const updatedGraph = graph
        ? await this.rewriteSceneGraphPaths(
            graph,
            descriptor.filePath,
            nextFilePath,
            sourcePath,
            targetPath,
            movedKind
          )
        : null;

      let nextFileHandle: FileSystemFileHandle | null | undefined = descriptor.fileHandle ?? null;
      let nextLastModifiedTime = descriptor.lastModifiedTime ?? null;

      try {
        nextFileHandle = nextFilePath.startsWith('res://')
          ? await this.storage.getFileHandle(nextFilePath)
          : null;
        nextLastModifiedTime = nextFilePath.startsWith('res://')
          ? await this.storage.getLastModified(nextFilePath)
          : null;
      } catch (error) {
        console.debug('[ProjectService] Failed to refresh scene handle after move', {
          nextFilePath,
          error,
        });
      }

      nextDescriptors[nextSceneId] = {
        ...descriptor,
        id: nextSceneId,
        filePath: nextFilePath,
        fileHandle: nextFileHandle ? ref(nextFileHandle) : null,
        lastModifiedTime: nextLastModifiedTime,
      };

      const hierarchy = appState.scenes.hierarchies[sceneId];
      if (updatedGraph) {
        nextHierarchies[nextSceneId] = {
          version: updatedGraph.version ?? null,
          description: updatedGraph.description ?? null,
          rootNodes: ref(updatedGraph.rootNodes),
          metadata: updatedGraph.metadata ?? {},
        };
        sceneManager.setActiveSceneGraph(nextSceneId, updatedGraph);
      } else if (hierarchy) {
        nextHierarchies[nextSceneId] = hierarchy;
        const existingGraph = sceneManager.getSceneGraph(sceneId);
        if (existingGraph && nextSceneId !== sceneId) {
          sceneManager.setActiveSceneGraph(nextSceneId, existingGraph);
        }
      }

      if (appState.scenes.editorCameraStates[sceneId]) {
        nextEditorCameraStates[nextSceneId] = appState.scenes.editorCameraStates[sceneId];
      }

      if (appState.scenes.navigation2DCameraStates[sceneId]) {
        nextNavigation2DCameraStates[nextSceneId] =
          appState.scenes.navigation2DCameraStates[sceneId];
      }

      if (nextActiveSceneId === sceneId) {
        nextActiveSceneId = nextSceneId;
      }

      if (nextSceneId !== sceneId) {
        sceneManager.removeSceneGraph(sceneId);
      }
    }

    appState.scenes.descriptors = nextDescriptors;
    appState.scenes.hierarchies = nextHierarchies;
    appState.scenes.editorCameraStates = nextEditorCameraStates;
    appState.scenes.navigation2DCameraStates = nextNavigation2DCameraStates;
    appState.scenes.activeSceneId = nextActiveSceneId;

    if (nextActiveSceneId && nextDescriptors[nextActiveSceneId]) {
      const activeGraph = sceneManager.getSceneGraph(nextActiveSceneId);
      if (activeGraph) {
        SceneStateUpdater.updateHierarchyState(appState, nextActiveSceneId, activeGraph);
      }
      return;
    }

    const activeDescriptor = Object.values(nextDescriptors).find(
      descriptor => descriptor.filePath === appState.project.lastOpenedScenePath
    );
    if (activeDescriptor) {
      appState.scenes.activeSceneId = activeDescriptor.id;
      const activeGraph = sceneManager.getSceneGraph(activeDescriptor.id);
      if (activeGraph) {
        SceneStateUpdater.updateHierarchyState(appState, activeDescriptor.id, activeGraph);
      }
    }
  }

  private updateProjectStatePathsAfterMove(
    sourcePath: string,
    targetPath: string,
    movedKind: FileSystemHandleKind
  ): void {
    appState.project.lastOpenedScenePath =
      this.remapResourcePath(
        appState.project.lastOpenedScenePath,
        sourcePath,
        targetPath,
        movedKind
      ) ?? appState.project.lastOpenedScenePath;

    appState.scenes.pendingScenePaths = appState.scenes.pendingScenePaths.map(
      filePath => this.remapResourcePath(filePath, sourcePath, targetPath, movedKind) ?? filePath
    );

    appState.project.assetBrowserExpandedPaths = appState.project.assetBrowserExpandedPaths.map(
      path => this.remapProjectPath(path, sourcePath, targetPath, movedKind) ?? path
    );
    appState.project.assetBrowserSelectedPath =
      this.remapProjectPath(
        appState.project.assetBrowserSelectedPath,
        sourcePath,
        targetPath,
        movedKind
      ) ?? appState.project.assetBrowserSelectedPath;

    appState.project.assetBrowserGroupedExpandedKeys =
      appState.project.assetBrowserGroupedExpandedKeys.map(key => {
        const parsed = splitGroupedDirectoryExpansionKey(key);
        if (!parsed) return key;
        const remapped = this.remapProjectPath(parsed.path, sourcePath, targetPath, movedKind);
        return remapped ? groupedDirectoryExpansionKey(parsed.categoryId, remapped) : key;
      });

    this.saveAssetBrowserState({
      expandedPaths: appState.project.assetBrowserExpandedPaths,
      selectedPath: appState.project.assetBrowserSelectedPath,
      groupedExpandedKeys: appState.project.assetBrowserGroupedExpandedKeys,
    });
  }

  private updateCollaborationReferencesAfterMove(
    sourcePath: string,
    targetPath: string,
    movedKind: FileSystemHandleKind
  ): void {
    const collaborationService = ServiceContainer.getInstance().getService<CollaborationService>(
      ServiceContainer.getInstance().getOrCreateToken(CollaborationService)
    );
    const ydoc = collaborationService.getYDoc();
    if (!ydoc) {
      return;
    }

    const scenesMap = ydoc.getMap<Y.Map<unknown>>('scenes');
    ydoc.transact(() => {
      for (const sceneValue of scenesMap.values()) {
        if (!(sceneValue instanceof Object)) {
          continue;
        }

        const sceneMap = sceneValue as Y.Map<unknown>;
        const filePath = sceneMap.get('filePath');
        if (typeof filePath === 'string') {
          const nextFilePath =
            this.remapResourcePath(filePath, sourcePath, targetPath, movedKind) ?? filePath;
          if (nextFilePath !== filePath) {
            sceneMap.set('filePath', nextFilePath);
          }
        }

        const snapshot = sceneMap.get('snapshot');
        if (typeof snapshot === 'string') {
          const nextSnapshot = this.rewriteResourceReferencesInText(
            snapshot,
            sourcePath,
            targetPath,
            movedKind
          );
          if (nextSnapshot !== snapshot) {
            sceneMap.set('snapshot', nextSnapshot);
          }
        }
      }
    }, collaborationService.getLocalOrigin());
  }

  private async rewriteSceneGraphPaths(
    graph: SceneGraph,
    currentFilePath: string,
    nextFilePath: string,
    sourcePath: string,
    targetPath: string,
    movedKind: FileSystemHandleKind
  ): Promise<SceneGraph> {
    const sceneManager = ServiceContainer.getInstance().getService<SceneManager>(
      ServiceContainer.getInstance().getOrCreateToken(SceneManager)
    );
    const serialized = sceneManager.serializeScene(graph);
    const nextSerialized = this.rewriteResourceReferencesInText(
      serialized,
      sourcePath,
      targetPath,
      movedKind
    );

    if (nextSerialized === serialized && nextFilePath === currentFilePath) {
      return graph;
    }

    return await sceneManager.parseScene(nextSerialized, { filePath: nextFilePath });
  }

  private rewriteUnknownValuePaths(
    value: unknown,
    rewrite: (value: string) => string | null
  ): unknown {
    if (typeof value === 'string') {
      return rewrite(value) ?? value;
    }

    if (Array.isArray(value)) {
      let didChange = false;
      const nextArray = value.map(item => {
        const nextItem = this.rewriteUnknownValuePaths(item, rewrite);
        didChange = didChange || nextItem !== item;
        return nextItem;
      });
      return didChange ? nextArray : value;
    }

    if (value && typeof value === 'object') {
      let didChange = false;
      const nextRecord: Record<string, unknown> = {};
      for (const [key, entryValue] of Object.entries(value)) {
        const nextValue = this.rewriteUnknownValuePaths(entryValue, rewrite);
        nextRecord[key] = nextValue;
        didChange = didChange || nextValue !== entryValue;
      }
      return didChange ? nextRecord : value;
    }

    return value;
  }

  private rewriteResourceReferencesInText(
    contents: string,
    sourcePath: string,
    targetPath: string,
    movedKind: FileSystemHandleKind
  ): string {
    const sourceResourcePath = this.toResourcePath(sourcePath);
    const targetResourcePath = this.toResourcePath(targetPath);
    const escapedSourceResourcePath = this.escapeRegExp(sourceResourcePath);

    let nextContents = contents;
    if (movedKind === 'directory') {
      nextContents = nextContents.replace(
        new RegExp(`${escapedSourceResourcePath}/`, 'g'),
        `${targetResourcePath}/`
      );
    }

    return nextContents.replace(
      new RegExp(`${escapedSourceResourcePath}(?=$|[^A-Za-z0-9._\\-/])`, 'g'),
      targetResourcePath
    );
  }

  private remapResourcePath(
    resourcePath: string | null | undefined,
    sourcePath: string,
    targetPath: string,
    movedKind: FileSystemHandleKind
  ): string | null {
    if (!resourcePath || !resourcePath.startsWith('res://')) {
      return null;
    }

    const projectPath = this.normalizeProjectPath(resourcePath);
    const remappedPath = this.remapProjectPath(projectPath, sourcePath, targetPath, movedKind);
    return remappedPath ? this.toResourcePath(remappedPath) : null;
  }

  private remapProjectPath(
    projectPath: string | null | undefined,
    sourcePath: string,
    targetPath: string,
    movedKind: FileSystemHandleKind
  ): string | null {
    if (!projectPath) {
      return null;
    }

    const normalizedPath = this.normalizeProjectPath(projectPath);
    if (normalizedPath === sourcePath) {
      return targetPath;
    }

    if (movedKind === 'directory' && normalizedPath.startsWith(`${sourcePath}/`)) {
      return `${targetPath}${normalizedPath.slice(sourcePath.length)}`;
    }

    return null;
  }

  private async listAllProjectFiles(path: string): Promise<FileDescriptor[]> {
    const entries = await this.storage.listDirectory(path);
    const result: FileDescriptor[] = [];

    for (const entry of entries) {
      result.push(entry);
      if (entry.kind === 'directory') {
        const children = await this.listAllProjectFiles(entry.path);
        result.push(...children);
      }
    }

    return result;
  }

  private async getProjectEntry(path: string): Promise<FileDescriptor | null> {
    const parentPath = this.getParentProjectPath(path);
    const entryName = path.split('/').pop();
    if (!entryName) {
      return null;
    }

    const entries = await this.storage.listDirectory(parentPath);
    return entries.find(entry => entry.name === entryName) ?? null;
  }

  private getParentProjectPath(path: string): string {
    const segments = this.normalizeProjectPath(path).split('/').filter(Boolean);
    if (segments.length <= 1) {
      return '.';
    }
    return segments.slice(0, -1).join('/');
  }

  private normalizeProjectPath(path: string): string {
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

  private toResourcePath(path: string): string {
    const normalizedPath = this.normalizeProjectPath(path);
    return normalizedPath === '.' ? 'res://' : `res://${normalizedPath}`;
  }

  private deriveSceneIdFromResource(resourcePath: string): string {
    const withoutScheme = resourcePath
      .replace(/^res:\/\//i, '')
      .replace(/^templ:\/\//i, '')
      .replace(/^collab:\/\//i, '');
    const withoutExtension = withoutScheme.replace(/\.[^./]+$/i, '');
    const normalized = withoutExtension
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    return normalized || 'scene';
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private scheduleHybridSyncRefresh(): void {
    void (async () => {
      try {
        const container = ServiceContainer.getInstance();
        const localSyncService = container.getService(
          container.getOrCreateToken((await import('./LocalSyncService')).LocalSyncService)
        ) as import('./LocalSyncService').LocalSyncService;
        await localSyncService.handleProjectActivated();
      } catch {
        // Hybrid sync is best-effort during project activation.
      }
    })();
  }

  public dispose(): void {
    // ProjectService holds no subscriptions or event listeners
  }

  async openStartupScene(): Promise<void> {
    const editorTabService = ServiceContainer.getInstance().getService(
      ServiceContainer.getInstance().getOrCreateToken(
        (await import('./EditorTabService')).EditorTabService
      )
    ) as import('./EditorTabService').EditorTabService;

    appState.scenes.pendingScenePaths = [ProjectService.STARTUP_SCENE_RESOURCE_PATH];
    appState.project.lastOpenedScenePath = ProjectService.STARTUP_SCENE_RESOURCE_PATH;
    await editorTabService.focusOrOpenScene(ProjectService.STARTUP_SCENE_RESOURCE_PATH);
  }

  closeCurrentProject(): void {
    try {
      const collaborationService = ServiceContainer.getInstance().getService<CollaborationService>(
        ServiceContainer.getInstance().getOrCreateToken(CollaborationService)
      );
      collaborationService.disconnect();
    } catch {
      // ignore if collaboration service is not available yet
    }

    appState.project.id = null;
    appState.project.backend = 'local';
    appState.project.directoryHandle = null;
    appState.project.projectName = null;
    appState.project.localAbsolutePath = null;
    appState.project.status = 'idle';
    appState.project.errorMessage = null;
    appState.project.lastOpenedScenePath = null;
    appState.project.assetBrowserExpandedPaths = [];
    appState.project.assetBrowserSelectedPath = null;
    appState.project.assetBrowserViewMode = 'folders';
    appState.project.assetBrowserGroupedExpandedKeys = [];
    appState.project.scriptsStatus = 'idle';
    appState.project.fileRefreshSignal = 0;
    appState.project.scriptRefreshSignal = 0;
    appState.project.lastModifiedDirectoryPath = null;
    appState.project.manifest = null;
    appState.project.openProgress = createInitialProjectOpenProgressState();
    appState.project.hybridSync = createInitialHybridSyncState();
    appState.scenes.activeSceneId = null;
    appState.scenes.descriptors = {};
    appState.scenes.hierarchies = {};
    appState.scenes.loadState = 'idle';
    appState.scenes.loadError = null;
    appState.scenes.lastLoadedAt = null;
    appState.scenes.pendingScenePaths = [];
    appState.scenes.nodeDataChangeSignal = 0;
    appState.scenes.editorCameraStates = {};
    appState.scenes.navigation2DCameraStates = {};
    appState.scenes.previewCameraNodeIds = {};
    appState.tabs.tabs = [];
    appState.tabs.activeTabId = null;
    appState.selection.nodeIds = [];
    appState.selection.primaryNodeId = null;
    appState.selection.hoveredNodeId = null;
  }
}

export const resolveProjectService = (): ProjectService => {
  return ServiceContainer.getInstance().getService(
    ServiceContainer.getInstance().getOrCreateToken(ProjectService)
  ) as ProjectService;
};
