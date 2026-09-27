/**
 * Operation → `P`: turn one completed human operation into protected-set records by comparing the
 * scene document right before it with the document right after it
 * (`.plans/external-agent-authoring.md` §4.3, "Запись в `P` добавляет каждая завершённая операция
 * человека").
 *
 * Why a document diff and not a per-Operation mapping: the editor has ~90 operations that touch a
 * scene (every Create*, transforms, nudges, align, group, duplicate, prefab ops, component and
 * effect edits, inspector edits, AO bakes, ...). A per-class table would silently leave every
 * operation nobody taught out of `P` — a manual edit the merge would then drop without a banner,
 * which is exactly the loss the promise forbids. Diffing the saved form makes coverage a property
 * of the saver (whatever is saved is protected) and yields the paths in DISK form for free:
 * `position` on a `Node2D` lands at `properties.transform.position`, a component value at
 * `components/@<id>/config/<key>`, exactly where the merge looks for them in the agent's file.
 *
 * Granularity (what one `P` entry covers):
 * - node-level keys (`name`, `type`, `groups`, `instance`, `overrides`) — the whole value;
 *   `metadata` per key;
 * - `properties.<key>` — the whole value, except structural blocks the disk-format descriptor
 *   declares `nested` (`transform`, `layout`, `flow`, ... — `resolveSceneDiskKey`), which go one
 *   level deeper (`properties.transform.position`);
 * - components by id: added → the whole component; removed → `delete-component` tombstone;
 *   changed → `type` / `enabled` whole, `config` per key;
 * - a key present before and absent after → `reset-property` tombstone;
 * - nodes: new → `create-node` (snapshot without children that already existed — those are
 *   recorded as moves); gone → `delete-node` with every removed id (the whole subtree);
 *   re-parented, or reordered relative to its surviving siblings (LCS, so inserting or deleting a
 *   neighbour does not read as a move) → `move-node` with the node's actual `prevSibling`.
 *
 * Pure: no DOM, no graph — two plain documents in, `HumanOperation[]` out (empty = nothing to
 * record; the caller must then NOT bump the generation).
 */
import { getSceneNodeDiskFormat, resolveSceneDiskKey, resolveSceneNodeType } from '@pix3/runtime';
import type { HumanOperation } from './protected-set';
import {
  deepClone,
  indexTree,
  isRecord,
  type MergeDoc,
  type MergeNode,
  type PropertyPath,
  type TreeIndex,
} from './scene-doc';

const STRUCTURAL_NODE_KEYS = new Set(['id', 'children', 'properties', 'components']);

export function diffSceneDocuments(before: MergeDoc, after: MergeDoc): HumanOperation[] {
  const bIndex = indexTree(before);
  const aIndex = indexTree(after);
  const ops: HumanOperation[] = [];

  // --- Removed nodes: one delete-node with every id that is gone (subtrees included). -------
  const removed = bIndex.order.filter(id => !aIndex.byId.has(id));
  if (removed.length > 0) {
    ops.push({ kind: 'delete-node', nodeIds: removed });
  }

  // --- Created nodes: the top-most new node of each new subtree. -----------------------------
  for (const id of aIndex.order) {
    if (bIndex.byId.has(id)) continue;
    const entry = aIndex.byId.get(id)!;
    if (entry.parentId !== null && !bIndex.byId.has(entry.parentId)) continue;
    ops.push({
      kind: 'create-node',
      node: snapshotNewSubtree(entry.node, bIndex),
      parentId: entry.parentId,
      prevSiblingId: prevSiblingIn(aIndex, after, id),
    });
  }

  // --- Moves among nodes present on both sides. ---------------------------------------------
  const moved = new Set<string>();
  for (const id of aIndex.order) {
    const b = bIndex.byId.get(id);
    const a = aIndex.byId.get(id)!;
    if (b && b.parentId !== a.parentId) moved.add(id);
  }
  const parents = new Set<string | null>([null, ...aIndex.order]);
  for (const parentId of parents) {
    const afterIds = childIds(aIndex, after, parentId).filter(id => {
      const b = bIndex.byId.get(id);
      return b !== undefined && b.parentId === parentId;
    });
    if (afterIds.length < 2) continue;
    const beforeIds = childIds(bIndex, before, parentId).filter(id => afterIds.includes(id));
    const keep = new Set(longestCommonSubsequence(beforeIds, afterIds));
    for (const id of afterIds) {
      if (!keep.has(id)) moved.add(id);
    }
  }
  for (const id of aIndex.order) {
    if (!moved.has(id)) continue;
    ops.push({
      kind: 'move-node',
      nodeId: id,
      parentId: aIndex.byId.get(id)!.parentId,
      prevSiblingId: prevSiblingIn(aIndex, after, id),
    });
  }

  // --- Field changes of nodes present on both sides. ----------------------------------------
  for (const id of aIndex.order) {
    const b = bIndex.byId.get(id);
    if (!b) continue;
    diffNodeFields(id, b.node, aIndex.byId.get(id)!.node, ops);
  }

  return ops;
}

