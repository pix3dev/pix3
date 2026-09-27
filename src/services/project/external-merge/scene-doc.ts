/**
 * Plain-object view of a parsed `.pix3scene` for the external-merge engine.
 *
 * The merge works on the YAML document (`version`, `metadata`, `root: [...]`, each node an
 * `{ id, type, name, properties, components, children, ... }` map), never on the live Three.js
 * graph — see `docs/pix3-specification.md` → "Scene File Format" and
 * `packages/pix3-runtime/src/core/SceneLoader.ts` (`SceneNodeDefinition`).
 *
 * Property paths address a location inside ONE node object:
 *   - plain segments are object keys: `['properties', 'transform', 'position']`, `['name']`;
 *   - a segment starting with `@` selects an element of an array by its `id` — used for
 *     components: `['components', '@game-rules', 'config', 'targetScore']`;
 *   - the empty path `[]` means the node's own fields (everything except `id` and `children`);
 *   - `['$tree']` is the node's position in the tree, `{ parent, prevSibling }` (see {@link TREE_PATH}).
 */
import { parse } from 'yaml';

export type PathSegment = string;
export type PropertyPath = readonly PathSegment[];

/**
 * Pseudo-property holding a node's tree position: `{ parent, prevSibling }` — the parent id (null =
 * scene root) and the id of the sibling right before the node (null = first child). Relative to a
 * neighbour rather than an index, so an agent inserting or deleting an unrelated sibling does not
 * read as a move.
 */
export const TREE_SEGMENT = '$tree';
export const TREE_PATH: PropertyPath = [TREE_SEGMENT];

export interface TreePosition {
  parent: string | null;
  prevSibling: string | null;
}

export interface MergeNode {
  id: string;
  children?: MergeNode[];
  [key: string]: unknown;
}

export interface MergeDoc {
  root: MergeNode[];
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

export function isTreePath(path: PropertyPath): boolean {
  return path.length === 1 && path[0] === TREE_SEGMENT;
}

/** Parse `.pix3scene` text into a plain document. Throws on YAML errors. */
export function parseSceneText(text: string): unknown {
  return parse(text) as unknown;
}

export interface DocShapeProblem {
  message: string;
}

/**
 * Structural shape check: `root` is an array of maps, every node has a non-empty string id and a
 * `children` that is an array when present. Id uniqueness is checked separately.
 */
export function checkDocShape(doc: unknown): DocShapeProblem[] {
  const problems: DocShapeProblem[] = [];
  if (!isRecord(doc)) {
    return [{ message: 'scene document is not a map' }];
  }
  if (!Array.isArray(doc.root)) {
    return [{ message: '`root` is not a list of nodes' }];
  }
  const visit = (nodes: unknown[], where: string): void => {
    nodes.forEach((node, index) => {
      const at = `${where}[${index}]`;
      if (!isRecord(node)) {
        problems.push({ message: `${at} is not a node map` });
        return;
      }
      if (typeof node.id !== 'string' || node.id.length === 0) {
        problems.push({ message: `${at} has no string id` });
      }
      if (node.children !== undefined) {
        if (!Array.isArray(node.children)) {
          problems.push({ message: `${at}.children is not a list` });
        } else {
          visit(node.children, `${at}.children`);
        }
      }
    });
  };
  visit(doc.root, 'root');
  return problems;
}

export interface IndexedNode {
  node: MergeNode;
  parentId: string | null;
  index: number;
  depth: number;
}

export interface TreeIndex {
  byId: Map<string, IndexedNode>;
  /** DFS (document) order of ids. */
  order: string[];
  duplicates: string[];
}

export function indexTree(doc: MergeDoc): TreeIndex {
  const byId = new Map<string, IndexedNode>();
  const order: string[] = [];
  const duplicates: string[] = [];
  const visit = (nodes: MergeNode[], parentId: string | null, depth: number): void => {
    nodes.forEach((node, index) => {
      if (byId.has(node.id)) {
        duplicates.push(node.id);
      } else {
        byId.set(node.id, { node, parentId, index, depth });
        order.push(node.id);
      }
      if (Array.isArray(node.children)) {
        visit(node.children, node.id, depth + 1);
      }
    });
  };
  visit(doc.root, null, 0);
  return { byId, order, duplicates };
}

export function collectSubtreeIds(node: MergeNode): string[] {
  const ids: string[] = [node.id];
  for (const child of node.children ?? []) {
    ids.push(...collectSubtreeIds(child));
  }
  return ids;
}

/** Node's own fields: a clone of the node without `id` and `children`. */
export function ownFields(node: MergeNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'id' && key !== 'children') {
      out[key] = deepClone(value);
    }
  }
  return out;
}

