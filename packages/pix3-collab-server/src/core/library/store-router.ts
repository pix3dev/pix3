import { Router, Response } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import {
  attachOptionalAuth,
  requireAdmin,
  requireAuth,
  AuthenticatedRequest,
} from '../auth/auth-middleware.js';
import {
  appendAudit,
  bumpDownloads,
  deleteCategory,
  getPublicItem,
  hardDeletePublicItem,
  isStoreItemStatus,
  listAudit,
  listCategories,
  listPublicItems,
  StoreCategoryError,
  updateCategory,
  upsertCategory,
  upsertPublicItem,
  type StoreItem,
  type StoreItemStatus,
  type StoreListFilter,
  type StoreListSort,
} from './library-service.js';
import { getItemDir, resolveSafePath } from './library-storage.js';
import { validateStorePublish } from './store-validation.js';

/**
 * Curated Asset Store: the same bundle storage as the private library router, with public
 * reads and admin-only writes. Reads run under `attachOptionalAuth` (no cookie required) so
 * one endpoint serves both anonymous visitors and admins previewing drafts.
 */
export const storeRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  // Same envelope as the private library router: a bundle uploads all of its files at once.
  limits: { fileSize: 100 * 1024 * 1024, files: 200 },
});

const adminOnly = [attachOptionalAuth, requireAuth, requireAdmin] as const;

function isAdmin(req: AuthenticatedRequest): boolean {
  return req.user?.is_admin === true;
}

