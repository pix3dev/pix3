import { Router, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '../auth/auth-middleware.js';
import { getDb } from '../db.js';
import { config } from '../../config.js';

export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);

// GET /api/admin/users — list all users
adminRouter.get('/users', (_req: AuthenticatedRequest, res: Response) => {
  const users = getDb()
    .prepare(
      'SELECT id, email, username, avatar_url, is_admin, created_at FROM users ORDER BY created_at DESC'
    )
    .all();
  res.json(users);
});

// DELETE /api/admin/users/:id — delete user and their data
adminRouter.delete('/users/:id', (req: AuthenticatedRequest, res: Response) => {
  const targetId = req.params.id;

  if (targetId === req.user!.id) {
    res.status(400).json({ error: 'Cannot delete yourself' });
    return;
  }

  const db = getDb();

  // Find user's owned projects to clean up storage
  const ownedProjects = db.prepare('SELECT id FROM projects WHERE owner_id = ?').all(targetId) as {
    id: string;
  }[];

  for (const project of ownedProjects) {
    const dir = path.resolve(config.PROJECTS_STORAGE_DIR, project.id);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // CASCADE will delete projects and project_members
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  res.json({ ok: true });
});

// GET /api/admin/projects — list all projects
adminRouter.get('/projects', (_req: AuthenticatedRequest, res: Response) => {
  const projects = getDb()
    .prepare(
      `SELECT p.*, u.username as owner_username, u.email as owner_email
       FROM projects p JOIN users u ON p.owner_id = u.id
       ORDER BY p.updated_at DESC`
    )
    .all();
  res.json(projects);
});

// DELETE /api/admin/projects/:id — delete any project
adminRouter.delete('/projects/:id', (req: AuthenticatedRequest, res: Response) => {
  const projectId = req.params.id;
  const db = getDb();

  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  // Remove storage
  const dir = path.resolve(config.PROJECTS_STORAGE_DIR, projectId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Delete from DB
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  res.json({ ok: true });
});
