import * as Y from 'yjs';
import { injectable, ServiceContainer } from '@/fw/di';
import { SceneStateUpdater } from '@/core/SceneStateUpdater';
import { appState } from '@/state';
import { ref } from 'valtio/vanilla';
import { SceneManager, type SceneGraph } from '@pix3/runtime';
import type { CollaborationService } from '@/services/collab/CollaborationService';
import type { OperationEvent, OperationService } from '@/services/core/OperationService';
import {
  SCENE_DOCUMENT_FORMAT,
  SCENE_FIELD_PREFIX,
  sameSceneField,
  sceneFieldsFromSnapshot,
  sceneSnapshotFromFields,
  type SceneFields,
} from '@pix3/collab-document';

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
  private localFields: SceneFields = new Map();
  private applyGeneration = 0;
  private pendingRemoteApply = false;

  bindToOperationService(
    operationService: OperationService,
    collabService: CollaborationService
  ): void {
    this.disposeOperationBinding?.();
    this.collabService = collabService;
    this.disposeOperationBinding = operationService.addListener(event => {
      try {
        this.onOperationCompleted(event);
      } finally {
        if (event.type === 'operation:completed' || event.type === 'operation:failed') {
          this.flushPendingRemoteApply();
        }
      }
    });
  }

  bindToYDoc(ydoc: Y.Doc, sceneId: string): void {
    if (this.observedSceneMap && this.sceneObserver) {
      this.observedSceneMap.unobserve(this.sceneObserver);
    }

    this.applyGeneration += 1;
    this.boundSceneId = sceneId;
    this.lastSerializedSnapshot = null;
    this.localFields = new Map();

    this.pendingRemoteApply = false;
    const sceneMap = this.getOrCreateSceneMap(ydoc, sceneId);
    const sharedFields = this.readEffectiveFields(sceneMap);
    const graph = this.getSceneManager().getSceneGraph(sceneId);
    if (graph) {
      // The bound graph can predate the room (host opening an existing room), or updates may
      // have arrived while the join loaded assets. Baseline what is actually installed.
      this.lastSerializedSnapshot = this.serializeSceneGraph(graph);
      this.localFields = sceneFieldsFromSnapshot(this.lastSerializedSnapshot, sharedFields);
    }

    this.sceneObserver = (event: Y.YMapEvent<unknown>) => {
      this.onSceneMapChanged(event);
    };
    this.observedSceneMap = sceneMap;
    sceneMap.observe(this.sceneObserver);
    const snapshot = this.readSnapshot(sceneMap);
    if (snapshot && !this.sameFields(this.localFields, sharedFields)) {
      void this.applyRemoteSnapshot(snapshot, sceneMap);
    }
  }

  initializeYDocFromScene(
    ydoc: Y.Doc,
    sceneId: string,
    sceneGraph: SceneGraph,
    filePath: string
  ): void {
    const snapshot = this.serializeSceneGraph(sceneGraph);
    const sceneMap = this.getOrCreateSceneMap(ydoc, sceneId);

    const fields = sceneFieldsFromSnapshot(snapshot);
    ydoc.transact(() => {
      sceneMap.set('version', sceneGraph.version ?? '1.0.0');
      sceneMap.set('description', sceneGraph.description ?? 'Collaborative Scene');
      sceneMap.set('filePath', filePath);
      // Retain a bootstrap snapshot for stored legacy rooms. Format 2 readers use registers.
      sceneMap.set('snapshot', snapshot);
      for (const key of this.readFields(sceneMap).keys()) sceneMap.delete(key);
      sceneMap.set('format', SCENE_DOCUMENT_FORMAT);
    }, this.collabService?.getLocalOrigin());

    this.lastSerializedSnapshot = snapshot;
    this.localFields = fields;
  }

  /**
   * True when the shared document already carries a snapshot entry for this scene.
   * A room that nobody has ever opened a scene in has none, so callers can fall back
   * to loading the scene from the project's files instead of failing the join.
   */
  hasScene(ydoc: Y.Doc, sceneId: string): boolean {
    const sceneMap = this.getSceneMap(ydoc, sceneId);
    return sceneMap !== null && this.readSnapshot(sceneMap) !== null;
  }

  async buildSceneFromYDoc(ydoc: Y.Doc, sceneId: string): Promise<SceneGraph> {
    const sceneManager = this.getSceneManager();
    const sceneMap = this.getSceneMap(ydoc, sceneId);
    if (!sceneMap) {
      throw new Error(`Scene '${sceneId}' is not available in the collaboration document.`);
    }
    const snapshot = this.readSnapshot(sceneMap);
    const filePath = sceneMap.get('filePath');
    const sceneText = snapshot ?? DEFAULT_SCENE_SNAPSHOT;
    const resolvedFilePath =
      typeof filePath === 'string' && filePath.trim() ? filePath : 'collab://scene';
    const graph = await sceneManager.parseScene(sceneText, { filePath: resolvedFilePath });
    if (!graph.description) {
      const description = sceneMap.get('description');
      if (typeof description === 'string') {
        graph.description = description;
      }
    }

    this.lastSerializedSnapshot = this.serializeSceneGraph(graph);
    this.localFields = this.readEffectiveFields(sceneMap);
    return graph;
  }

  dispose(): void {
    this.applyGeneration += 1;
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
    this.localFields = new Map();
    this.pendingRemoteApply = false;
  }

  private onOperationCompleted(event: OperationEvent): void {
    if (event.type !== 'operation:completed' || !event.didMutate || !event.pushedToHistory) {
      return;
    }

    if (!this.collabService || this.collabService.isRemoteUpdate || !this.boundSceneId) {
      return;
    }

    if (event.sceneId !== undefined && event.sceneId !== this.boundSceneId) {
      return;
    }

    const ydoc = this.collabService.getYDoc();
    if (!ydoc) {
      return;
    }

    const sceneManager = this.getSceneManager();
    const sceneGraph = sceneManager.getSceneGraph(this.boundSceneId);
    if (!sceneGraph) {
      return;
    }

    const snapshot = this.serializeSceneGraph(sceneGraph);
    if (snapshot === this.lastSerializedSnapshot && this.hasScene(ydoc, this.boundSceneId)) {
      return;
    }

    const fields = sceneFieldsFromSnapshot(snapshot, this.localFields);
    const descriptor = appState.scenes.descriptors[this.boundSceneId];
    const filePath = descriptor?.filePath ?? 'collab://scene';
    const sceneMap = this.getOrCreateSceneMap(ydoc, this.boundSceneId);
    // A remote parse may still be loading assets. Compare against the graph's last applied
    // state, not today's shared map, so this local edit cannot undo unseen remote changes.
    this.applyGeneration += 1;
    ydoc.transact(() => {
      // The bootstrap snapshot stays immutable. Only changed fields become shared registers,
      // including when two clients concurrently upgrade the same stored legacy snapshot.
      if (!sceneMap.has('snapshot')) sceneMap.set('snapshot', snapshot);
      sceneMap.set('version', sceneGraph.version ?? '1.0.0');
      sceneMap.set('description', sceneGraph.description ?? 'Collaborative Scene');
      sceneMap.set('filePath', filePath);
      this.writeFields(sceneMap, this.localFields, fields);
    }, this.collabService.getLocalOrigin());

    this.lastSerializedSnapshot = snapshot;
    this.localFields = fields;
    const merged = this.readSnapshot(sceneMap);
    if (merged && !this.sameFields(fields, this.readEffectiveFields(sceneMap))) {
      void this.applyRemoteSnapshot(merged, sceneMap);
    }
  }

  private onSceneMapChanged(event: Y.YMapEvent<unknown>): void {
    if (event.transaction.origin === this.collabService?.getLocalOrigin()) return;
    if (
      ![...event.changes.keys.keys()].some(
        key => key === 'snapshot' || key.startsWith(SCENE_FIELD_PREFIX)
      )
    )
      return;
    const snapshot = this.readSnapshot(event.target);
    if (!snapshot) return;
    // Always invalidate an in-flight parse, even if a later update returns to the current graph.
    this.applyGeneration += 1;
    if (this.sameFields(this.localFields, this.readEffectiveFields(event.target))) return;
    void this.applyRemoteSnapshot(snapshot, event.target);
  }

  private async applyRemoteSnapshot(snapshot: string, sceneMap: Y.Map<unknown>): Promise<void> {
    const sceneId = this.boundSceneId;
    const collabService = this.collabService;
    if (!sceneId || !collabService) return;
    const generation = ++this.applyGeneration;
    if (appState.operations.isExecuting) {
      this.pendingRemoteApply = true;
      return;
    }
    try {
      const sceneManager = this.getSceneManager();
      const filePath = sceneMap.get('filePath');
      const resolvedFilePath =
        typeof filePath === 'string' && filePath.trim() ? filePath : 'collab://scene';
      const graph = await sceneManager.parseScene(snapshot, { filePath: resolvedFilePath });
      if (
        generation !== this.applyGeneration ||
        this.boundSceneId !== sceneId ||
        this.observedSceneMap !== sceneMap
      ) {
        for (const root of graph.rootNodes) root.dispose();
        graph.nodeMap.clear();
        return;
      }

      if (appState.operations.isExecuting) {
        this.pendingRemoteApply = true;
        for (const root of graph.rootNodes) root.dispose();
        graph.nodeMap.clear();
        return;
      }

      // Suppress feedback only during installation, not asynchronous asset loading: a user can
      // keep editing while the remote graph is being parsed, and those edits must still sync.
      const wasRemoteUpdate = collabService.isRemoteUpdate;
      collabService.isRemoteUpdate = true;
      try {
        if (!graph.description) {
          const description = sceneMap.get('description');
          if (typeof description === 'string') graph.description = description;
        }
        const activeSceneId = appState.scenes.activeSceneId;
        sceneManager.setActiveSceneGraph(sceneId, graph);
        if (activeSceneId && activeSceneId !== sceneId) sceneManager.setActiveScene(activeSceneId);

        const descriptor = appState.scenes.descriptors[sceneId];
        if (descriptor) {
          descriptor.filePath = resolvedFilePath;
          descriptor.version = graph.version ?? descriptor.version;
          descriptor.name = graph.description || descriptor.name;
          // A shared edit has not been saved to the project's scene file yet.
          descriptor.isDirty = true;
        }
        appState.scenes.hierarchies[sceneId] = {
          version: graph.version ?? null,
          description: graph.description ?? null,
          rootNodes: ref(graph.rootNodes),
          metadata: graph.metadata ?? {},
        };
        SceneStateUpdater.updateHierarchyState(appState, sceneId, graph);
        appState.scenes.nodeDataChangeSignal += 1;
        this.lastSerializedSnapshot = this.serializeSceneGraph(graph);
        this.localFields = this.readEffectiveFields(sceneMap);
      } finally {
        collabService.isRemoteUpdate = wasRemoteUpdate;
      }
    } catch (error) {
      if (generation === this.applyGeneration) {
        console.error('[SceneCRDTBinding] Failed to apply remote snapshot', error);
      }
    }
  }

  private readFields(sceneMap: Y.Map<unknown>): SceneFields {
    return new Map([...sceneMap].filter(([key]) => key.startsWith(SCENE_FIELD_PREFIX)));
  }

  private flushPendingRemoteApply(): void {
    if (!this.pendingRemoteApply || appState.operations.isExecuting || !this.observedSceneMap)
      return;
    this.pendingRemoteApply = false;
    const snapshot = this.readSnapshot(this.observedSceneMap);
    if (
      snapshot &&
      !this.sameFields(this.localFields, this.readEffectiveFields(this.observedSceneMap))
    ) {
      void this.applyRemoteSnapshot(snapshot, this.observedSceneMap);
    }
  }

  private readEffectiveFields(sceneMap: Y.Map<unknown>): SceneFields {
    const snapshot = sceneMap.get('snapshot');
    if (typeof snapshot !== 'string' || !snapshot.trim()) return new Map();
    const fields = sceneFieldsFromSnapshot(snapshot);
    if (sceneMap.get('format') === SCENE_DOCUMENT_FORMAT) {
      for (const [key, value] of this.readFields(sceneMap)) {
        if (
          typeof value === 'object' &&
          value !== null &&
          'kind' in value &&
          value.kind === 'deleted'
        )
          fields.delete(key);
        else fields.set(key, value);
      }
    }
    return fields;
  }

  private readSnapshot(sceneMap: Y.Map<unknown>): string | null {
    const snapshot = sceneMap.get('snapshot');
    if (typeof snapshot !== 'string' || !snapshot.trim()) return null;
    return sceneMap.get('format') === SCENE_DOCUMENT_FORMAT
      ? sceneSnapshotFromFields(this.readEffectiveFields(sceneMap))
      : snapshot;
  }

  private writeFields(sceneMap: Y.Map<unknown>, previous: SceneFields, next: SceneFields): void {
    for (const key of previous.keys()) {
      if (!next.has(key)) sceneMap.set(key, { kind: 'deleted' });
    }
    for (const [key, value] of next) {
      if (!previous.has(key) || !sameSceneField(previous.get(key), value)) sceneMap.set(key, value);
    }
    sceneMap.set('format', SCENE_DOCUMENT_FORMAT);
  }

  private sameFields(a: SceneFields, b: SceneFields): boolean {
    return (
      a.size === b.size &&
      [...a].every(([key, value]) => b.has(key) && sameSceneField(value, b.get(key)))
    );
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
