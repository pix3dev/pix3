import { describe, expect, it } from 'vitest';
import { collectTags, filterItems, matchesFilter, slugify, uniqueSlug } from './library-search';
import type { LibraryItem, LibraryItemManifest } from './library-types';

function item(
  overrides: Partial<LibraryItemManifest> & { scope?: LibraryItem['scope'] } = {}
): LibraryItem {
  const { scope = 'user', ...manifest } = overrides;
  return {
    scope,
    manifest: {
      id: manifest.id ?? 'id',
      slug: manifest.slug ?? 'slug',
      name: manifest.name ?? 'Item',
      type: manifest.type ?? 'image',
      tags: manifest.tags ?? [],
      description: manifest.description,
      files: manifest.files ?? [],
      source: manifest.source ?? 'imported',
      createdAt: 0,
      updatedAt: 0,
    },
  };
}

describe('slugify / uniqueSlug', () => {
  it('produces lower-kebab slugs', () => {
    expect(slugify('Rounded Button (Blue)')).toBe('rounded-button-blue');
    expect(slugify('  Héllo Wörld  ')).toBe('hello-world');
    expect(slugify('***')).toBe('item');
  });

  it('disambiguates against taken slugs', () => {
    const taken = new Set(['button', 'button-2']);
    expect(uniqueSlug('Button', taken)).toBe('button-3');
    expect(uniqueSlug('Fresh', taken)).toBe('fresh');
  });
});

describe('matchesFilter / filterItems', () => {
  const items: LibraryItem[] = [
    item({
      id: '1',
      name: 'Blue Button',
      type: 'prefab',
      tags: ['ui', 'button'],
      scope: 'builtin',
    }),
    item({ id: '2', name: 'Click Sound', type: 'audio', tags: ['sfx'], scope: 'user' }),
    item({ id: '3', name: 'Hero Sprite', type: 'image', tags: ['character'], scope: 'user' }),
  ];

  it('filters by scope', () => {
    expect(filterItems(items, { scopes: ['user'] }).map(i => i.manifest.id)).toEqual(['2', '3']);
  });

  it('filters by type', () => {
    expect(filterItems(items, { types: ['prefab'] }).map(i => i.manifest.id)).toEqual(['1']);
  });

  it('requires every filter tag', () => {
    expect(matchesFilter(items[0], { tags: ['ui', 'button'] })).toBe(true);
    expect(matchesFilter(items[0], { tags: ['ui', 'missing'] })).toBe(false);
  });

  it('token-AND text search over name/tags/type/description', () => {
    expect(filterItems(items, { query: 'blue button' }).map(i => i.manifest.id)).toEqual(['1']);
    expect(filterItems(items, { query: 'sfx' }).map(i => i.manifest.id)).toEqual(['2']);
    expect(filterItems(items, { query: 'nomatch' })).toEqual([]);
  });

  it('combines filters', () => {
    expect(
      filterItems(items, { scopes: ['user'], types: ['image'], query: 'hero' }).map(
        i => i.manifest.id
      )
    ).toEqual(['3']);
  });

  it('collects sorted distinct tags', () => {
    expect(collectTags(items)).toEqual(['button', 'character', 'sfx', 'ui']);
  });
});
