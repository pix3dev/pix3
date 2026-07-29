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
export const MAX_NET_KIND = 65535;

/** A table as the build manifest emits it. `authored` is reserved (see the module doc). */
export interface NetKindTableSource {
  /** Spawnable prefab paths, in wire-index order. Index 0 is kind 0. */
  readonly prefabs: readonly string[];
  /** Reserved authored-binding segment; always empty in Phase 1. */
  readonly authored?: readonly string[];
}

/**
 * Canonical key for a prefab path: `res://` stripped, backslashes folded, leading `./` removed and
 * case preserved. Only the *key* is normalized — the table hands back the exact string it was given,
 * so a caller's `res://…` form survives into `SceneLoader.instantiatePrefab`.
 */
function normalizePrefabKey(path: string): string {
  const trimmed = path.trim().replace(/\\/g, '/');
  const withoutScheme = trimmed.startsWith('res://') ? trimmed.slice(6) : trimmed;
  return withoutScheme.replace(/^\.\//, '').replace(/^\/+/, '');
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
export class NetKindTable {
  private readonly entries: string[] = [];
  private readonly byKey = new Map<string, number>();
  /** Length of the reserved authored segment that follows the prefabs. */
  private authoredCount = 0;

  constructor(source?: NetKindTableSource | readonly string[]) {
    if (source) {
      this.replaceAll(source);
    }
  }

  /** Total reserved indices, prefabs plus the (currently always empty) authored segment. */
  get size(): number {
    return this.entries.length;
  }

  /** How many spawnable prefabs the table holds. Kinds `0…prefabCount-1` are prefabs. */
  get prefabCount(): number {
    return this.entries.length - this.authoredCount;
  }

  /** True when nothing has been installed or registered yet. */
  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /**
   * Replaces the whole table. Accepts either the manifest object or a bare prefab list; duplicate
   * paths collapse onto their first index, because two indices for one prefab would make the
   * client's `kind → path` answer depend on which one the server happened to mint.
   */
  replaceAll(source: NetKindTableSource | readonly string[]): void {
    const isList = Array.isArray(source);
    const prefabs: readonly string[] = isList ? source : (source as NetKindTableSource).prefabs;
    const authored: readonly string[] = isList
      ? []
      : ((source as NetKindTableSource).authored ?? []);

    this.entries.length = 0;
    this.byKey.clear();
    this.authoredCount = 0;

    for (const path of prefabs) {
      this.append(path);
    }
    // The authored segment only reserves indices in Phase 1: its entries are scene node ids, not
    // prefab paths, so they are deliberately absent from the path lookup.
    for (const entry of authored) {
      if (this.entries.length > MAX_NET_KIND) {
        break;
      }
      this.entries.push(entry);
      this.authoredCount += 1;
    }
  }

  /**
   * Ensures a prefab has a kind, returning it. Idempotent for a path already present.
   *
   * @throws RangeError when the table already carries an authored segment (appending would shift
   * its indices) or when the `u16` kind space is exhausted.
   */
  register(prefabPath: string): number {
    const existing = this.kindOf(prefabPath);
    if (existing !== null) {
      return existing;
    }
    if (this.authoredCount > 0) {
      throw new RangeError(
        'Cannot register a prefab into a net kind table that already carries an authored-binding ' +
          'segment: appending would shift every authored index.'
      );
    }
    return this.append(prefabPath);
  }

  /** The kind for a prefab path (either `res://` form), or `null` when it is not in the table. */
  kindOf(prefabPath: string): number | null {
    return this.byKey.get(normalizePrefabKey(prefabPath)) ?? null;
  }

  /**
   * The prefab path for a kind, or `null` when the kind is out of range or lands in the reserved
   * authored segment (which names scene nodes, not prefabs).
   */
  prefabPathOf(kind: number): string | null {
    if (!Number.isInteger(kind) || kind < 0 || kind >= this.prefabCount) {
      return null;
    }
    return this.entries[kind];
  }

  /** Every reserved entry, in index order. */
  toArray(): readonly string[] {
    return [...this.entries];
  }

  /** Forgets everything. */
  clear(): void {
    this.entries.length = 0;
    this.byKey.clear();
    this.authoredCount = 0;
  }

  private append(prefabPath: string): number {
    const key = normalizePrefabKey(prefabPath);
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    if (this.entries.length > MAX_NET_KIND) {
      throw new RangeError(`A net kind table holds at most ${MAX_NET_KIND + 1} entries.`);
    }
    const kind = this.entries.length;
    this.entries.push(prefabPath.trim());
    this.byKey.set(key, kind);
    return kind;
  }
}

// ── The process-wide table ───────────────────────────────────────────────────

let sharedTable = new NetKindTable();

/**
 * The table every {@link import('./NetworkService').NetworkService} uses unless it was handed its
 * own. A host installs the build's table into it once, at bootstrap.
 */
export function getNetKindTable(): NetKindTable {
  return sharedTable;
}

/**
 * Installs the build's table (`netKindTable` from the generated scene manifest). Call once, before
 * joining a room — a kind that changes mid-session repoints entities every peer already spawned.
 */
export function setNetworkPrefabTable(source: NetKindTableSource | readonly string[]): void {
  sharedTable.replaceAll(source);
}

/**
 * Appends one spawnable prefab to the shared table and returns its kind.
 *
 * This is the **fallback** for a session with no built manifest — a vitest case, or an in-editor
 * "Play Online" before the exporter has run. Every participant must call it with the same paths in
 * the same order, so prefer installing a sorted table with {@link setNetworkPrefabTable}.
 */
export function registerNetworkPrefab(prefabPath: string): number {
  return sharedTable.register(prefabPath);
}

/** Drops the shared table. Exists for tests; production code installs a table instead. */
export function resetNetKindTable(): void {
  sharedTable = new NetKindTable();
}
