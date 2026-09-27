/**
 * The protected set `P` of plan `.plans/external-agent-authoring.md` §4.3: every value a human
 * set that the external writer has not (provably) seen yet.
 *
 *   `(nodeId, path) → { value, gen }`  — a live entry: the human's value wins over the agent's;
 *   `(nodeId, path) → { deleted, gen }` — a tombstone: the human removed this node / component /
 *                                          property, and it stays removed.
 *
 * Paths follow `scene-doc.ts`: `[]` is the whole node (a created node's snapshot, or a deleted
 * node's tombstone), `['$tree']` its tree position `{ parent, index }`, anything else a location
 * inside the node (`['properties', 'transform', 'position']`, `['components', '@c1']`, ...).
 *
 * `gen` is a per-scene monotonic counter of COMPLETED human operations; every entry written by one
 * operation carries that operation's gen. `versions` remembers `(hash, genAtWrite)` for each file
 * version the editor wrote or accepted, so an agent's ack of hash `h` releases only entries with
 * `gen <= genAtWrite(h)`.
 *
 * All functions are pure: they return a new set and never mutate their input. The data shape is
 * plain JSON — it is persisted as `.pix3/protected.json` so protection survives an editor restart.
 */
import {
  collectSubtreeIds,
  deepClone,
  deleteAtPath,
  isPathPrefix,
  isRecord,
  isTreePath,
  ownFields,
  setAtPath,
  TREE_PATH,
  type MergeNode,
  type PathSegment,
  type PropertyPath,
  type TreePosition,
} from './scene-doc';

export const PROTECTED_SET_FORMAT = 1;
/** How many `(hash, genAtWrite)` records to keep (oldest dropped first). */
export const MAX_REMEMBERED_VERSIONS = 256;

export interface ProtectedEntry {
  nodeId: string;
  path: PathSegment[];
  gen: number;
  /** Tombstone: the human deleted what this path addresses. */
  deleted?: true;
  /** The human's value (absent for tombstones). */
  value?: unknown;
}

export interface RememberedVersion {
  hash: string;
  genAtWrite: number;
}

export interface ProtectedSetData {
  format: typeof PROTECTED_SET_FORMAT;
  gen: number;
  entries: ProtectedEntry[];
  versions: RememberedVersion[];
}

/** Reference to one entry at one generation — what a conflict hands to "accept agent's version". */
export interface EntryRef {
  key: string;
  gen: number;
}

export type HumanOperation =
  | { kind: 'set-property'; nodeId: string; path: PropertyPath; value: unknown }
  | { kind: 'reset-property'; nodeId: string; path: PropertyPath }
  /** A created node (with its whole subtree, e.g. a paste or a prefab instance). */
  | { kind: 'create-node'; node: MergeNode; parentId: string | null; prevSiblingId: string | null }
  /** A deleted node: pass EVERY id of the deleted subtree (see `collectSubtreeIds`). */
  | { kind: 'delete-node'; nodeIds: readonly string[] }
  /** `prevSiblingId`: the sibling the node now sits right after (null = first child). */
  | { kind: 'move-node'; nodeId: string; parentId: string | null; prevSiblingId: string | null }
  | { kind: 'delete-component'; nodeId: string; componentId: string };

export function entryKey(nodeId: string, path: PropertyPath): string {
  return JSON.stringify([nodeId, ...path]);
}

export function emptyProtectedSet(): ProtectedSetData {
  return { format: PROTECTED_SET_FORMAT, gen: 0, entries: [], versions: [] };
}

export function isTombstone(entry: ProtectedEntry): boolean {
  return entry.deleted === true;
}

export function isNodeTombstone(entry: ProtectedEntry): boolean {
  return entry.deleted === true && entry.path.length === 0;
}

// ---------------------------------------------------------------------------
// Internal mutable working copy.
// ---------------------------------------------------------------------------

class WorkingSet {
  readonly entries = new Map<string, ProtectedEntry>();

  constructor(source: ProtectedSetData) {
    for (const entry of source.entries) {
      this.entries.set(entryKey(entry.nodeId, entry.path), deepClone(entry));
    }
  }

  forNode(nodeId: string): ProtectedEntry[] {
    return [...this.entries.values()].filter(e => e.nodeId === nodeId);
  }

  removeNode(nodeId: string): void {
    for (const entry of this.forNode(nodeId)) {
      this.entries.delete(entryKey(entry.nodeId, entry.path));
    }
  }

