import { injectable } from '@/fw/di';
import {
  WorkspaceConflictError,
  WorkspaceError,
  isLoopbackHostname,
  toWorkspacePath,
  type WorkspaceChangeEvent,
  type WorkspaceDeleteResult,
  type WorkspaceManifest,
  type WorkspaceManifestEntry,
  type WorkspaceMkdirResult,
  type WorkspaceMoveResult,
  type WorkspaceStatusInfo,
  type WorkspaceWriteResult,
} from '@/services/project/workspace/workspace-protocol';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface CachedBody {
  readonly etag: string;
  readonly blob: Blob;
}

interface RequestOptions {
  readonly method: 'GET' | 'HEAD' | 'PUT' | 'POST';
  readonly route: string;
  readonly path?: string;
  readonly body?: BodyInit;
  readonly json?: unknown;
  readonly headers?: Record<string, string>;
  /** Mutations carry an id; a lost response is retried once with the SAME id (journal replay). */
  readonly mutation?: boolean;
  /** Status codes the caller handles itself instead of getting a thrown error. */
  readonly accept?: readonly number[];
}

/** Bodies above this are not kept for `If-None-Match` revalidation (the hash still is). */
const MAX_CACHED_BODY_BYTES = 8 * 1024 * 1024;

/**
 * HTTP client of one `pix3 serve` workspace (`packages/pix3-cli/README.md`, "Routes").
 *
 * Owns three pieces of per-path memory, all in memory only and all dropped by {@link reset}:
 * - **known hash** — the sha256 of the bytes this editor last read or wrote. It is the `If-Match`
 *   base of the next write, so a save over a file the agent changed meanwhile is refused with
 *   {@link WorkspaceConflictError} instead of silently overwriting it. A manifest or a change
 *   event never updates it: only bytes this editor actually has count as a base.
 * - **body cache** — last bytes + ETag, revalidated with `If-None-Match` (a `304` costs no body).
 * - **manifest** — the last `/ws/manifest`, patched in place by this client's own mutations and by
 *   pushed change events, so directory listings do not need a full server scan per call.
 */
@injectable()
export class WorkspaceClient {
  private endpoint: string | null = null;
  private token: string | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly knownHashes = new Map<string, string>();
  private readonly bodyCache = new Map<string, CachedBody>();
  private manifest: WorkspaceManifest | null = null;
  private manifestEntries = new Map<string, WorkspaceManifestEntry>();
  private manifestRequest: Promise<WorkspaceManifest> | null = null;

