/**
 * External scene version merge — plan `.plans/external-agent-authoring.md` §4.3
 * ("Редактор — полноправный соавтор"), the "Таблица разбора внешней версии `A`".
 *
 * INVARIANT: protection lives until an EVENT — a human decision ("Accept agent's version",
 * `acceptAgentVersion`) or an agent ack of a version the editor knows (`applyAcks`) — and is NEVER
 * lifted by an inference from values. The agent writing the same value the human set is not a
 * read event (it may have picked the round number itself and revert it on its next write), and
 * the merge never moves a base forward. So this function never removes an entry from `P`.
 *
 * Inputs: `E` (last version the editor wrote/accepted), `A` (the external version, parsed),
 * `P` (the protected set) and the pending acks. Per property the only question is "is it in `P`":
 *
 *   | p ∈ P | A.p      | result                                                        |
 *   |-------|----------|---------------------------------------------------------------|
 *   | no    | anything | A.p, silently                                                 |
 *   | yes   | == P[p]  | accepted without conflict, p STAYS in P                       |
 *   | yes   | != P[p]  | conflict: P[p] kept, p stays in P, reported + merge-log       |
 *   | yes   | == E.p   | (and != P[p]) P[p] kept, p stays in P, NO conflict: the agent  |
 *   |       |          | carried the file as it was on disk; logged as                 |
 *   |       |          | `human-unchanged-by-agent`. With no E, the row above applies.  |
 *
 * Structure: a node not in P and absent from A is deleted silently; a new node in A without a
 * tombstone is added; a protected node absent from A is restored (from its creation snapshot or
 * from E) with a conflict; a tombstoned node present in A stays deleted (silently when A has it
 * exactly as E did, with a conflict otherwise); a moved node keeps the human position (silently
 * when A still has E's position); tree positions are `{ parent, prevSibling }`; an
 * ancestor the agent deleted above a protected node comes back as the MINIMAL chain from E; after
 * the merge `M` must be a valid graph (unique ids, every node placed), otherwise the whole scene is
 * `rejected` and `M` is not produced.
 *
 * Pure and DOM-free: operates on the parsed `.pix3scene` document, not the Three.js graph.
 * Equality goes through `value-equality.ts` (normalized values); "changed at all" is the byte hash
 * in `hash.ts` and is the caller's business.
 */
import {
  applyAcks,
  entryKey,
  isNodeTombstone,
  isTombstone,
  recordEditorWrite,
  type AckOutcome,
  type EntryRef,
  type ProtectedEntry,
  type ProtectedSetData,
} from './protected-set';
import {
  checkDocShape,
  childIdsOf,
  collectSubtreeIds,
  deepClone,
  deleteAtPath,
  describePath,
  detachNode,
  getAtPath,
  indexOfSelector,
  indexTree,
  insertNode,
  insertSelectorElement,
  isRecord,
  isTreePath,
  ownFields,
  replaceOwnFields,
  setAtPath,
  treePositionIn,
  type IndexedNode,
  type MergeDoc,
  type MergeNode,
  type PathSegment,
  type PropertyPath,
  type TreeIndex,
  type TreePosition,
} from './scene-doc';
import { valuesEqualAtPath, type PropertyTypeResolver } from './value-equality';

export type MergeStatus = 'clean' | 'conflicts' | 'rejected';

export type ConflictKind =
  /** p ∈ P and A.p != P[p]: the human's value was kept. */
  | 'property'
  /** A tombstoned property/component (human reset/removed it) is present in A: kept removed. */
  | 'removed-restored'
  /** The agent removed a component the human edited: restored from E with the human's values. */
  | 'component-deleted'
  /** A node the human created differs in A: the human's snapshot was kept. */
  | 'node-fields'
  /** The agent deleted a node the human edited or created: it was restored. */
  | 'node-deleted'
  /** The agent deleted an ancestor of a protected node: the minimal ancestor chain was restored. */
  | 'ancestor-deleted'
  /** A tombstoned node (human deleted it) is present in A: it stays deleted. */
  | 'node-resurrected'
  /** The tree position (parent + index) differs from the human's: the human's was kept. */
  | 'moved'
  /** A protected value could not be placed into M (no base to restore it onto); it stays in P. */
  | 'unrestorable'
  /** Whole-scene conflict: A is malformed or M would be an invalid graph. Status `rejected`. */
  | 'invalid-graph';

