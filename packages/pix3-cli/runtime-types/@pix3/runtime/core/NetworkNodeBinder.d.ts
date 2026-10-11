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
    instantiate(path: string, options?: {
        parent?: NodeBase | string | null;
        instanceId?: string;
    }): Promise<NodeBase>;
    /**
     * False while no scene is running (still loading, or stopped). A snapshot routinely lands in that
     * window — the session connects before the scene starts — and attempting the spawn then is a
     * guaranteed failure, so the entity just stays pending until the scene reports it is running.
     * Optional: a host that does not implement it is treated as always running.
     */
    isSceneRunning?(): boolean;
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
export declare class NetworkNodeBinder {
    private readonly host;
    private readonly byNetId;
    private readonly byNode;
    /** Remote entities with no node yet: instantiation is in flight, or it failed and awaits a retry. */
    private readonly inFlight;
    private readonly pending;
    private unsubscribe;
    private disposed;
    private readonly counters;
    constructor(host: NetworkNodeBinderHost);
    /** A snapshot copy of the diagnostics counters. */
    get stats(): Readonly<NetBinderStats>;
    /** How many bound entities currently have a node. */
    get boundCount(): number;
    /** Remote entities still waiting for a node (instantiating, or awaiting a retry). */
    get pendingCount(): number;
    /**
     * Binds a node this client owns to its entity. `listener` receives that entity's changes —
     * including the authoritative corrections the server may send for an entity you own.
     */
    bind(netId: number, node: NodeBase, listener?: NetBindingListener | null): void;
    /** Replaces (or clears) the change listener of an existing binding. */
    setListener(netId: number, listener: NetBindingListener | null): void;
    /**
     * Drops a binding without freeing the node. A remote node the binder instantiated is put back on
     * the pending list only if its entity is still live — otherwise it is simply forgotten.
     */
    unbind(netId: number): void;
    /** The node bound to an entity, or `null`. */
    getNode(netId: number): NodeBase | null;
    /** The entity a node is bound to, or `0` (the protocol's permanent "no entity" sentinel). */
    getNetId(node: NodeBase): number;
    /** True when this binder instantiated the node for `netId` (i.e. the entity belongs to a peer). */
    isRemote(netId: number): boolean;
    /**
     * Instantiates whatever the session can see and this scene does not have yet, and retries anything
     * that failed. Idempotent, and cheap when there is nothing to do.
     *
     * Called on every entity change and by `core:NetworkedNode.onStart` — which is what heals a
     * `changeScene`: the session kept its entity table across the swap, and the first networked node
     * of the new scene is proof that a scene is running again.
     */
    reconcile(): void;
    /**
     * The scene is going away (a `changeScene`, a play-mode stop). Every binding dies with it, but the
     * *entities* do not — so remote ones go back on the pending list and are re-instantiated into the
     * next scene by {@link reconcile}. Nothing is freed here: the runner disposes the graph itself.
     */
    handleSceneStopped(): void;
    /** Unsubscribes from the session and forgets every binding. Idempotent. */
    dispose(): void;
    private adopt;
    private applyChanges;
    /** An entity leaving takes its remote node with it; a locally owned node is only unbound. */
    private releaseEntity;
    private isLocallyOwned;
    private instantiateRemote;
}
