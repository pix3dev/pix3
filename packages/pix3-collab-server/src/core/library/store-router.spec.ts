// @vitest-environment node
import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '../../config.js';
import type { StoreItem, StoreItemStatus } from './library-service.js';

interface TestUser {
  id: string;
  email: string;
  username: string;
  is_admin: boolean;
}

interface AuthCarrier {
  user?: TestUser;
}

const auth: { user: TestUser | null } = { user: null };

function asAdmin(): void {
  auth.user = { id: 'admin-1', email: 'a@b.c', username: 'admin', is_admin: true };
}

function asMember(): void {
  auth.user = { id: 'user-1', email: 'u@b.c', username: 'user', is_admin: false };
}

vi.mock('../auth/auth-middleware.js', () => ({
  attachOptionalAuth: (req: AuthCarrier, _res: unknown, next: () => void) => {
    if (auth.user) {
      req.user = auth.user;
    }
    next();
  },
  requireAuth: (
    req: AuthCarrier,
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void
  ) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    next();
  },
  requireAdmin: (
    req: AuthCarrier,
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void
  ) => {
    if (!req.user?.is_admin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    next();
  },
}));

function storeItem(overrides: Partial<StoreItem> & { id: string }): StoreItem {
  return {
    manifest: { id: overrides.id, name: 'Item' },
    updatedAt: 1,
    status: 'published',
    categoryPath: null,
    featured: false,
    downloads: 0,
    publishedAt: null,
    ...overrides,
  };
}

const service = {
  listPublicItems: vi.fn((): StoreItem[] => []),
  getPublicItem: vi.fn((_id: string): StoreItem | null => null),
  upsertPublicItem: vi.fn(),
  hardDeletePublicItem: vi.fn((_id: string): boolean => true),
  bumpDownloads: vi.fn((_id: string): number | null => 1),
  listCategories: vi.fn(() => []),
  upsertCategory: vi.fn(),
  updateCategory: vi.fn((): boolean => true),
  deleteCategory: vi.fn((): boolean => true),
  appendAudit: vi.fn(),
  listAudit: vi.fn(() => []),
  isStoreItemStatus: (value: unknown): value is StoreItemStatus =>
    value === 'draft' || value === 'published' || value === 'unlisted',
  StoreCategoryError: class StoreCategoryError extends Error {},
};

vi.mock('./library-service.js', () => service);

const { storeRouter } = await import('./store-router.js');

