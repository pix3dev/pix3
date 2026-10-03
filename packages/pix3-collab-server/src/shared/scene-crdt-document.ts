import { parse, stringify } from 'yaml';

/** Flat registers avoid replacing a whole node (or concurrently-created nested Y.Map). */
export const SCENE_FIELD_PREFIX = 'field:';
export const SCENE_DOCUMENT_FORMAT = 2;
export type SceneFields = Map<string, unknown>;

interface SceneNode {
  id: string;
  children?: SceneNode[];
  [key: string]: unknown;
}

interface Position {
  parent: string | null;
  order: number;
}

interface FieldTree {
  value?: unknown;
  children: Map<string, FieldTree>;
}

const ORDER_GAP = 1024;
const ABSENT = Symbol('absent scene field');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function key(path: string[]): string {
  return SCENE_FIELD_PREFIX + JSON.stringify(path);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function readPath(field: string): string[] | null {
  if (!field.startsWith(SCENE_FIELD_PREFIX)) return null;
  try {
    const path: unknown = JSON.parse(field.slice(SCENE_FIELD_PREFIX.length));
    return Array.isArray(path) && path.every(segment => typeof segment === 'string') ? path : null;
  } catch {
    return null;
  }
}

function readPositions(fields: SceneFields): Map<string, Position> {
  const positions = new Map<string, Position>();
  for (const [field, value] of fields) {
    const path = readPath(field);
    if (path?.[0] !== 'exists' || path.length !== 2 || value !== true) continue;
    const id = path[1];
    const parent = fields.get(key(['parent', id]));
    const order = fields.get(key(['order', id]));
    if (
      (parent === null || typeof parent === 'string') &&
      typeof order === 'number' &&
      Number.isFinite(order)
    ) {
      positions.set(id, { parent, order });
    }
  }
  return positions;
}

/**
 * Preserve a longest common subsequence of siblings and rank only inserts/moves. Since IDs are
 * unique, the LCS is the longest increasing subsequence of their old indices (O(n log n)).
 */
function stableOrders(ids: string[], previous: Map<string, number>): Map<string, number> {
  const oldIds = [...previous].sort(([a, ar], [b, br]) => ar - br || compareIds(a, b));
  const oldIndices = new Map(oldIds.map(([id], index) => [id, index]));
  const tails: number[] = [];
  const predecessors = new Map<number, number>();
  for (let i = 0; i < ids.length; i++) {
    const oldIndex = oldIndices.get(ids[i]);
    if (oldIndex === undefined) continue;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (oldIndices.get(ids[tails[middle]])! < oldIndex) low = middle + 1;
      else high = middle;
    }
    if (low > 0) predecessors.set(i, tails[low - 1]);
    tails[low] = i;
  }
  const anchors = new Set<number>();
  let cursor: number | undefined = tails.at(-1);
  while (cursor !== undefined) {
    anchors.add(cursor);
    cursor = predecessors.get(cursor);
  }
  const ranks: number[] = [];
  let leftIndex = -1;
  for (let rightIndex = 0; rightIndex <= ids.length; rightIndex++) {
    if (rightIndex < ids.length && !anchors.has(rightIndex)) continue;
    const left = leftIndex >= 0 ? ranks[leftIndex] : undefined;
    const right = rightIndex < ids.length ? previous.get(ids[rightIndex]) : undefined;
    const count = rightIndex - leftIndex - 1;
    for (let offset = 1; offset <= count; offset++) {
      const fraction = offset / (count + 1);
      ranks[leftIndex + offset] =
        left === undefined
          ? right === undefined
            ? (offset - 1) * ORDER_GAP
            : right - (count + 1 - offset) * ORDER_GAP
          : right === undefined
            ? left + offset * ORDER_GAP
            : left * (1 - fraction) + right * fraction;
    }
    if (right !== undefined) ranks[rightIndex] = right;
    leftIndex = rightIndex;
  }
  // Concurrent insertions can tie ranks; repeated interpolation can exhaust IEEE-754 precision.
  // Reindex only this sibling group when no strictly increasing finite ranks are representable.
  if (
    ranks.some((rank, index) => !Number.isFinite(rank) || (index > 0 && rank <= ranks[index - 1]))
  ) {
    return new Map(ids.map((id, index) => [id, index * ORDER_GAP]));
  }
  return new Map(ids.map((id, index) => [id, ranks[index]]));
}

