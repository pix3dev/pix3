/**
 * Asset Library shared model.
 *
 * One item format, three sources (scope). An item is a *bundle* — a manifest
 * (`item.json`) plus one or more files with bundle-relative paths — not a single
 * file. A lone image is the degenerate one-file bundle. See `.plans/asset-library.md`.
 */

import { categorizeAssetPath, type AssetCategoryId } from '@/core/asset-categories';

/** Where an item is stored. UI/search work over the aggregate and stay scope-agnostic. */
export type LibraryScope = 'builtin' | 'user' | 'team';

/**
 * Insertion-relevant type of an item. Superset of the asset-browser categories: it
 * distinguishes `prefab`/`scene`/`material`/`shader` which all live in category files.
 */
export type LibraryItemType =
  | 'prefab'
  | 'scene'
  | 'image'
  | 'font'
  | 'audio'
  | 'shader'
  | 'script'
  | 'material';

/** Provenance of the item, for filtering/telemetry. */
export type LibraryItemSource = 'generated' | 'packed' | 'imported';

/**
 * The manifest persisted as `item.json` inside a bundle. Paths in `preview`, `entry`
 * and `files` are bundle-relative (never `res://`). Absolute `res://` paths only ever
 * appear *inside* bundled `.pix3scene`/script files and are remapped on insert.
 */
export interface LibraryItemManifest {
  /** Stable id (for sync/updates), independent of slug/name. */
  id: string;
  /** Folder name used when inserting into a project (`res://assets/library/<slug>/`). */
  slug: string;
  name: string;
  type: LibraryItemType;
  tags: string[];
  /**
   * Author-assigned collection within a source (e.g. `ui`, `brand`, `characters`). Editable
   * sources let the user create/assign these; read-only sources declare theirs in source config.
   * Absent ⇒ the item only appears under the aggregate ("All") category.
   */
  category?: string;
  description?: string;
  /** Bundle-relative thumbnail path, e.g. `preview.png`. */
  preview?: string;
  /** Bundle-relative main file (for prefab/scene/script), e.g. `button.pix3scene`. */
  entry?: string;
  /** Every file in the bundle, bundle-relative, including `entry` and `preview`. */
  files: string[];
  /**
   * Bundle-relative paths that must be restored to their ORIGINAL project-relative locations on
   * insert (user scripts + assets referenced from script code), instead of being copied under
   * `res://assets/library/<slug>/`. References to these files are never remapped — the files are
   * written verbatim, and their `res://`/import paths only resolve at the original layout. Absent
   * ⇒ empty (pre-existing items keep the fully-namespaced behavior).
   */
  originalPathFiles?: string[];
  source: LibraryItemSource;
  /**
   * SPDX-ish license id. Required for builtin/public (white-listed: OFL, CC0, MIT,
   * CC-BY). A license *file* should also live inside the bundle when attribution is
   * required — the snapshot insert carries it into the project. Optional for team scope.
   */
  license?: string;
  authorId?: string;
  /** Epoch millis. */
  createdAt: number;
  /** Epoch millis. */
  updatedAt: number;
}

/**
 * A library item as seen by the UI: its manifest plus the scope it came from.
 * The scope is supplied by the provider, never stored in the manifest.
 */
export interface LibraryItem {
  readonly scope: LibraryScope;
  readonly manifest: LibraryItemManifest;
}

/** A fully-materialized bundle: manifest plus every file as a Blob, keyed bundle-relative. */
export interface LibraryBundle {
  readonly manifest: LibraryItemManifest;
  readonly files: ReadonlyMap<string, Blob>;
}

/**
 * A storage backend for one scope. `AssetLibraryService` aggregates providers and never
 * inspects the scope beyond routing writes. `put`/`delete` are optional (builtin is read-only).
 */
export interface LibraryProvider {
  readonly scope: LibraryScope;
  /** Whether this provider can run in the current environment (e.g. IndexedDB/OPFS present). */
  isSupported(): boolean;
  list(): Promise<LibraryItem[]>;
  getBundle(id: string): Promise<LibraryBundle | null>;
  /** Resolve a thumbnail URL for an item without materializing the whole bundle. */
  getPreviewUrl?(id: string): Promise<string | null>;
  put?(bundle: LibraryBundle): Promise<LibraryItem>;
  delete?(id: string): Promise<void>;
  /** Notified when this provider's contents change (write providers only). */
  subscribe?(listener: () => void): () => void;
}

const CATEGORY_BY_ITEM_TYPE: Readonly<Record<LibraryItemType, AssetCategoryId>> = {
  prefab: 'scenes',
  scene: 'scenes',
  image: 'images',
  font: 'fonts',
  audio: 'audio',
  shader: 'other',
  script: 'scripts',
  material: 'other',
};

/** Map an item type to the canonical asset-browser category (for shared filter chips/icons). */
export function categoryForItemType(type: LibraryItemType): AssetCategoryId {
  return CATEGORY_BY_ITEM_TYPE[type];
}

/**
 * Best-effort item type for a file path, reusing the canonical classifier. `.pix3scene`
 * defaults to `prefab` (the common library case); callers with a known scene entry can
 * override to `scene`.
 */
export function inferItemTypeFromPath(path: string): LibraryItemType {
  const category = categorizeAssetPath(path);
  switch (category) {
    case 'scenes':
      return 'prefab';
    case 'images':
      return 'image';
    case 'fonts':
      return 'font';
    case 'audio':
      return 'audio';
    case 'scripts':
      return 'script';
    default:
      return 'image';
  }
}

/** All item types, in a stable display order (for filter chips). */
export const LIBRARY_ITEM_TYPES: readonly LibraryItemType[] = [
  'prefab',
  'scene',
  'image',
  'font',
  'audio',
  'shader',
  'script',
  'material',
];

/** All scopes, in display order. */
export const LIBRARY_SCOPES: readonly LibraryScope[] = ['builtin', 'user', 'team'];

/** Human labels for scopes (UI). */
export const LIBRARY_SCOPE_LABELS: Readonly<Record<LibraryScope, string>> = {
  builtin: 'Built-in',
  user: 'My',
  team: 'Team',
};
