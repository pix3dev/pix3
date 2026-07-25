/**
 * Asset Library *source* model — the left-rail catalogue the user browses.
 *
 * A source is a presentation-layer grouping over the storage scopes: several sources can be
 * config-declared (Team, Store, external providers) while only some are wired to a real
 * {@link LibraryProvider} today. The rail renders from {@link LIBRARY_SOURCES}, never hard-codes
 * rows, so adding a provider is a config edit. Categories are per-source: editable sources derive
 * them from item manifests (+ user-created names), read-only sources declare them here.
 *
 * See `.plans/asset-library.md`. The Store is server-backed (`StoreLibraryProvider`, with the
 * builtin pack as its offline fallback); Team and the external providers are declared but list no
 * items until their backends land.
 */

import type { LibraryItem, LibraryScope, StoreCategory } from './library-types';

/** How a source behaves: whether it is writable and what metadata its cards show. */
export type LibrarySourceKind = 'personal' | 'team' | 'store' | 'provider';

/** A rail category. `id` is stable/slug-like; `label` is shown. */
export interface LibrarySourceCategory {
  readonly id: string;
  readonly label: string;
}

export interface LibrarySourceConfig {
  readonly id: string;
  readonly name: string;
  readonly kind: LibrarySourceKind;
  /** IconService (Feather) name for the rail row. */
  readonly icon: string;
  /**
   * Editable *by design* (the user's own / team content). Not the whole story for the store,
   * whose write access depends on the signed-in user — ask {@link canEditSource} instead of
   * reading this flag in UI code.
   */
  readonly editable: boolean;
  /** Short read-only hint shown on the rail badge / inspector subtitle. */
  readonly hint: string;
  /** Real storage scope backing this source, when one exists. Absent ⇒ config-only (empty for now). */
  readonly scope?: LibraryScope;
  /** Label of the always-first aggregate category ("All" / "Featured"). */
  readonly aggregateLabel: string;
  /**
   * Declared categories for read-only sources. Editable sources derive theirs from items, and
   * the store overrides these with the server taxonomy when it is reachable (they stay as the
   * offline fallback).
   */
  readonly categories?: readonly LibrarySourceCategory[];
}

/**
 * The catalogue. Order is the rail order. `user`/`store` are wired to the real user (OPFS) and
 * store (server + builtin fallback) providers; `team`/providers are declared but list no items
 * until the server lands.
 */
export const LIBRARY_SOURCES: readonly LibrarySourceConfig[] = [
  {
    id: 'user',
    name: 'My Library',
    kind: 'personal',
    icon: 'package',
    editable: true,
    hint: 'local · synced',
    scope: 'user',
    aggregateLabel: 'All',
  },
  {
    id: 'team',
    name: 'Team',
    kind: 'team',
    icon: 'users',
    editable: true,
    hint: 'shared · org',
    scope: 'team',
    aggregateLabel: 'All',
  },
  {
    id: 'store',
    name: 'Pix3 Store',
    kind: 'store',
    icon: 'tag',
    editable: false,
    hint: 'official',
    scope: 'store',
    aggregateLabel: 'Featured',
    categories: [
      { id: 'ui', label: 'UI Kits' },
      { id: 'char', label: 'Characters' },
      { id: 'env', label: 'Environments' },
      { id: 'vfx', label: 'VFX' },
      { id: 'audio', label: 'Audio' },
      { id: 'shader', label: 'Shaders' },
    ],
  },
  {
    id: 'kenney',
    name: 'Kenney.nl',
    kind: 'provider',
    icon: 'globe',
    editable: false,
    hint: 'CC0 · provider',
    aggregateLabel: 'All packs',
    categories: [
      { id: 'ui', label: 'UI' },
      { id: 'char', label: 'Characters' },
      { id: 'env', label: 'Environments' },
      { id: 'audio', label: 'Audio' },
    ],
  },
];

/**
 * Whether the signed-in user may write to a source right now: personal/team are editable by
 * design, the curated store only for an admin. A pure function taking the context (rather than
 * reading `appState` here) keeps this config module testable and free of state imports; callers
 * pass `{ isAdmin: appState.auth.user?.is_admin ?? false }` and re-render on auth changes.
 */
export function canEditSource(
  source: LibrarySourceConfig,
  ctx: { readonly isAdmin: boolean }
): boolean {
  return source.editable || (source.kind === 'store' && ctx.isAdmin);
}

