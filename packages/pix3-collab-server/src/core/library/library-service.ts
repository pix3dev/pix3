import { getDb } from '../db.js';

/** Visibility of a library item. `private` is per-owner; `team` is a reserved shared scope. */
export type LibraryItemVisibility = 'private' | 'team';

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