  constructor(fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  configure(options: { readonly endpoint: string; readonly token: string }): void {
    if (options.endpoint !== this.endpoint) {
      this.clearCaches();
    }
    this.endpoint = options.endpoint;
    this.token = options.token;
  }

  reset(): void {
    this.endpoint = null;
    this.token = null;
    this.clearCaches();
  }

  isConfigured(): boolean {
    return this.endpoint !== null && this.token !== null;
  }

  getEndpoint(): string | null {
    return this.endpoint;
  }

  /** Hash of the bytes this editor last read or wrote at `path` (the next write's base). */
  getKnownHash(path: string): string | null {
    return this.knownHashes.get(toWorkspacePath(path)) ?? null;
  }

  /** Drop the cached body of `path` (its known hash stays — it is still our write base). */
  invalidate(path: string): void {
    this.bodyCache.delete(toWorkspacePath(path));
  }

  // --- Manifest -------------------------------------------------------------------------------

  getCachedManifest(): WorkspaceManifest | null {
    return this.manifest;
  }

  getManifestEntry(path: string): WorkspaceManifestEntry | null {
    return this.manifestEntries.get(toWorkspacePath(path)) ?? null;
  }

  /** All entries (files and directories) of the last manifest, patched with later changes. */
  getManifestEntries(): WorkspaceManifestEntry[] {
    return Array.from(this.manifestEntries.values());
  }

  /** Cached manifest unless `force`; concurrent callers share one request. */
  async getManifest(force = false): Promise<WorkspaceManifest> {
    if (!force && this.manifest) {
      return this.manifest;
    }
    if (this.manifestRequest) {
      return this.manifestRequest;
    }
    this.manifestRequest = (async () => {
      const response = await this.request({ method: 'GET', route: '/ws/manifest' });
      const manifest = (await response.json()) as WorkspaceManifest;
      this.manifest = manifest;
      this.manifestEntries = new Map(manifest.files.map(entry => [entry.path, entry]));
      return manifest;
    })();
    try {
      return await this.manifestRequest;
    } finally {
      this.manifestRequest = null;
    }
  }

  /** Apply pushed change events to the cached manifest (and forget stale bodies). */
  applyChangeEvents(events: readonly WorkspaceChangeEvent[]): void {
    for (const event of events) {
      if (event.op === 'rename' && event.from) {
        this.removeManifestPath(event.from);
        this.bodyCache.delete(event.from);
      }
      if (event.op === 'delete') {
        this.removeManifestPath(event.path);
        this.bodyCache.delete(event.path);
        continue;
      }
      if (event.kind === 'dir') {
        this.upsertManifestEntry({ path: event.path, kind: 'dir', size: 0, mtime: Date.now() });
        continue;
      }
      const cached = this.bodyCache.get(event.path);
      if (cached && cached.etag !== event.sha256) {
        this.bodyCache.delete(event.path);
      }
      const previous = this.manifestEntries.get(event.path);
      this.upsertManifestEntry({
        path: event.path,
        kind: 'file',
        size: previous?.size ?? 0,
        mtime: Date.now(),
        ...(event.sha256 ? { sha256: event.sha256 } : {}),
      });
    }
  }

  // --- Reads ----------------------------------------------------------------------------------

  async status(): Promise<WorkspaceStatusInfo> {
    const response = await this.request({ method: 'GET', route: '/ws/status' });
    return (await response.json()) as WorkspaceStatusInfo;
  }

  async readBlob(path: string): Promise<Blob> {
    const normalized = toWorkspacePath(path);
    const cached = this.bodyCache.get(normalized);
    const response = await this.request({
      method: 'GET',
      route: '/ws/file',
      path: normalized,
      headers: cached ? { 'If-None-Match': `"${cached.etag}"` } : undefined,
      accept: [304],
    });

    if (response.status === 304 && cached) {
      this.knownHashes.set(normalized, cached.etag);
      return cached.blob;
    }

    const blob = await response.blob();
    const etag = parseEtag(response.headers.get('ETag'));
    if (etag) {
      this.knownHashes.set(normalized, etag);
      if (blob.size <= MAX_CACHED_BODY_BYTES) {
        this.bodyCache.set(normalized, { etag, blob });
      } else {
        this.bodyCache.delete(normalized);
      }
    }
    return blob;
  }

  async readText(path: string): Promise<string> {
    return (await this.readBlob(path)).text();
  }

  // --- Mutations ------------------------------------------------------------------------------

  /**
   * `PUT /ws/file`. The base is the known hash of `path` unless `options.baseHash` says otherwise
   * (`null` = write unconditionally — only for a path the caller knows is new). A `409` becomes
   * {@link WorkspaceConflictError}; nothing is written then.
   */
  async writeFile(
    path: string,
    data: string | ArrayBuffer | Blob,
    options: { readonly baseHash?: string | null } = {}
  ): Promise<WorkspaceWriteResult> {
    const normalized = toWorkspacePath(path);
    const baseHash =
      options.baseHash === undefined
        ? (this.knownHashes.get(normalized) ?? null)
        : options.baseHash;
    const blob = data instanceof Blob ? data : new Blob([data]);

    const response = await this.request({
      method: 'PUT',
      route: '/ws/file',
      path: normalized,
      body: blob,
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(baseHash ? { 'If-Match': `"${baseHash}"` } : {}),
      },
      mutation: true,
      accept: [409],
    });

    if (response.status === 409) {
      const body = await readErrorBody(response);
      if (body.error === 'base_mismatch') {
        throw new WorkspaceConflictError(
          normalized,
          baseHash,
          typeof body.currentHash === 'string' ? body.currentHash : null
        );
      }
      throw toResponseError(response.status, body, `Could not write "${normalized}".`);
    }

    const result = (await response.json()) as WorkspaceWriteResult;
    this.knownHashes.set(normalized, result.sha256);
    if (blob.size <= MAX_CACHED_BODY_BYTES) {
      this.bodyCache.set(normalized, { etag: result.sha256, blob });
    }
    this.ensureParentDirectories(normalized);
    this.upsertManifestEntry({
      path: normalized,
      kind: 'file',
      size: result.size,
      mtime: result.mtime,
      sha256: result.sha256,
    });
    return result;
  }