/** Items belonging to a source: everything from its backing scope, or none for config-only sources. */
export function itemsForSource(
  source: LibrarySourceConfig,
  items: readonly LibraryItem[]
): LibraryItem[] {
  if (!source.scope) {
    return [];
  }
  return items.filter(item => item.scope === source.scope);
}

const CUSTOM_CATEGORY_KEY = (sourceId: string) => `pix3.library.categories:${sourceId}`;

/** Slugify a free-text category label into a stable id. */
function categorySlug(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'category'
  );
}

/** User-created (possibly empty) categories for an editable source, persisted per source. */
function loadCustomCategories(sourceId: string): LibrarySourceCategory[] {
  try {
    const raw = localStorage.getItem(CUSTOM_CATEGORY_KEY(sourceId));
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(
        (entry): entry is LibrarySourceCategory =>
          typeof entry?.id === 'string' && typeof entry?.label === 'string'
      )
      .map(entry => ({ id: entry.id, label: entry.label }));
  } catch {
    return [];
  }
}

/** Persist a new user category label; returns the resulting category (idempotent by id). */
export function addCustomCategory(sourceId: string, label: string): LibrarySourceCategory {
  const category: LibrarySourceCategory = { id: categorySlug(label), label: label.trim() };
  const existing = loadCustomCategories(sourceId);
  if (!existing.some(entry => entry.id === category.id)) {
    try {
      localStorage.setItem(CUSTOM_CATEGORY_KEY(sourceId), JSON.stringify([...existing, category]));
    } catch {
      // Non-fatal: the category just won't survive a reload.
    }
  }
  return category;
}

/** Top-level nodes of a server taxonomy, in curated order — what the rail renders. */
export function topLevelCategories(
  declared: readonly StoreCategory[] = []
): readonly StoreCategory[] {
  return declared
    .filter(category => !category.parentId)
    .slice()
    .sort(compareCategories);
}

/** Children of one taxonomy node, in curated order — what the subcategory chips render. */
export function subcategoriesOf(
  declared: readonly StoreCategory[] = [],
  parentId: string
): readonly StoreCategory[] {
  return declared
    .filter(category => category.parentId === parentId)
    .slice()
    .sort(compareCategories);
}

function compareCategories(a: StoreCategory, b: StoreCategory): number {
  return a.sortOrder - b.sortOrder || a.label.localeCompare(b.label);
}

/**
 * The rail categories for a source: always the aggregate first, then either the declared
 * categories (read-only) or the union of item-assigned + user-created categories (editable).
 *
 * `declared` carries a server taxonomy (the store's) and, when present, replaces the config
 * categories of a read-only source. Only its top level goes on the rail — the rail stays flat,
 * subcategories surface as chips (see {@link subcategoriesOf}). Omitting it keeps the previous
 * behavior exactly, which is also the offline path.
 */
export function categoriesForSource(
  source: LibrarySourceConfig,
  sourceItems: readonly LibraryItem[],
  declared?: readonly StoreCategory[]
): LibrarySourceCategory[] {
  const aggregate: LibrarySourceCategory = { id: 'all', label: source.aggregateLabel };

  if (!source.editable) {
    if (declared && declared.length > 0) {
      return [aggregate, ...topLevelCategories(declared).map(({ id, label }) => ({ id, label }))];
    }
    return [aggregate, ...(source.categories ?? [])];
  }

  const byId = new Map<string, LibrarySourceCategory>();
  for (const item of sourceItems) {
    const id = item.manifest.category;
    if (id && !byId.has(id)) {
      byId.set(id, { id, label: labelForCategoryId(id) });
    }
  }
  for (const custom of loadCustomCategories(source.id)) {
    if (!byId.has(custom.id)) {
      byId.set(custom.id, custom);
    }
  }
  return [aggregate, ...byId.values()];
}

/**
 * Count of items in a source under a category id (`all` ⇒ every item in the source).
 *
 * Store items live on the hierarchical `categoryPath`, so a top-level count includes its
 * subcategories (`ui` counts `ui/buttons`); user/team items keep the flat `manifest.category`.
 * An item is matched by whichever field it carries, so a mixed list counts correctly.
 */
export function countItemsInCategory(
  categoryId: string,
  sourceItems: readonly LibraryItem[]
): number {
  if (categoryId === 'all') {
    return sourceItems.length;
  }
  return sourceItems.filter(item => {
    const { category, categoryPath } = item.manifest;
    if (categoryPath) {
      return categoryPath === categoryId || categoryPath.startsWith(`${categoryId}/`);
    }
    return category === categoryId;
  }).length;
}

/** Best-effort human label from a category id when no explicit label was recorded. */
function labelForCategoryId(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
