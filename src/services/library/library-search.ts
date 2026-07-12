/**
 * Pure helpers for the Asset Library: slug generation and the in-memory search/filter
 * over the aggregated item list. Kept free of storage/DOM so they are trivially testable.
 */

import type { LibraryItem, LibraryItemType, LibraryScope } from './library-types';

/** Turn an arbitrary name into a filesystem-safe, lower-kebab slug. Never empty. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || 'item';
}

/** Ensure a slug is unique against a set of taken slugs by appending `-2`, `-3`, … */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  const slug = slugify(base);
  if (!taken.has(slug)) {
    return slug;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${slug}-${n}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

export interface LibraryFilter {
  /** Free-text query matched against name + tags + description (substring, token AND). */
  readonly query?: string;
  /** When set, only items of these types pass. */
  readonly types?: readonly LibraryItemType[];
  /** When set, only items in these scopes pass. */
  readonly scopes?: readonly LibraryScope[];
  /** When set, an item must carry every one of these tags. */
  readonly tags?: readonly string[];
}

/** Build the lower-cased searchable haystack for an item (name + tags + description + type). */
export function itemHaystack(item: LibraryItem): string {
  const { manifest } = item;
  return [manifest.name, manifest.type, manifest.description ?? '', ...manifest.tags]
    .join(' ')
    .toLowerCase();
}

/** Does a single item pass the filter? */
export function matchesFilter(item: LibraryItem, filter: LibraryFilter): boolean {
  const { manifest } = item;

  if (filter.scopes && filter.scopes.length > 0 && !filter.scopes.includes(item.scope)) {
    return false;
  }
  if (filter.types && filter.types.length > 0 && !filter.types.includes(manifest.type)) {
    return false;
  }
  if (filter.tags && filter.tags.length > 0) {
    const itemTags = new Set(manifest.tags.map(tag => tag.toLowerCase()));
    if (!filter.tags.every(tag => itemTags.has(tag.toLowerCase()))) {
      return false;
    }
  }
  const query = filter.query?.trim().toLowerCase();
  if (query) {
    const haystack = itemHaystack(item);
    const tokens = query.split(/\s+/).filter(Boolean);
    if (!tokens.every(token => haystack.includes(token))) {
      return false;
    }
  }
  return true;
}

/** Apply a filter to a list, preserving input order. */
export function filterItems(items: readonly LibraryItem[], filter: LibraryFilter): LibraryItem[] {
  return items.filter(item => matchesFilter(item, filter));
}

/** Distinct, sorted tag list across items (for the tag filter UI). */
export function collectTags(items: readonly LibraryItem[]): string[] {
  const tags = new Set<string>();
  for (const item of items) {
    for (const tag of item.manifest.tags) {
      tags.add(tag);
    }
  }
  return [...tags].sort((a, b) => a.localeCompare(b));
}
