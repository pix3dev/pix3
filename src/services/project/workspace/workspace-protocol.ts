/**
 * Editor-side view of the `pix3 serve` workspace protocol (`packages/pix3-cli/README.md` is the
 * source of truth — routes, headers and frames there; this file only mirrors their shapes).
 *
 * The editor does not import the CLI package: the CLI is a Node program and the two are versioned
 * independently on the wire through {@link WORKSPACE_PROTOCOL}.
 */

/**
 * The workspace protocol version this editor speaks. `hello.protocol` / `/ws/status` must equal
 * it; anything else is refused with a `protocol_mismatch` error instead of half-working.
 */
export const WORKSPACE_PROTOCOL = 1;

/** What the connect dialog proposes: `pix3 serve` takes 8490 first, forwarded 1:1 by default. */
export const DEFAULT_WORKSPACE_ENDPOINT = 'http://localhost:8490';

export type WorkspaceEntryKind = 'file' | 'dir';

export interface WorkspaceManifestEntry {
  readonly path: string;
  readonly kind: WorkspaceEntryKind;
  readonly size: number;
  readonly mtime: number;
  readonly sha256?: string;
}

export interface WorkspaceManifest {
  readonly workspaceId: string;
  readonly serverSession: string;
  readonly revision: string;
  readonly seq: number;
  readonly files: readonly WorkspaceManifestEntry[];
}

export interface WorkspaceStatusInfo {
  readonly workspaceId: string;
  readonly serverSession: string;
  readonly protocol: number;
  readonly cliVersion: string;
  readonly root: string;
  readonly pid: number;
  readonly port: number;
  readonly revision: string;
  readonly seq: number;
  readonly leased: boolean;
}

export interface WorkspaceHelloFrame {
  readonly type: 'hello';
  readonly workspaceId: string;
  readonly serverSession: string;
  readonly protocol: number;
  readonly cliVersion: string;
  readonly revision: string;
  readonly seq: number;
  readonly root: string;
  readonly projectId: string | null;
  readonly projectName: string;
  readonly lease: 'held' | 'free';
}

export interface WorkspaceChangeEvent {
  readonly op: 'create' | 'modify' | 'delete' | 'rename';
  readonly path: string;
  readonly kind: WorkspaceEntryKind;
  readonly sha256?: string;
  readonly from?: string;
}

export interface WorkspaceChangeFrame {
  readonly type: 'change';
  readonly seq: number;
  readonly revision: string;
  readonly events: readonly WorkspaceChangeEvent[];
}

export type WorkspaceLeaseFrame =
  | {
      readonly type: 'lease';
      readonly state: 'granted';
      readonly leaseId: string;
      readonly resumed: boolean;
    }
  | { readonly type: 'lease'; readonly state: 'busy'; readonly inGrace: boolean }
  | {
      readonly type: 'lease';
      readonly state: 'lost';
      readonly reason: 'taken_over' | 'expired' | 'revoked';
      readonly leaseId: string;
    }
  | { readonly type: 'lease'; readonly state: 'released' };

