/**
 * Fixtures for the external-version merge table — plan `.plans/external-agent-authoring.md`
 * §4.3 (table, structure rules, two exits from P, acks) and Phase 0 "Гонки записи"
 * counterexamples (а)–(и). The plan requires these to be pinned BEFORE Phase 2 wiring.
 */
import { describe, expect, it } from 'vitest';
import * as runtime from '@pix3/runtime';
import { sha256 } from './hash';
import {
  mergeExternalVersion,
  stampMergedHash,
  type MergeInput,
  type MergeResult,
} from './merge-external-version';
import {
  acceptAgentVersion,
  emptyProtectedSet,
  entryKey,
  parseProtectedSet,
  recordEditorWrite,
  recordHumanOperation,
  serializeProtectedSet,
  deleteNodeOperation,
  type ProtectedSetData,
} from './protected-set';
import { createSchemaTypeResolver } from './runtime-type-resolver';
import { getAtPath, indexTree, parseSceneText, type MergeDoc, type MergeNode } from './scene-doc';

const resolver = createSchemaTypeResolver(runtime as unknown as Record<string, unknown>);

const doc = (text: string): MergeDoc => parseSceneText(text) as MergeDoc;

/** The plan's running example: a Coin with two independent properties `x` and `y`. */
const coinScene = (x: number | string, y: number | string): string => `
version: 1.0.0
root:
  - id: root
    type: Group2D
    name: Root
    children:
      - id: coin
        type: Node2D
        name: Coin
        properties:
          x: ${x}
          y: ${y}
`;

function merge(
  E: string | null,
  A: string,
  P: ProtectedSetData,
  extra: Partial<MergeInput> = {}
): MergeResult {
  return mergeExternalVersion({
    editorVersion: E === null ? null : doc(E),
    externalVersion: parseSceneText(A),
    protectedSet: P,
    typeResolver: resolver,
    file: 'scenes/main.pix3scene',
    ...extra,
  });
}

function node(M: MergeDoc | null, id: string): MergeNode {
  expect(M).not.toBeNull();
  const found = indexTree(M as MergeDoc).byId.get(id);
  expect(found, `node ${id} in M`).toBeDefined();
  return (found as { node: MergeNode }).node;
}

function prop(M: MergeDoc | null, id: string, ...path: string[]): unknown {
  return getAtPath(node(M, id), ['properties', ...path]).value;
}

function has(M: MergeDoc | null, id: string): boolean {
  return indexTree(M as MergeDoc).byId.has(id);
}

function childIds(M: MergeDoc | null, id: string | null): string[] {
  const list = id === null ? (M as MergeDoc).root : (node(M, id).children ?? []);
  return list.map(n => n.id);
}

const setProp = (P: ProtectedSetData, nodeId: string, path: string[], value: unknown) =>
  recordHumanOperation(P, { kind: 'set-property', nodeId, path: ['properties', ...path], value });

const inP = (P: ProtectedSetData, nodeId: string, path: string[]): boolean =>
  P.entries.some(e => entryKey(e.nodeId, e.path) === entryKey(nodeId, path));

// ---------------------------------------------------------------------------------------------

