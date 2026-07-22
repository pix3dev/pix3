import * as Y from 'yjs';
import { injectable, ServiceContainer } from '@/fw/di';
import { SceneStateUpdater } from '@/core/SceneStateUpdater';
import { appState } from '@/state';
import { ref } from 'valtio/vanilla';
import { SceneManager, type SceneGraph } from '@pix3/runtime';
import type { CollaborationService } from '@/services/collab/CollaborationService';
import type { OperationEvent, OperationService } from '@/services/core/OperationService';

const DEFAULT_SCENE_SNAPSHOT = `version: 1.0.0
description: Collaborative Scene
root: []
`;

@injectable()
export class SceneCRDTBinding {
  private disposeOperationBinding: (() => void) | null = null;
  private observedSceneMap: Y.Map<unknown> | null = null;
  private sceneObserver: ((event: Y.YMapEvent<unknown>) => void) | null = null;
  private boundSceneId: string | null = null;
  private collabService: CollaborationService | null = null;
  private lastSerializedSnapshot: string | null = null;

  bindToOperationService(
    operationService: OperationService,
    collabService: CollaborationService
  ): void {
    this.disposeOperationBinding?.();
    this.collabService = collabService;
    this.disposeOperationBinding = operationService.addListener(event => {
      this.onOperationCompleted(event);
    });
  }

  bindToYDoc(ydoc: Y.Doc, sceneId: string): void {
    if (this.observedSceneMap && this.sceneObserver) {
      this.observedSceneMap.unobserve(this.sceneObserver);
    }

    this.boundSceneId = sceneId;

    const sceneMap = this.getOrCreateSceneMap(ydoc, sceneId);
    const snapshot = sceneMap.get('snapshot');
    if (typeof snapshot === 'string' && snapshot.trim()) {
      this.lastSerializedSnapshot = snapshot;
    }

    this.sceneObserver = (event: Y.YMapEvent<unknown>) => {
      this.onSceneMapChanged(event);
    };
    this.observedSceneMap = sceneMap;
    sceneMap.observe(this.sceneObserver);
  }

  initializeYDocFromScene(
    ydoc: Y.Doc,
    sceneId: string,
    sceneGraph: SceneGraph,
    filePath: string
  ): void {
    const snapshot = this.serializeSceneGraph(sceneGraph);
    const sceneMap = this.getOrCreateSceneMap(ydoc, sceneId);

    sceneMap.set('version', sceneGraph.version ?? '1.0.0');
    sceneMap.set('description', sceneGraph.description ?? 'Collaborative Scene');
    sceneMap.set('filePath', filePath);
    sceneMap.set('snapshot', snapshot);

    this.lastSerializedSnapshot = snapshot;
  }

  async buildSceneFromYDoc(ydoc: Y.Doc, sceneId: string): Promise<SceneGraph> {
    const sceneManager = this.getSceneManager();
    const sceneMap = this.getSceneMap(ydoc, sceneId);
    if (!sceneMap) {
      throw new Error(`Scene '${sceneId}' is not available in the collaboration document.`);
    }
    const snapshot = sceneMap.get('snapshot');
    const filePath = sceneMap.get('filePath');
    const sceneText =
      typeof snapshot === 'string' && snapshot.trim() ? snapshot : DEFAULT_SCENE_SNAPSHOT;
    const resolvedFilePath =
      typeof filePath === 'string' && filePath.trim() ? filePath : 'collab://scene';
    const graph = await sceneManager.parseScene(sceneText, { filePath: resolvedFilePath });
    if (!graph.description) {
      const description = sceneMap.get('description');
      if (typeof description === 'string') {
        graph.description = description;
      }
    }

    this.lastSerializedSnapshot = sceneText;
    return graph;
  }

  dispose(): void {
    this.disposeOperationBinding?.();
    this.disposeOperationBinding = null;

    if (this.observedSceneMap && this.sceneObserver) {
      this.observedSceneMap.unobserve(this.sceneObserver);
    }

    this.observedSceneMap = null;
    this.sceneObserver = null;
    this.boundSceneId = null;
    this.collabService = null;
    this.lastSerializedSnapshot = null;
  }

  private onOperationCompleted(event: OperationEvent): void {
    if (event.type !== 'operation:completed' || !event.didMutate || !event.pushedToHistory) {
      return;
    }

    if (!this.collabService || this.collabService.isRemoteUpdate || !this.boundSceneId) {
      return;
    }

    const ydoc = this.collabService.getYDoc();
    if (!ydoc) {
      return;
    }

    const sceneManager = this.getSceneManager();
    const sceneGraph =
      sceneManager.getSceneGraph(this.boundSceneId) ?? sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      return;
    }

