import { describe, expect, it } from 'vitest';
import type { NodeBase } from '@pix3/runtime';
import { isInstancePlacementProperty, type PrefabMetadata } from './prefab-utils';

/**
 * Minimal NodeBase stand-in — the prefab-utils helpers only read `nodeId` and
 * `metadata.__pix3Prefab`.
 */
function fakeNode(nodeId: string, marker: PrefabMetadata | null): NodeBase {
  return {
    nodeId,
    metadata: marker ? { __pix3Prefab: marker } : {},
  } as unknown as NodeBase;
}

function marker(instanceRootId: string): PrefabMetadata {
  return {
    localId: 'root',
    effectiveLocalId: 'root',
    instanceRootId,
    sourcePath: 'res://prefabs/panel.pix3scene',
  };
}

describe('isInstancePlacementProperty', () => {
  const placement = [
    'name',
    'position',
    'rotation',
    'scale',
    'layoutEnabled',
    'horizontalAlign',
    'verticalAlign',
  ];

  it('treats placement props on an instance root as placement (not overrides)', () => {
    const root = fakeNode('inst', marker('inst')); // instanceRootId === nodeId → root
    for (const prop of placement) {
      expect(isInstancePlacementProperty(root, prop)).toBe(true);
    }
  });

  it('does not treat content props on an instance root as placement', () => {
    const root = fakeNode('inst', marker('inst'));
    for (const prop of ['opacity', 'width', 'height', 'texturePath', 'visible']) {
      expect(isInstancePlacementProperty(root, prop)).toBe(false);
    }
  });

  it('never treats a prefab child as placement (moving a child is a real override)', () => {
    const child = fakeNode('child', marker('inst')); // instanceRootId !== nodeId → child
    for (const prop of placement) {
      expect(isInstancePlacementProperty(child, prop)).toBe(false);
    }
  });

  it('returns false for a plain (non-prefab) node', () => {
    const plain = fakeNode('plain', null);
    expect(isInstancePlacementProperty(plain, 'position')).toBe(false);
  });
});