describe('merge table — properties', () => {
  it('p ∉ P: the agent value is taken silently', () => {
    const r = merge(coinScene(0, 0), coinScene(5, 7), emptyProtectedSet());
    expect(r.status).toBe('clean');
    expect(r.conflicts).toEqual([]);
    expect(prop(r.merged, 'coin', 'x')).toBe(5);
    expect(prop(r.merged, 'coin', 'y')).toBe(7);
  });

  it('p ∈ P and A.p == P[p]: accepted without conflict, p STAYS in P', () => {
    const P = setProp(emptyProtectedSet(), 'coin', ['x'], 100);
    const r = merge(coinScene(100, 0), coinScene(100, 3), P);
    expect(r.status).toBe('clean');
    expect(prop(r.merged, 'coin', 'y')).toBe(3);
    expect(inP(r.protectedSet, 'coin', ['properties', 'x'])).toBe(true);
    const log = r.mergeLog.find(e => e.event === 'merge');
    expect(log && log.event === 'merge' && log.decisions[0].kept).toBe('agent-equal');
  });

  it('p ∈ P and A.p != P[p]: conflict, P[p] kept, p stays in P', () => {
    const P = setProp(emptyProtectedSet(), 'coin', ['x'], 100);
    const r = merge(coinScene(100, 0), coinScene(20, 0), P);
    expect(r.status).toBe('conflicts');
    expect(prop(r.merged, 'coin', 'x')).toBe(100);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({
      kind: 'property',
      nodeId: 'coin',
      path: ['properties', 'x'],
      humanValue: 100,
      agentValue: 20,
      agentPresent: true,
      agentChanged: true,
    });
    expect(inP(r.protectedSet, 'coin', ['properties', 'x'])).toBe(true);
  });

  it('A.p == E.p != P[p] (edit not autosaved yet): human value kept silently, logged', () => {
    const P = setProp(emptyProtectedSet(), 'coin', ['x'], 100);
    const r = merge(coinScene(0, 0), coinScene(0, 5), P, { externalHash: 'hA' });
    expect(r.status).toBe('clean');
    expect(r.conflicts).toEqual([]);
    expect(prop(r.merged, 'coin', 'x')).toBe(100);
    expect(prop(r.merged, 'coin', 'y')).toBe(5);
    expect(inP(r.protectedSet, 'coin', ['properties', 'x'])).toBe(true);
    expect(r.mergedEqualsExternal).toBe(false); // the caller must write M
    expect(r.protectedSet.versions).toEqual([]); // A lacks the human value: never an accepted version
    const log = r.mergeLog.find(e => e.event === 'merge');
    expect(log && log.event === 'merge' && log.decisions[0].kept).toBe('human-unchanged-by-agent');
  });

  it('A.p != E.p and != P[p]: conflict', () => {
    const P = setProp(emptyProtectedSet(), 'coin', ['x'], 100);
    const r = merge(coinScene(0, 0), coinScene(20, 5), P);
    expect(r.status).toBe('conflicts');
    expect(r.conflicts[0]).toMatchObject({ kind: 'property', agentChanged: true });
    expect(prop(r.merged, 'coin', 'x')).toBe(100);
  });

  it('no E known: the literal table applies (A.p != P[p] → conflict)', () => {
    const P = setProp(emptyProtectedSet(), 'coin', ['x'], 100);
    const r = merge(null, coinScene(0, 5), P);
    expect(r.status).toBe('conflicts');
    expect(r.conflicts[0].agentChanged).toBeUndefined();
  });

  it('a clean merge yields M == A and remembers A as accepted; a conflicted one does not', () => {
    const A = coinScene(1, 2);
    const clean = merge(coinScene(0, 0), A, emptyProtectedSet(), { externalHash: 'hA' });
    expect(clean.merged).toEqual(parseSceneText(A));
    expect(clean.protectedSet.versions).toEqual([{ hash: 'hA', genAtWrite: 0 }]);

    const P = setProp(emptyProtectedSet(), 'coin', ['x'], 100);
    const conflicted = merge(coinScene(100, 0), A, P, { externalHash: 'hA' });
    expect(conflicted.status).toBe('conflicts');
    expect(conflicted.protectedSet.versions).toEqual([]);
  });
});

