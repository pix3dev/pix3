/**
 * `NetworkNodeBinder` — the seam between the wire's entity table and the scene tree.
 *
 * The session (`NetworkService`) is host-owned and survives `changeScene`; nodes do not. This binder
 * is therefore **scene-scoped**, exactly like `Collision2DService`: `SceneService` creates it lazily
 * and drops it when the delegate goes away, so a scene swap cannot leave a `netId` pointing at a
 * disposed node.
 *
 * What it does (plan decision D6 — everything networked is spawned):
 *
 * - **Binds** a `netId` to a node, in both directions, and fans that entity's changes to one
 *   listener (the node's `core:ReplicatedTransform`), so a hundred replicated nodes cost one
 *   subscription rather than a hundred filtered ones.
 * - **Instantiates a remote entity's prefab** when a `FullRecord` enters: `Kind` indexes the build's
 *   `netKindTable` to a prefab path, and the instance id is `net:<netId>` so every client derives
 *   *identical* child ids for the same entity (prefab child ids otherwise collide across spawns —
 *   `SceneLoader.ts:426` mints them from a fresh Map).
 * - **Frees** what it instantiated when the entity leaves, and never frees a node it did not create.
 *
 * Nodes this client spawned itself are bound by `core:NetworkedNode`, not here: the owner already
 * has the node, and the binder must not instantiate a second copy of it.
 */
import type { NodeBase } from '../nodes/NodeBase';
import type { NetEntityChange, NetworkService } from '../net/NetworkService';

/** Receives every change to one bound entity, in the order the session applied them. */
export type NetBindingListener = (change: NetEntityChange) => void;

/**
 * What the binder needs from its host. `SceneService` satisfies it structurally; a test can pass a
 * stub without standing up a renderer.
 */
export interface NetworkNodeBinderHost {
  /** The live session. Read on every use, so a host may swap it. */
  readonly network: NetworkService;
  /** Spawns a prefab into the running scene. Rejects when no scene is running. */
  instantiate(
    path: string,
    options?: { parent?: NodeBase | string | null; instanceId?: string }
  ): Promise<NodeBase>;
}

interface Binding {
  readonly netId: number;
  readonly node: NodeBase;
  /** True when this binder instantiated the node and therefore owns freeing it. */
  readonly remote: boolean;
  listener: NetBindingListener | null;
}

/** Counters for the Game tab and for diagnosing a scene that renders no peers. */
export interface NetBinderStats {
  /** Remote prefabs successfully instantiated. */
  remoteSpawned: number;
  /** Remote nodes freed because their entity left. */
  remoteFreed: number;
  /** Enters whose `Kind` is absent from this build's `netKindTable` — a build/allowlist mismatch. */
  unknownKinds: number;
  /** Instantiations that failed (no running scene, unreadable prefab); retried on the next reconcile. */
  instantiateFailures: number;
}

export class NetworkNodeBinder {
  private readonly byNetId = new Map<number, Binding>();
  private readonly byNode = new WeakMap<NodeBase, number>();
  /** Remote entities with no node yet: instantiation is in flight, or it failed and awaits a retry. */
  private readonly inFlight = new Set<number>();
  private readonly pending = new Set<number>();
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  private readonly counters: NetBinderStats = {
    remoteSpawned: 0,
    remoteFreed: 0,
    unknownKinds: 0,
    instantiateFailures: 0,
  };

  constructor(private readonly host: NetworkNodeBinderHost) {
    this.unsubscribe = host.network.onEntitiesChange(changes => this.applyChanges(changes));
  }

  /** A snapshot copy of the diagnostics counters. */
  get stats(): Readonly<NetBinderStats> {
    return { ...this.counters };
  }

  /** How many bound entities currently have a node. */
  get boundCount(): number {
    return this.byNetId.size;
  }

  /** Remote entities still waiting for a node (instantiating, or awaiting a retry). */
  get pendingCount(): number {
    return this.pending.size + this.inFlight.size;
  }

  /**
   * Binds a node this client owns to its entity. `listener` receives that entity's changes —
   * including the authoritative corrections the server may send for an entity you own.
   */
  bind(netId: number, node: NodeBase, listener: NetBindingListener | null = null): void {
    this.adopt({ netId, node, remote: false, listener });
  }

  /** Replaces (or clears) the change listener of an existing binding. */
  setListener(netId: number, listener: NetBindingListener | null): void {
    const binding = this.byNetId.get(netId);
    if (binding) {
      binding.listener = listener;
    }
  }

  /**
   * Drops a binding without freeing the node. A remote node the binder instantiated is put back on
   * the pending list only if its entity is still live — otherwise it is simply forgotten.
   */
  unbind(netId: number): void {
    const binding = this.byNetId.get(netId);
    if (!binding) {
      return;
    }
    this.byNetId.delete(netId);
    if (this.byNode.get(binding.node) === netId) {
      this.byNode.delete(binding.node);
    }
  }

  /** The node bound to an entity, or `null`. */
  getNode(netId: number): NodeBase | null {
    return this.byNetId.get(netId)?.node ?? null;
  }

