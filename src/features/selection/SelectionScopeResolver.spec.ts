import { describe, expect, it } from 'vitest';

import {
  resolveViewportClick,
  resolveViewportDoubleClick,
  resolveViewportPopOut,
  type ScopeNode,
  type ScopeNodeLookup,
} from '@/features/selection/SelectionScopeResolver';

interface TestNode extends ScopeNode {
  nodeId: string;
  parentNode: TestNode | null;
  properties: { locked?: boolean };
}

/**
 * Fixture tree:
 *   A (top-level container)
 *     A1 (container)
 *       A1a (leaf)
 *       A1b (leaf)
 *     A2 (leaf)
 *   B (top-level leaf)
 *   L (top-level, LOCKED container)
 *     L1 (leaf)
 */
function buildGraph(): ScopeNodeLookup {
  const nodes = new Map<string, TestNode>();
  const add = (id: string, parentId: string | null, locked = false): TestNode => {
    const parentNode = parentId ? (nodes.get(parentId) ?? null) : null;
    const node: TestNode = { nodeId: id, parentNode, properties: { locked } };
    nodes.set(id, node);
    return node;
  };

  add('A', null);
  add('A1', 'A');
  add('A1a', 'A1');
  add('A1b', 'A1');
  add('A2', 'A');
  add('B', null);
  add('L', null, true);
  add('L1', 'L');

  return (id: string) => nodes.get(id) ?? null;
}

describe('resolveViewportClick', () => {
  const getNode = buildGraph();

  it('selects the top-level container at root scope', () => {
    expect(resolveViewportClick(getNode, null, 'A1a')).toEqual({
      candidateId: 'A',
      nextFocusId: null,
    });
  });

  it('selects a top-level leaf directly at root scope', () => {
    expect(resolveViewportClick(getNode, null, 'B')).toEqual({
      candidateId: 'B',
      nextFocusId: null,
    });
  });

  it('deep-selects the raw leaf and leaves scope unchanged', () => {
    expect(resolveViewportClick(getNode, null, 'A1a', { deep: true })).toEqual({
      candidateId: 'A1a',
      nextFocusId: null,
    });
  });

  it('selects a direct child within the focused container', () => {
    expect(resolveViewportClick(getNode, 'A', 'A1a')).toEqual({
      candidateId: 'A1',
      nextFocusId: 'A',
    });
    expect(resolveViewportClick(getNode, 'A', 'A2')).toEqual({
      candidateId: 'A2',
      nextFocusId: 'A',
    });
  });

  it('selects the leaf when the scope is its direct parent', () => {
    expect(resolveViewportClick(getNode, 'A1', 'A1a')).toEqual({
      candidateId: 'A1a',
      nextFocusId: 'A1',
    });
  });

  it('pops out to the nearest common ancestor when clicking outside the scope', () => {
    // Focused in A1, clicking a sibling under A pops out to A.
    expect(resolveViewportClick(getNode, 'A1', 'A2')).toEqual({
      candidateId: 'A2',
      nextFocusId: 'A',
    });
    // Focused in A1, clicking B (different branch) pops out to root.
    expect(resolveViewportClick(getNode, 'A1', 'B')).toEqual({
      candidateId: 'B',
      nextFocusId: null,
    });
  });

  it('treats a stale/unknown focus id as the scene root', () => {
    expect(resolveViewportClick(getNode, 'ghost', 'A1a')).toEqual({
      candidateId: 'A',
      nextFocusId: null,
    });
  });

  it('descends through a locked container to the unlocked child', () => {
    expect(resolveViewportClick(getNode, null, 'L1')).toEqual({
      candidateId: 'L1',
      nextFocusId: null,
    });
  });

  it('returns null candidate on empty hit but preserves validated scope', () => {
    expect(resolveViewportClick(getNode, 'A', null)).toEqual({
      candidateId: null,
      nextFocusId: 'A',
    });
  });
});

describe('resolveViewportDoubleClick', () => {
  const getNode = buildGraph();

  it('drills from root into the top-level container and selects the child', () => {
    expect(resolveViewportDoubleClick(getNode, null, 'A1a')).toEqual({
      candidateId: 'A1',
      nextFocusId: 'A',
    });
  });

  it('drills a second level and selects the leaf', () => {
    expect(resolveViewportDoubleClick(getNode, 'A', 'A1a')).toEqual({
      candidateId: 'A1a',
      nextFocusId: 'A1',
    });
  });

  it('is a no-op when already at the leaf', () => {
    expect(resolveViewportDoubleClick(getNode, 'A1', 'A1a')).toEqual({
      candidateId: 'A1a',
      nextFocusId: 'A1',
    });
  });
});

describe('resolveViewportPopOut', () => {
  const getNode = buildGraph();

  it('pops one level and selects the former container', () => {
    expect(resolveViewportPopOut(getNode, 'A1')).toEqual({
      candidateId: 'A1',
      nextFocusId: 'A',
    });
    expect(resolveViewportPopOut(getNode, 'A')).toEqual({
      candidateId: 'A',
      nextFocusId: null,
    });
  });

  it('clears selection at the scene root', () => {
    expect(resolveViewportPopOut(getNode, null)).toEqual({
      candidateId: null,
      nextFocusId: null,
    });
  });

  it('treats a stale focus id as root (clears)', () => {
    expect(resolveViewportPopOut(getNode, 'ghost')).toEqual({
      candidateId: null,
      nextFocusId: null,
    });
  });
});
