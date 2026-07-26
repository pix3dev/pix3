import { getDb } from '../db.js';

/**
 * Visibility of a library item. `private` is per-owner; `public` is the curated Asset Store
 * (admin-written, world-readable); `team` is a reserved shared scope.
 */
export type LibraryItemVisibility = 'private' | 'team' | 'public';

/** A row as stored in `library_items` (manifest kept as a JSON string). */
export interface LibraryItemRow {
  id: string;
  owner_id: string;
  visibility: LibraryItemVisibility;
  manifest: string | null;
  updated_at: number;
  deleted: number;
}

/**
 * The sync-facing shape returned to the editor: the parsed manifest plus the authoritative
 * `updatedAt` and a `deleted` tombstone flag. Deleted rows carry no manifest.
 */
export interface LibraryItemIndexEntry {
  id: string;
  visibility: LibraryItemVisibility;
  manifest: unknown | null;
  updatedAt: number;
  deleted: boolean;
}

function toIndexEntry(row: LibraryItemRow): LibraryItemIndexEntry {
  return {
    id: row.id,
    visibility: row.visibility,
    manifest: row.manifest ? (JSON.parse(row.manifest) as unknown) : null,
    updatedAt: row.updated_at,
    deleted: row.deleted === 1,
  };
}

/** Full private index for an owner, including tombstones (the editor reconciles both). */
export function listOwnerLibraryItems(ownerId: string): LibraryItemIndexEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT id, owner_id, visibility, manifest, updated_at, deleted
       FROM library_items
       WHERE owner_id = ? AND visibility = 'private'
       ORDER BY updated_at DESC`
    )
    .all(ownerId) as LibraryItemRow[];
  return rows.map(toIndexEntry);
}

/** A single row scoped to its owner (used to authorize file downloads / deletes). */
export function getOwnerLibraryItem(ownerId: string, id: string): LibraryItemRow | undefined {
  return getDb()
    .prepare('SELECT * FROM library_items WHERE id = ? AND owner_id = ?')
    .get(id, ownerId) as LibraryItemRow | undefined;
}

/**
 * Create or replace an item (clears any tombstone). `updatedAt` is the client-supplied
 * authoritative timestamp used for last-write-wins on the next sync.
 */
export function upsertLibraryItem(
  ownerId: string,
  id: string,
  manifest: unknown,
  updatedAt: number,
  visibility: LibraryItemVisibility = 'private'
): void {
  getDb()
    .prepare(
      `INSERT INTO library_items (id, owner_id, visibility, manifest, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET
         visibility = excluded.visibility,
         manifest = excluded.manifest,
         updated_at = excluded.updated_at,
         deleted = 0`
    )
    .run(id, ownerId, visibility, JSON.stringify(manifest), updatedAt);
}

/** Tombstone an item: keep the row (for propagation) but drop its manifest and mark deleted. */
export function softDeleteLibraryItem(ownerId: string, id: string, deletedAt: number): boolean {
  const result = getDb()
    .prepare(
      `UPDATE library_items
       SET deleted = 1, manifest = NULL, updated_at = ?
       WHERE id = ? AND owner_id = ?`
    )
    .run(deletedAt, id, ownerId);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Curated Asset Store (visibility = 'public')
// ---------------------------------------------------------------------------

/** Store lifecycle: `unlisted` stays reachable by direct id but drops out of the listing. */
export type StoreItemStatus = 'draft' | 'published' | 'unlisted';

export const STORE_ITEM_STATUSES: readonly StoreItemStatus[] = ['draft', 'published', 'unlisted'];

export function isStoreItemStatus(value: unknown): value is StoreItemStatus {
  return typeof value === 'string' && (STORE_ITEM_STATUSES as readonly string[]).includes(value);
}

/** A `library_items` row including the store-only columns. */
export interface StoreItemRow extends LibraryItemRow {
  status: StoreItemStatus;
  category_path: string | null;
  featured: number;
  downloads: number;
  published_at: number | null;
}

/** The store-facing shape returned to clients. */
export interface StoreItem {
  id: string;
  manifest: Record<string, unknown> | null;
  updatedAt: number;
  status: StoreItemStatus;
  categoryPath: string | null;
  featured: boolean;
  downloads: number;
  publishedAt: number | null;
}

/** Column values the server owns; the client manifest is never trusted for these. */
export interface StoreItemColumns {
  status: StoreItemStatus;
  categoryPath: string | null;
  featured: boolean;
  publishedAt: number | null;
}

export interface StoreListFilter {
  q?: string;
  categoryPath?: string;
  type?: string;
  status?: StoreItemStatus;
  sort?: StoreListSort;
}

export type StoreListSort = 'updated' | 'downloads' | 'featured';

const STORE_ROW_COLUMNS = `id, owner_id, visibility, manifest, updated_at, deleted,
       status, category_path, featured, downloads, published_at`;

/**
 * Re-stamp the server-owned fields onto the manifest we hand out. The columns are the source
 * of truth for downloads/featured/status/categoryPath/publisher, so a stale (or forged)
 * manifest copy of them can never leak to clients.
 */
function toStoreItem(row: StoreItemRow): StoreItem {
  const parsed = row.manifest ? (JSON.parse(row.manifest) as Record<string, unknown>) : null;
  const manifest = parsed
    ? {
        ...parsed,
        status: row.status,
        categoryPath: row.category_path,
        featured: row.featured === 1,
        downloads: row.downloads,
        publisherId: row.owner_id,
      }
    : null;
  return {
    id: row.id,
    manifest,
    updatedAt: row.updated_at,
    status: row.status,
    categoryPath: row.category_path,
    featured: row.featured === 1,
    downloads: row.downloads,
    publishedAt: row.published_at,
  };
}

/** LIKE metacharacters in user input must not act as wildcards. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`);
}