describe('merge table — structure', () => {
  const tree = `
version: 1.0.0
root:
  - id: root
    type: Group2D
    name: Root
    children:
      - id: a
        type: Node2D
        name: A
        properties: { x: 1 }
      - id: b
        type: Node2D
        name: B
        properties: { x: 2 }
`;
  const onlyA = `
version: 1.0.0
root:
  - id: root
    type: Group2D
    name: Root
    children:
      - id: a
        type: Node2D
        name: A
        properties: { x: 1 }
`;

  it('node not in P and absent in A: deleted silently', () => {
    const r = merge(tree, onlyA, emptyProtectedSet());
    expect(r.status).toBe('clean');
    expect(has(r.merged, 'b')).toBe(false);
  });

  it('new node in A without a tombstone: added', () => {
    const r = merge(onlyA, tree, emptyProtectedSet());
    expect(r.status).toBe('clean');
    expect(childIds(r.merged, 'root')).toEqual(['a', 'b']);
  });

  it('node in P (edited) and absent in A: restored from E, stays in P, conflict', () => {
    const P = setProp(emptyProtectedSet(), 'b', ['x'], 50);
    const r = merge(tree, onlyA, P);
    expect(r.status).toBe('conflicts');
    expect(childIds(r.merged, 'root')).toEqual(['a', 'b']);
    expect(prop(r.merged, 'b', 'x')).toBe(50);
    expect(r.conflicts.map(c => c.kind)).toEqual(['node-deleted']);
    expect(inP(r.protectedSet, 'b', ['properties', 'x'])).toBe(true);
  });

  it('node the human created (not in E yet) and absent in A: restored from its snapshot', () => {
    const created: MergeNode = {
      id: 'c',
      type: 'Node2D',
      name: 'C',
      properties: { x: 9 },
    };
    const P = recordHumanOperation(emptyProtectedSet(), {
      kind: 'create-node',
      node: created,
      parentId: 'root',
      prevSiblingId: 'a',
    });
    const r = merge(tree, tree, P);
    expect(r.status).toBe('conflicts');
    expect(childIds(r.merged, 'root')).toEqual(['a', 'c', 'b']);
    expect(prop(r.merged, 'c', 'x')).toBe(9);
    expect(r.conflicts.map(c => c.kind)).toEqual(['node-deleted']);
  });

  it('a later edit of a created node patches its snapshot (one entry, one gen)', () => {
    let P = recordHumanOperation(emptyProtectedSet(), {
      kind: 'create-node',
      node: { id: 'c', type: 'Node2D', name: 'C', properties: { x: 9 } },
      parentId: 'root',
      prevSiblingId: 'b',
    });
    P = setProp(P, 'c', ['x'], 10);
    expect(P.entries.filter(e => e.nodeId === 'c').map(e => e.path)).toEqual([[], ['$tree']]);
    const withC = tree.replace(
      '        properties: { x: 2 }\n',
      '        properties: { x: 2 }\n      - id: c\n        type: Node2D\n        name: C\n        properties: { x: 11 }\n'
    );
    const r = merge(tree, withC, P);
    expect(r.conflicts.map(c => c.kind)).toEqual(['node-fields']);
    expect(prop(r.merged, 'c', 'x')).toBe(10);
  });

  it('component tombstone: the agent brings back a component the human deleted → stays deleted', () => {
    const withComponent = `
version: 1.0.0
root:
  - id: root
    type: Group2D
    name: Root
    components:
      - id: rules
        type: user:GameRules
        enabled: true
        config: { targetScore: 10 }
`;
    const P = recordHumanOperation(emptyProtectedSet(), {
      kind: 'delete-component',
      nodeId: 'root',
      componentId: 'rules',
    });
    // Deletion not autosaved yet, agent carried the file as it was: stays deleted, silently.
    const carried = merge(withComponent, withComponent, P);
    expect(carried.status).toBe('clean');
    expect(carried.conflicts).toEqual([]);
    expect(node(carried.merged, 'root').components).toEqual([]);
    expect(carried.mergedEqualsExternal).toBe(false);
    // The agent wrote the component with a different config: conflict, still deleted.
    const edited = merge(
      withComponent,
      withComponent.replace('targetScore: 10', 'targetScore: 11'),
      P
    );
    expect(edited.status).toBe('conflicts');
    expect(edited.conflicts[0].kind).toBe('removed-restored');
    expect(node(edited.merged, 'root').components).toEqual([]);
  });

  it('agent removed a component the human edited → restored from E with the human value', () => {
    const withComponent = `
version: 1.0.0
root:
  - id: root
    type: Group2D
    name: Root
    components:
      - id: rules
        type: user:GameRules
        enabled: true
        config: { targetScore: 10, lives: 3 }
`;
    const without = `
version: 1.0.0
root:
  - id: root
    type: Group2D
    name: Root
`;
    const P = recordHumanOperation(emptyProtectedSet(), {
      kind: 'set-property',
      nodeId: 'root',
      path: ['components', '@rules', 'config', 'targetScore'],
      value: 25,
    });
    const r = merge(withComponent, without, P);
    expect(r.conflicts.map(c => c.kind)).toEqual(['component-deleted']);
    expect(node(r.merged, 'root').components).toEqual([
      { id: 'rules', type: 'user:GameRules', enabled: true, config: { targetScore: 25, lives: 3 } },
    ]);
  });

  it('reset property: tombstone keeps it removed when the agent writes it back', () => {
    const P = recordHumanOperation(emptyProtectedSet(), {
      kind: 'reset-property',
      nodeId: 'coin',
      path: ['properties', 'y'],
    });
    const carried = merge(coinScene(0, 5), coinScene(0, 5), P);
    expect(carried.status).toBe('clean');
    expect(getAtPath(node(carried.merged, 'coin'), ['properties', 'y']).present).toBe(false);
    const r = merge(coinScene(0, 5), coinScene(0, 6), P);
    expect(r.conflicts.map(c => c.kind)).toEqual(['removed-restored']);
    expect(getAtPath(node(r.merged, 'coin'), ['properties', 'y']).present).toBe(false);
    const absent = merge(coinScene(0, 5), coinScene(0, 5).replace('          y: 5\n', ''), P);
    expect(absent.status).toBe('clean');
  });
});

