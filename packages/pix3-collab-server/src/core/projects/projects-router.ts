import { Router, Response, NextFunction } from 'express';
import { attachOptionalAuth, requireAuth, AuthenticatedRequest } from '../auth/auth-middleware.js';
import * as projectsService from './projects-service.js';

export const projectsRouter = Router();

// Middleware: check project access for routes with :id param
function requireProjectAccess(...allowedRoles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const projectId = req.params.id;
    const userId = req.user!.id;

    const project = projectsService.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const role = projectsService.getUserRole(projectId, userId);
    if (!role || (allowedRoles.length > 0 && !allowedRoles.includes(role))) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    next();
  };
}

function handleProjectsServiceError(res: Response, error: unknown): void {
  if (!(error instanceof projectsService.ProjectsServiceError)) {
    throw error;
  }

  switch (error.code) {
    case 'invalid-role':
      res.status(400).json({ error: error.message });
      return;
    case 'user-not-found':
    case 'member-not-found':
      res.status(404).json({ error: error.message });
      return;
    case 'member-exists':
      res.status(409).json({ error: error.message });
      return;
    case 'cannot-remove-owner':
    case 'cannot-change-owner':
      res.status(400).json({ error: error.message });
      return;
    default:
      res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/projects — list user's projects
projectsRouter.get('/', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const projects = projectsService.listUserProjects(req.user!.id);
  res.json(projects);
});

// POST /api/projects — create new project
projectsRouter.post('/', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    res.status(400).json({ error: 'Project name is required' });
    return;
  }

  const project = projectsService.createProject(req.user!.id, name.trim());
  res.status(201).json(project);
});

// GET /api/projects/:id/access — project metadata with share-token-aware access check
projectsRouter.get(
  '/:id/access',
  attachOptionalAuth,
  (req: AuthenticatedRequest, res: Response) => {
    const shareTokenHeader = req.header('x-share-token');
    const access = projectsService.resolveProjectAccess(req.params.id, {
      userId: req.user?.id ?? null,
      shareToken: typeof shareTokenHeader === 'string' ? shareTokenHeader : null,
    });

    if (!access) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    res.json({
      id: access.project.id,
      name: access.project.name,
      role: access.role,
      auth_source: access.authSource,
      access_mode: access.accessMode,
      share_enabled: access.shareEnabled,
      share_token: access.authSource === 'member' ? access.project.share_token : null,
    });
  }
);

projectsRouter.get(
  '/:id/members',
  requireAuth,
  requireProjectAccess('owner', 'editor', 'viewer'),
  (req: AuthenticatedRequest, res: Response) => {
    const members = projectsService.listProjectMembers(req.params.id);
    res.json({ members });
  }
);

projectsRouter.get(
  '/:id/members/search',
  requireAuth,
  requireProjectAccess('owner'),
  (req: AuthenticatedRequest, res: Response) => {
    const emailQuery = typeof req.query.email === 'string' ? req.query.email : '';
    const users = projectsService.searchProjectUsersByEmail(req.params.id, emailQuery);
    res.json({ users });
  }
);

projectsRouter.post(
  '/:id/members',
  requireAuth,
  requireProjectAccess('owner'),
  (req: AuthenticatedRequest, res: Response) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const role = req.body?.role;

    if (!email) {
      res.status(400).json({ error: 'Email is required.' });
      return;
    }

    if (!projectsService.isAssignableProjectMemberRole(role)) {
      res.status(400).json({ error: 'Role must be editor or viewer.' });
      return;
    }

    try {
      const member = projectsService.addProjectMember(req.params.id, email, role);
      res.status(201).json(member);
    } catch (error) {
      handleProjectsServiceError(res, error);
    }
  }
);

projectsRouter.delete(
  '/:id/members/non-owner',
  requireAuth,
  requireProjectAccess('owner'),
  (req: AuthenticatedRequest, res: Response) => {
    const removedCount = projectsService.removeAllNonOwnerMembers(req.params.id);
    res.json({ ok: true, removed_count: removedCount });
  }
);

projectsRouter.patch(
  '/:id/members/:userId',
  requireAuth,
  requireProjectAccess('owner'),
  (req: AuthenticatedRequest, res: Response) => {
    const role = req.body?.role;
    if (!projectsService.isAssignableProjectMemberRole(role)) {
      res.status(400).json({ error: 'Role must be editor or viewer.' });
      return;
    }

    try {
      const member = projectsService.updateProjectMemberRole(
        req.params.id,
        req.params.userId,
        role
      );
      res.json(member);
    } catch (error) {
      handleProjectsServiceError(res, error);
    }
  }
);

projectsRouter.delete(
  '/:id/members/:userId',
  requireAuth,
  requireProjectAccess('owner'),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      projectsService.removeProjectMember(req.params.id, req.params.userId);
      res.json({ ok: true });
    } catch (error) {
      handleProjectsServiceError(res, error);
    }
  }
);

/**
 * POST /api/projects/:id/share — the project's share link.
 *
 * **Owner-only, like the revoke below.** It used to accept `editor` too, so an editor could publish
 * a world-readable link to a project whose owner had no way to see it had been created — an
 * asymmetry with no reason behind it, since only the owner could take it back. The editor UI has
 * always gated this control on `role === 'owner'`, so the two now agree.
 *
 * Idempotent: returns the existing token unless `rotate: true` is passed. See `ensureShareToken`.
 */
projectsRouter.post(
  '/:id/share',
  requireAuth,
  requireProjectAccess('owner'),
  (req: AuthenticatedRequest, res: Response) => {
    const rotate = (req.body as { rotate?: unknown } | undefined)?.rotate === true;
    const result = projectsService.ensureShareToken(req.params.id, rotate);
    if (!result) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    res.json({ share_token: result.token, outcome: result.outcome });
  }
);

// DELETE /api/projects/:id/share — revoke share token
projectsRouter.delete(
  '/:id/share',
  requireAuth,
  requireProjectAccess('owner'),
  (req: AuthenticatedRequest, res: Response) => {
    projectsService.revokeShareToken(req.params.id);
    res.json({ ok: true });
  }
);

// DELETE /api/projects/:id — delete project
projectsRouter.delete(
  '/:id',
  requireAuth,
  requireProjectAccess('owner'),
  (req: AuthenticatedRequest, res: Response) => {
    projectsService.deleteProject(req.params.id);
    res.json({ ok: true });
  }
);