  /** Record a value (or a tombstone when `deleted`) at `path`, folding overlapping paths. */
  write(
    nodeId: string,
    path: PropertyPath,
    gen: number,
    change: { value?: unknown; deleted?: true }
  ): void {
    if (!isTreePath(path)) {
      const ancestors = this.forNode(nodeId)
        .filter(e => e.path.length < path.length && isPathPrefix(e.path, path))
        .sort((a, b) => a.path.length - b.path.length);
      for (const ancestor of ancestors) {
        if (isTombstone(ancestor)) {
          // A later operation supersedes the earlier removal of the enclosing value.
          this.entries.delete(entryKey(ancestor.nodeId, ancestor.path));
          continue;
        }
        // A live enclosing value (e.g. a created node's snapshot): patch it in place.
        if (patchValue(ancestor, path.slice(ancestor.path.length), change)) {
          ancestor.gen = gen;
          this.dropDescendants(nodeId, path);
          return;
        }
      }
      this.dropDescendants(nodeId, path);
    }
    const entry: ProtectedEntry = { nodeId, path: [...path], gen };
    if (change.deleted) entry.deleted = true;
    else entry.value = deepClone(change.value);
    this.entries.set(entryKey(nodeId, path), entry);
  }

  private dropDescendants(nodeId: string, path: PropertyPath): void {
    for (const entry of this.forNode(nodeId)) {
      if (entry.path.length > path.length && isPathPrefix(path, entry.path)) {
        this.entries.delete(entryKey(entry.nodeId, entry.path));
      }
    }
  }

  toData(gen: number, versions: RememberedVersion[]): ProtectedSetData {
    return {
      format: PROTECTED_SET_FORMAT,
      gen,
      entries: [...this.entries.values()],
      versions: versions.map(v => ({ ...v })),
    };
  }
}

function patchValue(
  ancestor: ProtectedEntry,
  relative: PropertyPath,
  change: { value?: unknown; deleted?: true }
): boolean {
  const container = ancestor.path.length === 0 ? ancestor.value : { value: ancestor.value };
  if (!isRecord(container)) return false;
  const holder: MergeNode = { ...(deepClone(container) as Record<string, unknown>), id: '' };
  const target = ancestor.path.length === 0 ? relative : ['value', ...relative];
  if (change.deleted) {
    deleteAtPath(holder, target);
  } else if (!setAtPath(holder, target, change.value)) {
    return false;
  }
  const fields = ownFields(holder);
  ancestor.value = ancestor.path.length === 0 ? fields : fields.value;
  return true;
}

function applyOperation(work: WorkingSet, op: HumanOperation, gen: number): void {
  switch (op.kind) {
    case 'set-property':
      if (op.path.length === 0 || isTreePath(op.path)) {
        throw new Error('set-property needs a property path; use create-node / move-node');
      }
      work.write(op.nodeId, op.path, gen, { value: op.value });
      return;
    case 'reset-property':
      if (op.path.length === 0 || isTreePath(op.path)) {
        throw new Error('reset-property needs a property path; use delete-node');
      }
      work.write(op.nodeId, op.path, gen, { deleted: true });
      return;
    case 'delete-component':
      work.write(op.nodeId, ['components', `@${op.componentId}`], gen, { deleted: true });
      return;
    case 'move-node': {
      const position: TreePosition = { parent: op.parentId, prevSibling: op.prevSiblingId };
      work.write(op.nodeId, TREE_PATH, gen, { value: position });
      return;
    }
    case 'delete-node':
      for (const id of op.nodeIds) {
        work.removeNode(id);
        work.write(id, [], gen, { deleted: true });
      }
      return;
    case 'create-node': {
      const visit = (
        node: MergeNode,
        parentId: string | null,
        prevSibling: string | null
      ): void => {
        work.removeNode(node.id);
        work.write(node.id, [], gen, { value: ownFields(node) });
        const position: TreePosition = { parent: parentId, prevSibling };
        work.write(node.id, TREE_PATH, gen, { value: position });
        (node.children ?? []).forEach((child, i, all) =>
          visit(child, node.id, i > 0 ? all[i - 1].id : null)
        );
      };
      visit(op.node, op.parentId, op.prevSiblingId);
      return;
    }
  }
}

/**
 * Record one completed human operation (or several that form ONE operation, e.g. a multi-select
 * move) — bumps `gen` once. Unfinished gestures must not be recorded (§4.3).
 */
export function recordHumanOperation(
  set: ProtectedSetData,
  op: HumanOperation | readonly HumanOperation[]
): ProtectedSetData {
  const gen = set.gen + 1;
  const work = new WorkingSet(set);
  const ops: readonly HumanOperation[] = Array.isArray(op) ? op : [op as HumanOperation];
  for (const each of ops) applyOperation(work, each, gen);
  return work.toData(gen, set.versions);
}

