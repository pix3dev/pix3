import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config.js';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function initDb(): Database.Database {
  const dbPath = path.resolve(config.DB_PATH);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  return db;
}

/**
 * Single definition of the `library_items` base shape: used both to create it on a fresh
 * database and to rebuild it when an older CHECK constraint has to be widened.
 */
const LIBRARY_ITEMS_DDL = `
    CREATE TABLE IF NOT EXISTS library_items (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      visibility TEXT NOT NULL DEFAULT 'private'
        CHECK(visibility IN ('private', 'team', 'public')),
      manifest TEXT,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0
    );`;

/**
 * Idempotent schema setup. Exported so tests (and any future CLI) can run it against a
 * database they own instead of the process-wide singleton.
 */
export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      avatar_url TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      share_token TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner', 'editor', 'viewer')),
      PRIMARY KEY (project_id, user_id)
    );

    -- Personal ("private") Asset Library items, synced from the editor's OPFS/IndexedDB store.
    -- One row per bundle. \`updated_at\` is an epoch-ms authoritative timestamp for last-write-wins
    -- sync (either the manifest's updatedAt on write, or the delete time). \`deleted\` keeps a
    -- tombstone so a delete on one device propagates to others on the next pull. \`visibility\`
    -- is 'private' for personal items, 'public' for curated Asset Store items; 'team' is
    -- reserved for the shared scope (same mechanism, wider read).
    ${LIBRARY_ITEMS_DDL}
  `);

  migrateLibraryItemsVisibility(db);
  addLibraryItemStoreColumns(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_library_items_owner
      ON library_items(owner_id, visibility);

    -- Store listing always filters on this triple, so it stays a covering-ish lookup.
    CREATE INDEX IF NOT EXISTS idx_library_items_public
      ON library_items(visibility, status, category_path);

    -- Curated Asset Store taxonomy. \`id\` IS the full path ('ui', 'ui/buttons'), so items
    -- reference a category by a single opaque string and no path parsing is needed.
    -- Depth is capped at 2 by code (see library-service.ts), not by the schema.
    CREATE TABLE IF NOT EXISTS library_categories (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES library_categories(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Append-only trail of admin store mutations. Store deletes are hard deletes, so this
    -- is the only record that an item ever existed.
    CREATE TABLE IF NOT EXISTS library_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      item_id TEXT,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * SQLite cannot ALTER a CHECK constraint, so a database created before the Asset Store
 * still rejects `visibility = 'public'`. Rebuild the table when its stored DDL predates it.
 * Only the six original columns are copied — the store columns below are (re-)added right
 * after, and the production database has no store rows to lose (plan §4).
 */
function migrateLibraryItemsVisibility(db: Database.Database): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'library_items'`)
    .get() as { sql: string | null } | undefined;
  if (!row?.sql || row.sql.includes(`'public'`)) {
    return;
  }

  // A table RENAME rewrites FK references in *other* tables unless foreign_keys is off, and
  // a pragma cannot change inside a transaction — hence pragma off → transaction → pragma on.
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE library_items RENAME TO library_items_old;
        ${LIBRARY_ITEMS_DDL}
        INSERT INTO library_items (id, owner_id, visibility, manifest, updated_at, deleted)
          SELECT id, owner_id, visibility, manifest, updated_at, deleted FROM library_items_old;
        DROP TABLE library_items_old;
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/** Asset Store columns: everything the server filters, sorts or authorizes on. */
const LIBRARY_ITEM_STORE_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: 'status', ddl: `status TEXT NOT NULL DEFAULT 'published'` },
  { name: 'category_path', ddl: 'category_path TEXT' },
  { name: 'featured', ddl: 'featured INTEGER NOT NULL DEFAULT 0' },
  { name: 'downloads', ddl: 'downloads INTEGER NOT NULL DEFAULT 0' },
  { name: 'published_at', ddl: 'published_at INTEGER' },
];

function addLibraryItemStoreColumns(db: Database.Database): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(library_items)').all() as Array<{ name: string }>).map(
      column => column.name
    )
  );
  for (const column of LIBRARY_ITEM_STORE_COLUMNS) {
    if (!existing.has(column.name)) {
      db.exec(`ALTER TABLE library_items ADD COLUMN ${column.ddl};`);
    }
  }
}