function diffNodeFields(
  nodeId: string,
  before: MergeNode,
  after: MergeNode,
  ops: HumanOperation[]
): void {
  // Node-level keys.
  const keys = unionKeys(before, after).filter(k => !STRUCTURAL_NODE_KEYS.has(k));
  for (const key of keys) {
    if (key === 'metadata' && isRecord(before[key]) && isRecord(after[key])) {
      diffRecordLeaves(nodeId, ['metadata'], before[key], after[key], ops);
      continue;
    }
    diffLeaf(nodeId, [key], before[key], after[key], ops);
  }

  // properties.
  const bProps = isRecord(before.properties) ? before.properties : {};
  const aProps = isRecord(after.properties) ? after.properties : {};
  const nestedKeys = nestedPropertyKeys(after.type ?? before.type);
  for (const key of unionKeys(bProps, aProps)) {
    const bv = bProps[key];
    const av = aProps[key];
    if (nestedKeys.has(key) && isRecord(bv) && isRecord(av)) {
      diffRecordLeaves(nodeId, ['properties', key], bv, av, ops);
      continue;
    }
    diffLeaf(nodeId, ['properties', key], bv, av, ops);
  }

  // components.
  const bComponents = componentsById(before.components);
  const aComponents = componentsById(after.components);
  for (const [componentId, bc] of bComponents) {
    const ac = aComponents.get(componentId);
    if (!ac) {
      ops.push({ kind: 'delete-component', nodeId, componentId });
      continue;
    }
    const base: PropertyPath = ['components', `@${componentId}`];
    for (const key of unionKeys(bc, ac)) {
      if (key === 'id') continue;
      if (key === 'config') {
        const bConfig = isRecord(bc.config) ? bc.config : {};
        const aConfig = isRecord(ac.config) ? ac.config : {};
        diffRecordLeaves(nodeId, [...base, 'config'], bConfig, aConfig, ops);
        continue;
      }
      diffLeaf(nodeId, [...base, key], bc[key], ac[key], ops);
    }
  }
  for (const [componentId, ac] of aComponents) {
    if (bComponents.has(componentId)) continue;
    const value: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(ac)) {
      if (key !== 'id') value[key] = deepClone(v);
    }
    ops.push({
      kind: 'set-property',
      nodeId,
      path: ['components', `@${componentId}`],
      value,
    });
  }
}

function diffRecordLeaves(
  nodeId: string,
  base: PropertyPath,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  ops: HumanOperation[]
): void {
  for (const key of unionKeys(before, after)) {
    diffLeaf(nodeId, [...base, key], before[key], after[key], ops);
  }
}

function diffLeaf(
  nodeId: string,
  path: PropertyPath,
  before: unknown,
  after: unknown,
  ops: HumanOperation[]
): void {
  if (sameValue(before, after)) return;
  if (after === undefined) {
    ops.push({ kind: 'reset-property', nodeId, path });
    return;
  }
  ops.push({ kind: 'set-property', nodeId, path, value: deepClone(after) });
}

/** Keys the disk-format descriptor declares structural (`nested`) for this node type. */
function nestedPropertyKeys(type: unknown): Set<string> {
  const canonical =
    typeof type === 'string' ? (resolveSceneNodeType(type) ?? type) : ('Group' as const);
  const format = getSceneNodeDiskFormat(canonical);
  const keys = new Set<string>();
  if (!format) return keys;
  for (const key of Object.keys(format.extras)) {
    const resolution = resolveSceneDiskKey(format, [], key);
    if (resolution.kind === 'extra' && resolution.rule.nested) keys.add(key);
  }
  return keys;
}

function componentsById(value: unknown): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (isRecord(item) && typeof item.id === 'string' && item.id.length > 0) {
      out.set(item.id, item);
    }
  }
  return out;
}

/** Snapshot of a new node with only its NEW descendants (existing ones are recorded as moves). */
function snapshotNewSubtree(node: MergeNode, before: TreeIndex): MergeNode {
  const copy: MergeNode = { ...deepClone({ ...node, children: undefined }), id: node.id };
  delete copy.children;
  const children = (node.children ?? [])
    .filter(child => !before.byId.has(child.id))
    .map(child => snapshotNewSubtree(child, before));
  if (children.length > 0) copy.children = children;
  return copy;
}

function childIds(index: TreeIndex, doc: MergeDoc, parentId: string | null): string[] {
  if (parentId === null) return doc.root.map(n => n.id);
  return (index.byId.get(parentId)?.node.children ?? []).map(n => n.id);
}

function prevSiblingIn(index: TreeIndex, doc: MergeDoc, id: string): string | null {
  const entry = index.byId.get(id);
  if (!entry) return null;
  const siblings = childIds(index, doc, entry.parentId);
  const at = siblings.indexOf(id);
  return at > 0 ? siblings[at - 1] : null;
}

function longestCommonSubsequence(a: readonly string[], b: readonly string[]): string[] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(a[i]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

function unionKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
}

/** Exact structural equality (key order ignored); `undefined` members count as absent. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameValue(item, b[i]))
    );
  }
  if (isRecord(a) && isRecord(b)) {
    return unionKeys(a, b).every(k => sameValue(a[k], b[k]));
  }
  return Object.is(a, b);
}

/** A saved document as a plain JSON value (`undefined` members dropped, as YAML would). */
export function toMergeDoc(document: unknown): MergeDoc {
  const plain = JSON.parse(JSON.stringify(document ?? { root: [] })) as unknown;
  if (!isRecord(plain) || !Array.isArray(plain.root)) {
    return { root: [] };
  }
  return plain as MergeDoc;
}
