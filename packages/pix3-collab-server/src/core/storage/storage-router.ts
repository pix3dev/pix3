import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { config } from '../../config.js';
import { attachOptionalAuth, requireAuth, AuthenticatedRequest } from '../auth/auth-middleware.js';
import { resolveProjectAccess } from '../projects/projects-service.js';
import { touchProject } from '../projects/projects-service.js';
import { buildManifest } from './manifest.js';
import { resolveContainedPath } from './contained-path.js';

export const storageRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

function getProjectDir(projectId: string): string {
  return path.resolve(config.PROJECTS_STORAGE_DIR, projectId);
}

/**
 * Prevent path traversal. `allowRoot` because the directory routes legitimately address the project
 * directory itself; the shared rule is in `contained-path.ts`.
 */
function resolveSafePath(projectDir: string, filePath: string): string | null {
  return resolveContainedPath(projectDir, filePath, { allowRoot: true });
}

function checkAccess(req: AuthenticatedRequest, res: Response, write: boolean): boolean {
  const projectId = req.params.id;
  const shareToken = req.header('x-share-token');
  const access = resolveProjectAccess(projectId, {
    userId: req.user?.id ?? null,
    shareToken: typeof shareToken === 'string' ? shareToken : null,
  });

  if (!access) {
    res.status(403).json({ error: 'Access denied' });
    return false;
  }

  if (write && access.role === 'viewer') {
    res.status(403).json({ error: 'Write access denied' });
    return false;
  }
  return true;
}

// GET /api/projects/:id/manifest — file tree with hashes
storageRouter.get(
  '/:id/manifest',
  attachOptionalAuth,
  (req: AuthenticatedRequest, res: Response) => {
    if (!checkAccess(req, res, false)) return;

    const projectDir = getProjectDir(req.params.id);
    const manifest = buildManifest(projectDir);
    res.json({ files: manifest });
  }
);

// GET /api/projects/:id/files/* — download file
storageRouter.get(
  '/:id/files/*',
  attachOptionalAuth,
  (req: AuthenticatedRequest, res: Response) => {
    if (!checkAccess(req, res, false)) return;

    const filePath = (req.params as Record<string, string>)[0];
    if (!filePath) {
      res.status(400).json({ error: 'File path is required' });
      return;
    }

    const projectDir = getProjectDir(req.params.id);
    const fullPath = resolveSafePath(projectDir, filePath);
    if (!fullPath) {
      res.status(400).json({ error: 'Invalid file path' });
      return;
    }

    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    res.sendFile(fullPath, { dotfiles: 'allow' });
  }
);

// POST /api/projects/:id/files/* — upload/overwrite file
storageRouter.post(
  '/:id/files/*',
  requireAuth,
  upload.single('file'),
  (req: Request & AuthenticatedRequest, res: Response) => {
    if (!checkAccess(req, res, true)) return;

    const filePath = (req.params as Record<string, string>)[0];
    if (!filePath) {
      res.status(400).json({ error: 'File path is required' });
      return;
    }

    const projectDir = getProjectDir(req.params.id);
    const fullPath = resolveSafePath(projectDir, filePath);
    if (!fullPath) {
      res.status(400).json({ error: 'Invalid file path' });
      return;
    }

    // Multipart only. The route used to advertise a raw-body fallback, but the server mounts
    // `express.json()` and no `express.raw()`, so `req.body` is never a Buffer or a string here —
    // those branches could not be reached, and the 400 they fell through to blamed the client for
    // a shape the server had no parser for. `ApiClient.uploadFile` has always sent multipart.
    if (!req.file) {
      res
        .status(400)
        .json({ error: 'No file content provided. Send the file as multipart/form-data.' });
      return;
    }

    const content = req.file.buffer;

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    touchProject(req.params.id);

    res.status(201).json({ path: filePath, size: content.length });
  }
);

// POST /api/projects/:id/directories/* — create directory
storageRouter.post(
  '/:id/directories/*',
  requireAuth,
  (req: AuthenticatedRequest, res: Response) => {
    if (!checkAccess(req, res, true)) return;

    const directoryPath = (req.params as Record<string, string>)[0];
    if (!directoryPath) {
      res.status(400).json({ error: 'Directory path is required' });
      return;
    }

    const projectDir = getProjectDir(req.params.id);
    const fullPath = resolveSafePath(projectDir, directoryPath);
    if (!fullPath) {
      res.status(400).json({ error: 'Invalid directory path' });
      return;
    }

    if (fs.existsSync(fullPath) && !fs.statSync(fullPath).isDirectory()) {
      res.status(409).json({ error: 'A file already exists at that path' });
      return;
    }

    fs.mkdirSync(fullPath, { recursive: true });
    touchProject(req.params.id);
    res.status(201).json({ path: directoryPath });
  }
);

// DELETE /api/projects/:id/files/* — delete file
storageRouter.delete('/:id/files/*', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  if (!checkAccess(req, res, true)) return;

  const filePath = (req.params as Record<string, string>)[0];
  if (!filePath) {
    res.status(400).json({ error: 'File path is required' });
    return;
  }

  const projectDir = getProjectDir(req.params.id);
  const fullPath = resolveSafePath(projectDir, filePath);
  if (!fullPath) {
    res.status(400).json({ error: 'Invalid file path' });
    return;
  }

  if (!fs.existsSync(fullPath)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  if (fs.statSync(fullPath).isDirectory()) {
    fs.rmSync(fullPath, { recursive: true, force: true });
  } else {
    fs.unlinkSync(fullPath);
  }

  touchProject(req.params.id);

  res.json({ ok: true });
});