export interface WorkspaceCallFrame {
  readonly type: 'call';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface WorkspaceErrorFrame {
  readonly type: 'error';
  readonly error: string;
  readonly message?: string;
  readonly id?: string;
  readonly retryAfter?: number;
}

export type WorkspaceServerFrame =
  | WorkspaceHelloFrame
  | WorkspaceChangeFrame
  | WorkspaceLeaseFrame
  | WorkspaceCallFrame
  | WorkspaceErrorFrame
  | { readonly type: 'ping' }
  | { readonly type: 'pong' };

/** Mutation responses (`PUT /ws/file`, `/ws/mkdir`, `/ws/delete`, `/ws/move`). */
export interface WorkspaceWriteResult {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mtime: number;
  readonly seq: number;
}

export interface WorkspaceMkdirResult {
  readonly path: string;
  readonly created: boolean;
  readonly seq: number;
}

export interface WorkspaceDeleteResult {
  readonly path: string;
  readonly kind: WorkspaceEntryKind;
  readonly seq: number;
}

export interface WorkspaceMoveResult {
  readonly from: string;
  readonly to: string;
  readonly kind: WorkspaceEntryKind;
  readonly sha256?: string;
  readonly seq: number;
}

export type WorkspaceErrorCode =
  /** 401 / `4401`: token missing, wrong or revoked. The fix is a new token, never a folder picker. */
  | 'unauthorized'
  /** 429: ten failed attempts in 60 s; wait `retryAfter` seconds. */
  | 'rate_limited'
  | 'not_found'
  /** 409 on `If-Match`: the file changed on disk since this editor last read or wrote it. */
  | 'base_mismatch'
  | 'exists'
  /** Server not reachable: not running, port not forwarded, or the origin is not allowed. */
  | 'connection_failed'
  /** A fetch from an `https:` origin to loopback failed — the browser's Local Network Access gate. */
  | 'local_network_access'
  | 'protocol_mismatch'
  /** The address now serves a different workspace than the recents entry remembers. */
  | 'workspace_mismatch'
  /** This window does not hold the edit lease (another window does). */
  | 'read_only'
  | 'forbidden'
  | 'bad_request'
  | 'timeout'
  | 'server_error';

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  /** HTTP status, when the error came from a response. */
  readonly status: number | null;
  /** The server's `error` field (`base_mismatch`, `symlink`, `reserved_path`, …). */
  readonly serverCode: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: WorkspaceErrorCode,
    message: string,
    options: {
      readonly status?: number | null;
      readonly serverCode?: string | null;
      readonly retryAfterSeconds?: number | null;
      readonly cause?: unknown;
    } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WorkspaceError';
    this.code = code;
    this.status = options.status ?? null;
    this.serverCode = options.serverCode ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

/**
 * A write refused because the file on disk is no longer the version this editor based its edit
 * on (`409 base_mismatch`). Nothing was written. Callers route this into the external-change path
 * (reload / merge) — it must never be retried without a base, which would overwrite the agent.
 */
export class WorkspaceConflictError extends WorkspaceError {
  readonly path: string;
  readonly baseHash: string | null;
  readonly currentHash: string | null;

  constructor(path: string, baseHash: string | null, currentHash: string | null) {
    super(
      'base_mismatch',
      `"${path}" changed on disk since Pix3 last read it (an external edit). Nothing was ` +
        'written; reload the file to get the new version before saving again.',
      { status: 409, serverCode: 'base_mismatch' }
    );
    this.name = 'WorkspaceConflictError';
    this.path = path;
    this.baseHash = baseHash;
    this.currentHash = currentHash;
  }
}

export const isWorkspaceError = (error: unknown): error is WorkspaceError =>
  error instanceof WorkspaceError;

/**
 * True for a workspace failure that says nothing about whether the file exists: the transport
 * or the credentials broke. Resource loaders must not paper over these with a fallback source.
 */
export const isWorkspaceTransportError = (error: unknown): boolean =>
  isWorkspaceError(error) && error.code !== 'not_found';

/**
 * Accepts what a user types — `localhost:8490`, `http://127.0.0.1:8491/`, `  http://[::1]:8490 ` —
 * and returns `protocol://host[:port]` with no path or trailing slash.
 */
export function normalizeWorkspaceEndpoint(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new WorkspaceError(
      'bad_request',
      'Enter the workspace address, e.g. http://localhost:8490.'
    );
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new WorkspaceError('bad_request', `"${raw}" is not a valid address.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WorkspaceError('bad_request', `Use an http:// address (got ${url.protocol}).`);
  }
  return `${url.protocol}//${url.host}`;
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

/** `http://localhost:8490` → `ws://localhost:8490/ws/events`. */
export function toEventsUrl(endpoint: string): string {
  return `${endpoint.replace(/^http/i, 'ws')}/ws/events`;
}

/** POSIX, root-relative form the server expects: no `res://`, no leading `./` or `/`. */
export function toWorkspacePath(path: string): string {
  return path
    .replace(/^res:\/\//i, '')
    .replace(/\\+/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}
