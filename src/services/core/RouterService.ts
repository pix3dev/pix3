import { injectable, ServiceContainer } from '@/fw/di';
import { appState, type RouteParams } from '@/state';
import { SelectObjectCommand } from '@/features/selection/SelectObjectCommand';
import { SceneManager } from '@pix3/runtime';
import { subscribe } from 'valtio/vanilla';
import { ProjectService } from '@/services/project/ProjectService';
import { CollabJoinService } from '@/services/collab/CollabJoinService';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';

@injectable()
export class RouterService {
  private isUpdatingUrl = false;
  private disposeSubscriptions?: () => void;

  constructor() {}

  initialize(): void {
    const unsubs: Array<() => void> = [];

    // Listen to hash changes (for our query params in hash routing)
    const handleHashChange = () => {
      if (this.isUpdatingUrl) return;
      this.handleUrlChange();
    };

    window.addEventListener('hashchange', handleHashChange);
    unsubs.push(() => window.removeEventListener('hashchange', handleHashChange));

    // Subscribe to state changes to update the URL
    const unsubScenes = subscribe(appState.scenes, () => this.syncStateToUrl());
    unsubs.push(unsubScenes);

    const unsubSelection = subscribe(appState.selection, () => this.syncStateToUrl());
    unsubs.push(unsubSelection);

    this.disposeSubscriptions = () => unsubs.forEach(fn => fn());

    // Perform initial URL parse
    this.handleUrlChange();
  }

  dispose(): void {
    if (this.disposeSubscriptions) {
      this.disposeSubscriptions();
    }
  }

  /**
   * Parses the current URL's hash query parameters.
   */
  private parseUrl(): RouteParams {
    let projectId: string | null = null;
    let sceneId: string | null = null;
    let nodeId: string | null = null;
    let localSessionId: string | null = null;
    let shareToken: string | null = null;

    try {
      const hash = window.location.hash;
      if (hash.includes('?')) {
        const queryStr = hash.split('?')[1];
        const searchParams = new URLSearchParams(queryStr);

        projectId = searchParams.get('project');
        sceneId = searchParams.get('scene');
        nodeId = searchParams.get('select');
        localSessionId = searchParams.get('local');
        shareToken = searchParams.get('token');
      }
    } catch {
      // ignore parsing errors
    }

    return { projectId, sceneId, nodeId, localSessionId, shareToken };
  }

  /**
   * Pushes state changes into the URL without triggering a reload.
   */
  private syncStateToUrl(): void {
    if (!appState.ui.isLayoutReady || appState.project.status !== 'ready') return;

    this.isUpdatingUrl = true;
    try {
      const isCloud = appState.project.backend === 'cloud';
      const projectId = appState.project.id;
      const sceneId = appState.scenes.activeSceneId;
      const nodeId = appState.selection.primaryNodeId;

      const newParams = new URLSearchParams();

      if (isCloud && projectId) {
        newParams.set('project', projectId);
        if (sceneId) {
          newParams.set('scene', sceneId);
        }
      } else if (!isCloud && projectId) {
        newParams.set('local', projectId);
        // For local, we can theoretically set scene/select too, but let's stick to session ID for now,
        // or add them if we want to deep-link into a local project's specific scene.
        if (sceneId) newParams.set('scene', sceneId);
      }

      if (nodeId) {
        newParams.set('select', nodeId);
      }

      const queryString = newParams.toString();
      const currentUrl = window.location.href;

      let basePath = window.location.origin + window.location.pathname;
      let newUrl = basePath + '#editor';

      if (queryString) {
        newUrl += '?' + queryString;
      }

      if (currentUrl !== newUrl) {
        history.replaceState(null, '', newUrl);
      }
    } finally {
      this.isUpdatingUrl = false;
    }
  }

