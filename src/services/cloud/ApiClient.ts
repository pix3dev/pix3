const SERVER_BASE_URL = import.meta.env.VITE_COLLAB_SERVER_URL || 'http://localhost:4001';
const BASE_URL = import.meta.env.DEV ? '' : SERVER_BASE_URL;
export const PROJECT_UPLOAD_FILE_SIZE_LIMIT_BYTES = 100 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function getUploadLimitMessage(filePath?: string): string {
  const prefix = filePath ? `File ${filePath}` : 'File';
  return `${prefix} was rejected with HTTP 413. Pix3 server limit is ${formatBytes(PROJECT_UPLOAD_FILE_SIZE_LIMIT_BYTES)}, but an upstream proxy may enforce a lower limit.`;
}

export function formatUploadLimitBytes(bytes: number): string {
  return formatBytes(bytes);
}

export interface ApiUser {
  id: string;
  email: string;
  username: string;
  is_admin: boolean;
  token?: string;
}

export interface ApiProject {
  id: string;
  owner_id: string;
  name: string;
  share_token: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiProjectAccess {
  id: string;
  name: string;
  role: 'owner' | 'editor' | 'viewer';
  auth_source: 'member' | 'share-token';
  access_mode: 'edit' | 'view';
  share_enabled: boolean;
  share_token: string | null;
}

export type ApiAssignableProjectMemberRole = 'editor' | 'viewer';

export interface ApiProjectMember {
  user_id: string;
  email: string;
  username: string;
  role: 'owner' | 'editor' | 'viewer';
}

export interface ApiProjectUserSuggestion {
  id: string;
  email: string;
  username: string;
}

export interface ManifestEntry {
  path: string;
  kind: 'file' | 'directory';
  size: number;
  hash: string;
  modified: string;
}

/** One unmet publish requirement, as reported by the store's server-side gate. */
export interface ApiStoreValidationIssue {
  field: string;
  message: string;
}

class ApiClientError extends Error {
  /**
   * Field-level detail for endpoints that reject with a checklist rather than one message
   * (today: the Asset Store publish gate, `400 { error, issues }`).
   */
  public issues?: ApiStoreValidationIssue[];

  constructor(
    message: string,
    public status: number,
    public url?: string
  ) {
    const fullMessage = url ? `${message} (${url})` : message;
    super(fullMessage);
    this.name = 'ApiClientError';
  }
}

/** Pick up an `issues` array when the server sent one, so callers can render a per-field list. */
function readIssues(body: unknown): ApiStoreValidationIssue[] | undefined {
  const issues = (body as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues)) {
    return undefined;
  }
  return issues.filter(
    (issue): issue is ApiStoreValidationIssue =>
      typeof (issue as ApiStoreValidationIssue)?.field === 'string' &&
      typeof (issue as ApiStoreValidationIssue)?.message === 'string'
  );
}

/**
 * Encode a project- or bundle-relative path for a `/files/*` URL.
 *
 * Per segment, so the `/` separators the wildcard route depends on survive while everything else is
 * escaped. Interpolating the raw path — which the project file routes did, while `projectId` right
 * beside them was encoded — truncates at the first `?` or `#` in a filename and lets the URL parser
 * collapse a `..` segment before the request is even sent.
 */
function encodeResourcePath(resourcePath: string): string {
  return resourcePath
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const fullUrl = `${BASE_URL}${path}`;
  const res = await fetch(fullUrl, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    if (res.status === 413) {
      throw new ApiClientError(getUploadLimitMessage(), res.status, fullUrl);
    }
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const error = new ApiClientError(body.error ?? res.statusText, res.status, fullUrl);
    error.issues = readIssues(body);
    throw error;
  }
  return res.json() as Promise<T>;
}

function buildShareTokenHeaders(
  headers: HeadersInit | undefined,
  shareToken?: string
): HeadersInit | undefined {
  if (!shareToken) {
    return headers;
  }

  return {
    ...(headers ?? {}),
    'X-Share-Token': shareToken,
  };
}

// --- Auth ---

export function register(email: string, username: string, password: string): Promise<ApiUser> {
  return request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, username, password }),
  });
}