/**
 * Public store listing. `includeNonPublished` is the admin bit: everybody else is pinned to
 * `status = 'published'` regardless of what they ask for.
 */
export function listPublicItems(
  filter: StoreListFilter,
  includeNonPublished: boolean
): StoreItem[] {
  const where: string[] = [`visibility = 'public'`, 'deleted = 0'];
  const params: Array<string | number> = [];

  if (!includeNonPublished) {
    where.push(`status = 'published'`);
  } else if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }

  if (filter.categoryPath) {
    // A category matches itself and everything below it ('ui' also lists 'ui/buttons').
    where.push(`(category_path = ? OR category_path LIKE ? ESCAPE '\\')`);
    params.push(filter.categoryPath, `${escapeLike(filter.categoryPath)}/%`);
  }

  if (filter.type) {
    where.push(`json_extract(manifest, '$.type') = ?`);
    params.push(filter.type);
  }

  if (filter.q) {
    // Free-text search runs as a LIKE over the raw manifest JSON: name, tags and description
    // all live inside it, and the catalog is a curated few-hundred rows — an FTS index (or a
    // normalized tag table) would cost more to keep in sync than the scan costs to run.
    where.push(`lower(manifest) LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(filter.q.toLowerCase())}%`);
  }

  const orderBy =
    filter.sort === 'downloads'
      ? 'downloads DESC, updated_at DESC'
      : filter.sort === 'featured'
        ? 'featured DESC, updated_at DESC'
        : 'updated_at DESC';

  const rows = getDb()
    .prepare(
      `SELECT ${STORE_ROW_COLUMNS}
       FROM library_items
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderBy}`
    )
    .all(...params) as StoreItemRow[];
  return rows.map(toStoreItem);
}

/** A single store item by id, regardless of status (the router gates drafts). */
export function getPublicItem(id: string): StoreItem | null {
  const row = getDb()
    .prepare(
      `SELECT ${STORE_ROW_COLUMNS}
       FROM library_items
       WHERE id = ? AND visibility = 'public' AND deleted = 0`
    )
    .get(id) as StoreItemRow | undefined;
  return row ? toStoreItem(row) : null;
}

/**
 * Create or replace a store item. `downloads` is deliberately absent from the UPDATE clause:
 * a re-upload must not reset the counter.
 */
export function upsertPublicItem(
  ownerId: string,
  id: string,
  manifest: unknown,
  updatedAt: number,
  columns: StoreItemColumns
): void {
  getDb()
    .prepare(
      `INSERT INTO library_items
         (id, owner_id, visibility, manifest, updated_at, deleted,
          status, category_path, featured, published_at)
       VALUES (?, ?, 'public', ?, ?, 0, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         owner_id = excluded.owner_id,
         visibility = 'public',
         manifest = excluded.manifest,
         updated_at = excluded.updated_at,
         deleted = 0,
         status = excluded.status,
         category_path = excluded.category_path,
         featured = excluded.featured,
         published_at = excluded.published_at`
    )
    .run(
      id,
      ownerId,
      JSON.stringify(manifest),
      updatedAt,
      columns.status,
      columns.categoryPath,
      columns.featured ? 1 : 0,
      columns.publishedAt
    );
}

