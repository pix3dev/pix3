import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDb } from '../db.js';
import { config } from '../../config.js';

export interface ProjectRow {
  id: string;
  owner_id: string;
  name: string;
  share_token: string | null;
  created_at: string;
  updated_at: string;
}

export type ProjectMemberRole = 'owner' | 'editor' | 'viewer';
export type AssignableProjectMemberRole = Exclude<ProjectMemberRole, 'owner'>;

export interface ProjectMemberRow {
  project_id: string;
  user_id: string;
  role: ProjectMemberRole;
}

export interface ProjectMemberInfo {
  user_id: string;
  email: string;
  username: string;
  role: ProjectMemberRole;
}

export interface ProjectUserSuggestion {
  id: string;
  email: string;
  username: string;
}

export interface ProjectAccessInfo {
  project: ProjectRow;
  role: ProjectMemberRole;
  authSource: 'member' | 'share-token';
  accessMode: 'edit' | 'view';
  shareEnabled: boolean;
}

export class ProjectsServiceError extends Error {
  constructor(
    public readonly code:
      | 'invalid-role'
      | 'member-exists'
      | 'member-not-found'
      | 'user-not-found'
      | 'cannot-remove-owner'
      | 'cannot-change-owner',
    message: string
  ) {
    super(message);
    this.name = 'ProjectsServiceError';
  }
}

const ASSIGNABLE_PROJECT_MEMBER_ROLES = new Set<AssignableProjectMemberRole>(['editor', 'viewer']);

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function getMemberInfo(projectId: string, userId: string): ProjectMemberInfo | undefined {
  return getDb()
    .prepare(
      `SELECT pm.user_id, u.email, u.username, pm.role
       FROM project_members pm
       INNER JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = ? AND pm.user_id = ?`
    )
    .get(projectId, userId) as ProjectMemberInfo | undefined;
}

function getUserByEmail(email: string): ProjectUserSuggestion | undefined {
  return getDb()
    .prepare('SELECT id, email, username FROM users WHERE LOWER(email) = ?')
    .get(normalizeEmail(email)) as ProjectUserSuggestion | undefined;
}

export function isAssignableProjectMemberRole(
  value: unknown
): value is AssignableProjectMemberRole {
  return (
    typeof value === 'string' &&
    ASSIGNABLE_PROJECT_MEMBER_ROLES.has(value as AssignableProjectMemberRole)
  );
}

