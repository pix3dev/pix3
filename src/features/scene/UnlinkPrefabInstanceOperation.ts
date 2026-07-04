import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { SceneStateUpdater } from '@/core/SceneStateUpdater';
import { NodeBase, SceneManager } from '@pix3/runtime';
import { stringify } from 'yaml';
import {
  getPrefabMetadata,
  isPrefabInstanceRoot,
  type PrefabMetadata,
} from '@/features/scene/prefab-utils';

export interface UnlinkPrefabInstanceOperationParams {
  /** Runtime node id of the prefab instance root to unlink. */
  nodeId: string;
}

interface NodeMarkerState {
  marker: PrefabMetadata | null;
  instancePath: string | null;
}

const PREFAB_METADATA_KEY = '__pix3Prefab';

/**
 * Unlinks (unpacks) a prefab instance into plain, editable scene nodes — the
 * Unity "Unpack Prefab" workflow. The outer instance's prefab markers are
 * stripped so its nodes serialize as ordinary children, while any nested
 * instances inside it stay linked: their markers are re-rooted onto themselves
 * so they keep round-tripping as `instance:` references (preserving overrides).
 *
 * Shallow (one level): only the targeted instance is unpacked. Undo/redo restore
 * the exact marker/instancePath snapshots, so no scene reparse happens and node
 * identities — and the rest of the undo history — stay intact.
 */
export class UnlinkPrefabInstanceOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.unlink-prefab-instance',
    title: 'Unlink Prefab Instance',
    description: 'Convert a prefab instance into plain, editable scene nodes',
    tags: ['scene', 'prefab', 'instance', 'unlink', 'unpack'],
    affectsNodeStructure: true,
  };

  private readonly params: UnlinkPrefabInstanceOperationParams;
  private beforeState = new Map<string, NodeMarkerState>();
  private afterState = new Map<string, NodeMarkerState>();
  private activeSceneIdAtCommit: string | null = null;

  constructor(params: UnlinkPrefabInstanceOperationParams) {
    this.params = params;
  }

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state, container } = context;
    const activeSceneId = state.scenes.activeSceneId;
    if (!activeSceneId) {
      return { didMutate: false };
    }

    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const sceneGraph = sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      return { didMutate: false };
    }

    const root = sceneGraph.nodeMap.get(this.params.nodeId);
    if (!root || !isPrefabInstanceRoot(root)) {
      return { didMutate: false };
    }

    this.activeSceneIdAtCommit = activeSceneId;

    const subtree = this.collectSubtree(root);
    this.beforeState = this.snapshot(subtree);

    const filePath = state.scenes.descriptors[activeSceneId]?.filePath || undefined;
    await this.unpack(root, sceneManager, filePath);

    this.afterState = this.snapshot(subtree);

    this.applySideEffects(context);

    return {
      didMutate: true,
      commit: {
        label: `Unlink prefab instance: ${root.name}`,
        undo: () => this.restore(context, this.beforeState),
        redo: () => this.restore(context, this.afterState),
      },
    };
  }

  private async unpack(
    root: NodeBase,
    sceneManager: SceneManager,
    filePath: string | undefined
  ): Promise<void> {
    // The outer instance root becomes a plain node.
    this.removeMarker(root);
    root.setInstancePath(null);

    for (const child of root.children) {
      if (child instanceof NodeBase) {
        await this.processDescendant(child, sceneManager, filePath);
      }
    }
  }

  private async processDescendant(
    node: NodeBase,
    sceneManager: SceneManager,
    filePath: string | undefined
  ): Promise<void> {
    if (node.instancePath) {
      // A nested instance root: re-root it onto itself so it survives as its own
      // independent instance. reRootInstance rewrites its entire subtree.
      await this.reRootInstance(node, sceneManager, filePath);
      return;
    }

    this.removeMarker(node);
    for (const child of node.children) {
      if (child instanceof NodeBase) {
        await this.processDescendant(child, sceneManager, filePath);
      }
    }
  }

  private async reRootInstance(
    instanceRoot: NodeBase,
    sceneManager: SceneManager,
    filePath: string | undefined
  ): Promise<void> {
    const marker = getPrefabMetadata(instanceRoot);
    if (!marker) {
      return;
    }

    const rootEffective = this.normalizeLocalId(marker.localId);
    const baseMap = await this.buildBaseMap(sceneManager, marker.sourcePath, filePath);

    const assign = (node: NodeBase, effectiveLocalId: string, isRoot: boolean): void => {
      const nodeMarker = getPrefabMetadata(node);
      if (!nodeMarker) {
        return;
      }

      const nextMarker: PrefabMetadata = {
        localId: nodeMarker.localId,
        effectiveLocalId,
        instanceRootId: instanceRoot.nodeId,
        sourcePath: nodeMarker.sourcePath,
      };
      if (isRoot) {
        nextMarker.basePropertiesByLocalId = baseMap;
      }
      (node.metadata as Record<string, unknown>)[PREFAB_METADATA_KEY] = nextMarker;

      for (const child of node.children) {
        if (!(child instanceof NodeBase)) {
          continue;
        }
        const childMarker = getPrefabMetadata(child);
        const childLocalId = this.normalizeLocalId(childMarker?.localId ?? child.nodeId);
        assign(child, `${effectiveLocalId}/${childLocalId}`, false);
      }
    };

    assign(instanceRoot, rootEffective, true);
  }

  /**
   * Rebuild the pristine base-property map for a nested instance by freshly
   * parsing its source prefab. Keyed by effectiveLocalId relative to the prefab
   * root — matching the ids reRootInstance assigns to the live subtree. On read
   * failure returns an empty map: serialization then emits every value as an
   * override (verbose but lossless).
   *
   * Note: we probe `sourcePath` (paired with `marker.localId` for the root key,
   * which stays coherent). For chained-root prefabs (a prefab whose only root is
   * itself an `instance:`), `sourcePath` is the deepest base prefab rather than
   * the intermediate one, so the intermediate's internal overrides are re-emitted
   * as explicit overrides — verbose but still lossless on round-trip.
   */
  private async buildBaseMap(
    sceneManager: SceneManager,
    sourcePath: string,
    filePath: string | undefined
  ): Promise<Record<string, Record<string, unknown>>> {
    try {
      const probeDocument = {
        version: '1.0.0',
        root: [{ id: '__unlink_probe__', instance: sourcePath }],
      };
      const graph = await sceneManager.parseScene(stringify(probeDocument), { filePath });
      const probeRoot = graph.rootNodes[0];
      const probeMarker = probeRoot ? getPrefabMetadata(probeRoot) : null;
      return probeMarker?.basePropertiesByLocalId ?? {};
    } catch (error) {
      console.warn('[UnlinkPrefabInstanceOperation] Failed to rebuild nested instance base map', {
        sourcePath,
        error,
      });
      return {};
    }
  }

  private restore(context: OperationContext, snapshot: Map<string, NodeMarkerState>): void {
    const { container } = context;
    if (!this.activeSceneIdAtCommit) {
      return;
    }
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const sceneGraph = sceneManager.getSceneGraph(this.activeSceneIdAtCommit);
    if (!sceneGraph) {
      return;
    }

    for (const [nodeId, entry] of snapshot) {
      const node = sceneGraph.nodeMap.get(nodeId);
      if (!node) {
        continue;
      }
      if (entry.marker) {
        (node.metadata as Record<string, unknown>)[PREFAB_METADATA_KEY] = this.cloneMarker(
          entry.marker
        );
      } else {
        delete (node.metadata as Record<string, unknown>)[PREFAB_METADATA_KEY];
      }
      node.setInstancePath(entry.instancePath);
    }

    this.applySideEffects(context);
  }

  private applySideEffects(context: OperationContext): void {
    const { state } = context;
    if (!this.activeSceneIdAtCommit) {
      return;
    }
    SceneStateUpdater.markSceneDirty(state, this.activeSceneIdAtCommit);
    // Marker changes are not reflected in the rootNodes array, so bump the
    // change signal to force the scene tree (badges/lock) and inspector to
    // re-read prefab state.
    state.scenes.nodeDataChangeSignal = state.scenes.nodeDataChangeSignal + 1;
  }

  private collectSubtree(root: NodeBase): NodeBase[] {
    const out: NodeBase[] = [];
    const stack: NodeBase[] = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        continue;
      }
      out.push(node);
      for (const child of node.children) {
        if (child instanceof NodeBase) {
          stack.push(child);
        }
      }
    }
    return out;
  }

  private snapshot(nodes: NodeBase[]): Map<string, NodeMarkerState> {
    const map = new Map<string, NodeMarkerState>();
    for (const node of nodes) {
      map.set(node.nodeId, {
        marker: this.cloneMarker(getPrefabMetadata(node)),
        instancePath: node.instancePath,
      });
    }
    return map;
  }

  private cloneMarker(marker: PrefabMetadata | null): PrefabMetadata | null {
    return marker ? (JSON.parse(JSON.stringify(marker)) as PrefabMetadata) : null;
  }

  private removeMarker(node: NodeBase): void {
    delete (node.metadata as Record<string, unknown>)[PREFAB_METADATA_KEY];
  }

  private normalizeLocalId(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  }
}