  /**
   * Responds to an external URL change (initial load or back/forward buttons).
   */
  async handleUrlChange(): Promise<void> {
    const params = this.parseUrl();
    const isEditorActive = window.location.hash.startsWith('#editor');

    if (!isEditorActive) {
      return;
    }

    appState.router.currentParams = params;

    // Check if we are already in the correct project and scene
    if (params.projectId && appState.project.id === params.projectId) {
      if (params.sceneId && appState.scenes.activeSceneId !== params.sceneId) {
        // Same cloud project, different scene
        const editorTabService = ServiceContainer.getInstance().getService<EditorTabService>(
          ServiceContainer.getInstance().getOrCreateToken(EditorTabService)
        );
        const sceneResourcePath = `collab://${params.sceneId}`;
        appState.router.status = 'loadingAssets';
        await editorTabService.openResourceTab('scene', sceneResourcePath);
      }

      await this.applyRouteSelection(params.nodeId);

      appState.router.status = 'idle';
      return;
    }

    if (params.localSessionId && appState.project.id === params.localSessionId) {
      // Same local project
      // ... same logic for scene ... wait, local paths are res://...
      if (params.sceneId && appState.scenes.activeSceneId !== params.sceneId) {
        // Try to find the local descriptor mapped to this scene ID
        const targetId = params.sceneId;
        const descriptor = appState.scenes.descriptors[targetId];
        if (descriptor) {
          const editorTabService = ServiceContainer.getInstance().getService<EditorTabService>(
            ServiceContainer.getInstance().getOrCreateToken(EditorTabService)
          );
          await editorTabService.openResourceTab('scene', descriptor.filePath);
        }
      }
      await this.applyRouteSelection(params.nodeId);
      appState.router.status = 'idle';
      return;
    }

    // New cloud project session
    if (params.projectId && params.sceneId) {
      if (!appState.auth.isAuthenticated) {
        appState.router.status = 'authenticating';
        appState.router.targetParams = params;
        return; // UI shell will catch this and prompt auth
      }

      await this.joinCloudSession(params);
      return;
    }

    // New local project session
    if (params.localSessionId) {
      await this.joinLocalSession(params.localSessionId);
      return;
    }
  }

  async resumeTargetSession(): Promise<void> {
    const target = appState.router.targetParams;
    appState.router.targetParams = null;
    if (target && target.projectId && target.sceneId) {
      await this.joinCloudSession(target);
    }
  }

  private async joinCloudSession(params: RouteParams): Promise<void> {
    const { projectId, sceneId, shareToken, nodeId } = params;
    if (!projectId || !sceneId) return;

    appState.router.status = 'fetchingMetadata';

    try {
      const collabJoinService = ServiceContainer.getInstance().getService<CollabJoinService>(
        ServiceContainer.getInstance().getOrCreateToken(CollabJoinService)
      );

      appState.router.status = 'loadingAssets';

      const success = await collabJoinService.joinSession({
        projectId,
        sceneId,
        shareToken: shareToken ?? undefined,
      });

      if (success) {
        await this.applyRouteSelection(nodeId);
      }
    } catch (error) {
      console.error('[RouterService] Cloud session join failed:', error);
      appState.router.status = 'error';
      appState.router.errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return;
    }

    appState.router.status = 'idle';
  }

  private async applyRouteSelection(nodeId: string | null): Promise<void> {
    if (!nodeId) {
      return;
    }

    const activeSceneId = appState.scenes.activeSceneId;
    if (!activeSceneId) {
      return;
    }

    const container = ServiceContainer.getInstance();
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const graph = sceneManager.getSceneGraph(activeSceneId);
    if (!graph?.nodeMap.has(nodeId)) {
      return;
    }

    if (appState.selection.primaryNodeId === nodeId && appState.selection.nodeIds.length === 1) {
      return;
    }

    const commandDispatcher = container.getService<CommandDispatcher>(
      container.getOrCreateToken(CommandDispatcher)
    );
    await commandDispatcher.execute(new SelectObjectCommand({ nodeId }));
  }

  private async joinLocalSession(localSessionId: string): Promise<void> {
    appState.router.status = 'fetchingMetadata';

    try {
      const projectService = ServiceContainer.getInstance().getService<ProjectService>(
        ServiceContainer.getInstance().getOrCreateToken(ProjectService)
      );

      appState.router.status = 'loadingAssets';
      const success = await projectService.openLocalSession(localSessionId);

      // If success is false, it means we found it but we lack permissions right now.
      if (!success) {
        appState.router.status = 'reactivationRequired';
        return;
      }
    } catch (error) {
      console.error('[RouterService] Local session join failed:', error);
      appState.router.status = 'error';
      appState.router.errorMessage =
        error instanceof Error ? error.message : 'Could not restore local project';
      return;
    }

    appState.router.status = 'idle';
  }

  /**
   * Reactivate local session permissions using user gesture.
   */
  async reactivateLocalSession(): Promise<void> {
    const localSessionId = appState.router.currentParams.localSessionId;
    if (!localSessionId) return;

    // Called typically via a user click, so we can show file picker prompt.
    appState.router.status = 'loadingAssets';
    try {
      const projectService = ServiceContainer.getInstance().getService<ProjectService>(
        ServiceContainer.getInstance().getOrCreateToken(ProjectService)
      );
      const success = await projectService.reactivateLocalSession(localSessionId);

      if (success) {
        appState.router.status = 'idle';
      } else {
        appState.router.status = 'error';
        appState.router.errorMessage = 'Permission denied to restore project.';
      }
    } catch (err) {
      console.error('[RouterService] Reactivation failed:', err);
      appState.router.status = 'error';
      appState.router.errorMessage = 'Reactivation failed.';
    }
  }
}
