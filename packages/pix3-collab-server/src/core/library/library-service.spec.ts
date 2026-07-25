// @vitest-environment node
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Store queries and the category re-home transaction are pure SQL, so they run against a real
 * sqlite file: a mocked driver would only test the string we pass to it.
 */

let testDb: Database.Database | null = null;

vi.mock('../db.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../db.js')>();
  return { ...actual, getDb: () => testDb! };
});

const { runMigrations } = await import('../db.js');
const {
  StoreCategoryError,
  deleteCategory,
  getPublicItem,
  hardDeletePublicItem,
  bumpDownloads,
  listAudit,
  listCategories,
  listPublicItems,
  appendAudit,
  upsertCategory,
  upsertPublicItem,
} = await import('./library-service.js');

let dbPath: string | null = null;

function seedItem(
  id: string,
  manifest: Record<string, unknown>,
  columns: {
    status?: 'draft' | 'published' | 'unlisted';
    categoryPath?: string | null;
    featured?: boolean;
    updatedAt?: number;
  } = {}
): void {
  upsertPublicItem('u1', id, { id, ...manifest }, columns.updatedAt ?? 1, {
    status: columns.status ?? 'published',
    categoryPath: columns.categoryPath ?? null,
    featured: columns.featured ?? false,
    publishedAt: null,
  });
}

function ids(items: Array<{ id: string }>): string[] {
  return items.map(item => item.id);
}

/** The raw JSON as persisted (getPublicItem re-injects the server columns on read). */
function storedManifest(id: string): Record<string, unknown> {
  const row = testDb!.prepare('SELECT manifest FROM library_items WHERE id = ?').get(id) as {
    manifest: string;
  };
  return JSON.parse(row.manifest) as Record<string, unknown>;
}