export function login(email: string, password: string): Promise<ApiUser> {
  return request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function logout(): Promise<void> {
  await request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
}

export function getMe(): Promise<ApiUser> {
  return request('/api/auth/me');
}

// --- Projects ---

export function getProjects(): Promise<ApiProject[]> {
  return request('/api/projects');
}

export function createProject(name: string): Promise<ApiProject> {
  return request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export function deleteProject(id: string): Promise<{ ok: boolean }> {
  return request(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function generateShareToken(id: string): Promise<{ share_token: string }> {
  return request(`/api/projects/${encodeURIComponent(id)}/share`, {
    method: 'POST',
  });
}

export function getProjectAccess(id: string, shareToken?: string): Promise<ApiProjectAccess> {
  return request(`/api/projects/${encodeURIComponent(id)}/access`, {
    headers: buildShareTokenHeaders(undefined, shareToken),
  });
}

export function revokeShareToken(id: string): Promise<{ ok: boolean }> {
  return request(`/api/projects/${encodeURIComponent(id)}/share`, {
    method: 'DELETE',
  });
}

export function getProjectMembers(id: string): Promise<{ members: ApiProjectMember[] }> {
  return request(`/api/projects/${encodeURIComponent(id)}/members`);
}

export function searchProjectUsersByEmail(
  id: string,
  email: string
): Promise<{ users: ApiProjectUserSuggestion[] }> {
  const params = new URLSearchParams({ email });
  return request(`/api/projects/${encodeURIComponent(id)}/members/search?${params.toString()}`);
}

export function addProjectMember(
  id: string,
  email: string,
  role: ApiAssignableProjectMemberRole
): Promise<ApiProjectMember> {
  return request(`/api/projects/${encodeURIComponent(id)}/members`, {
    method: 'POST',
    body: JSON.stringify({ email, role }),
  });
}

export function updateProjectMemberRole(
  id: string,
  userId: string,
  role: ApiAssignableProjectMemberRole
): Promise<ApiProjectMember> {
  return request(`/api/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
}

export function removeProjectMember(id: string, userId: string): Promise<{ ok: boolean }> {
  return request(`/api/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
}

export function removeAllNonOwnerProjectMembers(
  id: string
): Promise<{ ok: boolean; removed_count: number }> {
  return request(`/api/projects/${encodeURIComponent(id)}/members/non-owner`, {
    method: 'DELETE',
  });
}

// --- Storage ---

export function getManifestWithAccess(
  projectId: string,
  shareToken?: string
): Promise<{ files: ManifestEntry[] }> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/manifest`, {
    headers: buildShareTokenHeaders(undefined, shareToken),
  });
}

export async function downloadFile(
  projectId: string,
  filePath: string,
  shareToken?: string
): Promise<Response> {
  const res = await fetch(
    `${BASE_URL}/api/projects/${encodeURIComponent(projectId)}/files/${encodeResourcePath(filePath)}`,
    {
      credentials: 'include',
      headers: buildShareTokenHeaders(undefined, shareToken),
    }
  );
  if (!res.ok) {
    throw new ApiClientError(`Failed to download ${filePath}`, res.status);
  }
  return res;
}

export async function uploadFile(
  projectId: string,
  filePath: string,
  content: Blob | ArrayBuffer | string
): Promise<{ path: string; size: number }> {
  const formData = new FormData();
  const blob =
    content instanceof Blob
      ? content
      : content instanceof ArrayBuffer
        ? new Blob([content])
        : new Blob([content], { type: 'text/plain' });
  formData.append('file', blob, filePath.split('/').pop() ?? 'file');

  const res = await fetch(
    `${BASE_URL}/api/projects/${encodeURIComponent(projectId)}/files/${encodeResourcePath(filePath)}`,
    {
      method: 'POST',
      credentials: 'include',
      body: formData,
    }
  );
  if (!res.ok) {
    if (res.status === 413) {
      throw new ApiClientError(getUploadLimitMessage(filePath), res.status);
    }
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiClientError(body.error ?? res.statusText, res.status);
  }
  return res.json();
}

export async function deleteFile(projectId: string, filePath: string): Promise<{ ok: boolean }> {
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/files/${encodeResourcePath(filePath)}`,
    {
      method: 'DELETE',
    }
  );
}

export async function createDirectory(
  projectId: string,
  directoryPath: string
): Promise<{ path: string }> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/directories/${directoryPath}`, {
    method: 'POST',
  });
}

// --- Personal Asset Library (cloud sync) ---

export interface LibraryIndexEntry {
  id: string;
  visibility: 'private' | 'team';
  /** Parsed manifest JSON, or null for a tombstone (deleted item). */
  manifest: unknown | null;
  /** Epoch-ms authoritative timestamp for last-write-wins reconciliation. */
  updatedAt: number;
  deleted: boolean;
}

/** A bundle file to upload, keyed by its bundle-relative path. */
export interface LibraryUploadFile {
  path: string;
  blob: Blob;
}

/** The caller's full private library index, including tombstones (for two-way sync). */
export function getLibraryIndex(): Promise<{ items: LibraryIndexEntry[] }> {
  return request('/api/library/items');
}

export async function downloadLibraryFile(itemId: string, filePath: string): Promise<Response> {
  const res = await fetch(
    `${BASE_URL}/api/library/items/${encodeURIComponent(itemId)}/files/${encodeResourcePath(filePath)}`,
    { credentials: 'include' }
  );
  if (!res.ok) {
    throw new ApiClientError(`Failed to download library file ${filePath}`, res.status);
  }
  return res;
}

/** Upload/replace a whole bundle. `manifest.id` must equal `itemId` (server-enforced). */
export async function uploadLibraryItem(
  itemId: string,
  manifest: unknown,
  files: readonly LibraryUploadFile[]
): Promise<{ id: string; updatedAt: number }> {
  const formData = new FormData();
  formData.append('manifest', JSON.stringify(manifest));
  formData.append('paths', JSON.stringify(files.map(file => file.path)));
  for (const file of files) {
    formData.append('files', file.blob, file.path.split('/').pop() ?? 'file');
  }

  const res = await fetch(`${BASE_URL}/api/library/items/${encodeURIComponent(itemId)}`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });
  if (!res.ok) {
    if (res.status === 413) {
      throw new ApiClientError(getUploadLimitMessage(itemId), res.status);
    }
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiClientError(body.error ?? res.statusText, res.status);
  }
  return res.json();
}

export function deleteLibraryItem(
  itemId: string,
  deletedAt: number
): Promise<{ ok: boolean; deletedAt: number }> {
  return request(`/api/library/items/${encodeURIComponent(itemId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ deletedAt }),
  });
}