export interface MergeConflict {
  /** Stable id: `${kind}:${entryKey}`. */
  id: string;
  kind: ConflictKind;
  nodeId: string | null;
  path: PathSegment[] | null;
  message: string;
  /** The value that stayed (the human's). Absent for tombstones. */
  humanValue?: unknown;
  /** The value the agent wrote — what "Accept agent's version" applies. */
  agentValue?: unknown;
  agentPresent: boolean;
  /**
   * Informational only (does not change the table): whether A's value differs from E's, i.e. the
   * agent actively wrote something else rather than carrying a copy of the pre-edit file. Undefined
   * when E does not have the node.
   */
  agentChanged?: boolean;
  /** Nodes involved (the subtree for structural conflicts). */
  nodeIds: string[];
  /** The P entries "Accept agent's version" releases (see `acceptAgentVersion`). */
  entries: EntryRef[];
}

export interface MergeDecision {
  nodeId: string;
  path: PathSegment[];
  label: string;
  /**
   * `human`: conflict, human value kept. `agent-equal`: A agrees with P. `human-unchanged-by-agent`:
   * A differs from P but equals E (the agent carried the on-disk file), human value kept silently.
   */
  kept: 'human' | 'agent-equal' | 'human-unchanged-by-agent';
}

export type MergeLogEntry =
  | { event: 'ack-applied'; hash: string; genAtWrite: number; released: string[] }
  | { event: 'ack-unknown'; hash: string }
  | {
      event: 'merge';
      file: string | null;
      status: MergeStatus;
      decisions: MergeDecision[];
      conflicts: { id: string; kind: ConflictKind; message: string }[];
      /** Hash of M as written; the caller stamps it via `stampMergedHash` after the write. */
      mergedHash: string | null;
      /** Keys of every entry in P after the merge. */
      protected: string[];
      problems?: string[];
    };

export interface MergeInput {
  /** E: the last version the editor wrote or accepted (parsed), or null if none yet. */
  editorVersion: MergeDoc | null;
  /** A: the external version, parsed (validated here). */
  externalVersion: unknown;
  protectedSet: ProtectedSetData;
  /** Hashes from `.pix3/ack.json`. One-shot: the caller deletes those in `consumedAcks`. */
  acks?: readonly string[];
  /** Byte hash of A. Remembered as an accepted version only when the merge is clean AND M == A. */
  externalHash?: string;
  file?: string;
  typeResolver?: PropertyTypeResolver;
}

export interface MergeResult {
  status: MergeStatus;
  /** M; null when rejected. */
  merged: MergeDoc | null;
  /**
   * M is identical to A (normalized structure). False even for a `clean` merge when a human value
   * was kept silently (`human-unchanged-by-agent`) — the caller must then write M.
   */
  mergedEqualsExternal: boolean;
  protectedSet: ProtectedSetData;
  conflicts: MergeConflict[];
  mergeLog: MergeLogEntry[];
  consumedAcks: string[];
}

class Rejection extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
  }
}

function nodeLabel(node: MergeNode | undefined, id: string): string {
  const name = node && typeof node.name === 'string' && node.name.length > 0 ? node.name : id;
  return `"${name}"`;
}

function nodeTypeOf(node: MergeNode | undefined): string | undefined {
  return node && typeof node.type === 'string' ? node.type : undefined;
}

function refOf(entry: ProtectedEntry): EntryRef {
  return { key: entryKey(entry.nodeId, entry.path), gen: entry.gen };
}

function asTreePosition(value: unknown): TreePosition | null {
  if (!isRecord(value)) return null;
  if (value.parent !== null && typeof value.parent !== 'string') return null;
  if (value.prevSibling !== null && typeof value.prevSibling !== 'string') return null;
  return { parent: value.parent, prevSibling: value.prevSibling };
}

/** Structural equality, key order ignored (arrays ordered). */
function sameStructure(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameStructure(item, b[i]))
    );
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every(k => sameStructure(a[k], b[k]));
  }
  return Object.is(a, b);
}