/** Drafts are invisible to non-admins as 404, not 403 — existence itself is not public. */
function isVisibleTo(item: StoreItem, admin: boolean): boolean {
  return admin || item.status !== 'draft';
}

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseSort(value: unknown): StoreListSort | undefined {
  const raw = queryString(value);
  return raw === 'downloads' || raw === 'featured' || raw === 'updated' ? raw : undefined;
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(String(raw ?? ''));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parsePathList(raw: unknown): string[] | null {
  try {
    const parsed: unknown = JSON.parse(String(raw ?? '[]'));
    if (!Array.isArray(parsed) || parsed.some(entry => typeof entry !== 'string')) {
      return null;
    }
    return parsed as string[];
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Keep the manifest's `categoryPath` in lockstep with the column (plan §4: one write point). */
function applyCategoryPath(manifest: Record<string, unknown>, categoryPath: string | null): void {
  if (categoryPath) {
    manifest.categoryPath = categoryPath;
  } else {
    delete manifest.categoryPath;
  }
}

// GET /api/library/store/items — public catalog listing.
storeRouter.get('/items', attachOptionalAuth, (req: AuthenticatedRequest, res: Response) => {
  const admin = isAdmin(req);
  const statusParam = queryString(req.query.status);
  const filter: StoreListFilter = {
    q: queryString(req.query.q),
    categoryPath: queryString(req.query.category),
    type: queryString(req.query.type),
    sort: parseSort(req.query.sort),
  };
  // Only an admin may narrow by status; everyone else is pinned to 'published' by the service.
  if (admin && statusParam && statusParam !== 'all' && isStoreItemStatus(statusParam)) {
    filter.status = statusParam;
  }

  res.json({ items: listPublicItems(filter, admin) });
});

// GET /api/library/store/items/:id — one manifest ('unlisted' is reachable by direct id).
storeRouter.get('/items/:id', attachOptionalAuth, (req: AuthenticatedRequest, res: Response) => {
  const item = getPublicItem(req.params.id);
  if (!item || !isVisibleTo(item, isAdmin(req))) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  res.json({ item });
});

// GET /api/library/store/items/:id/files/* — download one bundle file.
storeRouter.get(
  '/items/:id/files/*',
  attachOptionalAuth,
  (req: AuthenticatedRequest, res: Response) => {
    const itemId = req.params.id;
    const item = getPublicItem(itemId);
    if (!item || !isVisibleTo(item, isAdmin(req))) {
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

// POST /api/library/store/items/:id/download — explicit popularity ping. Counting file GETs
// instead would multiply one install by the number of files in the bundle.
storeRouter.post(
  '/items/:id/download',
  attachOptionalAuth,
  (req: AuthenticatedRequest, res: Response) => {
    const item = getPublicItem(req.params.id);
    if (!item || !isVisibleTo(item, isAdmin(req))) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }

    const downloads = bumpDownloads(req.params.id);
    if (downloads === null) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    res.json({ downloads });
  }
);

// POST /api/library/store/items/:id — upload/replace a whole store bundle (admin).
// multipart: `manifest` (JSON), `paths` (JSON string[] parallel to files), `files` (the blobs).
storeRouter.post(
  '/items/:id',
  ...adminOnly,
  upload.array('files'),
  (req: AuthenticatedRequest, res: Response) => {
    const itemId = req.params.id;
    const actorId = req.user!.id;

    const manifest = parseJsonObject(req.body.manifest);
    const paths = parsePathList(req.body.paths);
    if (!manifest || !paths) {
      res.status(400).json({ error: 'Invalid manifest or paths JSON' });
      return;
    }
    if (manifest.id !== itemId) {
      res.status(400).json({ error: 'Manifest id must match the item id' });
      return;
    }

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (paths.length !== files.length) {
      res.status(400).json({ error: 'paths must be parallel to files' });
      return;
    }

    const existing = getPublicItem(itemId);
    const status: StoreItemStatus = isStoreItemStatus(manifest.status) ? manifest.status : 'draft';
    const categoryPath = readString(manifest.categoryPath);

    // Server-owned fields: the publisher is whoever is authenticated, never what was uploaded.
    const stored: Record<string, unknown> = { ...manifest, status, publisherId: actorId };
    applyCategoryPath(stored, categoryPath);

    if (status === 'published') {
      const issues = validateStorePublish(stored);
      if (issues.length > 0) {
        res.status(400).json({ error: 'Item is not ready to publish', issues });
        return;
      }
    }

    // Resolve every destination before touching the disk: a rejected upload must leave no files.
    const targets: string[] = [];
    const itemDir = getItemDir(itemId);
    for (const relativePath of paths) {
      const fullPath = resolveSafePath(itemDir, relativePath);
      if (!fullPath) {
        res.status(400).json({ error: `Invalid file path: ${relativePath}` });
        return;
      }
      targets.push(fullPath);
    }

    const updatedAt =
      typeof manifest.updatedAt === 'number' && Number.isFinite(manifest.updatedAt)
        ? manifest.updatedAt
        : Date.now();

    // Replace the whole bundle: wipe then rewrite (mirrors the private library router).
    fs.rmSync(itemDir, { recursive: true, force: true });
    fs.mkdirSync(itemDir, { recursive: true });
    for (let i = 0; i < targets.length; i += 1) {
      fs.mkdirSync(path.dirname(targets[i]!), { recursive: true });
      fs.writeFileSync(targets[i]!, files[i]!.buffer);
    }

    upsertPublicItem(actorId, itemId, stored, updatedAt, {
      status,
      categoryPath,
      // `featured` is curation state, not bundle content — a re-upload must not clear it.
      featured: existing?.featured ?? false,
      publishedAt: existing?.publishedAt ?? (status === 'published' ? Date.now() : null),
    });
    appendAudit(actorId, 'item.upload', itemId, { status, categoryPath, files: files.length });

    res.status(201).json({ id: itemId, updatedAt, status });
  }
);

// PATCH /api/library/store/items/:id — status / category / featured / manifest fields (admin).
storeRouter.patch('/items/:id', ...adminOnly, (req: AuthenticatedRequest, res: Response) => {
  const itemId = req.params.id;
  const actorId = req.user!.id;
  const body = (req.body ?? {}) as {
    status?: unknown;
    categoryPath?: unknown;
    featured?: unknown;
    manifestPatch?: unknown;
  };

  const existing = getPublicItem(itemId);
  if (!existing) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }

  if (body.status !== undefined && !isStoreItemStatus(body.status)) {
    res.status(400).json({ error: 'Invalid status' });
    return;
  }
  if (
    body.manifestPatch !== undefined &&
    (typeof body.manifestPatch !== 'object' ||
      body.manifestPatch === null ||
      Array.isArray(body.manifestPatch))
  ) {
    res.status(400).json({ error: 'manifestPatch must be an object' });
    return;
  }

  const status: StoreItemStatus = isStoreItemStatus(body.status) ? body.status : existing.status;
  const categoryPath =
    body.categoryPath === undefined ? existing.categoryPath : readString(body.categoryPath);
  const featured = typeof body.featured === 'boolean' ? body.featured : existing.featured;

  const manifest: Record<string, unknown> = {
    ...(existing.manifest ?? {}),
    ...((body.manifestPatch as Record<string, unknown> | undefined) ?? {}),
    status,
    featured,
  };
  applyCategoryPath(manifest, categoryPath);

  if (status === 'published') {
    const issues = validateStorePublish(manifest);
    if (issues.length > 0) {
      res.status(400).json({ error: 'Item is not ready to publish', issues });
      return;
    }
  }

  // The publisher is the admin who uploaded the bundle; a metadata edit must not reassign it.
  // `publisherId` was stamped from the owner column when the item was read back.
  const ownerId =
    typeof existing.manifest?.publisherId === 'string' ? existing.manifest.publisherId : actorId;

  upsertPublicItem(ownerId, itemId, manifest, Date.now(), {
    status,
    categoryPath,
    featured,
    publishedAt: existing.publishedAt ?? (status === 'published' ? Date.now() : null),
  });

  const action =
    status === 'published' && existing.status !== 'published'
      ? 'item.publish'
      : status === 'unlisted' && existing.status !== 'unlisted'
        ? 'item.unlist'
        : 'item.meta';
  appendAudit(actorId, action, itemId, { status, categoryPath, featured });

  res.json({ item: getPublicItem(itemId) });
});

// DELETE /api/library/store/items/:id — hard delete: row + bundle files (admin).
storeRouter.delete('/items/:id', ...adminOnly, (req: AuthenticatedRequest, res: Response) => {
  const itemId = req.params.id;
  if (!hardDeletePublicItem(itemId)) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }

  fs.rmSync(getItemDir(itemId), { recursive: true, force: true });
  appendAudit(req.user!.id, 'item.delete', itemId, null);
  res.json({ ok: true });
});

// GET /api/library/store/categories — public taxonomy with published-item counts.
storeRouter.get('/categories', attachOptionalAuth, (_req: AuthenticatedRequest, res: Response) => {
  res.json({ categories: listCategories() });
});

// POST /api/library/store/categories — create (or overwrite) a category (admin).
storeRouter.post('/categories', ...adminOnly, (req: AuthenticatedRequest, res: Response) => {
  const body = (req.body ?? {}) as {
    id?: unknown;
    parentId?: unknown;
    label?: unknown;
    sortOrder?: unknown;
  };
  const id = readString(body.id);
  const label = readString(body.label);
  if (!id || !label) {
    res.status(400).json({ error: 'id and label are required' });
    return;
  }

  try {
    const category = upsertCategory({
      id,
      parentId: typeof body.parentId === 'string' ? body.parentId : null,
      label,
      sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : 0,
    });
    appendAudit(req.user!.id, 'category.create', null, { id, label });
    res.status(201).json({ category });
  } catch (error) {
    if (error instanceof StoreCategoryError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
});

// PATCH /api/library/store/categories/:id — rename / reorder (admin).
storeRouter.patch('/categories/:id', ...adminOnly, (req: AuthenticatedRequest, res: Response) => {
  const body = (req.body ?? {}) as { label?: unknown; sortOrder?: unknown };
  const patch: { label?: string; sortOrder?: number } = {};
  if (typeof body.label === 'string') {
    patch.label = body.label;
  }
  if (typeof body.sortOrder === 'number') {
    patch.sortOrder = body.sortOrder;
  }

  try {
    if (!updateCategory(req.params.id, patch)) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }
  } catch (error) {
    if (error instanceof StoreCategoryError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }

  appendAudit(req.user!.id, 'category.update', null, { id: req.params.id, ...patch });
  res.json({ ok: true });
});

// DELETE /api/library/store/categories/:id — delete + re-home its items (admin).
storeRouter.delete('/categories/:id', ...adminOnly, (req: AuthenticatedRequest, res: Response) => {
  if (!deleteCategory(req.params.id)) {
    res.status(404).json({ error: 'Category not found' });
    return;
  }
  appendAudit(req.user!.id, 'category.delete', null, { id: req.params.id });
  res.json({ ok: true });
});

// GET /api/library/store/audit — admin trail of store mutations.
storeRouter.get('/audit', ...adminOnly, (req: AuthenticatedRequest, res: Response) => {
  const limitRaw = Number(req.query.limit);
  const offsetRaw = Number(req.query.offset);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
  res.json({ entries: listAudit(limit, offset) });
});