// --- Curated Asset Store (public reads, admin writes) ---

/** Lifecycle of a store item; mirrors the server column. */
export type ApiStoreItemStatus = 'draft' | 'published' | 'unlisted';

/**
 * One catalog row. The server re-stamps its own columns (status/categoryPath/featured/downloads/
 * publisherId) onto `manifest` before sending, so the manifest is self-sufficient for the UI.
 */
export interface ApiStoreItem {
  id: string;
  manifest: Record<string, unknown> | null;
  updatedAt: number;
  status: ApiStoreItemStatus;
  categoryPath: string | null;
  featured: boolean;
  downloads: number;
  publishedAt: number | null;
}

/** A taxonomy node. `id` is the full path (`ui`, `ui/buttons`); depth is capped at 2. */
export interface ApiStoreCategory {
  id: string;
  parentId: string | null;
  label: string;
  sortOrder: number;
  /** Published items filed directly here (subcategories count separately). */
  itemCount: number;
}

export interface ApiStoreCategoryInput {
  id: string;
  parentId?: string | null;
  label: string;
  sortOrder?: number;
}

export interface ApiStoreAuditEntry {
  id: number;
  actorId: string;
  /** Username of the acting admin; `null` when that account no longer exists. */
  actorName: string | null;
  action: string;
  itemId: string | null;
  detail: unknown;
  createdAt: string;
}

export interface ApiStoreListParams {
  q?: string;
  /** Category path filter; matches the category and its subcategories server-side. */
  category?: string;
  type?: string;
  /** Admin-only narrowing; anonymous callers are pinned to `published` regardless. */
  status?: ApiStoreItemStatus | 'all';
  sort?: 'updated' | 'downloads' | 'featured';
}

