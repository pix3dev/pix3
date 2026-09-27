import { describe, expect, it } from 'vitest';
import { diffSceneDocuments, toMergeDoc } from './human-operation-diff';
import type { MergeDoc } from './scene-doc';

const doc = (root: unknown[]): MergeDoc => toMergeDoc({ version: '1.0.0', root });

describe('diffSceneDocuments', () => {
  it('returns nothing for identical documents (the caller must not bump gen)', () => {
    const a = doc([{ id: 'n', type: 'Node2D', name: 'N', properties: { visible: true } }]);
    expect(diffSceneDocuments(a, structuredClone(a))).toEqual([]);
  });

  it('descends one level into structural blocks the disk format declares nested', () => {
    const before = doc([
      {
        id: 'n',
        type: 'Node2D',
        properties: { transform: { position: [0, 0], scale: [1, 1] }, opacity: 1 },
      },
    ]);
    const after = doc([
      {
        id: 'n',
        type: 'Node2D',
        properties: { transform: { position: [5, 0], scale: [1, 1] }, opacity: 0.5 },
      },
    ]);
    expect(diffSceneDocuments(before, after)).toEqual([
      {
        kind: 'set-property',
        nodeId: 'n',
        path: ['properties', 'transform', 'position'],
        value: [5, 0],
      },
      { kind: 'set-property', nodeId: 'n', path: ['properties', 'opacity'], value: 0.5 },
    ]);
  });

  it('a key that disappears is a reset (tombstone), metadata is per key', () => {
    const before = doc([
      { id: 'n', type: 'Node3D', properties: { castShadow: true }, metadata: { a: 1, b: 2 } },
    ]);
    const after = doc([{ id: 'n', type: 'Node3D', properties: {}, metadata: { a: 1, b: 3 } }]);
    expect(diffSceneDocuments(before, after)).toEqual([
      { kind: 'set-property', nodeId: 'n', path: ['metadata', 'b'], value: 3 },
      { kind: 'reset-property', nodeId: 'n', path: ['properties', 'castShadow'] },
    ]);
  });

  it('components: added whole, config per key, removed → delete-component', () => {
    const before = doc([
      {
        id: 'n',
        type: 'Node2D',
        components: [
          { id: 'c1', type: 'core:Sine', enabled: true, config: { amplitude: 1 } },
          { id: 'c2', type: 'core:Rotate', enabled: true },
        ],
      },
    ]);
    const after = doc([
      {
        id: 'n',
        type: 'Node2D',
        components: [
          { id: 'c1', type: 'core:Sine', enabled: false, config: { amplitude: 2 } },
          { id: 'c3', type: 'user:Coin', enabled: true },
        ],
      },
    ]);
    expect(diffSceneDocuments(before, after)).toEqual([
      { kind: 'set-property', nodeId: 'n', path: ['components', '@c1', 'enabled'], value: false },
      {
        kind: 'set-property',
        nodeId: 'n',
        path: ['components', '@c1', 'config', 'amplitude'],
        value: 2,
      },
      { kind: 'delete-component', nodeId: 'n', componentId: 'c2' },
      {
        kind: 'set-property',
        nodeId: 'n',
        path: ['components', '@c3'],
        value: { type: 'user:Coin', enabled: true },
      },
    ]);
  });

  it('reorder: only the node that left the common order is a move (LCS)', () => {
    const before = doc([{ id: 'x' }, { id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const after = doc([{ id: 'a' }, { id: 'b' }, { id: 'x' }, { id: 'c' }]);
    expect(diffSceneDocuments(before, after)).toEqual([
      { kind: 'move-node', nodeId: 'x', parentId: null, prevSiblingId: 'b' },
    ]);
  });

  it('grouping: new parent is created without its moved children, which are moves', () => {
    const before = doc([{ id: 'a' }, { id: 'b' }]);
    const after = doc([{ id: 'g', type: 'Group2D', children: [{ id: 'a' }, { id: 'b' }] }]);
    expect(diffSceneDocuments(before, after)).toEqual([
      {
        kind: 'create-node',
        node: { id: 'g', type: 'Group2D' },
        parentId: null,
        prevSiblingId: null,
      },
      { kind: 'move-node', nodeId: 'a', parentId: 'g', prevSiblingId: null },
      { kind: 'move-node', nodeId: 'b', parentId: 'g', prevSiblingId: 'a' },
    ]);
  });

  it('a created subtree is one create-node; a deleted subtree lists every id', () => {
    const before = doc([
      { id: 'p', children: [{ id: 'q', children: [{ id: 'r' }] }] },
      { id: 's' },
    ]);
    const after = doc([{ id: 's' }, { id: 'n', children: [{ id: 'm' }] }]);
    const ops = diffSceneDocuments(before, after);
    expect(ops[0]).toEqual({ kind: 'delete-node', nodeIds: ['p', 'q', 'r'] });
    expect(ops[1]).toEqual({
      kind: 'create-node',
      node: { id: 'n', children: [{ id: 'm' }] },
      parentId: null,
      prevSiblingId: 's',
    });
    expect(ops).toHaveLength(2);
  });
});