/** Convenience for `delete-node`: every id of the subtree rooted at `node`. */
export function deleteNodeOperation(node: MergeNode): HumanOperation {
  return { kind: 'delete-node', nodeIds: collectSubtreeIds(node) };
}

/**
 * Remember that the editor wrote (or accepted from disk) a version with this byte hash, containing
 * every human entry up to `genAtWrite` (default: the current gen — autosave serializes the live
 * graph, which holds every completed operation).
 */
export function recordEditorWrite(
  set: ProtectedSetData,
  hash: string,
  genAtWrite: number = set.gen
): ProtectedSetData {
  const versions = set.versions.filter(v => v.hash !== hash);
  versions.push({ hash, genAtWrite });
  while (versions.length > MAX_REMEMBERED_VERSIONS) versions.shift();
  return { ...deepClone(set), versions };
}

export function genAtWrite(set: ProtectedSetData, hash: string): number | undefined {
  return set.versions.find(v => v.hash === hash)?.genAtWrite;
}

export interface AckOutcome {
  hash: string;
  known: boolean;
  genAtWrite?: number;
  released: string[];
}

/**
 * Exit 2 from `P`: the agent acknowledged reading the content with byte hash `hash`. Releases only
 * entries with `gen <= genAtWrite(hash)`; newer entries (edited after that version) stay.
 * An unknown hash releases nothing. Acks are one-shot — the CALLER deletes them once processed.
 */
export function applyAcks(
  set: ProtectedSetData,
  hashes: readonly string[]
): { set: ProtectedSetData; outcomes: AckOutcome[] } {
  const work = new WorkingSet(set);
  const outcomes: AckOutcome[] = [];
  for (const hash of hashes) {
    const limit = genAtWrite(set, hash);
    if (limit === undefined) {
      outcomes.push({ hash, known: false, released: [] });
      continue;
    }
    const released: string[] = [];
    for (const [key, entry] of work.entries) {
      if (entry.gen <= limit) {
        work.entries.delete(key);
        released.push(key);
      }
    }
    outcomes.push({ hash, known: true, genAtWrite: limit, released });
  }
  return { set: work.toData(set.gen, set.versions), outcomes };
}

/**
 * Exit 1 from `P`: the human pressed "Accept agent's version" on these conflicts. Removes the
 * referenced entries — but only at the generation the conflict saw: an entry the human edited
 * again after the conflict was reported is a newer decision and stays protected.
 * (The caller then applies the agent's values to the graph as an ordinary undoable operation
 * WITHOUT recording it into `P` — accepting is not a human edit of those values.)
 */
export function acceptAgentVersion(
  set: ProtectedSetData,
  conflicts: readonly { entries: readonly EntryRef[] }[]
): ProtectedSetData {
  const work = new WorkingSet(set);
  for (const conflict of conflicts) {
    for (const ref of conflict.entries) {
      const entry = work.entries.get(ref.key);
      if (entry && entry.gen === ref.gen) work.entries.delete(ref.key);
    }
  }
  return work.toData(set.gen, set.versions);
}

export function serializeProtectedSet(set: ProtectedSetData): string {
  return `${JSON.stringify(set, null, 2)}\n`;
}

/** Parse `.pix3/protected.json`. Throws on a malformed file (never silently drops protection). */
export function parseProtectedSet(text: string): ProtectedSetData {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw) || raw.format !== PROTECTED_SET_FORMAT) {
    throw new Error('protected set: unsupported format');
  }
  if (typeof raw.gen !== 'number' || !Array.isArray(raw.entries) || !Array.isArray(raw.versions)) {
    throw new Error('protected set: malformed');
  }
  const entries: ProtectedEntry[] = raw.entries.map((item: unknown) => {
    if (
      !isRecord(item) ||
      typeof item.nodeId !== 'string' ||
      !Array.isArray(item.path) ||
      !item.path.every((s: unknown) => typeof s === 'string') ||
      typeof item.gen !== 'number'
    ) {
      throw new Error('protected set: malformed entry');
    }
    const entry: ProtectedEntry = {
      nodeId: item.nodeId,
      path: item.path as string[],
      gen: item.gen,
    };
    if (item.deleted === true) entry.deleted = true;
    else entry.value = item.value;
    return entry;
  });
  const versions: RememberedVersion[] = raw.versions.map((item: unknown) => {
    if (!isRecord(item) || typeof item.hash !== 'string' || typeof item.genAtWrite !== 'number') {
      throw new Error('protected set: malformed version');
    }
    return { hash: item.hash, genAtWrite: item.genAtWrite };
  });
  return { format: PROTECTED_SET_FORMAT, gen: raw.gen, entries, versions };
}
