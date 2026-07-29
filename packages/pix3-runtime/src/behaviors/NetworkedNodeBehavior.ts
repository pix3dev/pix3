/**
 * `core:NetworkedNode` — binds a node to a replicated entity.
 *
 * Plan decision D6: a node has **no intrinsic netId**. Everything networked is *spawned*, and the
 * fabric mints the id. This component is the two halves of that:
 *
 * - **My own avatar** — on start it sends `SpawnEntityRequest{Kind}` (the kind comes from the
 *   build's `netKindTable`, keyed by `prefabPath`), and binds the `netId` the response carries.
 * - **A peer's avatar** — the entity arrived first and `NetworkNodeBinder` instantiated this very
 *   prefab for it. Then the node is already bound when this component starts, and it must **not**
 *   spawn a second entity. That is what the `isBound` check at the top of `onStart` is for.
 *
 * It survives `changeScene` the only way a node can: it does not. The session does, so the node's
 * entity is despawned on detach (`despawnOnDetach`) and the next scene's copy spawns a fresh one,
 * while remote entities are re-instantiated by the binder's reconcile.
 */
import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
import type { NetOwnershipPolicy, NetworkService } from '../net/NetworkService';
import { NetworkSpawnError, netOwnershipOf } from '../net/NetworkService';
import type { NetworkNodeBinder } from '../core/NetworkNodeBinder';

const OWNERSHIP_OPTIONS: readonly NetOwnershipPolicy[] = ['owned', 'shared', 'transferable'];

function toOwnership(value: unknown): NetOwnershipPolicy {
  return OWNERSHIP_OPTIONS.includes(value as NetOwnershipPolicy)
    ? (value as NetOwnershipPolicy)
    : 'owned';
}

