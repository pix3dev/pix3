import { injectable, inject, ServiceContainer } from '@/fw/di';
import {
  appState,
  createInitialHybridSyncState,
  createInitialProjectOpenProgressState,
  type ProjectOpenPhase,
} from '@/state';
import * as ApiClient from './ApiClient';
import type { ApiProject } from './ApiClient';
import { ProjectService } from './ProjectService';
import { CloudProjectCacheService } from './CloudProjectCacheService';
import { ProjectStorageService } from './ProjectStorageService';
import { EditorTabService } from './EditorTabService';
import type { ProjectManifest } from '@/core/ProjectManifest';
import { stringify } from 'yaml';
import { sceneTemplates } from './template-data';
import { CollaborationService } from './CollaborationService';
import { CollabSessionService } from './CollabSessionService';
import { ProjectScriptLoaderService } from './ProjectScriptLoaderService';

export interface CloudProjectState {
  projects: ApiProject[];
  isLoading: boolean;
}

export interface CreateCloudProjectOptions {
  readonly name: string;
  readonly manifest: ProjectManifest;
}

export interface OpenCloudProjectOptions {
  readonly beforeActivate?: () => Promise<void>;
  readonly preferredScenePath?: string | null;
  readonly skipSceneOpen?: boolean;
  readonly shareToken?: string;
}

const HYDRATED_MEDIA_EXTENSIONS = new Set([
  'aac',
  'avif',
  'basis',
  'bmp',
  'dds',
  'exr',
  'flac',
  'fbx',
  'gif',
  'glb',
  'gltf',
  'hdr',
  'jpeg',
  'jpg',
  'ktx2',
  'm4a',
  'mp3',
  'obj',
  'ogg',
  'otf',
  'png',
  'svg',
  'tif',
  'tiff',
  'ttf',
  'wav',
  'webm',
  'webp',
  'woff',
  'woff2',
]);
const HYDRATED_SCRIPT_DIRECTORIES = ['scripts', 'src/scripts'] as const;
const HYDRATED_SCRIPT_EXTENSIONS = new Set(['css', 'glsl', 'ts']);

@injectable()
export class CloudProjectService {
  @inject(ProjectService)
  private readonly projectService!: ProjectService;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(CloudProjectCacheService)
  private readonly cloudCache!: CloudProjectCacheService;

  @inject(EditorTabService)
  private readonly editorTabService!: EditorTabService;

  @inject(ProjectScriptLoaderService)
  private readonly projectScriptLoader!: ProjectScriptLoaderService;

  private state: CloudProjectState = {
    projects: [],
    isLoading: false,
  };

  async loadProjects(): Promise<void> {
    if (!appState.auth.isAuthenticated) {
      this.state = {
        projects: [],
        isLoading: false,
      };
      this.notifyListeners();
      return;
    }

    this.state = {
      ...this.state,
      isLoading: true,
    };
    this.notifyListeners();

    try {
      const projects = await ApiClient.getProjects();
      this.state = {
        projects,
        isLoading: false,
      };
      this.notifyListeners();
    } catch {
      this.state = {
        projects: [],
        isLoading: false,
      };
      this.notifyListeners();
    }
  }

  private listeners = new Set<(state: CloudProjectState) => void>();