export function mergeExternalVersion(input: MergeInput): MergeResult {
  try {
    return mergeOrThrow(input);
  } catch (error) {
    if (!(error instanceof Rejection)) throw error;
    const conflict: MergeConflict = {
      id: 'invalid-graph:scene',
      kind: 'invalid-graph',
      nodeId: null,
      path: null,
      message: `The external version cannot be merged (${error.problems.join('; ')}); the scene was left as it was.`,
      agentPresent: true,
      nodeIds: [],
      entries: [],
    };
    return {
      status: 'rejected',
      merged: null,
      mergedEqualsExternal: false,
      protectedSet: input.protectedSet,
      conflicts: [conflict],
      mergeLog: [
        {
          event: 'merge',
          file: input.file ?? null,
          status: 'rejected',
          decisions: [],
          conflicts: [{ id: conflict.id, kind: conflict.kind, message: conflict.message }],
          mergedHash: null,
          protected: input.protectedSet.entries.map(e => entryKey(e.nodeId, e.path)),
          problems: error.problems,
        },
      ],
      // A rejected merge changes nothing, so pending acks stay for the next attempt.
      consumedAcks: [],
    };
  }
}

function checkGraph(doc: unknown): MergeDoc {
  const problems = checkDocShape(doc).map(p => p.message);
  if (problems.length > 0) throw new Rejection(problems);
  const typed = doc as MergeDoc;
  const duplicates = indexTree(typed).duplicates;
  if (duplicates.length > 0) {
    throw new Rejection([`duplicate node id(s): ${[...new Set(duplicates)].join(', ')}`]);
  }
  return typed;
}

