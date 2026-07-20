import { Router, Response } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { config } from '../../config.js';
import { requireAuth, AuthenticatedRequest } from '../auth/auth-middleware.js';
import {
  getOwnerLibraryItem,
  listOwnerLibraryItems,
  softDeleteLibraryItem,
  upsertLibraryItem,
} from './library-service.js';

export const libraryRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  // Match the project storage limit; a bundle uploads its files together.
  limits: { fileSize: 100 * 1024 * 1024, files: 200 },
});

function getItemDir(itemId: string): string {
  // itemId is a client UUID; encode it so it can never escape the storage root.
  return path.resolve(config.LIBRARY_STORAGE_DIR, encodeURIComponent(itemId));
}

function resolveSafePath(itemDir: string, relativePath: string): string | null {
  const resolved = path.resolve(itemDir, relativePath);
  if (!resolved.startsWith(itemDir + path.sep) && resolved !== itemDir) {
    return null;
  }
  return resolved;
}

// GET /api/library/items — full private index for the caller (incl. tombstones) for sync.
libraryRouter.get('/items', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const items = listOwnerLibraryItems(req.user!.id);
  res.json({ items });
});

// GET /api/library/items/:id/files/* — download one bundle file (owner-only).
libraryRouter.get(
  '/items/:id/files/*',
  requireAuth,
  (req: AuthenticatedRequest, res: Response) => {
    const itemId = req.params.id;
    const row = getOwnerLibraryItem(req.user!.id, itemId);
    if (!row || row.deleted === 1) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }

    const filePath = (req.params as Record<string, string>)[0];
    if (!filePath) {
      res.status(400).json({ error: 'File path is required' });
      return;
    }

    const itemDir = getItemDir(itemId);
    const fullPath = resolveSafePath(itemDir, filePath);
    if (!fullPath) {
      res.status(400).json({ error: 'Invalid file path' });
      return;
    }

    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    res.sendFile(fullPath);
  }
);

// POST /api/library/items/:id — upload/replace a whole bundle (owner-only).
// multipart: `manifest` (JSON), `paths` (JSON string[] parallel to files), `files` (the blobs).
libraryRouter.post(
  '/items/:id',
  requireAuth,
  upload.array('files'),
  (req: AuthenticatedRequest, res: Response) => {
    const itemId = req.params.id;

    let manifest: { id?: string; updatedAt?: number; files?: string[] };
    let paths: string[];
    try {
      manifest = JSON.parse(String(req.body.manifest ?? ''));
      paths = JSON.parse(String(req.body.paths ?? '[]'));
    } catch {
      res.status(400).json({ error: 'Invalid manifest or paths JSON' });
      return;
    }

    if (!manifest || manifest.id !== itemId) {
      res.status(400).json({ error: 'Manifest id must match the item id' });
      return;
    }

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!Array.isArray(paths) || paths.length !== files.length) {
      res.status(400).json({ error: 'paths must be parallel to files' });
      return;
    }

    const updatedAt =
      typeof manifest.updatedAt === 'number' && Number.isFinite(manifest.updatedAt)
        ? manifest.updatedAt
        : Date.now();

    const itemDir = getItemDir(itemId);
    // Replace the whole bundle atomically-ish: wipe then rewrite (mirrors LocalLibraryProvider.put).
    fs.rmSync(itemDir, { recursive: true, force: true });
    fs.mkdirSync(itemDir, { recursive: true });

    for (let i = 0; i < files.length; i += 1) {
      const relativePath = paths[i];
      const fullPath = resolveSafePath(itemDir, relativePath);
      if (!fullPath) {
        fs.rmSync(itemDir, { recursive: true, force: true });
        res.status(400).json({ error: `Invalid file path: ${relativePath}` });
        return;
      }
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, files[i]!.buffer);
    }

    upsertLibraryItem(req.user!.id, itemId, manifest, updatedAt);
    res.status(201).json({ id: itemId, updatedAt });
  }
);

// DELETE /api/library/items/:id — tombstone the item + remove its files (owner-only).
libraryRouter.delete('/items/:id', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const itemId = req.params.id;
  const deletedAtRaw = Number((req.body as { deletedAt?: unknown })?.deletedAt);
  const deletedAt = Number.isFinite(deletedAtRaw) && deletedAtRaw > 0 ? deletedAtRaw : Date.now();

  softDeleteLibraryItem(req.user!.id, itemId, deletedAt);
  fs.rmSync(getItemDir(itemId), { recursive: true, force: true });

  res.json({ ok: true, deletedAt });
});