  /** The entity a node is bound to, or `0` (the protocol's permanent "no entity" sentinel). */
  getNetId(node: NodeBase): number {
    return this.byNode.get(node) ?? 0;
  }

  /** True when this binder instantiated the node for `netId` (i.e. the entity belongs to a peer). */
  isRemote(netId: number): boolean {
    return this.byNetId.get(netId)?.remote ?? false;
  }

  /**
   * Instantiates whatever the session can see and this scene does not have yet, and retries anything
   * that failed. Idempotent, and cheap when there is nothing to do.
   *
   * Called on every entity change and by `core:NetworkedNode.onStart` — which is what heals a
   * `changeScene`: the session kept its entity table across the swap, and the first networked node
   * of the new scene is proof that a scene is running again.
   */
  reconcile(): void {
    if (this.disposed) {
      return;
    }
    for (const [netId, entity] of this.host.network.entities) {
      if (this.byNetId.has(netId) || this.inFlight.has(netId)) {
        continue;
      }
      if (this.isLocallyOwned(netId)) {
        continue;
      }
      this.pending.add(netId);
      void this.instantiateRemote(netId, entity.kind);
    }
  }

  /**
   * The scene is going away (a `changeScene`, a play-mode stop). Every binding dies with it, but the
   * *entities* do not — so remote ones go back on the pending list and are re-instantiated into the
   * next scene by {@link reconcile}. Nothing is freed here: the runner disposes the graph itself.
   */
  handleSceneStopped(): void {
    for (const binding of this.byNetId.values()) {
      if (binding.remote) {
        this.pending.add(binding.netId);
      }
    }
    this.byNetId.clear();
    this.inFlight.clear();
  }

  /** Unsubscribes from the session and forgets every binding. Idempotent. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.byNetId.clear();
    this.inFlight.clear();
    this.pending.clear();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private adopt(binding: Binding): void {
    const previous = this.byNetId.get(binding.netId);
    if (previous && previous.node !== binding.node) {
      this.byNode.delete(previous.node);
    }
    this.byNetId.set(binding.netId, binding);
    this.byNode.set(binding.node, binding.netId);
    this.pending.delete(binding.netId);
  }

  private applyChanges(changes: readonly NetEntityChange[]): void {
    if (this.disposed) {
      return;
    }

    for (const change of changes) {
      const binding = this.byNetId.get(change.netId);
      if (binding?.listener) {
        try {
          binding.listener(change);
        } catch (error) {
          // A throwing game listener must never stop the rest of the frame from being applied.
          console.error(`[NetworkNodeBinder] Listener for entity ${change.netId} threw:`, error);
        }
      }

      if (change.kind === 'leave') {
        this.releaseEntity(change.netId);
        continue;
      }
      if (change.kind !== 'enter' || binding || this.inFlight.has(change.netId)) {
        continue;
      }
      if (this.isLocallyOwned(change.netId)) {
        // Our own spawn: `core:NetworkedNode` already has the node and binds it itself.
        continue;
      }
      this.pending.add(change.netId);
      void this.instantiateRemote(change.netId, change.entity.kind);
    }
  }

  /** An entity leaving takes its remote node with it; a locally owned node is only unbound. */
  private releaseEntity(netId: number): void {
    this.pending.delete(netId);
    const binding = this.byNetId.get(netId);
    if (!binding) {
      return;
    }
    this.byNetId.delete(netId);
    this.byNode.delete(binding.node);
    if (binding.remote) {
      // queueFree, not dispose: this runs inside a network callback that may land mid-frame, and the
      // runtime is allowed to be iterating the tree.
      binding.node.queueFree();
      this.counters.remoteFreed += 1;
    }
  }

  private isLocallyOwned(netId: number): boolean {
    const network = this.host.network;
    if (network.ownsEntity(netId)) {
      return true;
    }
    const entity = network.entities.get(netId);
    return entity !== undefined && entity.ownerId !== 0 && entity.ownerId === network.clientId;
  }

  private async instantiateRemote(netId: number, kind: number): Promise<void> {
    const prefabPath = this.host.network.kinds.prefabPathOf(kind);
    if (!prefabPath) {
      // Nothing to retry: the build simply does not know this kind. Counted, never fatal — the rest
      // of the room keeps replicating.
      this.pending.delete(netId);
      this.counters.unknownKinds += 1;
      return;
    }

    this.inFlight.add(netId);
    let node: NodeBase;
    try {
      // `net:<netId>` is the D6 instance id: every client derives the same child ids for the same
      // entity, which is what makes `(rootNetId, childPath)` addressable without a global lookup.
      node = await this.host.instantiate(prefabPath, { instanceId: `net:${netId}` });
    } catch (error) {
      this.inFlight.delete(netId);
      this.counters.instantiateFailures += 1;
      console.warn(`[NetworkNodeBinder] Could not instantiate "${prefabPath}":`, error);
      return;
    }
    this.inFlight.delete(netId);

    // The entity may have left (or the scene may have gone) while the prefab was loading.
    if (this.disposed || !this.host.network.entities.has(netId)) {
      node.queueFree();
      this.pending.delete(netId);
      return;
    }

    this.adopt({ netId, node, remote: true, listener: null });
    this.counters.remoteSpawned += 1;
  }
}