export function replaceOwnFields(node: MergeNode, fields: Record<string, unknown>): void {
  for (const key of Object.keys(node)) {
    if (key !== 'id' && key !== 'children') {
      delete node[key];
    }
  }
  for (const [key, value] of Object.entries(fields)) {
    if (key !== 'id' && key !== 'children') {
      node[key] = deepClone(value);
    }
  }
}

export interface ValueLookup {
  present: boolean;
  value: unknown;
}

const ABSENT: ValueLookup = { present: false, value: undefined };

function step(container: unknown, segment: PathSegment): ValueLookup {
  if (segment.startsWith('@')) {
    if (!Array.isArray(container)) return ABSENT;
    const id = segment.slice(1);
    const found = container.find(item => isRecord(item) && item.id === id);
    return found === undefined ? ABSENT : { present: true, value: found };
  }
  if (!isRecord(container) || !Object.prototype.hasOwnProperty.call(container, segment)) {
    return ABSENT;
  }
  const value = container[segment];
  return value === undefined ? ABSENT : { present: true, value };
}

/** Read the value at `path` inside a node (`[]` → own fields). `$tree` is not handled here. */
export function getAtPath(node: MergeNode, path: PropertyPath): ValueLookup {
  if (path.length === 0) {
    return { present: true, value: ownFields(node) };
  }
  let current: ValueLookup = { present: true, value: node };
  for (const segment of path) {
    current = step(current.value, segment);
    if (!current.present) return ABSENT;
  }
  return current;
}

/**
 * Write `value` at `path`, creating intermediate maps. Returns false when the path runs through
 * a missing `@id` array element (the caller must restore that element first) or a non-container.
 */
export function setAtPath(node: MergeNode, path: PropertyPath, value: unknown): boolean {
  if (path.length === 0) {
    if (!isRecord(value)) return false;
    replaceOwnFields(node, value);
    return true;
  }
  let container: unknown = node;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    const next = step(container, segment);
    if (next.present && (isRecord(next.value) || Array.isArray(next.value))) {
      container = next.value;
      continue;
    }
    if (segment.startsWith('@') || !isRecord(container)) return false;
    // Intermediate array for a following `@id` segment, map otherwise.
    const created: unknown = path[i + 1].startsWith('@') ? [] : {};
    container[segment] = created;
    container = created;
  }
  const last = path[path.length - 1];
  if (last.startsWith('@')) {
    if (!Array.isArray(container) || !isRecord(value)) return false;
    const id = last.slice(1);
    const at = container.findIndex(item => isRecord(item) && item.id === id);
    const element = { ...deepClone(value), id };
    if (at >= 0) container[at] = element;
    else container.push(element);
    return true;
  }
  if (!isRecord(container)) return false;
  container[last] = deepClone(value);
  return true;
}

/** Remove the value at `path` (a key, or an `@id` array element). No-op when absent. */
export function deleteAtPath(node: MergeNode, path: PropertyPath): void {
  if (path.length === 0) return;
  let container: unknown = node;
  for (let i = 0; i < path.length - 1; i++) {
    const next = step(container, path[i]);
    if (!next.present) return;
    container = next.value;
  }
  const last = path[path.length - 1];
  if (last.startsWith('@')) {
    if (!Array.isArray(container)) return;
    const id = last.slice(1);
    const at = container.findIndex(item => isRecord(item) && item.id === id);
    if (at >= 0) container.splice(at, 1);
    return;
  }
  if (isRecord(container)) delete container[last];
}