describe('equality of values (normalized, schema-typed)', () => {
  const rect = (width: string, color: string, position: string): string => `
version: 1.0.0
root:
  - id: rect
    type: ColorRect2D
    name: Rect
    properties:
      width: ${width}
      color: ${color}
      transform:
        position: ${position}
`;

  it('resolves schema types from @pix3/runtime', () => {
    expect(resolver('ColorRect2D', 'color')).toBe('color');
    expect(resolver('ColorRect2D', 'position')).toBe('vector2');
    expect(resolver('ColorRect2D', 'width')).toBe('number');
  });

  it('epsilon 1e-4: 100.000002 vs 100 is not an edit; 100.01 is', () => {
    const P = setProp(emptyProtectedSet(), 'rect', ['width'], 100);
    const E = rect('100', "'#ffaa00'", '[0, 0]');
    expect(merge(E, rect('100.000002', "'#ffaa00'", '[0, 0]'), P).status).toBe('clean');
    const r = merge(E, rect('100.01', "'#ffaa00'", '[0, 0]'), P);
    expect(r.status).toBe('conflicts');
    expect(prop(r.merged, 'rect', 'width')).toBe(100);
  });

  it('colours compare as canonical hex', () => {
    const P = setProp(emptyProtectedSet(), 'rect', ['color'], '#FFAA00');
    const E = rect('100', "'#FFAA00'", '[0, 0]');
    for (const same of ["'#ffaa00'", '"#fa0"', "'#FFAA00FF'"]) {
      expect(merge(E, rect('100', same, '[0, 0]'), P).status, same).toBe('clean');
    }
    expect(merge(E, rect('100', "'#ffaa01'", '[0, 0]'), P).status).toBe('conflicts');
  });

  it('vectors compare componentwise, array and map spellings alike', () => {
    const P = setProp(emptyProtectedSet(), 'rect', ['transform', 'position'], [10, 20]);
    const E = rect('100', "'#fff'", '[10, 20]');
    expect(merge(E, rect('100', "'#fff'", '{ x: 10.00001, y: 20 }'), P).status).toBe('clean');
    expect(merge(E, rect('100', "'#fff'", '[10, 21]'), P).status).toBe('conflicts');
  });

  it('"changed" is a byte hash; quotes and key order change the hash but not the merge', async () => {
    const E = `
version: 1.0.0
root:
  - id: coin
    type: Node2D
    name: Coin
    properties: { x: 100, label: hi }
`;
    const A = `
version: "1.0.0"
root:
  - name: 'Coin'
    id: "coin"
    type: Node2D
    properties:
      label: "hi"
      x: 100
`;
    expect(await sha256(E)).not.toBe(await sha256(A));
    expect(await sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    const P = setProp(emptyProtectedSet(), 'coin', ['x'], 100);
    const r = merge(E, A, P);
    expect(r.status).toBe('clean');
    expect(r.merged).toEqual(parseSceneText(A));
  });
});

describe('Phase 0 counterexamples (а)–(и)', () => {
  it('(а) x=0, agent reads, human sets 100 and autosaves, agent writes 20 → 100 stays, conflict, merge-log', async () => {
    const E0 = coinScene(0, 0); // what the agent read
    let P = emptyProtectedSet();
    P = setProp(P, 'coin', ['x'], 100);
    const E1 = coinScene(100, 0); // autosave
    P = recordEditorWrite(P, await sha256(E1));

    const A = coinScene(20, 0); // the agent's stale write, based on E0
    expect(E0).not.toBe(E1);
    const r = merge(E1, A, P);
    expect(r.status).toBe('conflicts');
    expect(prop(r.merged, 'coin', 'x')).toBe(100);
    expect(r.conflicts[0].message).toContain('Coin');

    const log = stampMergedHash(r.mergeLog, 'hM');
    const entry = log.find(e => e.event === 'merge');
    expect(entry).toMatchObject({
      event: 'merge',
      file: 'scenes/main.pix3scene',
      status: 'conflicts',
      mergedHash: 'hM',
      protected: [entryKey('coin', ['properties', 'x'])],
    });
    expect(entry && entry.event === 'merge' && entry.decisions).toEqual([
      { nodeId: 'coin', path: ['properties', 'x'], label: '"Coin".x', kept: 'human' },
    ]);
  });

  it('(б) human moved a node, autosave debounce not expired, A arrives → the edit is already in P', () => {
    const E = `
version: 1.0.0
root:
  - id: root
    type: Group2D
    name: Root
    children:
      - id: a
        type: Node2D
        name: A
        properties: { transform: { position: [0, 0] } }
      - id: b
        type: Node2D
        name: B
        properties: { transform: { position: [0, 0] } }
`;
    // The human dragged B to (40, 50) and above A; E on disk still has the old layout.
    const P = recordHumanOperation(emptyProtectedSet(), [
      { kind: 'move-node', nodeId: 'b', parentId: 'root', prevSiblingId: null },
      {
        kind: 'set-property',
        nodeId: 'b',
        path: ['properties', 'transform', 'position'],
        value: [40, 50],
      },
    ]);
    expect(P.gen).toBe(1);
    const A = E.replace(
      'name: A\n        properties: { transform: { position: [0, 0] } }',
      'name: A\n        properties: { transform: { position: [7, 7] } }'
    );
    const r = merge(E, A, P);
    expect(childIds(r.merged, 'root')).toEqual(['b', 'a']);
    expect(prop(r.merged, 'b', 'transform', 'position')).toEqual([40, 50]);
    expect(prop(r.merged, 'a', 'transform', 'position')).toEqual([7, 7]); // agent's edit kept
    // The agent did not touch B, it carried the on-disk copy: no banner, only merge-log entries.
    expect(r.status).toBe('clean');
    expect(r.conflicts).toEqual([]);
    expect(r.mergedEqualsExternal).toBe(false);
    const log = r.mergeLog.find(e => e.event === 'merge');
    expect(
      log && log.event === 'merge' && log.decisions.map(d => [d.nodeId, d.label, d.kept])
    ).toEqual([
      ['b', 'tree position', 'human-unchanged-by-agent'],
      ['b', '"B".transform.position', 'human-unchanged-by-agent'],
    ]);
  });

  it('(в) agent does NOT re-read and continues the batch (x=0,y=1 then x=0,y=2) → manual value on every write', () => {
    const P = setProp(emptyProtectedSet(), 'coin', ['x'], 100);
    let E = coinScene(100, 0);
    for (const y of [1, 2, 3]) {
      const r = merge(E, coinScene(0, y), P);
      expect(r.status).toBe('conflicts');
      expect(prop(r.merged, 'coin', 'x')).toBe(100);
      expect(prop(r.merged, 'coin', 'y')).toBe(y);
      expect(inP(r.protectedSet, 'coin', ['properties', 'x'])).toBe(true);
      E = coinScene(100, y); // the editor writes M, E := M
    }
  });

  it('(г) agent re-read via `pix3 read` and acked, then wrote its value → accepted silently', async () => {
    let P = setProp(emptyProtectedSet(), 'coin', ['x'], 100);
    const E1 = coinScene(100, 0);
    const h1 = await sha256(E1);
    P = recordEditorWrite(P, h1);
    const r = merge(E1, coinScene(80, 0), P, { acks: [h1] });
    expect(r.status).toBe('clean');
    expect(prop(r.merged, 'coin', 'x')).toBe(80);
    expect(inP(r.protectedSet, 'coin', ['properties', 'x'])).toBe(false);
    expect(r.consumedAcks).toEqual([h1]);
    expect(r.mergeLog[0]).toMatchObject({ event: 'ack-applied', hash: h1, genAtWrite: 1 });
  });

  it('(д) accidental equality: agent writes x=100,y=1 unread, then x=20,y=2 → 100 stays', () => {
    const P = setProp(emptyProtectedSet(), 'coin', ['x'], 100);
    const first = merge(coinScene(100, 0), coinScene(100, 1), P);
    expect(first.status).toBe('clean');
    expect(inP(first.protectedSet, 'coin', ['properties', 'x'])).toBe(true);
    const second = merge(coinScene(100, 1), coinScene(20, 2), first.protectedSet);
    expect(second.status).toBe('conflicts');
    expect(prop(second.merged, 'coin', 'x')).toBe(100);
    expect(prop(second.merged, 'coin', 'y')).toBe(2);
  });

  it('(е) edit after ack before autosave: acked x=100, human sets 120, agent writes 80 → 120 stays', async () => {
    let P = setProp(emptyProtectedSet(), 'coin', ['x'], 100);
    const E1 = coinScene(100, 0);
    const h1 = await sha256(E1);
    P = recordEditorWrite(P, h1); // genAtWrite = 1
    P = setProp(P, 'coin', ['x'], 120); // gen 2, not autosaved yet
    const r = merge(E1, coinScene(80, 0), P, { acks: [h1] });
    expect(r.status).toBe('conflicts');
    expect(prop(r.merged, 'coin', 'x')).toBe(120);
    expect(r.protectedSet.entries).toEqual([
      { nodeId: 'coin', path: ['properties', 'x'], gen: 2, value: 120 },
    ]);
  });

  it('(е) acks are one-shot and release only entries up to genAtWrite', async () => {
    let P = setProp(emptyProtectedSet(), 'coin', ['x'], 100); // gen 1
    const E1 = coinScene(100, 0);
    const h1 = await sha256(E1);
    P = recordEditorWrite(P, h1);
    const acked = merge(E1, coinScene(100, 0), P, { acks: [h1] });
    expect(acked.consumedAcks).toEqual([h1]); // caller deletes .pix3/ack.json entries
    let next = setProp(acked.protectedSet, 'coin', ['y'], 7); // gen 2
    next = setProp(next, 'coin', ['x'], 150); // gen 3
    // The same hash again (should not happen — one-shot — but must be harmless): gen 2/3 stay.
    const again = merge(coinScene(150, 7), coinScene(0, 0), next, { acks: [h1] });
    expect(again.status).toBe('conflicts');
    expect(prop(again.merged, 'coin', 'x')).toBe(150);
    expect(prop(again.merged, 'coin', 'y')).toBe(7);
    // Without an ack: protection holds.
    const none = merge(coinScene(150, 7), coinScene(0, 0), next);
    expect(none.conflicts).toHaveLength(2);
  });

  it('(е) an unknown ack hash is ignored and logged', () => {
    const P = setProp(emptyProtectedSet(), 'coin', ['x'], 100);
    const r = merge(coinScene(100, 0), coinScene(20, 0), P, { acks: ['deadbeef'] });
    expect(r.status).toBe('conflicts');
    expect(prop(r.merged, 'coin', 'x')).toBe(100);
    expect(r.mergeLog[0]).toEqual({ event: 'ack-unknown', hash: 'deadbeef' });
    expect(r.consumedAcks).toEqual(['deadbeef']);
  });

  it('(ж) human deleted a node, agent writes the old file with it → stays deleted, conflict', () => {
    const E = coinScene(0, 0);
    const coin = indexTree(doc(E)).byId.get('coin')?.node as MergeNode;
    const P = recordHumanOperation(emptyProtectedSet(), deleteNodeOperation(coin));
    const afterDelete = `
version: 1.0.0
root:
  - id: root
    type: Group2D
    name: Root
`;
    for (const A of [coinScene(0, 0), coinScene(3, 4)]) {
      const r = merge(afterDelete, A, P);
      expect(r.status).toBe('conflicts');
      expect(has(r.merged, 'coin')).toBe(false);
      expect(r.conflicts[0]).toMatchObject({ kind: 'node-resurrected', nodeId: 'coin' });
      expect(r.conflicts[0].message).toContain('"Coin"');
      expect(r.protectedSet.entries).toEqual([{ nodeId: 'coin', path: [], gen: 1, deleted: true }]);
    }
  });

  it('(ж) deletion not autosaved yet, agent carried the unchanged node → stays deleted silently', () => {
    const E = coinScene(0, 0); // still has Coin on disk
    const coin = indexTree(doc(E)).byId.get('coin')?.node as MergeNode;
    const P = recordHumanOperation(emptyProtectedSet(), deleteNodeOperation(coin));
    const carried = merge(E, coinScene(0, 0), P);
    expect(carried.status).toBe('clean');
    expect(has(carried.merged, 'coin')).toBe(false);
    const log = carried.mergeLog.find(e => e.event === 'merge');
    expect(log && log.event === 'merge' && log.decisions[0]).toMatchObject({
      nodeId: 'coin',
      kept: 'human-unchanged-by-agent',
    });
    const edited = merge(E, coinScene(3, 4), P); // the agent changed the deleted node
    expect(edited.status).toBe('conflicts');
    expect(has(edited.merged, 'coin')).toBe(false);
    expect(edited.conflicts[0].kind).toBe('node-resurrected');
  });

  describe('(з) ancestor deletion', () => {
    const E = `
version: 1.0.0
root:
  - id: root
    type: Group2D
    name: Root
    children:
      - id: title
        type: Node2D
        name: Title
      - id: panel
        type: Group2D
        name: Panel
        properties: { width: 300 }
        children:
          - id: label
            type: Node2D
            name: Label
          - id: button
            type: Node2D
            name: Button
            properties: { transform: { position: [0, 0] } }
`;
    const panelGone = `
version: 1.0.0
root:
  - id: root
    type: Group2D
    name: Root
    children:
      - id: title
        type: Node2D
        name: Title
`;

    it('human edited Button, agent deleted Panel → minimal ancestor chain restored, no orphans', () => {
      const P = setProp(emptyProtectedSet(), 'button', ['transform', 'position'], [5, 6]);
      const r = merge(E, panelGone, P);
      expect(r.status).toBe('conflicts');
      expect(childIds(r.merged, 'root')).toEqual(['title', 'panel']);
      expect(childIds(r.merged, 'panel')).toEqual(['button']); // Label is not protected: gone
      expect(prop(r.merged, 'panel', 'width')).toBe(300);
      expect(prop(r.merged, 'button', 'transform', 'position')).toEqual([5, 6]);
      expect(r.conflicts).toHaveLength(1);
      expect(r.conflicts[0]).toMatchObject({
        kind: 'ancestor-deleted',
        nodeId: 'panel',
        nodeIds: ['panel', 'button'],
      });
      expect(r.conflicts[0].message).toContain('"Panel"');
      expect(r.conflicts[0].message).toContain('Button.transform.position');

      // Accept = delete the subtree: the agent's version then merges silently.
      const accepted = acceptAgentVersion(r.protectedSet, r.conflicts);
      const again = merge(E, panelGone, accepted);
      expect(again.status).toBe('clean');
      expect(again.merged).toEqual(parseSceneText(panelGone));
    });

    it('human deleted Panel, agent edited Button inside it → tombstones cover the subtree', () => {
      const panel = indexTree(doc(E)).byId.get('panel')?.node as MergeNode;
      const P = recordHumanOperation(emptyProtectedSet(), deleteNodeOperation(panel));
      const A = E.replace('position: [0, 0]', 'position: [9, 9]');
      const r = merge(panelGone, A, P);
      expect(r.status).toBe('conflicts');
      expect(has(r.merged, 'panel')).toBe(false);
      expect(has(r.merged, 'button')).toBe(false);
      expect(r.conflicts).toHaveLength(1);
      expect(r.conflicts[0]).toMatchObject({ kind: 'node-resurrected', nodeId: 'panel' });
      expect(r.conflicts[0].nodeIds).toEqual(['panel', 'label', 'button']);
    });
  });

  it('(и) editor restarted mid-batch: P round-trips through .pix3/protected.json and keeps protecting', async () => {
    let P = setProp(emptyProtectedSet(), 'coin', ['x'], 100);
    const E1 = coinScene(100, 0);
    const h1 = await sha256(E1);
    P = recordEditorWrite(P, h1);
    const first = merge(E1, coinScene(0, 1), P);
    expect(prop(first.merged, 'coin', 'x')).toBe(100);

    // --- editor closes; protected.json is all that survives ---
    const json = serializeProtectedSet(first.protectedSet);
    const restoredP = parseProtectedSet(json);
    expect(restoredP).toEqual(first.protectedSet);

    const second = merge(coinScene(100, 1), coinScene(0, 2), restoredP);
    expect(second.status).toBe('conflicts');
    expect(prop(second.merged, 'coin', 'x')).toBe(100);
    expect(prop(second.merged, 'coin', 'y')).toBe(2);

    // The remembered (hash, genAtWrite) also survived: an ack after restart still works.
    const acked = merge(coinScene(100, 2), coinScene(0, 3), second.protectedSet, { acks: [h1] });
    expect(acked.status).toBe('clean');
    expect(prop(acked.merged, 'coin', 'x')).toBe(0);
  });
});

describe('exit 1 — "Accept agent\'s version"', () => {
  it('releases the conflicting entries; the same A then merges clean with M == A', () => {
    const P = setProp(emptyProtectedSet(), 'coin', ['x'], 100);
    const A = coinScene(20, 0);
    const r = merge(coinScene(100, 0), A, P);
    const accepted = acceptAgentVersion(r.protectedSet, r.conflicts);
    expect(accepted.entries).toEqual([]);
    const again = merge(coinScene(100, 0), A, accepted);
    expect(again.status).toBe('clean');
    expect(again.merged).toEqual(parseSceneText(A));
  });

  it('does not release an entry the human edited again after the conflict was shown', () => {
    const P = setProp(emptyProtectedSet(), 'coin', ['x'], 100);
    const r = merge(coinScene(100, 0), coinScene(20, 0), P);
    const reEdited = setProp(r.protectedSet, 'coin', ['x'], 130);
    const accepted = acceptAgentVersion(reEdited, r.conflicts);
    expect(inP(accepted, 'coin', ['properties', 'x'])).toBe(true);
  });
});

describe('tree position { parent, prevSibling }', () => {
  type T = string | { id: string; children: T[] };
  const sceneOf = (nodes: T[]): string => {
    const lines = ['version: 1.0.0', 'root:'];
    const emit = (list: T[], indent: string): void => {
      for (const item of list) {
        const id = typeof item === 'string' ? item : item.id;
        lines.push(
          `${indent}- id: ${id}`,
          `${indent}  type: Node2D`,
          `${indent}  name: ${id.toUpperCase()}`
        );
        if (typeof item !== 'string' && item.children.length > 0) {
          lines.push(`${indent}  children:`);
          emit(item.children, `${indent}    `);
        }
      }
    };
    emit(nodes, '  ');
    return `${lines.join('\n')}\n`;
  };
  // The human moved C right after A (E on disk still has x, a, b, c).
  const E = sceneOf(['x', 'a', 'b', 'c']);
  const P = recordHumanOperation(emptyProtectedSet(), {
    kind: 'move-node',
    nodeId: 'c',
    parentId: null,
    prevSiblingId: 'a',
  });

  it('agent carried the stale order (A == E): human position kept silently', () => {
    const r = merge(E, E, P);
    expect(r.status).toBe('clean');
    expect(childIds(r.merged, null)).toEqual(['x', 'a', 'c', 'b']);
    expect(r.mergedEqualsExternal).toBe(false);
  });

  it('agent inserts a sibling before the human-moved node → no conflict, neighbours kept', () => {
    const A = sceneOf(['x', 'a', 'n', 'c', 'b']);
    const r = merge(E, A, P);
    expect(r.status).toBe('clean');
    expect(r.mergedEqualsExternal).toBe(true);
    expect(childIds(r.merged, null)).toEqual(['x', 'a', 'n', 'c', 'b']);
  });

  it('agent inserts a sibling into a stale order → no conflict, node still right after A', () => {
    const A = sceneOf(['n', 'x', 'a', 'b', 'c']);
    const r = merge(E, A, P);
    expect(r.status).toBe('clean');
    expect(childIds(r.merged, null)).toEqual(['n', 'x', 'a', 'c', 'b']);
  });

  it('agent deletes the prevSibling → resolved through E order, no conflict', () => {
    const A = sceneOf(['x', 'c', 'b']); // A deleted; C after X is "right after where A was"
    const r = merge(sceneOf(['x', 'a', 'c', 'b']), A, P);
    expect(r.status).toBe('clean');
    expect(r.mergedEqualsExternal).toBe(true);
    expect(childIds(r.merged, null)).toEqual(['x', 'c', 'b']);
  });

  it('agent really reorders the human-moved node → conflict, human position restored', () => {
    const A = sceneOf(['c', 'x', 'a', 'b']);
    const r = merge(E, A, P);
    expect(r.status).toBe('conflicts');
    expect(r.conflicts[0]).toMatchObject({
      kind: 'moved',
      nodeId: 'c',
      humanValue: { parent: null, prevSibling: 'a' },
      agentValue: { parent: null, prevSibling: null },
    });
    expect(childIds(r.merged, null)).toEqual(['x', 'a', 'c', 'b']);
  });

  it('agent really reparents the human-moved node → conflict, human position restored', () => {
    const A = sceneOf(['x', { id: 'a', children: ['c'] }, 'b']);
    const r = merge(E, A, P);
    expect(r.status).toBe('conflicts');
    expect(r.conflicts.map(c => c.kind)).toEqual(['moved']);
    expect(childIds(r.merged, null)).toEqual(['x', 'a', 'c', 'b']);
    expect(childIds(r.merged, 'a')).toEqual([]);
  });

  it('human reparent + stale agent file (A == E) → reparent kept silently', () => {
    const reparent = recordHumanOperation(emptyProtectedSet(), {
      kind: 'move-node',
      nodeId: 'b',
      parentId: 'a',
      prevSiblingId: null,
    });
    const r = merge(E, E, reparent);
    expect(r.status).toBe('clean');
    expect(childIds(r.merged, null)).toEqual(['x', 'a', 'c']);
    expect(childIds(r.merged, 'a')).toEqual(['b']);
  });
});

describe('rejected — M would be an invalid graph', () => {
  it('duplicate ids in A → whole-scene conflict, M not produced, P and acks untouched', () => {
    const P = setProp(emptyProtectedSet(), 'coin', ['x'], 100);
    const A = coinScene(1, 1).replace('- id: coin', '- id: root');
    const r = merge(coinScene(100, 0), A, P, { acks: ['h'] });
    expect(r.status).toBe('rejected');
    expect(r.merged).toBeNull();
    expect(r.protectedSet).toBe(P);
    expect(r.consumedAcks).toEqual([]);
    expect(r.conflicts[0].kind).toBe('invalid-graph');
    expect(r.conflicts[0].message).toContain('duplicate node id');
  });

  it('malformed A (root is not a list) → rejected', () => {
    const r = merge(coinScene(0, 0), 'version: 1.0.0\nroot: nope\n', emptyProtectedSet());
    expect(r.status).toBe('rejected');
  });

  it('human moved B under A while the agent moved A under B → cycle → rejected', () => {
    const E = `
version: 1.0.0
root:
  - id: a
    type: Node2D
    name: A
  - id: b
    type: Node2D
    name: B
`;
    const A = `
version: 1.0.0
root:
  - id: b
    type: Node2D
    name: B
    children:
      - id: a
        type: Node2D
        name: A
`;
    const P = recordHumanOperation(emptyProtectedSet(), {
      kind: 'move-node',
      nodeId: 'b',
      parentId: 'a',
      prevSiblingId: null,
    });
    const r = merge(E, A, P);
    expect(r.status).toBe('rejected');
    expect(r.merged).toBeNull();
  });
});