function flatten(value: unknown, path: string[], fields: SceneFields): void {
  if (value === undefined) return;
  if (isRecord(value)) {
    fields.set(key(path), { kind: 'object' });
    for (const [name, child] of Object.entries(value)) flatten(child, [...path, name], fields);
  } else {
    // Vectors, keyframes and all non-component arrays remain atomic values.
    fields.set(key(path), { kind: 'value', value });
  }
}

function flattenComponents(
  value: unknown,
  nodeId: string,
  fields: SceneFields,
  previous: SceneFields
): void {
  const path = ['node', nodeId, 'components'];
  if (
    !Array.isArray(value) ||
    !value.every(
      component =>
        isRecord(component) && typeof component.id === 'string' && component.id.length > 0
    )
  ) {
    // Older authored scenes may omit component IDs. Preserve these without inventing identity.
    flatten(value, path, fields);
    return;
  }
  const components = value as Array<Record<string, unknown> & { id: string }>;
  const ids = components.map(component => component.id);
  if (new Set(ids).size !== ids.length)
    throw new Error(`Duplicate component IDs on collaborative node '${nodeId}'.`);
  fields.set(key(path), { kind: 'components' });
  const previousOrders = new Map<string, number>();
  for (const id of ids) {
    const membership = previous.get(key([...path, id]));
    const order = previous.get(key(['component-order', nodeId, id]));
    if (
      isRecord(membership) &&
      membership.kind === 'object' &&
      typeof order === 'number' &&
      Number.isFinite(order)
    ) {
      previousOrders.set(id, order);
    }
  }
  const orders = stableOrders(ids, previousOrders);
  for (const component of components) {
    const { id, ...own } = component;
    fields.set(key(['component-order', nodeId, id]), orders.get(id)!);
    flatten(own, [...path, id], fields);
  }
}

export function sceneFieldsFromSnapshot(
  snapshot: string,
  previous: SceneFields = new Map()
): SceneFields {
  const parsed: unknown = parse(snapshot);
  if (!isRecord(parsed) || !Array.isArray(parsed.root))
    throw new Error('Invalid collaborative scene: root is not a list of nodes.');
  const nodes = new Map<string, { node: SceneNode; parent: string | null }>();
  const siblings = new Map<string | null, string[]>();
  const visit = (children: unknown[], parent: string | null): void => {
    const ids: string[] = [];
    siblings.set(parent, ids);
    for (const value of children) {
      if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0)
        throw new Error('Invalid collaborative scene: node has no string id.');
      if (nodes.has(value.id)) throw new Error('Duplicate node IDs in collaborative scene.');
      if (value.children !== undefined && !Array.isArray(value.children))
        throw new Error('Invalid collaborative scene: children is not a list of nodes.');
      const node = value as SceneNode;
      nodes.set(node.id, { node, parent });
      ids.push(node.id);
      if (node.children) visit(node.children, node.id);
    }
  };
  visit(parsed.root, null);
  const previousSiblings = new Map<string | null, Map<string, number>>();
  for (const [id, position] of readPositions(previous)) {
    const group = previousSiblings.get(position.parent) ?? new Map<string, number>();
    group.set(id, position.order);
    previousSiblings.set(position.parent, group);
  }
  const orders = new Map<string, number>();
  for (const [parent, ids] of siblings) {
    for (const [id, order] of stableOrders(ids, previousSiblings.get(parent) ?? new Map()))
      orders.set(id, order);
  }
  const fields: SceneFields = new Map();
  const { root: _root, ...documentFields } = parsed;
  flatten(documentFields, ['document'], fields);
  for (const [id, { node, parent }] of nodes) {
    // Membership, parent and order are independent: editing/reordering a node cannot revive it,
    // and sibling insertions never overwrite a concurrent reparent's destination.
    fields.set(key(['exists', id]), true);
    fields.set(key(['parent', id]), parent);
    fields.set(key(['order', id]), orders.get(id)!);
    const { id: _id, children, components, ...own } = node;
    if (children !== undefined) fields.set(key(['children', id]), true);
    flatten(own, ['node', id], fields);
    flattenComponents(components, id, fields, previous);
  }
  return fields;
}

