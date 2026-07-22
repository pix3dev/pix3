import { injectable, ServiceContainer } from '@/fw/di';
import type * as Y from 'yjs';
import { appState } from '@/state';
import { SceneManager } from '@pix3/runtime';
import { CollaborationService } from '@/services/collab/CollaborationService';
import { OperationService } from '@/services/core/OperationService';
import type { SceneCRDTBinding } from '@/services/collab/SceneCRDTBinding';
import * as ApiClient from '@/services/cloud/ApiClient';

const HOST_COLOR = '#f5ae39'; // --presence-1 (amber, you)

@injectable()
export class CollabSessionService {
  async ensureSceneSynchronized(sceneId = appState.scenes.activeSceneId): Promise<void> {
    const projectId = appState.project.id;

    if (!projectId || !sceneId) {
      throw new Error('Open a project and scene before sharing.');
    }

    const container = ServiceContainer.getInstance();
    const collabService = container.getService<CollaborationService>(
      container.getOrCreateToken(CollaborationService)
    );
    const { SceneCRDTBinding } = await import('@/services/collab/SceneCRDTBinding');
    const binding = container.getService<SceneCRDTBinding>(
      container.getOrCreateToken(SceneCRDTBinding)
    );
    const operationService = container.getService<OperationService>(
      container.getOrCreateToken(OperationService)
    );
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );

    const roomName = `project:${projectId}`;
    const existingRoomName = appState.collaboration.roomName;

    if (!collabService.isConnected() || existingRoomName !== roomName) {
      await collabService.connect(projectId, sceneId, this.getHostName(), HOST_COLOR, {
        role: appState.collaboration.role,
        authSource: appState.collaboration.authSource,
        isReadOnly: appState.collaboration.isReadOnly,
      });
      await this.waitForSync(collabService);
    }

    const ydoc = collabService.getYDoc();
    if (!ydoc) {
      throw new Error('Collaboration document is unavailable.');
    }

    binding.bindToOperationService(operationService, collabService);
    binding.bindToYDoc(ydoc, sceneId);

    const sceneGraph = sceneManager.getSceneGraph(sceneId) ?? sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      throw new Error('Active scene graph is unavailable.');
    }

    const existingFilePath = binding.getSceneFilePath(ydoc, sceneId);
    const descriptor = appState.scenes.descriptors[sceneId];
    const sceneEntry = ydoc.getMap<Y.Map<unknown>>('scenes').get(sceneId);
    const { Map: YMap } = await import('yjs');
    const snapshot = sceneEntry instanceof YMap ? sceneEntry.get('snapshot') : undefined;
    if (typeof snapshot !== 'string' || !snapshot.trim()) {
      ydoc.transact(() => {
        binding.initializeYDocFromScene(
          ydoc,
          sceneId,
          sceneGraph,
          descriptor?.filePath ?? existingFilePath ?? `collab://${sceneId}`
        );
      }, collabService.getLocalOrigin());
    }
  }

  async shareActiveScene(): Promise<string> {
    const projectId = appState.project.id;
    const sceneId = appState.scenes.activeSceneId;

    if (!projectId || !sceneId) {
      throw new Error('Open a project and scene before sharing.');
    }

    await this.ensureSceneSynchronized(sceneId);

    // Generate a share token via the API and build an invite link
    const { share_token } = await ApiClient.generateShareToken(projectId);
    appState.collaboration.shareEnabled = true;
    return this.buildInviteLink(projectId, sceneId, share_token);
  }

  buildInviteLink(projectId: string, sceneId: string, shareToken?: string): string {
    const url = new URL(window.location.href);
    url.searchParams.set('collab', projectId);
    url.searchParams.set('scene', sceneId);
    if (shareToken) {
      url.searchParams.set('token', shareToken);
    }
    url.hash = 'editor';
    return url.toString();
  }

  private getHostName(): string {
    const projectName = appState.project.projectName?.trim();
    if (projectName) {
      return `${projectName} Host`;
    }
    return 'Pix3 Host';
  }

  private waitForSync(collabService: CollaborationService): Promise<void> {
    return new Promise((resolve, reject) => {
      if (collabService.connectionStatus === 'synced') {
        resolve();
        return;
      }

      const timeoutId = window.setTimeout(() => {
        unsubscribe();
        resolve();
      }, 15000);

      const unsubscribe = collabService.addStatusListener(status => {
        if (status === 'synced') {
          window.clearTimeout(timeoutId);
          unsubscribe();
          resolve();
        } else if (status === 'disconnected') {
          window.clearTimeout(timeoutId);
          unsubscribe();
          reject(new Error('Unable to connect to the collaboration server.'));
        }
      });
    });
  }
}
