// @vitest-environment node
import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { config } from '../../config.js';

vi.mock('../auth/auth-middleware.js', () => ({
  requireAuth: (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 'owner-1' };
    next();
  },
}));

const libraryService = {
  listOwnerLibraryItems: vi.fn(() => []),
  getOwnerLibraryItem: vi.fn(() => undefined as unknown),
  // `null` = no row yet, which is the create case every upload starts from.
  getLibraryItemOwnerId: vi.fn((): string | null => null),
  upsertLibraryItem: vi.fn(() => true),
  softDeleteLibraryItem: vi.fn(() => true),
};

vi.mock('./library-service.js', () => libraryService);

const { libraryRouter } = await import('./library-router.js');

function startServer(): Promise<http.Server> {
  const app = express();
  app.use(express.json());
  app.use('/api/library', libraryRouter);
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

describe('libraryRouter', () => {
  let server: http.Server | null = null;
  let createdItemId: string | null = null;

  afterEach(async () => {
    await stopServer(server);
    server = null;
    vi.clearAllMocks();
    libraryService.getOwnerLibraryItem.mockReturnValue(undefined);
    libraryService.getLibraryItemOwnerId.mockReturnValue(null);
    libraryService.upsertLibraryItem.mockReturnValue(true);
    libraryService.softDeleteLibraryItem.mockReturnValue(true);
    if (createdItemId) {
      fs.rmSync(itemDir(createdItemId), { recursive: true, force: true });
      createdItemId = null;
    }
  });

  it('uploads a bundle and records it', async () => {
    const itemId = (createdItemId = `lib-${randomUUID()}`);
    server = await startServer();
    const port = (server.address() as AddressInfo).port;

    const form = new FormData();
    form.append('manifest', JSON.stringify({ id: itemId, updatedAt: 1234, files: ['item.json'] }));
    form.append('paths', JSON.stringify(['item.json']));
    form.append('files', new Blob(['{"hello":true}']), 'item.json');

    const res = await fetch(`http://127.0.0.1:${port}/api/library/items/${itemId}`, {
      method: 'POST',
      body: form,
    });

    expect(res.status).toBe(201);
    expect(fs.existsSync(path.join(itemDir(itemId), 'item.json'))).toBe(true);
    expect(libraryService.upsertLibraryItem).toHaveBeenCalledWith(
      'owner-1',
      itemId,
      expect.objectContaining({ id: itemId }),
      1234
    );
  });

  it('rejects a manifest id that does not match the item id', async () => {
    const itemId = `lib-${randomUUID()}`;
    server = await startServer();
    const port = (server.address() as AddressInfo).port;

    const form = new FormData();
    form.append('manifest', JSON.stringify({ id: 'someone-else', updatedAt: 1, files: [] }));
    form.append('paths', JSON.stringify([]));

    const res = await fetch(`http://127.0.0.1:${port}/api/library/items/${itemId}`, {
      method: 'POST',
      body: form,
    });

    expect(res.status).toBe(400);
    expect(libraryService.upsertLibraryItem).not.toHaveBeenCalled();
  });

  it('rejects path traversal in bundle paths', async () => {
    const itemId = (createdItemId = `lib-${randomUUID()}`);
    server = await startServer();
    const port = (server.address() as AddressInfo).port;

    const form = new FormData();
    form.append('manifest', JSON.stringify({ id: itemId, updatedAt: 1, files: ['../evil.txt'] }));
    form.append('paths', JSON.stringify(['../evil.txt']));
    form.append('files', new Blob(['pwned']), 'evil.txt');

    const res = await fetch(`http://127.0.0.1:${port}/api/library/items/${itemId}`, {
      method: 'POST',
      body: form,
    });

    expect(res.status).toBe(400);
  });

  it('downloads a bundle file for the owner', async () => {
    const itemId = (createdItemId = `lib-${randomUUID()}`);
    fs.mkdirSync(itemDir(itemId), { recursive: true });
    fs.writeFileSync(path.join(itemDir(itemId), 'item.json'), '{"ok":1}');
    libraryService.getOwnerLibraryItem.mockReturnValue({ id: itemId, deleted: 0 });

    server = await startServer();
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/library/items/${itemId}/files/item.json`);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":1}');
  });

  it('returns 404 downloading a tombstoned item', async () => {
    const itemId = `lib-${randomUUID()}`;
    libraryService.getOwnerLibraryItem.mockReturnValue({ id: itemId, deleted: 1 });

    server = await startServer();
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/library/items/${itemId}/files/item.json`);

    expect(res.status).toBe(404);
  });

  it('tombstones an item on delete', async () => {
    const itemId = `lib-${randomUUID()}`;
    server = await startServer();
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/library/items/${itemId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deletedAt: 999 }),
    });

    expect(res.status).toBe(200);
    expect(libraryService.softDeleteLibraryItem).toHaveBeenCalledWith('owner-1', itemId, 999);
  });

  /**
   * Both routes are addressed by a client-chosen id and both do destructive filesystem work.
   * The mocked `requireAuth` signs everyone in as `owner-1`, so "another user's item" is any id
   * the service reports a different owner for.
   */
  describe('another user’s item', () => {
    it('refuses an upload without touching the existing bundle', async () => {
      const itemId = (createdItemId = `lib-${randomUUID()}`);
      // Stand in for the victim's already-synced bundle.
      fs.mkdirSync(itemDir(itemId), { recursive: true });
      fs.writeFileSync(path.join(itemDir(itemId), 'victim.json'), '{"mine":true}');
      libraryService.getLibraryItemOwnerId.mockReturnValue('owner-2');

      server = await startServer();
      const port = (server.address() as AddressInfo).port;

      const form = new FormData();
      form.append('manifest', JSON.stringify({ id: itemId, updatedAt: 9, files: ['item.json'] }));
      form.append('paths', JSON.stringify(['item.json']));
      form.append('files', new Blob(['{"pwned":true}']), 'item.json');

      const res = await fetch(`http://127.0.0.1:${port}/api/library/items/${itemId}`, {
        method: 'POST',
        body: form,
      });

      expect(res.status).toBe(404);
      expect(libraryService.upsertLibraryItem).not.toHaveBeenCalled();
      // The point of the fix: the wipe happens before the DB write, so a late check is no check.
      expect(fs.readFileSync(path.join(itemDir(itemId), 'victim.json'), 'utf-8')).toBe(
        '{"mine":true}'
      );
      expect(fs.existsSync(path.join(itemDir(itemId), 'item.json'))).toBe(false);
    });

    it('refuses a delete without removing the bundle files', async () => {
      const itemId = (createdItemId = `lib-${randomUUID()}`);
      fs.mkdirSync(itemDir(itemId), { recursive: true });
      fs.writeFileSync(path.join(itemDir(itemId), 'victim.json'), '{"mine":true}');
      // Owner-scoped tombstone matches no row for this caller.
      libraryService.softDeleteLibraryItem.mockReturnValue(false);

      server = await startServer();
      const port = (server.address() as AddressInfo).port;

      const res = await fetch(`http://127.0.0.1:${port}/api/library/items/${itemId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deletedAt: 999 }),
      });

      expect(res.status).toBe(404);
      expect(fs.existsSync(path.join(itemDir(itemId), 'victim.json'))).toBe(true);
    });

    it('still allows creating an id nobody owns', async () => {
      // The check must not turn every first upload into a 404.
      const itemId = (createdItemId = `lib-${randomUUID()}`);
      libraryService.getLibraryItemOwnerId.mockReturnValue(null);

      server = await startServer();
      const port = (server.address() as AddressInfo).port;

      const form = new FormData();
      form.append('manifest', JSON.stringify({ id: itemId, updatedAt: 1, files: ['item.json'] }));
      form.append('paths', JSON.stringify(['item.json']));
      form.append('files', new Blob(['{"ok":1}']), 'item.json');

      const res = await fetch(`http://127.0.0.1:${port}/api/library/items/${itemId}`, {
        method: 'POST',
        body: form,
      });

      expect(res.status).toBe(201);
    });

    it('allows the owner to replace their own item', async () => {
      const itemId = (createdItemId = `lib-${randomUUID()}`);
      libraryService.getLibraryItemOwnerId.mockReturnValue('owner-1');

      server = await startServer();
      const port = (server.address() as AddressInfo).port;

      const form = new FormData();
      form.append('manifest', JSON.stringify({ id: itemId, updatedAt: 2, files: ['item.json'] }));
      form.append('paths', JSON.stringify(['item.json']));
      form.append('files', new Blob(['{"ok":2}']), 'item.json');

      const res = await fetch(`http://127.0.0.1:${port}/api/library/items/${itemId}`, {
        method: 'POST',
        body: form,
      });

      expect(res.status).toBe(201);
      expect(libraryService.upsertLibraryItem).toHaveBeenCalled();
    });
  });
});
