// @vitest-environment node
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { runMigrations } from './db.js';

/**
 * The store migration has to work on databases created before the Asset Store existed, so
 * these run against a real sqlite file seeded with the *old* schema (in-memory would do, but
 * a temp file matches how the server actually opens it).
 */

const OLD_LIBRARY_ITEMS_DDL = `
  CREATE TABLE library_items (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private', 'team')),
    manifest TEXT,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_library_items_owner ON library_items(owner_id, visibility);
`;

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    column => column.name
  );
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
  );
}

describe('runMigrations', () => {
  let db: Database.Database | null = null;
  let dbPath: string | null = null;

  function openLegacyDb(): Database.Database {
    dbPath = path.join(os.tmpdir(), `pix3-migration-${randomUUID()}.sqlite`);
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        avatar_url TEXT,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      ${OLD_LIBRARY_ITEMS_DDL}
    `);
    db.prepare(
      `INSERT INTO users (id, email, username, password_hash) VALUES ('u1', 'a@b.c', 'a', 'x')`
    ).run();
    db.prepare(
      `INSERT INTO library_items (id, owner_id, visibility, manifest, updated_at, deleted)
       VALUES ('legacy-1', 'u1', 'private', '{"id":"legacy-1"}', 42, 0)`
    ).run();
    return db;
  }

  afterEach(() => {
    db?.close();
    db = null;
    if (dbPath) {
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
      dbPath = null;
    }
  });

  it('rejects public visibility before the migration', () => {
    const legacy = openLegacyDb();
    expect(() =>
      legacy
        .prepare(
          `INSERT INTO library_items (id, owner_id, visibility, updated_at)
           VALUES ('store-1', 'u1', 'public', 1)`
        )
        .run()
    ).toThrow();
  });

  it('widens the visibility CHECK and adds the store columns', () => {
    const migrated = openLegacyDb();
    runMigrations(migrated);

    expect(() =>
      migrated
        .prepare(
          `INSERT INTO library_items (id, owner_id, visibility, updated_at)
           VALUES ('store-1', 'u1', 'public', 1)`
        )
        .run()
    ).not.toThrow();

    const columns = tableColumns(migrated, 'library_items');
    expect(columns).toEqual(
      expect.arrayContaining(['status', 'category_path', 'featured', 'downloads', 'published_at'])
    );

    // A table rebuild drops the indexes with the old table — both must be back.
    const indexes = (
      migrated
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`)
        .all('library_items') as Array<{ name: string }>
    ).map(index => index.name);
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_library_items_owner', 'idx_library_items_public'])
    );

    // Defaults must be usable by rows inserted without the new columns.
    const row = migrated
      .prepare('SELECT status, featured, downloads, category_path FROM library_items WHERE id = ?')
      .get('store-1') as {
      status: string;
      featured: number;
      downloads: number;
      category_path: string | null;
    };
    expect(row).toEqual({
      status: 'published',
      featured: 0,
      downloads: 0,
      category_path: null,
    });
  });

  it('creates the store taxonomy and audit tables', () => {
    const migrated = openLegacyDb();
    runMigrations(migrated);

    expect(tableExists(migrated, 'library_categories')).toBe(true);
    expect(tableExists(migrated, 'library_audit_log')).toBe(true);

    // FK cascade is what removes subcategories when a top-level one is deleted.
    migrated
      .prepare(`INSERT INTO library_categories (id, parent_id, label) VALUES ('ui', NULL, 'UI')`)
      .run();
    migrated
      .prepare(
        `INSERT INTO library_categories (id, parent_id, label) VALUES ('ui/buttons', 'ui', 'Buttons')`
      )
      .run();
    migrated.prepare(`DELETE FROM library_categories WHERE id = 'ui'`).run();
    expect(migrated.prepare('SELECT COUNT(*) AS n FROM library_categories').get()).toEqual({
      n: 0,
    });
  });

  it('carries legacy rows over and is idempotent', () => {
    const migrated = openLegacyDb();
    runMigrations(migrated);
    runMigrations(migrated);
    runMigrations(migrated);

    expect(
      migrated.prepare('SELECT manifest FROM library_items WHERE id = ?').get('legacy-1')
    ).toEqual({ manifest: '{"id":"legacy-1"}' });
    // A repeated ADD COLUMN would have thrown; a repeated rebuild would have duplicated columns.
    expect(tableColumns(migrated, 'library_items').filter(name => name === 'status')).toHaveLength(
      1
    );
    expect(migrated.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('sets up a fresh database in one pass', () => {
    dbPath = path.join(os.tmpdir(), `pix3-migration-${randomUUID()}.sqlite`);
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    expect(tableColumns(db, 'library_items')).toEqual(
      expect.arrayContaining(['status', 'category_path', 'featured', 'downloads', 'published_at'])
    );
    expect(tableExists(db, 'library_categories')).toBe(true);
  });
});
