import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { WORKSPACE_STATE_FILE } from '../protocol.ts';
import { RESERVED_ROOT_DIR } from './paths.ts';

/**
 * `.pix3/workspace.json` — what one workspace root remembers between `pix3 serve` runs.
 *
 * ```json
 * { "version": 1, "workspaceId": "…", "root": "/abs/canonical/root",
 *   "token": { "sha256": "<hex of sha256(token)>", "issuedAt": "<ISO>" } | null,
 *   "server": { "pid": 1, "port": 8490, "serverSession": "…", "control": "…", "startedAt": "<ISO>" } | null }
 * ```
 *
 * Only the token's HASH is stored (supplement §5, §11.1): the token itself is printed once and
 * lives in the browser. Revoking in v1 = deleting this file (a running server notices, closes
 * every authenticated socket and refuses the old token). A copy of the project carries this file
 * along; `root` is what stops the copy inheriting trust — a mismatching canonical root mints a
 * fresh identity and token.
 *
 * `server.control` is a per-session secret that lets another `pix3` process of the same user
 * (who can read this 0600 file) confirm a running server really is the one this file describes
 * (`GET /ws/status` with `X-Pix3-Control`). It grants nothing else.
 */

export interface TokenRecord {
  readonly sha256: string;
  readonly issuedAt: string;
}

export interface ServerRecord {
  readonly pid: number;
  readonly port: number;
  readonly serverSession: string;
  readonly control: string;
  readonly startedAt: string;
}

export interface WorkspaceState {
  readonly version: 1;
  readonly workspaceId: string;
  readonly root: string;
  readonly token: TokenRecord | null;
  readonly server: ServerRecord | null;
}

const TOKEN_PREFIX = 'p3ws_';

export const statePath = (root: string): string => join(root, ...WORKSPACE_STATE_FILE.split('/'));

const reservedDir = (root: string): string => join(root, RESERVED_ROOT_DIR);

export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/** 32 random bytes, base64url, with a prefix secret scanners can key on. */
export const generateToken = (): string =>
  `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

export const tokenMatches = (presented: string, record: TokenRecord | null): boolean => {
  if (!record || !presented) return false;
  const a = Buffer.from(hashToken(presented), 'hex');
  const b = Buffer.from(record.sha256, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const parseState = (raw: string): WorkspaceState | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || !isString(record.workspaceId) || !isString(record.root)) return null;
  const tokenRaw = record.token as Record<string, unknown> | null | undefined;
  const token: TokenRecord | null =
    tokenRaw &&
    typeof tokenRaw === 'object' &&
    isString(tokenRaw.sha256) &&
    isString(tokenRaw.issuedAt)
      ? { sha256: tokenRaw.sha256, issuedAt: tokenRaw.issuedAt }
      : null;
  const serverRaw = record.server as Record<string, unknown> | null | undefined;
  const server: ServerRecord | null =
    serverRaw &&
    typeof serverRaw === 'object' &&
    typeof serverRaw.pid === 'number' &&
    typeof serverRaw.port === 'number' &&
    isString(serverRaw.serverSession) &&
    isString(serverRaw.control) &&
    isString(serverRaw.startedAt)
      ? {
          pid: serverRaw.pid,
          port: serverRaw.port,
          serverSession: serverRaw.serverSession,
          control: serverRaw.control,
          startedAt: serverRaw.startedAt,
        }
      : null;
  return { version: 1, workspaceId: record.workspaceId, root: record.root, token, server };
};

export const readState = (root: string): WorkspaceState | null => {
  try {
    return parseState(readFileSync(statePath(root), 'utf8'));
  } catch {
    return null;
  }
};

/** mtime + size of the state file, or null when it is gone (used to notice rotation/revocation). */
export const stateStamp = (root: string): string | null => {
  try {
    const stats = statSync(statePath(root), { bigint: true });
    return `${stats.mtimeNs}:${stats.size}:${stats.ino}`;
  } catch {
    return null;
  }
};

/** `.pix3/` (0700) with a `.gitignore` of `*`, so server state never lands in git or an export. */
export const ensureReservedDir = (root: string): void => {
  const dir = reservedDir(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n', { mode: 0o600 });
};

export const writeState = (root: string, state: WorkspaceState): void => {
  ensureReservedDir(root);
  const target = statePath(root);
  const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, target);
};

export interface IdentityResult {
  readonly state: WorkspaceState;
  /** The plaintext token when one was issued by this call (print it once), else null. */
  readonly issuedToken: string | null;
  /** Why an identity was (re)minted, for the startup message. */
  readonly minted: 'new' | 'moved' | null;
}

/**
 * Load or mint the identity of `root` (canonical path). Mints a new `workspaceId` + token when
 * there is no state, or when the state was written for a different root (a copied project).
 * `rotateToken` issues a new token and invalidates the old one.
 */
export const ensureIdentity = (
  root: string,
  options: { readonly rotateToken: boolean }
): IdentityResult => {
  const existing = readState(root);
  const moved = existing !== null && existing.root !== root;
  if (!existing || moved) {
    const token = generateToken();
    const state: WorkspaceState = {
      version: 1,
      workspaceId: randomUUID(),
      root,
      token: { sha256: hashToken(token), issuedAt: new Date().toISOString() },
      server: null,
    };
    writeState(root, state);
    return { state, issuedToken: token, minted: moved ? 'moved' : 'new' };
  }
  if (options.rotateToken || existing.token === null) {
    const token = generateToken();
    const state: WorkspaceState = {
      ...existing,
      token: { sha256: hashToken(token), issuedAt: new Date().toISOString() },
    };
    writeState(root, state);
    return { state, issuedToken: token, minted: null };
  }
  return { state: existing, issuedToken: null, minted: null };
};

/** Record the live server in the state file, keeping identity and token as they are now. */
export const recordServer = (root: string, server: ServerRecord): void => {
  const current = readState(root);
  // Deleted meanwhile = revoked: do not resurrect it.
  if (!current) return;
  writeState(root, { ...current, server });
};

/** Clear the server record on shutdown, but only if it is still ours. */
export const clearServer = (root: string, serverSession: string): void => {
  const current = readState(root);
  if (!current || current.server?.serverSession !== serverSession) return;
  writeState(root, { ...current, server: null });
};

// --- One server per root ------------------------------------------------------------------------

const lockPath = (root: string): string => join(reservedDir(root), 'serve.lock');

export const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = alive but not ours to signal.
    return !!error && typeof error === 'object' && 'code' in error && error.code === 'EPERM';
  }
};

export type LockResult =
  | { readonly acquired: true; readonly release: () => void }
  | { readonly acquired: false; readonly pid: number };

/**
 * `.pix3/serve.lock` (O_EXCL, holds the pid) — the one-server-per-root rule. A lock whose pid is
 * dead is stale and taken over; a live pid means another `pix3 serve` owns the root.
 */
export const acquireServeLock = (root: string): LockResult => {
  ensureReservedDir(root);
  const file = lockPath(root);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      let released = false;
      return {
        acquired: true,
        release: () => {
          if (released) return;
          released = true;
          try {
            if (readFileSync(file, 'utf8').trim() === String(process.pid))
              rmSync(file, { force: true });
          } catch {
            // already gone
          }
        },
      };
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
        throw error;
    }
    let pid = 0;
    try {
      pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    } catch {
      // vanished between the two calls — retry
    }
    if (pid && isProcessAlive(pid)) return { acquired: false, pid };
    rmSync(file, { force: true });
  }
  throw new Error(`Could not take ${lockPath(root)}; remove it if no pix3 serve is running.`);
};