function mergeOrThrow(input: MergeInput): MergeResult {
  const resolver = input.typeResolver;
  const A = checkGraph(input.externalVersion);
  const aIndex = indexTree(A);
  const E = input.editorVersion;
  const eIndex: TreeIndex | null = E ? indexTree(E) : null;

  // --- Exit 2: acks, before anything is compared. -----------------------------------------
  const acks = input.acks ?? [];
  const { set: P, outcomes } = applyAcks(input.protectedSet, acks);
  const mergeLog: MergeLogEntry[] = outcomes.map(
    (o: AckOutcome): MergeLogEntry =>
      o.known
        ? {
            event: 'ack-applied',
            hash: o.hash,
            genAtWrite: o.genAtWrite ?? 0,
            released: o.released,
          }
        : { event: 'ack-unknown', hash: o.hash }
  );

  const conflicts: MergeConflict[] = [];
  const decisions: MergeDecision[] = [];
  const M: MergeDoc = deepClone(A);

  const byNode = new Map<string, ProtectedEntry[]>();
  for (const entry of P.entries) {
    const list = byNode.get(entry.nodeId) ?? [];
    list.push(entry);
    byNode.set(entry.nodeId, list);
  }
  const tombstonedNodes = new Set(P.entries.filter(isNodeTombstone).map(e => e.nodeId));
  /** Nodes the human edited or created (anything but a node tombstone). */
  const protectedNodes = new Set(P.entries.filter(e => !isNodeTombstone(e)).map(e => e.nodeId));
  const entriesOf = (id: string): ProtectedEntry[] =>
    (byNode.get(id) ?? []).filter(e => !isNodeTombstone(e));
  const liveEntry = (
    id: string,
    match: (e: ProtectedEntry) => boolean
  ): ProtectedEntry | undefined => entriesOf(id).find(e => !isTombstone(e) && match(e));
  const snapshotEntry = (id: string) => liveEntry(id, e => e.path.length === 0);
  const treeEntry = (id: string) => liveEntry(id, e => isTreePath(e.path));
  const eNode = (id: string): IndexedNode | undefined => eIndex?.byId.get(id);

  // --- Position helpers ({ parent, prevSibling }). ----------------------------------------
  const positionInE = (id: string): TreePosition | null =>
    E && eIndex ? treePositionIn(eIndex, E, id) : null;
  type Resolved = { kind: 'at'; prev: string | null } | { kind: 'wait' } | { kind: 'unknown' };
  /**
   * Resolve `want.prevSibling` against a doc: the nearest id at or before it — walking back through
   * E's sibling order when it no longer exists there — that sits under `want.parent`.
   * `wait`: the chain runs through a node still waiting to be placed; `unknown`: not resolvable.
   */
  const resolvePrev = (
    want: TreePosition,
    selfId: string,
    index: TreeIndex,
    pending?: ReadonlyMap<string, unknown>
  ): Resolved => {
    let current = want.prevSibling;
    const seen = new Set<string>();
    while (current !== null) {
      if (seen.has(current)) return { kind: 'unknown' };
      seen.add(current);
      if (current !== selfId) {
        if (pending?.has(current)) return { kind: 'wait' };
        const found = index.byId.get(current);
        if (found && found.parentId === want.parent) return { kind: 'at', prev: current };
      }
      const inE = positionInE(current);
      if (!inE) return { kind: 'unknown' };
      current = inE.prevSibling;
    }
    return { kind: 'at', prev: null };
  };
  /** Does the node sit at `want` in A? Siblings the agent newly added (not in E) are skipped. */
  const matchesInA = (id: string, want: TreePosition): boolean => {
    const entry = aIndex.byId.get(id);
    if (!entry || entry.parentId !== want.parent) return false;
    const resolved = resolvePrev(want, id, aIndex);
    if (resolved.kind !== 'at') return false;
    const siblings = childIdsOf(aIndex, A, entry.parentId) ?? [];
    let effective: string | null = null;
    for (let i = siblings.indexOf(id) - 1; i >= 0; i--) {
      const sibling = siblings[i];
      const agentNew =
        eIndex !== null &&
        !eIndex.byId.has(sibling) &&
        !protectedNodes.has(sibling) &&
        sibling !== resolved.prev;
      if (!agentNew) {
        effective = sibling;
        break;
      }
    }
    return effective === resolved.prev;
  };
  /** A's subtree at `id` equals E's (own fields, child ids, recursively) and sits under the same parent. */
  const unchangedFromE = (id: string): boolean => {
    const a = aIndex.byId.get(id);
    const e = eIndex?.byId.get(id);
    if (!a || !e || a.parentId !== e.parentId) return false;
    const same = (an: MergeNode, en: MergeNode): boolean => {
      if (!valuesEqualAtPath([], ownFields(an), ownFields(en), nodeTypeOf(an), resolver)) {
        return false;
      }
      const ac = an.children ?? [];
      const ec = en.children ?? [];
      return ac.length === ec.length && ac.every((c, i) => c.id === ec[i].id && same(c, ec[i]));
    };
    return same(a.node, e.node);
  };

  // --- Tombstoned nodes present in A stay deleted. ----------------------------------------
  for (const id of aIndex.order) {
    if (!tombstonedNodes.has(id)) continue;
    const current = indexTree(M).byId.get(id);
    if (!current) continue; // already removed with a tombstoned ancestor
    const removed = detachNode(M, id);
    if (!removed) continue;
    const subtree = collectSubtreeIds(removed);
    if (unchangedFromE(id)) {
      // The agent carried the pre-deletion file; the deletion simply had not reached disk.
      decisions.push({
        nodeId: id,
        path: [],
        label: nodeLabel(removed, id),
        kept: 'human-unchanged-by-agent',
      });
      continue;
    }
    decisions.push({ nodeId: id, path: [], label: nodeLabel(removed, id), kept: 'human' });
    conflicts.push({
      id: `node-resurrected:${entryKey(id, [])}`,
      kind: 'node-resurrected',
      nodeId: id,
      path: [],
      message: `Agent restored node ${nodeLabel(removed, id)} you deleted; it stays deleted.`,
      agentValue: deepClone(removed),
      agentPresent: true,
      agentChanged: eIndex ? true : undefined,
      nodeIds: subtree,
      entries: subtree
        .filter(n => tombstonedNodes.has(n))
        .flatMap(n => (byNode.get(n) ?? []).filter(isNodeTombstone).map(refOf)),
    });
  }

  // --- Restore protected nodes the agent deleted, and apply tree positions. ---------------
  let mIndex = indexTree(M);
  const sourceFields = (id: string): Record<string, unknown> | null => {
    const snapshot = snapshotEntry(id);
    if (snapshot && isRecord(snapshot.value)) return deepClone(snapshot.value);
    const fromE = eNode(id);
    return fromE ? ownFields(fromE.node) : null;
  };
  const desiredPosition = (id: string): TreePosition | null => {
    const tree = treeEntry(id);
    if (tree) return asTreePosition(tree.value);
    return positionInE(id);
  };

  const restored = new Map<string, MergeNode>();
  const restoreOrder = [...(eIndex?.order ?? []), ...P.entries.map(e => e.nodeId)].filter(
    (id, i, all) => all.indexOf(id) === i
  );
  for (const id of restoreOrder) {
    if (!protectedNodes.has(id) || tombstonedNodes.has(id) || mIndex.byId.has(id)) continue;
    // Walk up and restore every missing ancestor (from E) — the minimal chain.
    let current: string | null = id;
    while (current !== null && !mIndex.byId.has(current) && !restored.has(current)) {
      if (tombstonedNodes.has(current)) {
        throw new Rejection([
          `protected node ${id} would have to be restored under ${current}, which you deleted`,
        ]);
      }
      const fields = sourceFields(current);
      const position = desiredPosition(current);
      if (!fields || !position) {
        throw new Rejection([`protected node ${current} is missing and has no version to restore`]);
      }
      restored.set(current, { ...fields, id: current, children: [] });
      current = position.parent;
    }
  }

  // Nodes present in A whose tree position is protected: compare, and re-place when it differs.
  const moved: string[] = mIndex.order.filter(id => protectedNodes.has(id) && treeEntry(id));
  const replaced: string[] = [];
  for (const id of moved) {
    const tree = treeEntry(id);
    const want = tree ? asTreePosition(tree.value) : null;
    if (!tree || !want) continue;
    if (matchesInA(id, want)) {
      decisions.push({
        nodeId: id,
        path: [...tree.path],
        label: 'tree position',
        kept: 'agent-equal',
      });
      continue;
    }
    replaced.push(id);
    const fromE = positionInE(id);
    if (fromE && matchesInA(id, fromE)) {
      // A still has the position E had: the human's move had not reached disk yet.
      decisions.push({
        nodeId: id,
        path: [...tree.path],
        label: 'tree position',
        kept: 'human-unchanged-by-agent',
      });
      continue;
    }
    const node = aIndex.byId.get(id)?.node;
    decisions.push({ nodeId: id, path: [...tree.path], label: 'tree position', kept: 'human' });
    conflicts.push({
      id: `moved:${entryKey(id, tree.path)}`,
      kind: 'moved',
      nodeId: id,
      path: [...tree.path],
      message: `Agent moved ${nodeLabel(node, id)}, which you placed yourself; your position was kept.`,
      humanValue: want,
      agentValue: treePositionIn(aIndex, A, id),
      agentPresent: true,
      agentChanged: fromE ? true : undefined,
      nodeIds: [id],
      entries: [refOf(tree)],
    });
  }

  const pool = new Map<string, MergeNode>(restored);
  for (const id of replaced) {
    const node = detachNode(M, id);
    if (node) pool.set(id, node);
  }
  mIndex = indexTree(M);
  // Insert in rounds: a node goes in once its parent and its preceding sibling are placed.
  while (pool.size > 0) {
    let progress = false;
    for (const id of [...pool.keys()]) {
      const position = desiredPosition(id);
      if (!position) throw new Rejection([`node ${id} has no position to restore`]);
      if (position.parent !== null && !mIndex.byId.has(position.parent)) continue;
      const resolved = resolvePrev(position, id, mIndex, pool);
      if (resolved.kind === 'wait') continue;
      const siblings = childIdsOf(mIndex, M, position.parent) ?? [];
      const at =
        resolved.kind === 'unknown'
          ? siblings.length
          : resolved.prev === null
            ? 0
            : siblings.indexOf(resolved.prev) + 1;
      const node = pool.get(id);
      if (!node || !insertNode(M, position.parent, at, node)) {
        throw new Rejection([`cannot place node ${id}`]);
      }
      pool.delete(id);
      mIndex = indexTree(M);
      progress = true;
    }
    if (!progress) {
      throw new Rejection([
        `tree positions form a cycle or point at missing parents: ${[...pool.keys()].join(', ')}`,
      ]);
    }
  }

  // Structural conflicts for restored nodes, grouped by the topmost restored ancestor.
  const topOf = (id: string): string => {
    let top = id;
    let parent = desiredPosition(id)?.parent ?? null;
    while (parent !== null && restored.has(parent)) {
      top = parent;
      parent = desiredPosition(parent)?.parent ?? null;
    }
    return top;
  };
  const groups = new Map<string, string[]>();
  for (const id of [...restored.keys(), ...moved]) {
    const top = topOf(id);
    if (!restored.has(top)) continue; // a moved node under a present parent: handled above
    const list = groups.get(top) ?? [];
    list.push(id);
    groups.set(top, list);
  }
  const docOrder = new Map(mIndex.order.map((id, i) => [id, i]));
  for (const [top, unordered] of groups) {
    const members = [...unordered].sort((a, b) => (docOrder.get(a) ?? 0) - (docOrder.get(b) ?? 0));
    const protectedMembers = members.filter(m => protectedNodes.has(m));
    const topNode = restored.get(top);
    const edits = protectedMembers
      .flatMap(m =>
        entriesOf(m)
          .filter(e => !isTreePath(e.path) || !moved.includes(m))
          .map(e => `${eNode(m)?.node.name ?? restored.get(m)?.name ?? m}.${describePath(e.path)}`)
      )
      .join(', ');
    const selfProtected = protectedNodes.has(top);
    conflicts.push({
      id: `${selfProtected ? 'node-deleted' : 'ancestor-deleted'}:${entryKey(top, [])}`,
      kind: selfProtected ? 'node-deleted' : 'ancestor-deleted',
      nodeId: top,
      path: [],
      message: selfProtected
        ? `Agent deleted ${nodeLabel(topNode, top)}, which you changed (${edits}); it was kept.`
        : `Agent deleted ${nodeLabel(topNode, top)}, which contains your edits (${edits}); ${nodeLabel(topNode, top)} was kept.`,
      agentPresent: false,
      nodeIds: members,
      // Accepting = let the agent's deletion stand: release every entry of the protected members.
      entries: protectedMembers.flatMap(m => entriesOf(m).map(refOf)),
    });
  }

  // --- Property entries: the table. -------------------------------------------------------
  for (const entry of P.entries) {
    if (isNodeTombstone(entry) || isTreePath(entry.path)) continue;
    const target = mIndex.byId.get(entry.nodeId)?.node;
    if (!target) continue; // only possible for tombstoned-subtree leftovers; nothing to apply
    const wasRestored = restored.has(entry.nodeId);
    const agentNode = aIndex.byId.get(entry.nodeId)?.node;
    const editorNode = eNode(entry.nodeId)?.node;
    const nodeType = nodeTypeOf(agentNode) ?? nodeTypeOf(target);
    const agent = agentNode
      ? getAtPath(agentNode, entry.path)
      : { present: false, value: undefined };
    const label = `${nodeLabel(target, entry.nodeId)}.${describePath(entry.path)}`;
    const agentChanged = editorNode
      ? (() => {
          const inE = getAtPath(editorNode, entry.path);
          if (inE.present !== agent.present) return true;
          return (
            inE.present &&
            !valuesEqualAtPath(entry.path, inE.value, agent.value, nodeType, resolver)
          );
        })()
      : undefined;
    /** A.p == E.p: the agent carried the file as it was on disk (no E node → literal table). */
    const agentKeptE = agentChanged === false && !wasRestored;

    if (isTombstone(entry)) {
      const inM = getAtPath(target, entry.path);
      if (inM.present) deleteAtPath(target, entry.path);
      if (!agent.present) {
        decisions.push({ nodeId: entry.nodeId, path: [...entry.path], label, kept: 'agent-equal' });
        continue;
      }
      if (agentKeptE) {
        decisions.push({
          nodeId: entry.nodeId,
          path: [...entry.path],
          label,
          kept: 'human-unchanged-by-agent',
        });
        continue;
      }
      decisions.push({ nodeId: entry.nodeId, path: [...entry.path], label, kept: 'human' });
      if (!wasRestored) {
        conflicts.push({
          id: `removed-restored:${entryKey(entry.nodeId, entry.path)}`,
          kind: 'removed-restored',
          nodeId: entry.nodeId,
          path: [...entry.path],
          message: `Agent restored ${label}, which you removed; it stays removed.`,
          agentValue: deepClone(agent.value),
          agentPresent: true,
          agentChanged,
          nodeIds: [entry.nodeId],
          entries: [refOf(entry)],
        });
      }
      continue;
    }

    const equal =
      agent.present && valuesEqualAtPath(entry.path, agent.value, entry.value, nodeType, resolver);
    if (equal && !wasRestored) {
      // Accepted without conflict — and the entry STAYS in P (equality is not a read event).
      decisions.push({ nodeId: entry.nodeId, path: [...entry.path], label, kept: 'agent-equal' });
      continue;
    }
    let kind: ConflictKind = entry.path.length === 0 ? 'node-fields' : 'property';
    if (entry.path.length === 0) {
      if (isRecord(entry.value)) replaceOwnFields(target, entry.value);
    } else if (!setAtPath(target, entry.path, entry.value)) {
      // The path runs through an `@id` element the agent removed (a component): restore it from E.
      if (restoreSelectorFromE(target, editorNode, entry.path)) {
        kind = 'component-deleted';
        setAtPath(target, entry.path, entry.value);
      } else {
        kind = 'unrestorable';
      }
    }
    if (agentKeptE && (kind === 'property' || kind === 'node-fields')) {
      decisions.push({
        nodeId: entry.nodeId,
        path: [...entry.path],
        label,
        kept: 'human-unchanged-by-agent',
      });
      continue;
    }
    decisions.push({ nodeId: entry.nodeId, path: [...entry.path], label, kept: 'human' });
    if (wasRestored && kind !== 'unrestorable') continue; // covered by the structural conflict
    const message =
      kind === 'unrestorable'
        ? `Your edit to ${label} could not be applied to the agent's version (its container is gone); it is kept protected.`
        : kind === 'component-deleted'
          ? `Agent removed the component holding ${label}, which you edited; it was kept.`
          : kind === 'node-fields'
            ? `Agent changed ${nodeLabel(target, entry.nodeId)}, which you created; your version was kept.`
            : `Agent changed ${label}, which you edited; your value was kept.`;
    conflicts.push({
      id: `${kind}:${entryKey(entry.nodeId, entry.path)}`,
      kind,
      nodeId: entry.nodeId,
      path: [...entry.path],
      message,
      humanValue: deepClone(entry.value),
      agentValue: agent.present ? deepClone(agent.value) : undefined,
      agentPresent: agent.present,
      agentChanged,
      nodeIds: [entry.nodeId],
      entries: [refOf(entry)],
    });
  }

  // --- M must be a valid graph. -------------------------------------------------------------
  checkGraph(M);

  const status: MergeStatus = conflicts.length > 0 ? 'conflicts' : 'clean';
  const mergedEqualsExternal = sameStructure(M, A);
  // Only when M == A does A contain every protected value: then remember A as accepted.
  const protectedSet =
    status === 'clean' && mergedEqualsExternal && input.externalHash
      ? recordEditorWrite(P, input.externalHash)
      : P;
  mergeLog.push({
    event: 'merge',
    file: input.file ?? null,
    status,
    decisions,
    conflicts: conflicts.map(c => ({ id: c.id, kind: c.kind, message: c.message })),
    mergedHash: null,
    protected: protectedSet.entries.map(e => entryKey(e.nodeId, e.path)),
  });

  return {
    status,
    merged: M,
    mergedEqualsExternal,
    protectedSet,
    conflicts,
    mergeLog,
    consumedAcks: [...acks],
  };
}

/** Re-insert the first missing `@id` element along `path` from E's node, at E's index. */
function restoreSelectorFromE(
  target: MergeNode,
  editorNode: MergeNode | undefined,
  path: PropertyPath
): boolean {
  if (!editorNode) return false;
  const at = path.findIndex(segment => segment.startsWith('@'));
  if (at <= 0) return false;
  const arrayPath = path.slice(0, at);
  const selector = path[at];
  if (indexOfSelector(target, arrayPath, selector) >= 0) return false;
  const element = getAtPath(editorNode, path.slice(0, at + 1));
  if (!element.present || !isRecord(element.value)) return false;
  return insertSelectorElement(
    target,
    arrayPath,
    element.value,
    indexOfSelector(editorNode, arrayPath, selector)
  );
}

/** Fill in the byte hash of M once the caller has written it (merge-log entries are otherwise final). */
export function stampMergedHash(log: readonly MergeLogEntry[], hash: string): MergeLogEntry[] {
  return log.map(entry => (entry.event === 'merge' ? { ...entry, mergedHash: hash } : entry));
}