  subscribe(fn: (state: CloudProjectState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private notifyListeners() {
    this.listeners.forEach(fn => fn(this.state));
  }

  async createProject(name: string): Promise<ApiProject> {
    const project = await ApiClient.createProject(name);
    await this.loadProjects();
    return project;
  }

  async createProjectFromTemplate(
    options: CreateCloudProjectOptions,
    openOptions?: OpenCloudProjectOptions
  ): Promise<ApiProject> {
    const project = await ApiClient.createProject(options.name);
    const manifestYaml = stringify(
      {
        version: options.manifest.version,
        defaultExportScenePath: options.manifest.defaultExportScenePath,
        viewportBaseSize: options.manifest.viewportBaseSize,
        metadata: options.manifest.metadata ?? {},
        autoloads: options.manifest.autoloads.map(entry => ({
          scriptPath: entry.scriptPath,
          singleton: entry.singleton,
          enabled: entry.enabled,
        })),
      },
      { indent: 2 }
    );

    await ApiClient.uploadFile(project.id, 'pix3project.yaml', manifestYaml);
    await ApiClient.uploadFile(
      project.id,
      ProjectService.STARTUP_SCENE_PATH,
      sceneTemplates.find(template => template.id === 'startup-scene')?.contents ??
        sceneTemplates[0]?.contents ??
        ''
    );

    await this.loadProjects();
    await this.openProject(project.id, openOptions);
    return project;
  }

  async deleteProject(id: string): Promise<void> {
    await ApiClient.deleteProject(id);
    await this.loadProjects();
  }

  async generateShareToken(id: string): Promise<string> {
    const result = await ApiClient.generateShareToken(id);
    if (appState.project.id === id) {
      appState.collaboration.shareEnabled = true;
      appState.collaboration.shareToken = result.share_token;
    }
    await this.loadProjects();
    return result.share_token;
  }

  async revokeShareToken(id: string): Promise<void> {
    await ApiClient.revokeShareToken(id);
    if (appState.project.id === id) {
      appState.collaboration.shareEnabled = false;
      appState.collaboration.shareToken = null;
    }
    await this.loadProjects();
  }

  async openProject(projectId: string, options?: OpenCloudProjectOptions): Promise<void> {
    const listedProject = this.state.projects.find(entry => entry.id === projectId) ?? null;

    if (options?.beforeActivate) {
      await options.beforeActivate();
    }
    this.resetOpenProjectState();

    this.beginProjectOpening(
      projectId,
      listedProject?.name ?? 'Cloud Project',
      options?.shareToken ?? listedProject?.share_token ?? null
    );

    try {
      this.updateOpenProgress('fetching-access', 'Verifying project access.');
      const access = await ApiClient.getProjectAccess(projectId, options?.shareToken);

      appState.project.projectName = access.name || listedProject?.name || 'Cloud Project';
      appState.collaboration.authSource = access.auth_source;
      appState.collaboration.role = access.role;
      appState.collaboration.isReadOnly = access.access_mode === 'view';
      appState.collaboration.accessMode =
        access.access_mode === 'view' ? 'cloud-view' : 'cloud-edit';
      appState.collaboration.shareEnabled = access.share_enabled;
      appState.collaboration.shareToken = options?.shareToken ?? access.share_token;

      this.updateOpenProgress('loading-manifest', 'Loading project manifest.');
      appState.project.manifest = await this.projectService.loadProjectManifest();
      await this.storage.refreshManifest();

      const manifest = await this.storage.getManifestEntries();
      const scenePaths = manifest
        .map(entry => entry.path)
        .filter(path => path.endsWith('.pix3scene'))
        .sort((a, b) => a.localeCompare(b));

      await this.hydrateProjectCache(projectId, manifest, options?.shareToken);

      this.updateOpenProgress('connecting-collaboration', 'Connecting collaboration session.');
      await this.connectToProjectRoom(projectId, options?.shareToken, access);

      appState.project.status = 'ready';

      this.projectService.addRecentProject({
        id: projectId,
        name: appState.project.projectName ?? 'Cloud Project',
        backend: 'cloud',
        lastOpenedAt: Date.now(),
      });
      this.scheduleHybridSyncRefresh();

      if (options?.skipSceneOpen) {
        this.finishProjectOpening();
        return;
      }

      this.updateOpenProgress('compiling-scripts', 'Compiling project scripts.');
      await this.projectScriptLoader.ensureReady();

      const preferredScenePath =
        options?.preferredScenePath ?? this.getPreferredScenePath(projectId);
      const initialScenePath =
        (preferredScenePath && scenePaths.includes(preferredScenePath)
          ? preferredScenePath
          : null) ??
        scenePaths[0] ??
        null;

      if (!initialScenePath) {
        this.finishProjectOpening();
        return;
      }

      this.updateOpenProgress('opening-scene', 'Opening initial scene.', {
        currentPath: initialScenePath,
      });
      appState.project.lastOpenedScenePath = `res://${initialScenePath}`;
      appState.scenes.pendingScenePaths = [`res://${initialScenePath}`];
      await this.editorTabService.focusOrOpenScene(`res://${initialScenePath}`);
      await this.ensureActiveSceneBound();
      this.finishProjectOpening();
    } catch (error) {
      this.failProjectOpening(error);
      throw error;
    }
  }

  private normalizeScenePath(scenePath: string | null): string | null {
    if (!scenePath) {
      return null;
    }

    return scenePath.replace(/^res:\/\//i, '').replace(/^\/+/, '');
  }

  private getPreferredScenePath(projectId: string): string | null {
    try {
      const raw = localStorage.getItem(`pix3.projectTabs:${projectId}`);
      if (!raw) {
        return null;
      }

      const session = JSON.parse(raw) as {
        activeTabId?: string | null;
        tabs?: Array<{ type?: string; resourceId?: string }>;
      };
      if (!Array.isArray(session.tabs)) {
        return null;
      }

      const preferredTab = session.tabs.find(tab => tab.type === 'scene');

      return this.normalizeScenePath(preferredTab?.resourceId ?? null);
    } catch {
      return null;
    }
  }

  private resetOpenProjectState(): void {
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
  }

  private beginProjectOpening(
    projectId: string,
    projectName: string,
    shareToken: string | null
  ): void {
    appState.project.id = projectId;
    appState.project.backend = 'cloud';
    appState.project.directoryHandle = null;
    appState.project.projectName = projectName;
    appState.project.localAbsolutePath = null;
    appState.project.status = 'opening';
    appState.project.errorMessage = null;
    appState.collaboration.shareToken = shareToken;
    appState.project.openProgress = createInitialProjectOpenProgressState();
  }

  private updateOpenProgress(
    phase: ProjectOpenPhase,
    message: string,
    progress: Partial<typeof appState.project.openProgress> = {}
  ): void {
    appState.project.openProgress = {
      ...appState.project.openProgress,
      phase,
      message,
      ...progress,
    };
  }

  private finishProjectOpening(): void {
    appState.project.openProgress = createInitialProjectOpenProgressState();
  }

  private failProjectOpening(error: unknown): void {
    appState.project.status = 'error';
    appState.project.errorMessage =
      error instanceof Error ? error.message : 'Failed to open cloud project.';
    appState.project.openProgress = {
      ...createInitialProjectOpenProgressState(),
      message: appState.project.errorMessage,
    };
  }

  private async hydrateProjectCache(
    projectId: string,
    manifest: readonly ApiClient.ManifestEntry[],
    shareToken?: string
  ): Promise<void> {
    const fileEntries = manifest.filter(entry => entry.kind === 'file');
    const hydratedEntries = fileEntries.filter(entry => this.shouldHydrateEntry(entry.path));
    const totalBytes = hydratedEntries.reduce((sum, entry) => sum + entry.size, 0);
    let processedFileCount = 0;
    let processedBytes = 0;

    this.updateOpenProgress('hydrating-cache', 'Preparing project files for local access.', {
      currentPath: null,
      processedFileCount: 0,
      totalFileCount: hydratedEntries.length,
      processedBytes: 0,
      totalBytes,
    });

    await this.cloudCache.reconcileManifest(projectId, manifest);

    for (const entry of fileEntries) {
      const isFresh = await this.cloudCache.isEntryFresh(projectId, entry);

      if (!this.shouldHydrateEntry(entry.path)) {
        if (!isFresh) {
          await this.cloudCache.invalidatePath(projectId, entry.path);
        }
        continue;
      }

      if (!isFresh) {
        try {
          const response = await ApiClient.downloadFile(projectId, entry.path, shareToken);
          await this.cloudCache.storeBlobFile(projectId, entry.path, await response.blob(), {
            hash: entry.hash,
            modified: entry.modified,
            size: entry.size,
          });
        } catch (error) {
          if (!this.shouldSkipHydrationError(error)) {
            throw error;
          }

          await this.cloudCache.invalidatePath(projectId, entry.path);
          console.warn('[CloudProjectService] Skipping missing manifest entry during hydrate', {
            path: entry.path,
            error,
          });
        }
      }

      processedFileCount += 1;
      processedBytes += entry.size;
      this.updateOpenProgress('hydrating-cache', 'Preparing project files for local access.', {
        currentPath: entry.path,
        processedFileCount,
        totalFileCount: hydratedEntries.length,
        processedBytes,
        totalBytes,
      });
    }
  }

  private shouldHydrateEntry(path: string): boolean {
    const normalizedPath = this.normalizeProjectPath(path);
    if (!normalizedPath || normalizedPath === '.') {
      return false;
    }

    const segments = normalizedPath.split('/').filter(Boolean);
    if (segments.length === 0 || segments.some(segment => segment.startsWith('.'))) {
      return false;
    }

    const fileName = segments[segments.length - 1] ?? '';
    const extension = fileName.includes('.')
      ? (fileName.split('.').pop()?.toLowerCase() ?? '')
      : '';

    if (extension === 'pix3scene') {
      return true;
    }

    if (
      HYDRATED_SCRIPT_EXTENSIONS.has(extension) &&
      HYDRATED_SCRIPT_DIRECTORIES.some(directory => {
        return normalizedPath === directory || normalizedPath.startsWith(`${directory}/`);
      })
    ) {
      return true;
    }

    return HYDRATED_MEDIA_EXTENSIONS.has(extension);
  }

  private normalizeProjectPath(path: string): string {
    return (
      path
        .replace(/^res:\/\//i, '')
        .replace(/^\.\/+/, '')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')
        .replace(/\\+/g, '/') || '.'
    );
  }

  private shouldSkipHydrationError(error: unknown): boolean {
    if (error instanceof ApiClient.ApiClientError) {
      return error.status === 404;
    }

    return (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      (error as { status?: number }).status === 404
    );
  }

  private scheduleHybridSyncRefresh(): void {
    void (async () => {
      try {
        const serviceContainer = ServiceContainer.getInstance();
        const localSyncService = serviceContainer.getService(
          serviceContainer.getOrCreateToken((await import('./LocalSyncService')).LocalSyncService)
        ) as import('./LocalSyncService').LocalSyncService;
        await localSyncService.handleProjectActivated();
      } catch {
        // Hybrid sync probing should not block project opening.
      }
    })();
  }

  private async connectToProjectRoom(
    projectId: string,
    shareToken: string | undefined,
    access: ApiClient.ApiProjectAccess
  ): Promise<void> {
    const serviceContainer = ServiceContainer.getInstance();
    const collabService = serviceContainer.getService<CollaborationService>(
      serviceContainer.getOrCreateToken(CollaborationService)
    );

    const roomName = `project:${projectId}`;
    if (collabService.isConnected() && appState.collaboration.roomName === roomName) {
      return;
    }

    const username =
      access.auth_source === 'member'
        ? appState.auth.user?.username?.trim() || appState.project.projectName || 'Pix3 User'
        : `Guest ${Math.floor(Math.random() * 1000)}`;
    const color = access.access_mode === 'view' ? '#1ebde3' : '#f5ae39'; // --presence-5 (sky) / --presence-1 (amber)

    collabService.connect(
      projectId,
      appState.scenes.activeSceneId ?? 'shared-scene',
      username,
      color,
      {
        tokenOverride: access.auth_source === 'share-token' ? shareToken : undefined,
        role: access.role,
        authSource: access.auth_source,
        isReadOnly: access.access_mode === 'view',
      }
    );
  }

  private async ensureActiveSceneBound(): Promise<void> {
    if (!appState.scenes.activeSceneId) {
      return;
    }

    const serviceContainer = ServiceContainer.getInstance();
    const collabSessionService = serviceContainer.getService<CollabSessionService>(
      serviceContainer.getOrCreateToken(CollabSessionService)
    );
    await collabSessionService.ensureSceneSynchronized(appState.scenes.activeSceneId);
  }
}