/** Index of an `@id` element inside the array at `arrayPath`, or -1. */
export function indexOfSelector(
  node: MergeNode,
  arrayPath: PropertyPath,
  selector: PathSegment
): number {
  const array = getAtPath(node, arrayPath);
  if (!array.present || !Array.isArray(array.value)) return -1;
  const id = selector.slice(1);
  return array.value.findIndex(item => isRecord(item) && item.id === id);
}

/** Insert an `@id` array element at a given index (clamped), creating the array if needed. */
export function insertSelectorElement(
  node: MergeNode,
  arrayPath: PropertyPath,
  element: Record<string, unknown>,
  index: number
): boolean {
  let array = getAtPath(node, arrayPath);
  if (!array.present) {
    if (!setAtPath(node, arrayPath, [])) return false;
    array = getAtPath(node, arrayPath);
  }
  if (!Array.isArray(array.value)) return false;
  const at = Math.max(0, Math.min(index, array.value.length));
  array.value.splice(at, 0, deepClone(element));
  return true;
}

export function isPathPrefix(prefix: PropertyPath, path: PropertyPath): boolean {
  if (isTreePath(prefix) || isTreePath(path)) return false;
  if (prefix.length > path.length) return false;
  return prefix.every((segment, i) => path[i] === segment);
}

export function describePath(path: PropertyPath): string {
  if (path.length === 0) return '(node)';
  if (isTreePath(path)) return 'tree position';
  return path
    .filter((segment, i) => !(i === 0 && segment === 'properties'))
    .map(segment => (segment.startsWith('@') ? `[${segment.slice(1)}]` : segment))
    .join('.');
}

// ---------------------------------------------------------------------------
// Tree surgery on a MergeDoc (nested children arrays).
// ---------------------------------------------------------------------------

export function siblingsOf(doc: MergeDoc, parentId: string | null): MergeNode[] | null {
  if (parentId === null) return doc.root;
  const parent = indexTree(doc).byId.get(parentId);
  if (!parent) return null;
  if (!Array.isArray(parent.node.children)) parent.node.children = [];
  return parent.node.children;
}

/** Remove a node (with its subtree) from wherever it sits. Returns it, or null when absent. */
export function detachNode(doc: MergeDoc, id: string): MergeNode | null {
  const entry = indexTree(doc).byId.get(id);
  if (!entry) return null;
  const siblings = siblingsOf(doc, entry.parentId);
  if (!siblings) return null;
  const at = siblings.indexOf(entry.node);
  if (at < 0) return null;
  siblings.splice(at, 1);
  return entry.node;
}

export function insertNode(
  doc: MergeDoc,
  parentId: string | null,
  index: number,
  node: MergeNode
): boolean {
  const siblings = siblingsOf(doc, parentId);
  if (!siblings) return false;
  const at = Math.max(0, Math.min(index, siblings.length));
  siblings.splice(at, 0, node);
  return true;
}

/** Ids of the children of `parentId` (null = root) in document order; null when no such parent. */
export function childIdsOf(
  index: TreeIndex,
  doc: MergeDoc,
  parentId: string | null
): string[] | null {
  if (parentId === null) return doc.root.map(n => n.id);
  const parent = index.byId.get(parentId);
  return parent ? (parent.node.children ?? []).map(n => n.id) : null;
}

/** `{ parent, prevSibling }` of a node as it sits in `doc`, or null when absent. */
export function treePositionIn(index: TreeIndex, doc: MergeDoc, id: string): TreePosition | null {
  const entry = index.byId.get(id);
  if (!entry) return null;
  const siblings = childIdsOf(index, doc, entry.parentId) ?? [];
  const at = siblings.indexOf(id);
  return { parent: entry.parentId, prevSibling: at > 0 ? siblings[at - 1] : null };
}