export class NetworkedNodeBehavior extends Script {
  private boundNetId = 0;
  /** True when *this* client asked for the entity (so it owns it even before the record arrives). */
  private spawnedLocally = false;
  /** Guards against a second spawn while the first request is still in flight. */
  private spawnInFlight = false;
  /** Set when a spawn failed, so the Game tab / a script can say why nothing appeared. */
  private lastSpawnError: NetworkSpawnError | null = null;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      prefabPath: '',
      ownership: 'owned',
      appFlags: 0,
      spawnOnStart: true,
      despawnOnDetach: true,
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'NetworkedNode',
      properties: [
        {
          name: 'prefabPath',
          type: 'string',
          ui: {
            label: 'Prefab',
            description:
              "This node's own prefab (res:// path). Indexes the build's netKindTable to the wire " +
              'kind, and is what every other client instantiates for this entity.',
            group: 'Identity',
          },
          getValue: c => (c as NetworkedNodeBehavior).config.prefabPath,
          setValue: (c, v) => {
            (c as NetworkedNodeBehavior).config.prefabPath = String(v ?? '');
          },
        },
        {
          name: 'ownership',
          type: 'select',
          ui: {
            label: 'Ownership',
            description:
              'What happens when the owner leaves: owned = despawned, shared = reassigned to the ' +
              'new host, transferable = reassignable to anyone.',
            group: 'Identity',
            options: [...OWNERSHIP_OPTIONS],
          },
          getValue: c => (c as NetworkedNodeBehavior).config.ownership,
          setValue: (c, v) => {
            (c as NetworkedNodeBehavior).config.ownership = toOwnership(v);
          },
        },
        {
          name: 'spawnOnStart',
          type: 'boolean',
          ui: {
            label: 'Spawn On Start',
            description:
              'Request an entity as soon as this node starts. Turn it off for a node a script ' +
              'spawns explicitly, or for a prefab that only ever represents a peer.',
            group: 'Lifecycle',
          },
          getValue: c => (c as NetworkedNodeBehavior).config.spawnOnStart !== false,
          setValue: (c, v) => {
            (c as NetworkedNodeBehavior).config.spawnOnStart = Boolean(v);
          },
        },
        {
          name: 'despawnOnDetach',
          type: 'boolean',
          ui: {
            label: 'Despawn On Detach',
            description:
              'Despawn the entity when this node goes away (scene change, queueFree). Off leaves a ' +
              'ghost in the room until its owner disconnects.',
            group: 'Lifecycle',
          },
          getValue: c => (c as NetworkedNodeBehavior).config.despawnOnDetach !== false,
          setValue: (c, v) => {
            (c as NetworkedNodeBehavior).config.despawnOnDetach = Boolean(v);
          },
        },
        {
          name: 'appFlags',
          type: 'number',
          ui: {
            label: 'App Flags',
            description: 'Game-defined flag bits 3–7 (0–31), replicated verbatim.',
            group: 'Identity',
            min: 0,
            max: 31,
            step: 1,
          },
          getValue: c => (c as NetworkedNodeBehavior).config.appFlags,
          setValue: (c, v) => {
            const parsed = Number(v);
            (c as NetworkedNodeBehavior).config.appFlags = Number.isFinite(parsed)
              ? Math.max(0, Math.min(31, Math.round(parsed)))
              : 0;
          },
        },
      ],
      groups: {
        Identity: { label: 'Identity', expanded: true },
        Lifecycle: { label: 'Lifecycle', expanded: true },
      },
    };
  }

  // ── Public surface (what a game script reads) ──────────────────────────────

  /** The bound entity, or `0` — the protocol's permanent "no entity" sentinel. */
  get netId(): number {
    return this.boundNetId;
  }

  /** True once an entity is bound. */
  get isBound(): boolean {
    return this.boundNetId !== 0;
  }

  /**
   * True when this client may move the node: it spawned the entity, or the record says it owns it.
   * `OwnerId == 0` is server-owned and read-only to everyone.
   */
  get isMine(): boolean {
    if (!this.isBound) {
      return false;
    }
    if (this.spawnedLocally) {
      return true;
    }
    const network = this.network;
    const owner = network?.getEntity(this.boundNetId)?.ownerId ?? 0;
    return owner !== 0 && owner === network?.clientId;
  }

  /** The entity's owner client id, or `0` while unbound or server-owned. */
  get ownerId(): number {
    const network = this.network;
    if (!this.isBound || !network) {
      return 0;
    }
    const owner = network.getEntity(this.boundNetId)?.ownerId ?? 0;
    return owner !== 0 ? owner : this.spawnedLocally ? network.clientId : 0;
  }

  /** The entity's ownership policy, read back from the replicated flags byte. */
  get ownership(): NetOwnershipPolicy {
    const flags = this.network?.getEntity(this.boundNetId)?.flags;
    return flags === undefined ? toOwnership(this.config.ownership) : netOwnershipOf(flags);
  }

  /** Why the last spawn attempt failed, or `null`. */
  get spawnError(): NetworkSpawnError | null {
    return this.lastSpawnError;
  }

  /**
   * Requests an entity for this node. Resolves with the minted `netId`, or `0` when the request was
   * refused (the reason lands in {@link spawnError}) — a game script should not have to try/catch a
   * component lifecycle call.
   */
  async spawn(): Promise<number> {
    if (this.isBound || this.spawnInFlight) {
      return this.boundNetId;
    }
    const network = this.network;
    const node = this.node;
    if (!network || !node || !network.isOnline) {
      return 0;
    }

    const prefabPath = String(this.config.prefabPath ?? '');
    this.spawnInFlight = true;
    try {
      const netId = await network.spawn(prefabPath, {
        position: { x: node.position.x, y: node.position.y },
        rotation: node.rotation.z,
        ownership: toOwnership(this.config.ownership),
        appFlags: Number(this.config.appFlags) || 0,
      });
      this.lastSpawnError = null;
      this.spawnedLocally = true;
      this.adopt(netId);
      return netId;
    } catch (error) {
      this.lastSpawnError =
        error instanceof NetworkSpawnError
          ? error
          : new NetworkSpawnError('invalid', prefabPath, String(error));
      console.warn(
        `[core:NetworkedNode] Spawn of "${prefabPath}" failed (${this.lastSpawnError.kind}): ` +
          this.lastSpawnError.message
      );
      return 0;
    } finally {
      this.spawnInFlight = false;
    }
  }

  /** Releases the entity (despawning it when this client owns it) and unbinds the node. */
  despawn(): void {
    const netId = this.boundNetId;
    if (netId === 0) {
      return;
    }
    if (this.spawnedLocally) {
      this.network?.despawn(netId);
    }
    this.binder?.unbind(netId);
    this.boundNetId = 0;
    this.spawnedLocally = false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  onStart(): void {
    const binder = this.binder;
    const node = this.node;
    if (!binder || !node) {
      return;
    }

    // A scene that just started may be the *second* scene of a session whose entities are still
    // live; this is the moment the binder learns a scene is running again.
    binder.reconcile();

    const existing = binder.getNetId(node);
    if (existing !== 0) {
      // Instantiated for a peer's entity by the binder — adopt it, never spawn a second one.
      this.boundNetId = existing;
      this.spawnedLocally = false;
      return;
    }

    if (this.config.spawnOnStart !== false) {
      void this.spawn();
    }
  }

  override onDetach(): void {
    if (this.boundNetId !== 0 && this.config.despawnOnDetach !== false) {
      this.despawn();
    } else if (this.boundNetId !== 0) {
      this.binder?.unbind(this.boundNetId);
      this.boundNetId = 0;
    }
    super.onDetach();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private adopt(netId: number): void {
    const node = this.node;
    if (!node || netId === 0) {
      return;
    }
    this.boundNetId = netId;
    this.binder?.bind(netId, node);
  }

  private get network(): NetworkService | null {
    return this.scene?.network ?? null;
  }

  private get binder(): NetworkNodeBinder | null {
    return this.scene?.netNodes ?? null;
  }
}