export function sameSceneField(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function fieldTree(fields: SceneFields): FieldTree {
  const root: FieldTree = { children: new Map() };
  for (const [field, value] of fields) {
    const path = readPath(field);
    if (!path) continue;
    let target = root;
    for (const name of path) {
      let child = target.children.get(name);
      if (!child) {
        child = { children: new Map() };
        target.children.set(name, child);
      }
      target = child;
    }
    target.value = value;
  }
  return root;
}

function readValue(tree: FieldTree | undefined, path: string[], fields: SceneFields): unknown {
  if (!tree || !isRecord(tree.value)) return ABSENT;
  if (tree.value.kind === 'value') return tree.value.value;
  if (tree.value.kind === 'object') {
    const object: Record<string, unknown> = Object.create(null);
    for (const [name, child] of [...tree.children].sort(([a], [b]) => compareIds(a, b))) {
      const value = readValue(child, [...path, name], fields);
      if (value !== ABSENT) object[name] = value;
    }
    return object;
  }
  if (
    tree.value.kind === 'components' &&
    path[0] === 'node' &&
    path.length === 3 &&
    path[2] === 'components'
  ) {
    const components: Array<{ id: string; order: number; value: Record<string, unknown> }> = [];
    for (const [id, child] of tree.children) {
      const value = readValue(child, [...path, id], fields);
      const order = fields.get(key(['component-order', path[1], id]));
      if (isRecord(value) && typeof order === 'number' && Number.isFinite(order))
        components.push({ id, order, value });
    }
    components.sort((a, b) => a.order - b.order || compareIds(a.id, b.id));
    return components.map(({ id, value }) => ({ ...value, id }));
  }
  // An explicit deletion, missing marker, or scalar ancestor masks every descendant register.
  // Never create an object merely because a concurrent child edit remains in the shared map.
  return ABSENT;
}

export function sceneSnapshotFromFields(fields: SceneFields): string {
  const tree = fieldTree(fields);
  const document = readValue(tree.children.get('document'), ['document'], fields);
  const positions = readPositions(fields);
  const nodes = new Map<string, SceneNode>();
  for (const id of positions.keys()) {
    const own = readValue(tree.children.get('node')?.children.get(id), ['node', id], fields);
    const node: SceneNode = { ...(isRecord(own) ? own : {}), id };
    if (fields.get(key(['children', id])) === true) node.children = [];
    nodes.set(id, node);
  }
  // Concurrent moves can form a cycle. Break it at its smallest ID on every replica, without
  // duplicating or dropping nodes. A child of a deleted parent remains hidden with it.
  const resolvedParents = new Map<string, string | null>();
  for (const [id, position] of positions) {
    const chain: string[] = [id];
    let parent = position.parent;
    while (parent !== null && positions.has(parent)) {
      const cycleAt = chain.indexOf(parent);
      if (cycleAt >= 0) {
        resolvedParents.set(chain.slice(cycleAt).sort(compareIds)[0], null);
        break;
      }
      chain.push(parent);
      parent = positions.get(parent)!.parent;
    }
  }
  const root: SceneNode[] = [];
  const sorted = [...positions].sort(([a, pa], [b, pb]) => pa.order - pb.order || compareIds(a, b));
  for (const [id, position] of sorted) {
    const node = nodes.get(id)!;
    const parent = resolvedParents.has(id) ? resolvedParents.get(id)! : position.parent;
    if (parent === null) root.push(node);
    else {
      const parentNode = nodes.get(parent);
      if (parentNode) (parentNode.children ??= []).push(node);
    }
  }
  return stringify({ ...(isRecord(document) ? document : {}), root }, { indent: 2 });
}
