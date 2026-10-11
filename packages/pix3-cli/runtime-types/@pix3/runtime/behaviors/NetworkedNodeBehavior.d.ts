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
import type { NetOwnershipPolicy } from '../net/NetworkService';
import { NetworkSpawnError } from '../net/NetworkService';
export declare class NetworkedNodeBehavior extends Script {
    private boundNetId;
    /** True when *this* client asked for the entity (so it owns it even before the record arrives). */
    private spawnedLocally;
    /** Guards against a second spawn while the first request is still in flight. */
    private spawnInFlight;
    /** Set when a spawn failed, so the Game tab / a script can say why nothing appeared. */
    private lastSpawnError;
    constructor(id: string, type: string);
    static getPropertySchema(): PropertySchema;
    /** The bound entity, or `0` — the protocol's permanent "no entity" sentinel. */
    get netId(): number;
    /** True once an entity is bound. */
    get isBound(): boolean;
    /**
     * True when this client may move the node: it spawned the entity, or the record says it owns it.
     * `OwnerId == 0` is server-owned and read-only to everyone.
     */
    get isMine(): boolean;
    /** The entity's owner client id, or `0` while unbound or server-owned. */
    get ownerId(): number;
    /** The entity's ownership policy, read back from the replicated flags byte. */
    get ownership(): NetOwnershipPolicy;
    /** Why the last spawn attempt failed, or `null`. */
    get spawnError(): NetworkSpawnError | null;
    /**
     * Requests an entity for this node. Resolves with the minted `netId`, or `0` when the request was
     * refused (the reason lands in {@link spawnError}) — a game script should not have to try/catch a
     * component lifecycle call.
     */
    spawn(): Promise<number>;
    /** Releases the entity (despawning it when this client owns it) and unbinds the node. */
    despawn(): void;
    onStart(): void;
    onDetach(): void;
    private adopt;
    private get network();
    private get binder();
}