/**
 * Drop the row outright. Store items take part in no two-way sync, so there is nothing for a
 * tombstone to propagate to — the audit log is the history. Bundle files are the caller's job.
 */
export function hardDeletePublicItem(id: string): boolean {
  const result = getDb()
    .prepare(`DELETE FROM library_items WHERE id = ? AND visibility = 'public'`)
    .run(id);
  return result.changes > 0;
}

/** +1 download; returns the new count, or null when the item does not exist. */
export function bumpDownloads(id: string): number | null {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE library_items SET downloads = downloads + 1
       WHERE id = ? AND visibility = 'public' AND deleted = 0`
    )
    .run(id);
  if (result.changes === 0) {
    return null;
  }
  const row = db.prepare('SELECT downloads FROM library_items WHERE id = ?').get(id) as
    | { downloads: number }
    | undefined;
  return row?.downloads ?? null;
}

// --- Categories -------------------------------------------------------------

export interface StoreCategory {
  id: string;
  parentId: string | null;
  label: string;
  sortOrder: number;
  /** Published items directly in this category (subcategories count separately). */
  itemCount: number;
}

export interface StoreCategoryInput {
  id: string;
  parentId?: string | null;
  label: string;
  sortOrder?: number;
}

/** Thrown for taxonomy shape violations; the router turns it into a 400. */
export class StoreCategoryError extends Error {}

const CATEGORY_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The taxonomy is intentionally two levels deep (Unity/Fab-style), and `id` is the full path,
 * so a subcategory id must literally be `<parentId>/<segment>`.
 */
function assertCategoryShape(
  db: ReturnType<typeof getDb>,
  id: string,
  parentId: string | null
): void {
  const segments = id.split('/');
  if (segments.length > 2 || segments.some(segment => !CATEGORY_SEGMENT.test(segment))) {
    throw new StoreCategoryError(
      `Invalid category id "${id}": expected 'slug' or 'parent-slug/slug'`
    );
  }

  if (parentId === null) {
    if (segments.length !== 1) {
      throw new StoreCategoryError(`Category "${id}" needs a parentId`);
    }
    return;
  }

  if (parentId.includes('/')) {
    throw new StoreCategoryError(`Parent "${parentId}" is not a top-level category`);
  }
  if (id !== `${parentId}/${segments[1] ?? ''}`) {
    throw new StoreCategoryError(`Category id "${id}" must start with "${parentId}/"`);
  }
  const parent = db
    .prepare('SELECT id FROM library_categories WHERE id = ?')
    .get(parentId) as { id: string } | undefined;
  if (!parent) {
    throw new StoreCategoryError(`Parent category "${parentId}" does not exist`);
  }
}

/** Flat list (the client builds the two-level tree) with published-item counts. */
export function listCategories(): StoreCategory[] {
  const rows = getDb()
    .prepare(
      `SELECT c.id AS id, c.parent_id AS parent_id, c.label AS label,
              c.sort_order AS sort_order, COUNT(i.id) AS item_count
       FROM library_categories c
       LEFT JOIN library_items i
         ON i.category_path = c.id
        AND i.visibility = 'public'
        AND i.deleted = 0
        AND i.status = 'published'
       GROUP BY c.id, c.parent_id, c.label, c.sort_order
       ORDER BY c.sort_order ASC, c.id ASC`
    )
    .all() as Array<{
    id: string;
    parent_id: string | null;
    label: string;
    sort_order: number;
    item_count: number;
  }>;
  return rows.map(row => ({
    id: row.id,
    parentId: row.parent_id,
    label: row.label,
    sortOrder: row.sort_order,
    itemCount: row.item_count,
  }));
}

export function upsertCategory(input: StoreCategoryInput): StoreCategory {
  const db = getDb();
  const parentId = input.parentId ?? null;
  const label = input.label.trim();
  if (!label) {
    throw new StoreCategoryError('Category label is required');
  }
  assertCategoryShape(db, input.id, parentId);

  db.prepare(
    `INSERT INTO library_categories (id, parent_id, label, sort_order)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       parent_id = excluded.parent_id,
       label = excluded.label,
       sort_order = excluded.sort_order`
  ).run(input.id, parentId, label, input.sortOrder ?? 0);

  return {
    id: input.id,
    parentId,
    label,
    sortOrder: input.sortOrder ?? 0,
    itemCount: 0,
  };
}

/**
 * Rename / reorder. `parentId` is not patchable on purpose: the id *is* the path, so a move
 * is a delete + recreate (which also has to re-bind the items).
 */
export function updateCategory(
  id: string,
  patch: { label?: string; sortOrder?: number }
): boolean {
  const sets: string[] = [];
  const params: Array<string | number> = [];
  if (patch.label !== undefined) {
    const label = patch.label.trim();
    if (!label) {
      throw new StoreCategoryError('Category label is required');
    }
    sets.push('label = ?');
    params.push(label);
  }
  if (patch.sortOrder !== undefined) {
    sets.push('sort_order = ?');
    params.push(patch.sortOrder);
  }
  if (sets.length === 0) {
    return categoryExists(id);
  }
  params.push(id);
  const result = getDb()
    .prepare(`UPDATE library_categories SET ${sets.join(', ')} WHERE id = ?`)
    .run(...params);
  return result.changes > 0;
}

function categoryExists(id: string): boolean {
  return Boolean(
    getDb().prepare('SELECT id FROM library_categories WHERE id = ?').get(id)
  );
}

/**
 * Delete a category and re-home its items in the same transaction: to the parent for a
 * subcategory, to "uncategorized" for a top-level one. Children are removed by the FK cascade,
 * but their items are re-bound explicitly here — the cascade knows nothing about `library_items`.
 * The manifest copy of `categoryPath` is rewritten alongside the column so the two can't drift.
 */
export function deleteCategory(id: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT id, parent_id FROM library_categories WHERE id = ?').get(id) as
    | { id: string; parent_id: string | null }
    | undefined;
  if (!row) {
    return false;
  }

  const nextPath = row.parent_id;
  const subtreePrefix = `${escapeLike(id)}/%`;

  db.transaction(() => {
    if (nextPath === null) {
      db.prepare(
        `UPDATE library_items
         SET category_path = NULL,
             manifest = CASE WHEN manifest IS NULL THEN NULL
                             ELSE json_remove(manifest, '$.categoryPath') END
         WHERE visibility = 'public'
           AND (category_path = ? OR category_path LIKE ? ESCAPE '\\')`
      ).run(id, subtreePrefix);
    } else {
      db.prepare(
        `UPDATE library_items
         SET category_path = ?,
             manifest = CASE WHEN manifest IS NULL THEN NULL
                             ELSE json_set(manifest, '$.categoryPath', ?) END
         WHERE visibility = 'public'
           AND (category_path = ? OR category_path LIKE ? ESCAPE '\\')`
      ).run(nextPath, nextPath, id, subtreePrefix);
    }
    db.prepare('DELETE FROM library_categories WHERE id = ?').run(id);
  })();

  return true;
}

// --- Audit log --------------------------------------------------------------

export type LibraryAuditAction =
  | 'item.upload'
  | 'item.publish'
  | 'item.unlist'
  | 'item.delete'
  | 'item.meta'
  | 'category.create'
  | 'category.update'
  | 'category.delete';

export interface LibraryAuditEntry {
  id: number;
  actorId: string;
  /** Actor's username, joined at read time. `null` once that user is gone — the trail survives. */
  actorName: string | null;
  action: string;
  itemId: string | null;
  detail: unknown;
  createdAt: string;
}

export function appendAudit(
  actorId: string,
  action: LibraryAuditAction,
  itemId: string | null,
  detail?: unknown
): void {
  getDb()
    .prepare(
      `INSERT INTO library_audit_log (actor_id, action, item_id, detail)
       VALUES (?, ?, ?, ?)`
    )
    .run(actorId, action, itemId, detail === undefined ? null : JSON.stringify(detail));
}

export function listAudit(limit: number, offset: number): LibraryAuditEntry[] {
  // LEFT JOIN, not INNER: an entry whose actor was deleted must still show up in the trail.
  const rows = getDb()
    .prepare(
      `SELECT a.id, a.actor_id, u.username AS actor_name, a.action, a.item_id, a.detail,
              a.created_at
       FROM library_audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
       ORDER BY a.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as Array<{
    id: number;
    actor_id: string;
    actor_name: string | null;
    action: string;
    item_id: string | null;
    detail: string | null;
    created_at: string;
  }>;
  return rows.map(row => ({
    id: row.id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    action: row.action,
    itemId: row.item_id,
    detail: row.detail ? (JSON.parse(row.detail) as unknown) : null,
    createdAt: row.created_at,
  }));
}