  async mkdir(path: string): Promise<WorkspaceMkdirResult> {
    const normalized = toWorkspacePath(path);
    const response = await this.request({
      method: 'POST',
      route: '/ws/mkdir',
      json: { path: normalized },
      mutation: true,
    });
    const result = (await response.json()) as WorkspaceMkdirResult;
    this.ensureParentDirectories(normalized);
    this.upsertManifestEntry({ path: normalized, kind: 'dir', size: 0, mtime: Date.now() });
    return result;
  }

  async delete(
    path: string,
    options: { readonly recursive?: boolean } = {}
  ): Promise<WorkspaceDeleteResult> {
    const normalized = toWorkspacePath(path);
    const response = await this.request({
      method: 'POST',
      route: '/ws/delete',
      json: { path: normalized, ...(options.recursive ? { recursive: true } : {}) },
      mutation: true,
    });
    const result = (await response.json()) as WorkspaceDeleteResult;
    this.removeManifestPath(normalized);
    this.forgetPath(normalized);
    return result;
  }

  async move(
    from: string,
    to: string,
    options: { readonly overwrite?: boolean } = {}
  ): Promise<WorkspaceMoveResult> {
    const source = toWorkspacePath(from);
    const target = toWorkspacePath(to);
    const response = await this.request({
      method: 'POST',
      route: '/ws/move',
      json: { from: source, to: target, ...(options.overwrite ? { overwrite: true } : {}) },
      mutation: true,
    });
    const result = (await response.json()) as WorkspaceMoveResult;
    this.renamePrefix(source, target);
    return result;
  }

  async hash(paths: readonly string[]): Promise<Record<string, string | null>> {
    const response = await this.request({
      method: 'POST',
      route: '/ws/hash',
      json: { paths: paths.map(toWorkspacePath) },
    });
    const body = (await response.json()) as { hashes: Record<string, string | null> };
    return body.hashes;
  }

  // --- Transport ------------------------------------------------------------------------------

  private async request(options: RequestOptions): Promise<Response> {
    const endpoint = this.endpoint;
    const token = this.token;
    if (!endpoint || !token) {
      throw new WorkspaceError('connection_failed', 'No workspace is connected.');
    }

    const query = options.path !== undefined ? `?path=${encodeURIComponent(options.path)}` : '';
    const url = `${endpoint}${options.route}${query}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    };
    let body = options.body;
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.json);
    }
    if (options.mutation) {
      headers['X-Mutation-Id'] = createMutationId();
    }

    const init: RequestInit = {
      method: options.method,
      headers,
      body,
      // Revalidation is ours (If-None-Match on a known ETag); the HTTP cache would only blur it.
      cache: 'no-store',
      credentials: 'omit',
    };

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      if (!options.mutation) {
        throw this.toNetworkError(endpoint, error);
      }
      // The request may or may not have reached the server. The mutation journal makes a retry
      // with the same id safe: an applied mutation is answered from the journal, not re-applied.
      try {
        response = await this.fetchImpl(url, init);
      } catch (retryError) {
        throw this.toNetworkError(endpoint, retryError);
      }
    }

    if (response.ok || options.accept?.includes(response.status)) {
      return response;
    }
    const errorBody = await readErrorBody(response);
    throw toResponseError(
      response.status,
      errorBody,
      `Workspace request failed: ${options.method} ${options.route}${options.path ? ` ${options.path}` : ''}`,
      response.headers.get('Retry-After')
    );
  }

  private toNetworkError(endpoint: string, cause: unknown): WorkspaceError {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'this page';
    let hostname = '';
    try {
      hostname = new URL(endpoint).hostname;
    } catch {
      // keep empty
    }
    const pageIsHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
    if (pageIsHttps && isLoopbackHostname(hostname)) {
      return new WorkspaceError(
        'local_network_access',
        `The browser blocked ${origin} from reaching ${endpoint}. Chrome asks before a website ` +
          'may talk to this computer (Local Network Access): allow "Local network access" for ' +
          'this site (address bar lock icon → Site settings) and connect again. If the ' +
          'permission is granted, check that `pix3 serve` is running and its port is forwarded.',
        { cause }
      );
    }
    return new WorkspaceError(
      'connection_failed',
      `Could not reach a workspace server at ${endpoint}. Is \`pix3 serve\` running on the ` +
        'remote machine, and is its port forwarded to this computer (VS Code → Ports)? If it ' +
        `is, the server may not allow this editor's origin (${origin}).`,
      { cause }
    );
  }

  // --- Cache bookkeeping ----------------------------------------------------------------------

  private clearCaches(): void {
    this.knownHashes.clear();
    this.bodyCache.clear();
    this.manifest = null;
    this.manifestEntries = new Map();
    this.manifestRequest = null;
  }

  private forgetPath(path: string): void {
    for (const map of [this.knownHashes, this.bodyCache] as const) {
      for (const key of Array.from(map.keys())) {
        if (key === path || key.startsWith(`${path}/`)) {
          map.delete(key);
        }
      }
    }
  }

  private upsertManifestEntry(entry: WorkspaceManifestEntry): void {
    if (!this.manifest) {
      return;
    }
    this.manifestEntries.set(entry.path, entry);
  }

  private ensureParentDirectories(path: string): void {
    const segments = path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const directory = segments.slice(0, index).join('/');
      if (!this.manifestEntries.has(directory)) {
        this.upsertManifestEntry({ path: directory, kind: 'dir', size: 0, mtime: Date.now() });
      }
    }
  }

  private removeManifestPath(path: string): void {
    for (const key of Array.from(this.manifestEntries.keys())) {
      if (key === path || key.startsWith(`${path}/`)) {
        this.manifestEntries.delete(key);
      }
    }
  }

  private renamePrefix(from: string, to: string): void {
    const remap = (key: string): string | null =>
      key === from ? to : key.startsWith(`${from}/`) ? `${to}${key.slice(from.length)}` : null;

    for (const [key, entry] of Array.from(this.manifestEntries.entries())) {
      const next = remap(key);
      if (next !== null) {
        this.manifestEntries.delete(key);
        this.manifestEntries.set(next, { ...entry, path: next });
      }
    }
    for (const [key, hash] of Array.from(this.knownHashes.entries())) {
      const next = remap(key);
      if (next !== null) {
        this.knownHashes.delete(key);
        this.knownHashes.set(next, hash);
      }
    }
    for (const [key, cached] of Array.from(this.bodyCache.entries())) {
      const next = remap(key);
      if (next !== null) {
        this.bodyCache.delete(key);
        this.bodyCache.set(next, cached);
      }
    }
    this.ensureParentDirectories(to);
  }
}

