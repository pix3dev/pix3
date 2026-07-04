import { ref } from 'valtio/vanilla';
import { SceneManager } from '@pix3/runtime';

import {
  type Operation,
  type OperationContext,
  type OperationInvokeResult,
} from '@/core/Operation';
import { ProjectStorageService } from '@/services/ProjectStorageService';
import { PrefabRefreshTracker } from '@/services/PrefabRefreshTracker';
import { OperationService } from '@/services/OperationService';

export interface RefreshPrefabInstancesOperationParams {
  sceneId: string;
  changedPrefabPath?: string;
}

export class RefreshPrefabInstancesOperation implements Operation<OperationInvokeResult> {
  readonly metadata = {
    id: 'scene.refresh-prefab-instances',
    title: 'Refresh Prefab Instances',
    description: 'Rebuild scene prefab instances from latest source assets',
    tags: ['scene', 'prefab', 'refresh'],
  } as const;

  private readonly params: RefreshPrefabInstancesOperationParams;

  constructor(params: RefreshPrefabInstancesOperationParams) {
    this.params = params;
  }

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state, container } = context;
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const { sceneId } = this.params;
    const descriptor = state.scenes.descriptors[sceneId];

    if (!descriptor) {
      return { didMutate: false };
    }

    const currentGraph = sceneManager.getSceneGraph(sceneId);
    if (!currentGraph) {
      return { didMutate: false };
    }

    const prefabPaths = this.collectPrefabPaths(currentGraph);
    if (prefabPaths.length === 0) {
      return { didMutate: false };
    }

    const changedPrefabPath = this.normalizePath(this.params.changedPrefabPath);
    const forced = changedPrefabPath.length > 0;
    if (forced && !prefabPaths.includes(changedPrefabPath)) {
      return { didMutate: false };
    }

    // Decide whether a rebuild is actually necessary. Reparsing swaps every live
    // node instance, which orphans the node references captured in undo/redo
    // history closures — so we only pay that cost when a referenced prefab file
    // genuinely changed on disk. When nothing changed (the common case: tab
    // switches, exiting play mode) we keep the current graph, its node identity,
    // and the undo history intact.
    const tracker = container.getService<PrefabRefreshTracker>(
      container.getOrCreateToken(PrefabRefreshTracker)
    );
    const storage = container.getService<ProjectStorageService>(
      container.getOrCreateToken(ProjectStorageService)
    );

    const signature = await this.computeSignature(storage, prefabPaths);
    const previousSignature = tracker.get(sceneId);

    if (!forced) {
      if (previousSignature === undefined) {
        // First refresh for this scene: adopt the current graph as the baseline
        // (it was parsed from disk when loaded, so it is already up to date) and
        // avoid a needless rebuild that would discard existing undo history.
        tracker.set(sceneId, signature);
        return { didMutate: false };
      }
      if (previousSignature === signature) {
        return { didMutate: false };
      }
    }

    const preservedDirty = descriptor.isDirty;
    const preservedLastSavedAt = descriptor.lastSavedAt;
    const sceneText = sceneManager.serializeScene(currentGraph);
    const refreshedGraph = await sceneManager.parseScene(sceneText, {
      filePath: descriptor.filePath || undefined,
    });

    sceneManager.setActiveSceneGraph(sceneId, refreshedGraph);
    state.scenes.hierarchies[sceneId] = {
      version: refreshedGraph.version ?? null,
      description: refreshedGraph.description ?? null,
      rootNodes: ref(refreshedGraph.rootNodes),
      metadata: refreshedGraph.metadata ?? {},
    };

    descriptor.isDirty = preservedDirty;
    descriptor.lastSavedAt = preservedLastSavedAt;
    state.scenes.lastLoadedAt = Date.now();
    state.scenes.nodeDataChangeSignal = state.scenes.nodeDataChangeSignal + 1;

    // The referenced prefab set can change after a rebuild (e.g. a prefab that
    // now nests another prefab), so re-derive the signature from the fresh graph.
    tracker.set(
      sceneId,
      await this.computeSignature(storage, this.collectPrefabPaths(refreshedGraph))
    );

    // Every live node was replaced. Undo/redo entries still hold references to
    // the old node instances, so applying them would silently no-op against the
    // detached graph. Clearing history keeps undo honest (unavailable) rather
    // than silently broken.
    try {
      const operationService = container.getService<OperationService>(
        container.getOrCreateToken(OperationService)
      );
      operationService.history.clear();
    } catch {
      // OperationService is always registered in the editor; ignore in tests
      // that construct the operation with a minimal container.
    }

    return { didMutate: true };
  }

  private collectPrefabPaths(graph: {
    nodeMap: Map<string, { instancePath: string | null }>;
  }): string[] {
    const paths = new Set<string>();
    for (const node of graph.nodeMap.values()) {
      if (typeof node.instancePath === 'string' && node.instancePath.length > 0) {
        paths.add(this.normalizePath(node.instancePath));
      }
    }
    return [...paths].sort();
  }

  private async computeSignature(
    storage: ProjectStorageService,
    prefabPaths: readonly string[]
  ): Promise<string> {
    const parts = await Promise.all(
      prefabPaths.map(async path => {
        try {
          const modified = await storage.getLastModified(path);
          return `${path}@${modified ?? 'na'}`;
        } catch {
          // Treat unreadable prefab files as a stable sentinel so a transient
          // read failure does not force an identity-destroying rebuild.
          return `${path}@err`;
        }
      })
    );
    return parts.join('|');
  }

  private normalizePath(value?: string): string {
    if (!value) {
      return '';
    }
    return value.replace(/\\/g, '/');
  }
}