export function listUserProjects(userId: string): ProjectRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT DISTINCT p.* FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.id
       WHERE p.owner_id = ? OR pm.user_id = ?
       ORDER BY p.updated_at DESC`
    )
    .all(userId, userId) as ProjectRow[];
}

export function getProject(projectId: string): ProjectRow | undefined {
  return getDb().prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
    | ProjectRow
    | undefined;
}

export function getProjectByShareToken(token: string): ProjectRow | undefined {
  return getDb().prepare('SELECT * FROM projects WHERE share_token = ?').get(token) as
    | ProjectRow
    | undefined;
}

export function createProject(ownerId: string, name: string): ProjectRow {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    'INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, ownerId, name, now, now);

  db.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)').run(
    id,
    ownerId,
    'owner'
  );

  // Create project storage directory
  const projectDir = path.resolve(config.PROJECTS_STORAGE_DIR, id);
  fs.mkdirSync(projectDir, { recursive: true });

  return { id, owner_id: ownerId, name, share_token: null, created_at: now, updated_at: now };
}

export function deleteProject(projectId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

  // Remove project storage directory
  const projectDir = path.resolve(config.PROJECTS_STORAGE_DIR, projectId);
  if (fs.existsSync(projectDir)) {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

/** What {@link ensureShareToken} did, so the router can say so and a caller can tell them apart. */
export interface ShareTokenResult {
  token: string;
  outcome: 'created' | 'existing' | 'rotated';
}

function mintShareToken(projectId: string): string {
  const token = crypto.randomBytes(24).toString('base64url');
  getDb().prepare('UPDATE projects SET share_token = ? WHERE id = ?').run(token, projectId);
  return token;
}

/**
 * The project's share token, minting one only if there is none.
 *
 * Idempotent on purpose. This used to overwrite unconditionally, so opening the share dialog and
 * picking "link" a second time silently invalidated every link already sent out — with a 200 and a
 * fresh token that looked exactly like the first one. Rotation is still available, but it now has
 * to be asked for (`rotate: true`), which is the difference between an accident and a decision.
 */
export function ensureShareToken(projectId: string, rotate = false): ShareTokenResult | null {
  const project = getProject(projectId);
  if (!project) {
    return null;
  }

  if (rotate) {
    return { token: mintShareToken(projectId), outcome: 'rotated' };
  }

  if (project.share_token) {
    return { token: project.share_token, outcome: 'existing' };
  }

  return { token: mintShareToken(projectId), outcome: 'created' };
}

export function revokeShareToken(projectId: string): void {
  getDb().prepare('UPDATE projects SET share_token = NULL WHERE id = ?').run(projectId);
}

export function getUserRole(projectId: string, userId: string): ProjectMemberRole | null {
  const row = getDb()
    .prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?')
    .get(projectId, userId) as { role: ProjectMemberRole } | undefined;
  return row?.role ?? null;
}

export function listProjectMembers(projectId: string): ProjectMemberInfo[] {
  return getDb()
    .prepare(
      `SELECT pm.user_id, u.email, u.username, pm.role
       FROM project_members pm
       INNER JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = ?
       ORDER BY
         CASE pm.role
           WHEN 'owner' THEN 0
           WHEN 'editor' THEN 1
           ELSE 2
         END,
         LOWER(u.email) ASC`
    )
    .all(projectId) as ProjectMemberInfo[];
}

export function searchProjectUsersByEmail(
  projectId: string,
  emailQuery: string,
  limit = 8
): ProjectUserSuggestion[] {
  const normalizedQuery = normalizeEmail(emailQuery);
  if (normalizedQuery.length < 2) {
    return [];
  }

  const safeLimit = Math.max(1, Math.min(limit, 20));
  return getDb()
    .prepare(
      `SELECT u.id, u.email, u.username
       FROM users u
       WHERE LOWER(u.email) LIKE ?
         AND NOT EXISTS (
           SELECT 1
           FROM project_members pm
           WHERE pm.project_id = ? AND pm.user_id = u.id
         )
       ORDER BY
         CASE
           WHEN LOWER(u.email) = ? THEN 0
           WHEN LOWER(u.email) LIKE ? THEN 1
           ELSE 2
         END,
         LOWER(u.email) ASC
       LIMIT ?`
    )
    .all(
      `%${normalizedQuery}%`,
      projectId,
      normalizedQuery,
      `${normalizedQuery}%`,
      safeLimit
    ) as ProjectUserSuggestion[];
}

export function addProjectMember(
  projectId: string,
  email: string,
  role: AssignableProjectMemberRole
): ProjectMemberInfo {
  if (!isAssignableProjectMemberRole(role)) {
    throw new ProjectsServiceError('invalid-role', 'Role must be editor or viewer.');
  }

  const user = getUserByEmail(email);
  if (!user) {
    throw new ProjectsServiceError('user-not-found', 'No Pix3 user found with that email address.');
  }

  const existingMember = getUserRole(projectId, user.id);
  if (existingMember) {
    throw new ProjectsServiceError('member-exists', 'That user is already a project member.');
  }

  getDb()
    .prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)')
    .run(projectId, user.id, role);
  touchProject(projectId);

  return {
    user_id: user.id,
    email: user.email,
    username: user.username,
    role,
  };
}

export function updateProjectMemberRole(
  projectId: string,
  userId: string,
  role: AssignableProjectMemberRole
): ProjectMemberInfo {
  if (!isAssignableProjectMemberRole(role)) {
    throw new ProjectsServiceError('invalid-role', 'Role must be editor or viewer.');
  }

  const member = getMemberInfo(projectId, userId);
  if (!member) {
    throw new ProjectsServiceError('member-not-found', 'Project member not found.');
  }

  if (member.role === 'owner') {
    throw new ProjectsServiceError(
      'cannot-change-owner',
      'The project owner role cannot be changed.'
    );
  }

  getDb()
    .prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?')
    .run(role, projectId, userId);
  touchProject(projectId);

  return {
    ...member,
    role,
  };
}

export function removeProjectMember(projectId: string, userId: string): void {
  const member = getMemberInfo(projectId, userId);
  if (!member) {
    throw new ProjectsServiceError('member-not-found', 'Project member not found.');
  }

  if (member.role === 'owner') {
    throw new ProjectsServiceError('cannot-remove-owner', 'The project owner cannot be removed.');
  }

  getDb()
    .prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?')
    .run(projectId, userId);
  touchProject(projectId);
}

export function removeAllNonOwnerMembers(projectId: string): number {
  const result = getDb()
    .prepare("DELETE FROM project_members WHERE project_id = ? AND role != 'owner'")
    .run(projectId);

  if (result.changes > 0) {
    touchProject(projectId);
  }

  return result.changes;
}

export function resolveProjectAccess(
  projectId: string,
  options: {
    userId?: string | null;
    shareToken?: string | null;
  }
): ProjectAccessInfo | null {
  const project = getProject(projectId);
  if (!project) {
    return null;
  }

  const userId = options.userId?.trim();
  if (userId) {
    const role = getUserRole(projectId, userId);
    if (role === 'owner' || role === 'editor' || role === 'viewer') {
      return {
        project,
        role,
        authSource: 'member',
        accessMode: role === 'viewer' ? 'view' : 'edit',
        shareEnabled: project.share_token !== null,
      };
    }
  }

  const shareToken = options.shareToken?.trim();
  if (shareToken && project.share_token === shareToken) {
    return {
      project,
      role: 'viewer',
      authSource: 'share-token',
      accessMode: 'view',
      shareEnabled: true,
    };
  }

  return null;
}

export function touchProject(projectId: string): void {
  getDb().prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(projectId);
}