    const snapshot = this.serializeSceneGraph(sceneGraph);
    if (snapshot === this.lastSerializedSnapshot) {
      return;
    }

    const descriptor = appState.scenes.descriptors[this.boundSceneId];
    const filePath = descriptor?.filePath ?? 'collab://scene';
    const sceneMap = this.getOrCreateSceneMap(ydoc, this.boundSceneId);
    ydoc.transact(() => {
      sceneMap.set('version', sceneGraph.version ?? '1.0.0');
      sceneMap.set('description', sceneGraph.description ?? 'Collaborative Scene');
      sceneMap.set('filePath', filePath);
      sceneMap.set('snapshot', snapshot);
    }, this.collabService.getLocalOrigin());

    this.lastSerializedSnapshot = snapshot;
  }

  private onSceneMapChanged(event: Y.YMapEvent<unknown>): void {
    if (event.transaction.origin === this.collabService?.getLocalOrigin()) {
      return;
    }

    if (!event.changes.keys.has('snapshot')) {
      return;
    }

    const snapshot = event.target.get('snapshot');
    if (
      typeof snapshot !== 'string' ||
      !snapshot.trim() ||
      snapshot === this.lastSerializedSnapshot
    ) {
      return;
    }

    void this.applyRemoteSnapshot(snapshot, event.target);
  }

  private async applyRemoteSnapshot(snapshot: string, sceneMap: Y.Map<unknown>): Promise<void> {
    if (!this.boundSceneId || !this.collabService) {
      return;
    }

    this.collabService.isRemoteUpdate = true;
    try {
      const sceneManager = this.getSceneManager();
      const filePath = sceneMap.get('filePath');
      const resolvedFilePath =
        typeof filePath === 'string' && filePath.trim() ? filePath : 'collab://scene';
      const graph = await sceneManager.parseScene(snapshot, { filePath: resolvedFilePath });

      if (!graph.description) {
        const description = sceneMap.get('description');
        if (typeof description === 'string') {
          graph.description = description;
        }
      }

      sceneManager.setActiveSceneGraph(this.boundSceneId, graph);

      const descriptor = appState.scenes.descriptors[this.boundSceneId];
      if (descriptor) {
        descriptor.filePath = resolvedFilePath;
        descriptor.version = graph.version ?? descriptor.version;
        descriptor.name = graph.description || descriptor.name;
        descriptor.isDirty = false;
      }

      appState.scenes.hierarchies[this.boundSceneId] = {
        version: graph.version ?? null,
        description: graph.description ?? null,
        rootNodes: ref(graph.rootNodes),
        metadata: graph.metadata ?? {},
      };
      SceneStateUpdater.updateHierarchyState(appState, this.boundSceneId, graph);
      appState.scenes.nodeDataChangeSignal = appState.scenes.nodeDataChangeSignal + 1;
      this.lastSerializedSnapshot = snapshot;
    } catch (error) {
      console.error('[SceneCRDTBinding] Failed to apply remote snapshot', error);
    } finally {
      this.collabService.isRemoteUpdate = false;
    }
  }

  private serializeSceneGraph(sceneGraph: SceneGraph): string {
    return this.getSceneManager().serializeScene(sceneGraph);
  }

  getSceneFilePath(ydoc: Y.Doc, sceneId: string): string | null {
    const sceneMap = this.getSceneMap(ydoc, sceneId);
    const filePath = sceneMap?.get('filePath');
    return typeof filePath === 'string' && filePath.trim() ? filePath : null;
  }

  private getSceneMap(ydoc: Y.Doc, sceneId: string): Y.Map<unknown> | null {
    const scenesMap = ydoc.getMap<Y.Map<unknown>>('scenes');
    const entry = scenesMap.get(sceneId);
    return entry instanceof Y.Map ? entry : null;
  }

  private getOrCreateSceneMap(ydoc: Y.Doc, sceneId: string): Y.Map<unknown> {
    const existing = this.getSceneMap(ydoc, sceneId);
    if (existing) {
      return existing;
    }

    const sceneMap = new Y.Map<unknown>();
    ydoc.getMap<Y.Map<unknown>>('scenes').set(sceneId, sceneMap);
    return sceneMap;
  }

  private getSceneManager(): SceneManager {
    const container = ServiceContainer.getInstance();
    return container.getService<SceneManager>(container.getOrCreateToken(SceneManager));
  }
}