function startServer(): Promise<http.Server> {
  const app = express();
  app.use(express.json());
  app.use('/api/library/store', storeRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

function stopServer(server: http.Server | null): Promise<void> {
  if (!server) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}

function itemDir(itemId: string): string {
  return path.resolve(config.LIBRARY_STORAGE_DIR, encodeURIComponent(itemId));
}

/** A manifest that satisfies every publish-gate requirement. */
function publishableManifest(id: string): Record<string, unknown> {
  return {
    id,
    name: 'Neon Buttons',
    description: 'A pack of neon UI buttons.',
    categoryPath: 'ui/buttons',
    license: 'CC0-1.0',
    preview: 'preview.png',
    tags: ['ui'],
    type: 'sprite',
    updatedAt: 1234,
  };
}

describe('storeRouter', () => {
  let server: http.Server | null = null;
  let port = 0;
  const createdDirs: string[] = [];

  beforeEach(async () => {
    auth.user = null;
    server = await startServer();
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await stopServer(server);
    server = null;
    vi.clearAllMocks();
    service.getPublicItem.mockReturnValue(null);
    service.listPublicItems.mockReturnValue([]);
    service.hardDeletePublicItem.mockReturnValue(true);
    service.bumpDownloads.mockReturnValue(1);
    service.deleteCategory.mockReturnValue(true);
    while (createdDirs.length > 0) {
      fs.rmSync(createdDirs.pop()!, { recursive: true, force: true });
    }
  });

  function url(suffix: string): string {
    return `http://127.0.0.1:${port}/api/library/store${suffix}`;
  }

  function uploadForm(
    manifest: Record<string, unknown>,
    paths: string[] = ['item.json']
  ): FormData {
    const form = new FormData();
    form.append('manifest', JSON.stringify(manifest));
    form.append('paths', JSON.stringify(paths));
    for (const filePath of paths) {
      form.append('files', new Blob(['{}']), path.basename(filePath));
    }
    return form;
  }

  it('lists only published items for anonymous callers', async () => {
    service.listPublicItems.mockReturnValue([storeItem({ id: 'a' })]);

    const res = await fetch(url('/items?status=draft&sort=downloads&category=ui'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [storeItem({ id: 'a' })] });
    // includeNonPublished=false pins the service to published, and the status query is dropped.
    expect(service.listPublicItems).toHaveBeenCalledWith(
      { q: undefined, categoryPath: 'ui', type: undefined, sort: 'downloads' },
      false
    );
  });

  it('lets an admin narrow the listing by status', async () => {
    asAdmin();

    await fetch(url('/items?status=draft'));

    expect(service.listPublicItems).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft' }),
      true
    );
  });

  it('hides a draft from a non-admin behind a 404', async () => {
    service.getPublicItem.mockReturnValue(storeItem({ id: 'draft-1', status: 'draft' }));

    const anonymous = await fetch(url('/items/draft-1'));
    expect(anonymous.status).toBe(404);

    asMember();
    const member = await fetch(url('/items/draft-1'));
    expect(member.status).toBe(404);
  });

  it('serves a draft to an admin', async () => {
    asAdmin();
    service.getPublicItem.mockReturnValue(storeItem({ id: 'draft-1', status: 'draft' }));

    const res = await fetch(url('/items/draft-1'));

    expect(res.status).toBe(200);
    expect((await res.json()).item.status).toBe('draft');
  });

  it('serves an unlisted item by direct id', async () => {
    service.getPublicItem.mockReturnValue(storeItem({ id: 'u-1', status: 'unlisted' }));

    const res = await fetch(url('/items/u-1'));

    expect(res.status).toBe(200);
  });

  it('rejects an upload from a non-admin', async () => {
    asMember();
    const itemId = `store-${randomUUID()}`;

    const res = await fetch(url(`/items/${itemId}`), {
      method: 'POST',
      body: uploadForm(publishableManifest(itemId)),
    });

    expect(res.status).toBe(403);
    expect(service.upsertPublicItem).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated upload', async () => {
    const itemId = `store-${randomUUID()}`;

    const res = await fetch(url(`/items/${itemId}`), {
      method: 'POST',
      body: uploadForm(publishableManifest(itemId)),
    });

    expect(res.status).toBe(401);
  });

  it('stores an uploaded draft with server-owned fields forced', async () => {
    asAdmin();
    const itemId = `store-${randomUUID()}`;
    createdDirs.push(itemDir(itemId));

    const res = await fetch(url(`/items/${itemId}`), {
      method: 'POST',
      body: uploadForm({
        ...publishableManifest(itemId),
        status: 'draft',
        publisherId: 'someone-else',
        downloads: 9999,
      }),
    });

    expect(res.status).toBe(201);
    expect(fs.existsSync(path.join(itemDir(itemId), 'item.json'))).toBe(true);
    expect(service.upsertPublicItem).toHaveBeenCalledWith(
      'admin-1',
      itemId,
      expect.objectContaining({ publisherId: 'admin-1', status: 'draft' }),
      1234,
      { status: 'draft', categoryPath: 'ui/buttons', featured: false, publishedAt: null }
    );
    expect(service.appendAudit).toHaveBeenCalledWith(
      'admin-1',
      'item.upload',
      itemId,
      expect.objectContaining({ status: 'draft' })
    );
  });

  it('blocks a published upload that fails the gate and writes nothing', async () => {
    asAdmin();
    const itemId = `store-${randomUUID()}`;
    const manifest = publishableManifest(itemId);
    delete manifest.license;
    delete manifest.preview;

    const res = await fetch(url(`/items/${itemId}`), {
      method: 'POST',
      body: uploadForm({ ...manifest, status: 'published' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: Array<{ field: string }> };
    expect(body.issues.map(issue => issue.field).sort()).toEqual(['license', 'preview']);
    expect(service.upsertPublicItem).not.toHaveBeenCalled();
    expect(fs.existsSync(itemDir(itemId))).toBe(false);
  });

  it('stamps published_at on the first publish', async () => {
    asAdmin();
    const itemId = `store-${randomUUID()}`;
    createdDirs.push(itemDir(itemId));

    const res = await fetch(url(`/items/${itemId}`), {
      method: 'POST',
      body: uploadForm({ ...publishableManifest(itemId), status: 'published' }),
    });

    expect(res.status).toBe(201);
    const columns = service.upsertPublicItem.mock.calls[0]![4] as {
      status: string;
      publishedAt: number | null;
    };
    expect(columns.status).toBe('published');
    expect(columns.publishedAt).toBeGreaterThan(0);
  });

  it('rejects path traversal in bundle paths', async () => {
    asAdmin();
    const itemId = `store-${randomUUID()}`;
    createdDirs.push(itemDir(itemId));

    const res = await fetch(url(`/items/${itemId}`), {
      method: 'POST',
      body: uploadForm({ ...publishableManifest(itemId), status: 'draft' }, ['../evil.txt']),
    });

    expect(res.status).toBe(400);
    expect(service.upsertPublicItem).not.toHaveBeenCalled();
    expect(fs.existsSync(itemDir(itemId))).toBe(false);
  });

  it('runs the publish gate on a PATCH into published', async () => {
    asAdmin();
    service.getPublicItem.mockReturnValue(
      storeItem({ id: 'p-1', status: 'draft', manifest: { id: 'p-1', name: 'Bare' } })
    );

    const res = await fetch(url('/items/p-1'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'published' }),
    });

    expect(res.status).toBe(400);
    expect(service.upsertPublicItem).not.toHaveBeenCalled();
  });

  it('records an unlist transition in the audit log', async () => {
    asAdmin();
    service.getPublicItem.mockReturnValue(
      storeItem({ id: 'p-1', status: 'published', publishedAt: 10 })
    );

    const res = await fetch(url('/items/p-1'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'unlisted', featured: true }),
    });

    expect(res.status).toBe(200);
    expect(service.upsertPublicItem).toHaveBeenCalledWith(
      'admin-1',
      'p-1',
      expect.objectContaining({ status: 'unlisted', featured: true }),
      expect.any(Number),
      expect.objectContaining({ status: 'unlisted', featured: true, publishedAt: 10 })
    );
    expect(service.appendAudit).toHaveBeenCalledWith(
      'admin-1',
      'item.unlist',
      'p-1',
      expect.anything()
    );
  });

  it('deletes the row and the bundle directory', async () => {
    asAdmin();
    const itemId = `store-${randomUUID()}`;
    fs.mkdirSync(itemDir(itemId), { recursive: true });
    fs.writeFileSync(path.join(itemDir(itemId), 'item.json'), '{}');
    createdDirs.push(itemDir(itemId));

    const res = await fetch(url(`/items/${itemId}`), { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(service.hardDeletePublicItem).toHaveBeenCalledWith(itemId);
    expect(fs.existsSync(itemDir(itemId))).toBe(false);
    expect(service.appendAudit).toHaveBeenCalledWith('admin-1', 'item.delete', itemId, null);
  });

  it('404s a delete of an unknown item without touching the disk', async () => {
    asAdmin();
    service.hardDeletePublicItem.mockReturnValue(false);

    const res = await fetch(url('/items/nope'), { method: 'DELETE' });

    expect(res.status).toBe(404);
    expect(service.appendAudit).not.toHaveBeenCalled();
  });

  it('bumps the download counter once per ping', async () => {
    service.getPublicItem.mockReturnValue(storeItem({ id: 'd-1' }));
    service.bumpDownloads.mockReturnValue(7);

    const res = await fetch(url('/items/d-1/download'), { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ downloads: 7 });
    expect(service.bumpDownloads).toHaveBeenCalledTimes(1);
  });

  it('does not count a download for a draft seen by a non-admin', async () => {
    service.getPublicItem.mockReturnValue(storeItem({ id: 'd-1', status: 'draft' }));

    const res = await fetch(url('/items/d-1/download'), { method: 'POST' });

    expect(res.status).toBe(404);
    expect(service.bumpDownloads).not.toHaveBeenCalled();
  });

  it('serves bundle files and blocks traversal on download', async () => {
    const itemId = `store-${randomUUID()}`;
    fs.mkdirSync(itemDir(itemId), { recursive: true });
    fs.writeFileSync(path.join(itemDir(itemId), 'item.json'), '{"ok":1}');
    createdDirs.push(itemDir(itemId));
    service.getPublicItem.mockReturnValue(storeItem({ id: itemId }));

    const ok = await fetch(url(`/items/${itemId}/files/item.json`));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('{"ok":1}');

    const traversal = await fetch(url(`/items/${itemId}/files/..%2F..%2Fevil.txt`));
    expect(traversal.status).toBe(400);
  });

  it('requires admin for the audit feed', async () => {
    const anonymous = await fetch(url('/audit'));
    expect(anonymous.status).toBe(401);

    asMember();
    expect((await fetch(url('/audit'))).status).toBe(403);

    asAdmin();
    const admin = await fetch(url('/audit?limit=5&offset=2'));
    expect(admin.status).toBe(200);
    expect(service.listAudit).toHaveBeenCalledWith(5, 2);
  });

  it('deletes a category through the service (which re-homes its items)', async () => {
    asAdmin();

    const res = await fetch(url('/categories/ui'), { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(service.deleteCategory).toHaveBeenCalledWith('ui');
    expect(service.appendAudit).toHaveBeenCalledWith('admin-1', 'category.delete', null, {
      id: 'ui',
    });
  });

  it('404s deleting an unknown category', async () => {
    asAdmin();
    service.deleteCategory.mockReturnValue(false);

    const res = await fetch(url('/categories/nope'), { method: 'DELETE' });

    expect(res.status).toBe(404);
  });

  it('exposes the taxonomy publicly', async () => {
    const res = await fetch(url('/categories'));

    expect(res.status).toBe(200);
    expect(service.listCategories).toHaveBeenCalled();
  });
});