interface ErrorBody {
  readonly error?: string;
  readonly message?: string;
  readonly currentHash?: unknown;
  readonly retryAfter?: unknown;
}

async function readErrorBody(response: Response): Promise<ErrorBody> {
  try {
    const parsed: unknown = await response.json();
    return parsed && typeof parsed === 'object' ? (parsed as ErrorBody) : {};
  } catch {
    return {};
  }
}

function toResponseError(
  status: number,
  body: ErrorBody,
  fallbackMessage: string,
  retryAfterHeader?: string | null
): WorkspaceError {
  const serverCode = typeof body.error === 'string' ? body.error : null;
  const detail = typeof body.message === 'string' && body.message ? body.message : fallbackMessage;
  const common = { status, serverCode };

  if (status === 401) {
    return new WorkspaceError(
      'unauthorized',
      'The workspace server rejected the token (wrong, rotated with --new-token, or revoked). ' +
        'Copy the current token printed by `pix3 serve` and connect again.',
      common
    );
  }
  if (status === 429) {
    const retryAfter =
      typeof body.retryAfter === 'number'
        ? body.retryAfter
        : retryAfterHeader
          ? Number.parseInt(retryAfterHeader, 10)
          : null;
    return new WorkspaceError(
      'rate_limited',
      `Too many failed attempts; the server refuses connections for ${retryAfter ?? 'a few'} s.`,
      { ...common, retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null }
    );
  }
  if (status === 404) {
    return new WorkspaceError('not_found', detail, common);
  }
  if (status === 409 && serverCode === 'exists') {
    return new WorkspaceError('exists', detail, common);
  }
  if (status === 403) {
    return new WorkspaceError('forbidden', detail, common);
  }
  if (status >= 400 && status < 500) {
    return new WorkspaceError('bad_request', detail, common);
  }
  return new WorkspaceError('server_error', detail, common);
}

/** `"abc"`, `W/"abc"` → `abc`. */
function parseEtag(header: string | null): string | null {
  if (!header) {
    return null;
  }
  const match = /^(?:W\/)?"([^"]*)"$/.exec(header.trim());
  return match ? match[1] : header.trim();
}

function createMutationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