export interface ApiStoreItemMetaPatch {
  status?: ApiStoreItemStatus;
  categoryPath?: string | null;
  featured?: boolean;
  /** Shallow-merged into the stored manifest (name/description/tags/license/…). */
  manifestPatch?: Record<string, unknown>;
}

/**
 * Direct URL of a bundle file. Store reads are public, so previews and downloads go straight to
 * this URL (`<img src>`, plain `fetch`) with no cookie and no manifest round-trip.
 */
export function storeFileUrl(itemId: string, bundlePath: string): string {
  return `${BASE_URL}/api/library/store/items/${encodeURIComponent(itemId)}/files/${encodeResourcePath(bundlePath)}`;
}

/**
 * URL of a store item resource. Exported because the bundle upload runs on `XMLHttpRequest`
 * (progress + abort, see `StoreUploadService`) and still has to hit exactly this endpoint.
 */
export function storeItemUrl(itemId: string): string {
  return `${BASE_URL}/api/library/store/items/${encodeURIComponent(itemId)}`;
}

export function getStoreIndex(params: ApiStoreListParams = {}): Promise<{ items: ApiStoreItem[] }> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      query.set(key, value);
    }
  }
  const search = query.toString();
  return request(`/api/library/store/items${search ? `?${search}` : ''}`);
}

export function getStoreItem(itemId: string): Promise<{ item: ApiStoreItem }> {
  return request(`/api/library/store/items/${encodeURIComponent(itemId)}`);
}

/** Upload/replace a whole store bundle (admin). `manifest.id` must equal `itemId`. */
export async function uploadStoreItem(
  itemId: string,
  manifest: unknown,
  files: readonly LibraryUploadFile[]
): Promise<{ id: string; updatedAt: number; status: ApiStoreItemStatus }> {
  const formData = new FormData();
  formData.append('manifest', JSON.stringify(manifest));
  formData.append('paths', JSON.stringify(files.map(file => file.path)));
  for (const file of files) {
    formData.append('files', file.blob, file.path.split('/').pop() ?? 'file');
  }

  const res = await fetch(`${BASE_URL}/api/library/store/items/${encodeURIComponent(itemId)}`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });
  if (!res.ok) {
    if (res.status === 413) {
      throw new ApiClientError(getUploadLimitMessage(itemId), res.status);
    }
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const error = new ApiClientError(body.error ?? res.statusText, res.status);
    error.issues = readIssues(body);
    throw error;
  }
  return res.json();
}

/** Status / category / featured / manifest-field edit (admin). Publishing runs the server gate. */
export function patchStoreItemMeta(
  itemId: string,
  patch: ApiStoreItemMetaPatch
): Promise<{ item: ApiStoreItem }> {
  return request(`/api/library/store/items/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/** Hard delete: row plus bundle files (admin). The store has no tombstones — clients only read. */
export function deleteStoreItem(itemId: string): Promise<{ ok: boolean }> {
  return request(`/api/library/store/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
}

/** Popularity ping, sent once per materialized bundle (not per downloaded file). */
export function pingStoreDownload(itemId: string): Promise<{ downloads: number }> {
  return request(`/api/library/store/items/${encodeURIComponent(itemId)}/download`, {
    method: 'POST',
  });
}

export function getStoreCategories(): Promise<{ categories: ApiStoreCategory[] }> {
  return request('/api/library/store/categories');
}

export function createStoreCategory(
  input: ApiStoreCategoryInput
): Promise<{ category: ApiStoreCategory }> {
  return request('/api/library/store/categories', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateStoreCategory(
  categoryId: string,
  patch: { label?: string; sortOrder?: number }
): Promise<{ ok: boolean }> {
  return request(`/api/library/store/categories/${encodeURIComponent(categoryId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/** Delete a category; the server re-homes its items to the parent (or to none). */
export function deleteStoreCategory(categoryId: string): Promise<{ ok: boolean }> {
  return request(`/api/library/store/categories/${encodeURIComponent(categoryId)}`, {
    method: 'DELETE',
  });
}

export function getStoreAudit(limit = 50, offset = 0): Promise<{ entries: ApiStoreAuditEntry[] }> {
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return request(`/api/library/store/audit?${query.toString()}`);
}

export { ApiClientError };
