import { beforeEach, describe, expect, it } from 'vitest';

import {
  LIBRARY_SOURCES,
  canEditSource,
  categoriesForSource,
  countItemsInCategory,
  itemsForSource,
  subcategoriesOf,
  topLevelCategories,
  type LibrarySourceConfig,
} from '@/services/library/library-sources';
import type {
  LibraryItem,
  LibraryItemManifest,
  LibraryScope,
  StoreCategory,
} from '@/services/library/library-types';

function source(id: string): LibrarySourceConfig {
  const found = LIBRARY_SOURCES.find(entry => entry.id === id);
  if (!found) {
    throw new Error(`Unknown test source ${id}`);
  }
  return found;
}

function item(
  scope: LibraryScope,
  id: string,
  overrides: Partial<LibraryItemManifest> = {}
): LibraryItem {
  return {
    scope,
    manifest: {
      id,
      slug: id,
      name: id,
      type: 'image',
      tags: [],
      files: [],
      source: 'imported',
      createdAt: 1,
      updatedAt: 2,
      ...overrides,
    },
  };
}

const TAXONOMY: StoreCategory[] = [
  { id: 'ui', parentId: null, label: 'UI', sortOrder: 1, itemCount: 1 },
  { id: 'audio', parentId: null, label: 'Audio', sortOrder: 0, itemCount: 0 },
  { id: 'ui/buttons', parentId: 'ui', label: 'Buttons', sortOrder: 1, itemCount: 2 },
  { id: 'ui/panels', parentId: 'ui', label: 'Panels', sortOrder: 0, itemCount: 0 },
];

describe('library sources', () => {
  beforeEach(() => localStorage.clear());

  it('backs the store source with the store scope', () => {
    expect(source('store').scope).toBe('store');
    const items = [item('store', 'a'), item('user', 'b')];
    expect(itemsForSource(source('store'), items).map(entry => entry.manifest.id)).toEqual(['a']);
  });
});

describe('canEditSource', () => {
  it('keeps editable-by-design sources editable regardless of role', () => {
    expect(canEditSource(source('user'), { isAdmin: false })).toBe(true);
    expect(canEditSource(source('team'), { isAdmin: false })).toBe(true);
  });

  it('opens the store only for an admin', () => {
    expect(canEditSource(source('store'), { isAdmin: false })).toBe(false);
    expect(canEditSource(source('store'), { isAdmin: true })).toBe(true);
  });

  it('never opens a third-party provider', () => {
    expect(canEditSource(source('kenney'), { isAdmin: true })).toBe(false);
  });
});

describe('categoriesForSource', () => {
  it('uses the declared config categories for a read-only source without a taxonomy', () => {
    const categories = categoriesForSource(source('store'), []);
    expect(categories[0]).toEqual({ id: 'all', label: 'Featured' });
    expect(categories.map(entry => entry.id)).toContain('char');
  });

  it('replaces config categories with the server taxonomy top level, in curated order', () => {
    const categories = categoriesForSource(source('store'), [], TAXONOMY);
    expect(categories.map(entry => entry.id)).toEqual(['all', 'audio', 'ui']);
    // Subcategories stay off the rail; they surface as chips.
    expect(categories.map(entry => entry.id)).not.toContain('ui/buttons');
  });

  it('ignores an empty taxonomy (offline) and keeps the config fallback', () => {
    expect(categoriesForSource(source('store'), [], []).map(entry => entry.id)).toContain('ui');
    expect(categoriesForSource(source('store'), [], []).map(entry => entry.id)).toContain('vfx');
  });

  it('still derives editable-source categories from item manifests', () => {
    const items = [item('user', 'a', { category: 'brand-kit' }), item('user', 'b')];
    const categories = categoriesForSource(source('user'), items);
    expect(categories).toEqual([
      { id: 'all', label: 'All' },
      { id: 'brand-kit', label: 'Brand Kit' },
    ]);
  });

  it('leaves an editable source unaffected by a passed taxonomy', () => {
    const items = [item('user', 'a', { category: 'brand-kit' })];
    expect(categoriesForSource(source('user'), items, TAXONOMY)).toEqual(
      categoriesForSource(source('user'), items)
    );
  });
});

describe('taxonomy helpers', () => {
  it('lists top-level nodes by sort order', () => {
    expect(topLevelCategories(TAXONOMY).map(entry => entry.id)).toEqual(['audio', 'ui']);
  });

  it('lists the children of a node by sort order', () => {
    expect(subcategoriesOf(TAXONOMY, 'ui').map(entry => entry.id)).toEqual([
      'ui/panels',
      'ui/buttons',
    ]);
    expect(subcategoriesOf(TAXONOMY, 'audio')).toEqual([]);
  });

  it('tolerates a missing taxonomy', () => {
    expect(topLevelCategories()).toEqual([]);
    expect(subcategoriesOf(undefined, 'ui')).toEqual([]);
  });
});

describe('countItemsInCategory', () => {
  it('counts everything under the aggregate', () => {
    expect(countItemsInCategory('all', [item('user', 'a'), item('user', 'b')])).toBe(2);
  });

  it('matches user/team items on the flat category field', () => {
    const items = [
      item('user', 'a', { category: 'ui' }),
      item('user', 'b', { category: 'audio' }),
      item('user', 'c'),
    ];
    expect(countItemsInCategory('ui', items)).toBe(1);
  });

  it('counts store subcategories under their parent path', () => {
    const items = [
      item('store', 'a', { categoryPath: 'ui' }),
      item('store', 'b', { categoryPath: 'ui/buttons' }),
      item('store', 'c', { categoryPath: 'ui-kit' }),
      item('store', 'd', { categoryPath: 'audio' }),
    ];
    expect(countItemsInCategory('ui', items)).toBe(2);
    expect(countItemsInCategory('ui/buttons', items)).toBe(1);
    // A sibling whose id merely starts with the same text is not a subcategory.
    expect(countItemsInCategory('ui-kit', items)).toBe(1);
  });
});
