import { injectable, ServiceContainer } from '@/fw/di';
import { appState } from '@/state';
import { CollaborationService } from '@/services/collab/CollaborationService';
import type { SceneCRDTBinding } from '@/services/collab/SceneCRDTBinding';
import { OperationService } from '@/services/core/OperationService';
import { SceneManager, type SceneGraph } from '@pix3/runtime';
import { ref } from 'valtio/vanilla';
import { CloudProjectService } from '@/services/cloud/CloudProjectService';
import { ProjectScriptLoaderService } from '@/services/scripting/ProjectScriptLoaderService';

export interface CollabJoinParams {
  projectId: string;
  sceneId: string;
  shareToken?: string;
}

/**
 * Detects collab join URL parameters and orchestrates the guest join flow:
 * 1. Parse `?collab=<projectId>&scene=<sceneId>` from the URL (handled by RouterService now)
 * 2. Set project state to 'ready' in cloud mode
 * 3. Connect to the collab server
 * 4. Wait for Y.Doc sync from the server
 * 5. Build the target scene graph from Y.Doc and inject it into the editor
 */
@injectable()
export class CollabJoinService {
  /**
   * Execute the full collab join flow.
   * Returns true if the join was initiated, false if params weren't found.
   */
  async joinSession(params: CollabJoinParams): Promise<boolean> {
    const { projectId, sceneId, shareToken } = params;

    console.log('[CollabJoin] Joining collaborative session', { projectId, sceneId });

    const container = ServiceContainer.getInstance();
    const cloudProjectService = container.getService<CloudProjectService>(
      container.getOrCreateToken(CloudProjectService)
    );
    await cloudProjectService.openProject(projectId, {
      shareToken,
      skipSceneOpen: true,
    });

    const projectScriptLoader = container.getService<ProjectScriptLoaderService>(
      container.getOrCreateToken(ProjectScriptLoaderService)
    );

    // 2. Connect to the collab server
    const collabService = container.getService<CollaborationService>(
      container.getOrCreateToken(CollaborationService)
    );

    // 3. Wait for Y.Doc sync and project scripts before hydrating the scene graph.
    await Promise.all([this.waitForSync(collabService), projectScriptLoader.ensureReady()]);

    // 4. Build the target scene from the shared project document.
    const ydoc = collabService.getYDoc();
    if (!ydoc) {
      console.error('[CollabJoin] No Y.Doc available after sync');
      return false;
    }

    const { SceneCRDTBinding } = await import('@/services/collab/SceneCRDTBinding');
    const crdtBinding = container.getService<SceneCRDTBinding>(
      container.getOrCreateToken(SceneCRDTBinding)
    );
    const operationService = container.getService<OperationService>(
      container.getOrCreateToken(OperationService)
    );
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );

    const sceneGraph = await crdtBinding.buildSceneFromYDoc(ydoc, sceneId);
    const sceneFilePath = crdtBinding.getSceneFilePath(ydoc, sceneId) ?? `collab://${sceneId}`;
    this.injectSceneIntoEditor(sceneId, sceneGraph, sceneManager, sceneFilePath, null);

    // 6. Set up CRDT binding for ongoing sync
    crdtBinding.bindToOperationService(operationService, collabService);
    crdtBinding.bindToYDoc(ydoc, sceneId);

    console.log('[CollabJoin] Successfully joined collaborative session', {
      projectId,
      sceneId,
      nodeCount: sceneGraph.nodeMap.size,
    });

    return true;
  }

  /**
   * Wait for the HocuspocusProvider to report 'synced' status.
   * Times out after 15 seconds.
   */
  private waitForSync(collabService: CollaborationService): Promise<void> {
    return new Promise((resolve, reject) => {
      // Already synced?
      if (collabService.connectionStatus === 'synced') {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        cleanup();
        // Even if not fully synced, try to proceed with whatever we have
        console.warn('[CollabJoin] Sync timed out after 15s, proceeding with available data');
        resolve();
      }, 15_000);

      const cleanup = collabService.addStatusListener(status => {
        if (status === 'synced') {
          clearTimeout(timeout);
          cleanup();
          resolve();
        } else if (status === 'disconnected') {
          clearTimeout(timeout);
          cleanup();
          reject(new Error('Disconnected from collab server'));
        }
      });
    });
  }

  /**
   * Inject a scene graph into the editor state, mirroring what LoadSceneCommand does.
   */
  private injectSceneIntoEditor(
    sceneId: string,
    sceneGraph: SceneGraph,
    sceneManager: SceneManager,
    sceneFilePath: string,
    fileHandle: FileSystemFileHandle | null
  ): void {
    // Register scene in SceneManager
    sceneManager.setActiveSceneGraph(sceneId, sceneGraph);

    // Create scene descriptor (no file handle for collab guests)
    appState.scenes.descriptors[sceneId] = {
      id: sceneId,
      filePath: sceneFilePath,
      name: sceneGraph.description || sceneId,
      version: sceneGraph.version ?? '1.0.0',
      isDirty: false,
      lastSavedAt: null,
      fileHandle: fileHandle ? ref(fileHandle) : null,
      lastModifiedTime: null,
    };

    // Store hierarchy for UI (wrapped in ref() to prevent Valtio proxying of Three.js nodes)
    appState.scenes.hierarchies[sceneId] = {
      version: sceneGraph.version ?? null,
      description: sceneGraph.description ?? null,
      rootNodes: ref(sceneGraph.rootNodes),
      metadata: sceneGraph.metadata ?? {},
    };

    appState.scenes.activeSceneId = sceneId;
    appState.scenes.loadState = 'ready';
    appState.scenes.lastLoadedAt = Date.now();
    appState.project.lastOpenedScenePath = sceneFilePath;

    // Create an editor tab for the scene
    appState.tabs.tabs = [
      {
        id: `scene:${sceneFilePath}`,
        type: 'scene',
        resourceId: sceneFilePath,
        title: sceneGraph.description || 'Collab Scene',
        isDirty: false,
        contextState: {},
      },
    ];
    appState.tabs.activeTabId = `scene:${sceneFilePath}`;
  }

  dispose(): void {
    // nothing to clean up
  }
}
