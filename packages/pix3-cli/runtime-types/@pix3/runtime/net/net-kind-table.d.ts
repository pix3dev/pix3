/**
 * `netKindTable` — the client half of the wire `Kind` ↔ prefab mapping (plan decision D6).
 *
 * A spawned entity's `Kind` is a `u16` **index into the build's prefab table**, not a string: the
 * hot plane has no room for a path (`FullRecord` is a fixed 20 bytes) and the room validates a
 * spawn against an allowlist that *is* this table's index set. Both sides must therefore agree on
 * the order, which is why the exporter emits the table (`buildSceneManifestTs`) from a
 * deterministic sort and versions it with the `buildId`.
 *
 * The table has two segments, in this order:
 *
 * 1. **spawnable prefab paths** — the only segment Phase 1 emits or resolves;
 * 2. **authored bindings** — reserved for the Phase-3 mechanism that binds an authored scene node
 *    to an entity. Nothing implements it yet; the shape exists so its arrival does not shift a
 *    single prefab index (which would silently repoint every published build's kinds).
 *
 * This module is pure data — it imports nothing from `three` and nothing from the node tree, so it
 * stays inside the `net/` no-DOM boundary.
 */
/** The wire `Kind` field is a `u16`, so a table can hold at most this many entries. */
export declare const MAX_NET_KIND = 65535;
/** A table as the build manifest emits it. `authored` is reserved (see the module doc). */
export interface NetKindTableSource {
    /** Spawnable prefab paths, in wire-index order. Index 0 is kind 0. */
    readonly prefabs: readonly string[];
    /** Reserved authored-binding segment; always empty in Phase 1. */
    readonly authored?: readonly string[];
}
/**
 * Resolves `kind ↔ prefab path` for one build.
 *
 * A host installs the exporter's table with {@link replaceAll}; a test or an in-editor session with
 * no built manifest uses {@link register} instead. `register` **appends**, so it is only safe while
 * every participant registers the same paths in the same order — that is why `spawn()` refuses an
 * unregistered path rather than quietly auto-registering it, which would let two clients disagree
 * about what kind 0 means.
 */
export declare class NetKindTable {
    private readonly entries;
    private readonly byKey;
    /** Length of the reserved authored segment that follows the prefabs. */
    private authoredCount;
    constructor(source?: NetKindTableSource | readonly string[]);
    /** Total reserved indices, prefabs plus the (currently always empty) authored segment. */
    get size(): number;
    /** How many spawnable prefabs the table holds. Kinds `0…prefabCount-1` are prefabs. */
    get prefabCount(): number;
    /** True when nothing has been installed or registered yet. */
    get isEmpty(): boolean;
    /**
     * Replaces the whole table. Accepts either the manifest object or a bare prefab list; duplicate
     * paths collapse onto their first index, because two indices for one prefab would make the
     * client's `kind → path` answer depend on which one the server happened to mint.
     */
    replaceAll(source: NetKindTableSource | readonly string[]): void;
    /**
     * Ensures a prefab has a kind, returning it. Idempotent for a path already present.
     *
     * @throws RangeError when the table already carries an authored segment (appending would shift
     * its indices) or when the `u16` kind space is exhausted.
     */
    register(prefabPath: string): number;
    /** The kind for a prefab path (either `res://` form), or `null` when it is not in the table. */
    kindOf(prefabPath: string): number | null;
    /**
     * The prefab path for a kind, or `null` when the kind is out of range or lands in the reserved
     * authored segment (which names scene nodes, not prefabs).
     */
    prefabPathOf(kind: number): string | null;
    /** Every reserved entry, in index order. */
    toArray(): readonly string[];
    /** Forgets everything. */
    clear(): void;
    private append;
}
/**
 * The table every {@link import('./NetworkService').NetworkService} uses unless it was handed its
 * own. A host installs the build's table into it once, at bootstrap.
 */
export declare function getNetKindTable(): NetKindTable;
/**
 * Installs the build's table (`netKindTable` from the generated scene manifest). Call once, before
 * joining a room — a kind that changes mid-session repoints entities every peer already spawned.
 */
export declare function setNetworkPrefabTable(source: NetKindTableSource | readonly string[]): void;
/**
 * Appends one spawnable prefab to the shared table and returns its kind.
 *
 * This is the **fallback** for a session with no built manifest — a vitest case, or an in-editor
 * "Play Online" before the exporter has run. Every participant must call it with the same paths in
 * the same order, so prefer installing a sorted table with {@link setNetworkPrefabTable}.
 */
export declare function registerNetworkPrefab(prefabPath: string): number;
/** Drops the shared table. Exists for tests; production code installs a table instead. */
export declare function resetNetKindTable(): void;