describe('library-service store queries', () => {
  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `pix3-store-${randomUUID()}.sqlite`);
    testDb = new Database(dbPath);
    testDb.pragma('foreign_keys = ON');
    runMigrations(testDb);
    testDb
      .prepare(
        `INSERT INTO users (id, email, username, password_hash) VALUES ('u1', 'a@b.c', 'a', 'x')`
      )
      .run();
  });

  afterEach(() => {
    testDb?.close();
    testDb = null;
    if (dbPath) {
      fs.rmSync(dbPath, { force: true });
      dbPath = null;
    }
  });

  describe('listPublicItems', () => {
    beforeEach(() => {
      seedItem('pub', { name: 'Neon Button', tags: ['ui'], type: 'sprite' }, {
        categoryPath: 'ui/buttons',
        updatedAt: 30,
      });
      seedItem('draft', { name: 'Hidden', type: 'sprite' }, {
        status: 'draft',
        categoryPath: 'ui',
        updatedAt: 40,
      });
      seedItem('unlisted', { name: 'Secret', type: 'audio' }, {
        status: 'unlisted',
        updatedAt: 50,
      });
      seedItem('star', { name: 'Featured Pack', type: 'prefab' }, {
        featured: true,
        updatedAt: 10,
      });
    });

    it('hides everything but published items from non-admins', () => {
      expect(ids(listPublicItems({}, false)).sort()).toEqual(['pub', 'star']);
    });

    it('shows every status to an admin', () => {
      expect(ids(listPublicItems({}, true))).toEqual(['unlisted', 'draft', 'pub', 'star']);
    });

    it('filters an admin listing by status', () => {
      expect(ids(listPublicItems({ status: 'draft' }, true))).toEqual(['draft']);
    });

    it('matches a category and its subcategories', () => {
      expect(ids(listPublicItems({ categoryPath: 'ui' }, true)).sort()).toEqual(['draft', 'pub']);
      expect(ids(listPublicItems({ categoryPath: 'ui/buttons' }, true))).toEqual(['pub']);
    });

    it('filters by manifest type and free text', () => {
      expect(ids(listPublicItems({ type: 'audio' }, true))).toEqual(['unlisted']);
      expect(ids(listPublicItems({ q: 'NEON' }, false))).toEqual(['pub']);
      expect(ids(listPublicItems({ q: 'nothing-here' }, false))).toEqual([]);
    });

    it('treats LIKE metacharacters in the query as literals', () => {
      // Without the ESCAPE clause the escaped '%' would still glob and match every item.
      expect(ids(listPublicItems({ q: '%' }, false))).toEqual([]);
      expect(ids(listPublicItems({ q: 'neon_button' }, false))).toEqual([]);
      seedItem('literal', { name: '50% Off Pack', type: 'sprite' }, { updatedAt: 60 });
      expect(ids(listPublicItems({ q: '50%' }, false))).toEqual(['literal']);
    });

    it('sorts by featured and by downloads', () => {
      expect(ids(listPublicItems({ sort: 'featured' }, false))).toEqual(['star', 'pub']);
      bumpDownloads('pub');
      bumpDownloads('pub');
      expect(ids(listPublicItems({ sort: 'downloads' }, false))).toEqual(['pub', 'star']);
      expect(getPublicItem('pub')?.downloads).toBe(2);
    });

    it('injects the server-owned fields into the manifest it hands out', () => {
      bumpDownloads('star');
      const item = getPublicItem('star');
      expect(item?.manifest).toMatchObject({
        downloads: 1,
        featured: true,
        status: 'published',
        publisherId: 'u1',
      });
    });

    it('keeps the download counter across a re-upload', () => {
      bumpDownloads('pub');
      seedItem('pub', { name: 'Neon Button v2' }, { categoryPath: 'ui/buttons' });
      expect(getPublicItem('pub')?.downloads).toBe(1);
    });

    it('drops the row on hard delete', () => {
      expect(hardDeletePublicItem('pub')).toBe(true);
      expect(getPublicItem('pub')).toBeNull();
      expect(hardDeletePublicItem('pub')).toBe(false);
    });
  });

  describe('categories', () => {
    beforeEach(() => {
      upsertCategory({ id: 'ui', label: 'UI', sortOrder: 1 });
      upsertCategory({ id: 'ui/buttons', parentId: 'ui', label: 'Buttons', sortOrder: 2 });
      upsertCategory({ id: 'audio', label: 'Audio', sortOrder: 3 });
    });

    it('rejects a taxonomy deeper than two levels or with a bad parent', () => {
      expect(() => upsertCategory({ id: 'ui/buttons/round', parentId: 'ui/buttons', label: 'R' }))
        .toThrow(StoreCategoryError);
      expect(() => upsertCategory({ id: 'fx/glow', parentId: 'fx', label: 'Glow' })).toThrow(
        StoreCategoryError
      );
      expect(() => upsertCategory({ id: 'ui/pads', label: 'Pads' })).toThrow(StoreCategoryError);
    });

    it('counts published items per category', () => {
      seedItem('a', { name: 'A' }, { categoryPath: 'ui/buttons' });
      seedItem('b', { name: 'B' }, { categoryPath: 'ui/buttons', status: 'draft' });
      seedItem('c', { name: 'C' }, { categoryPath: 'ui' });

      const counts = Object.fromEntries(
        listCategories().map(category => [category.id, category.itemCount])
      );
      expect(counts).toEqual({ ui: 1, 'ui/buttons': 1, audio: 0 });
    });

    it('re-homes items to the parent when a subcategory is deleted', () => {
      seedItem('a', { name: 'A', categoryPath: 'ui/buttons' }, { categoryPath: 'ui/buttons' });

      expect(deleteCategory('ui/buttons')).toBe(true);

      expect(getPublicItem('a')?.categoryPath).toBe('ui');
      // The manifest copy must move with the column, or the two sources drift apart.
      expect(storedManifest('a')).toMatchObject({ categoryPath: 'ui' });
      expect(ids(listCategories())).toEqual(['ui', 'audio']);
    });

    it('uncategorizes the whole subtree when a top-level category is deleted', () => {
      seedItem('a', { name: 'A', categoryPath: 'ui' }, { categoryPath: 'ui' });
      seedItem('b', { name: 'B', categoryPath: 'ui/buttons' }, { categoryPath: 'ui/buttons' });
      seedItem('c', { name: 'C', categoryPath: 'audio' }, { categoryPath: 'audio' });

      expect(deleteCategory('ui')).toBe(true);

      expect(getPublicItem('a')?.categoryPath).toBeNull();
      expect(getPublicItem('b')?.categoryPath).toBeNull();
      // Read-back always re-injects the column value, so check the stored JSON directly:
      // the stale 'ui' / 'ui/buttons' strings must be gone from the manifest itself.
      expect(storedManifest('a')).not.toHaveProperty('categoryPath');
      expect(storedManifest('b')).not.toHaveProperty('categoryPath');
      // The FK cascade takes the child category with it; 'audio' is untouched.
      expect(ids(listCategories())).toEqual(['audio']);
      expect(getPublicItem('c')?.categoryPath).toBe('audio');
    });

    it('reports a missing category', () => {
      expect(deleteCategory('nope')).toBe(false);
    });
  });

  it('appends and reads the audit log newest-first', () => {
    appendAudit('admin-1', 'item.upload', 'a', { status: 'draft' });
    appendAudit('admin-1', 'item.delete', 'a', null);

    const entries = listAudit(10, 0);
    expect(entries.map(entry => entry.action)).toEqual(['item.delete', 'item.upload']);
    expect(entries[1]?.detail).toEqual({ status: 'draft' });
    expect(listAudit(1, 1).map(entry => entry.action)).toEqual(['item.upload']);
  });
});
