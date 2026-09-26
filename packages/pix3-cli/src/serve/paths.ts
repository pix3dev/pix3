import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { HttpError } from '../server/http.ts';

/**
 * Wire paths of the workspace protocol: POSIX, relative to the workspace root, case preserved.
 *
 * The server is the one that enforces the root (supplement §5 "Доступ ограничен корнем"), so the
 * rules are strict rather than normalising: a path that is not already canonical is refused, not
 * repaired. Percent-decoding happens exactly once, by `URLSearchParams` for `?path=` (JSON bodies
 * are not decoded at all) — a literal `%2e%2e` that survives that one decoding is an ordinary
 * file name, never a second chance to spell `..`.
 */

/**
 * Directory under the root that holds the server's own state AND the editor's co-authoring
 * bookkeeping (`protected.json`, `merge-log.jsonl`, `recovery/`, `ack.json`, ...). It is never
 * part of the revision set; through the API only its server-private entries are refused.
 */
export const RESERVED_ROOT_DIR = '.pix3';

/**
 * Entries directly under `.pix3/` that belong to the server (compared case-insensitively, so a
 * case-insensitive disk cannot be used to spell them differently). Anything below `tmp/` and
 * `link/` is private too.
 */
const SERVER_PRIVATE_ENTRIES: ReadonlySet<string> = new Set([
  'workspace.json',
  'serve.lock',
  'tmp',
  'link',
]);

/** The one internal file whose changes are broadcast as `change` events (the agent's acks). */
export const BROADCAST_INTERNAL_FILE = '.pix3/ack.json';

/**
 * True for paths the file API refuses with `403 reserved_path`: `.pix3` itself (so it can be
 * neither deleted nor moved) and the server-private entries under it.
 */
export const isServerPrivatePath = (wirePath: string): boolean => {
  const segments = wirePath.split('/');
  if (segments[0].toLowerCase() !== RESERVED_ROOT_DIR) return false;
  if (segments.length === 1) return true;
  return SERVER_PRIVATE_ENTRIES.has(segments[1].toLowerCase());
};

const MAX_PATH_LENGTH = 4096;

const bad = (message: string): HttpError => new HttpError(400, 'bad_path', message);

/** Validate a wire path and return it unchanged (it is already canonical when accepted). */
export const parseWirePath = (raw: unknown, field = 'path'): string => {
  if (typeof raw !== 'string' || raw.length === 0)
    throw bad(`\`${field}\` must be a non-empty string.`);
  if (raw.length > MAX_PATH_LENGTH) throw bad(`\`${field}\` is too long.`);
  if (raw.includes('\0')) throw bad(`\`${field}\` contains a NUL byte.`);
  if (raw.includes('\\')) throw bad(`\`${field}\` must use "/" separators, not backslashes.`);
  if (raw.startsWith('/')) throw bad(`\`${field}\` must be relative to the workspace root.`);
  if (/^[A-Za-z]:/.test(raw)) throw bad(`\`${field}\` must not carry a drive letter.`);
  const segments = raw.split('/');
  for (const segment of segments) {
    if (segment === '')
      throw bad(`\`${field}\` has an empty segment (leading, trailing or double "/").`);
    if (segment === '.' || segment === '..')
      throw bad(`\`${field}\` must not contain "." or "..".`);
  }
  if (isServerPrivatePath(raw)) {
    throw new HttpError(
      403,
      'reserved_path',
      `\`${RESERVED_ROOT_DIR}\` itself and \`${RESERVED_ROOT_DIR}/workspace.json\`, \`serve.lock\`, ` +
        '`tmp/` and `link/` belong to the server.'
    );
  }
  return raw;
};

export interface ResolvedPath {
  readonly absolute: string;
  /** What is at the path now; `null` when nothing is (only possible with `allowMissing`). */
  readonly kind: 'file' | 'dir' | 'other' | null;
}

const errnoCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;

/**
 * Resolve a validated wire path under `root` without ever passing through a symlink.
 *
 * Every existing component (parents included, which is what protects a path about to be CREATED)
 * is `lstat`ed: a symlink anywhere is refused with 403 `symlink`, a file where a directory is
 * needed with 409 `not_a_directory`. The v1 rule is "no operations through symlinks at all"
 * (supplement §5) — simpler to state and to test than "symlinks that stay inside the root".
 *
 * This is a check, not a lock: a local process that swaps a directory for a symlink between the
 * check and the use wins the race. Local processes of the same user are trusted by the plan.
 */
export const resolveInsideRoot = async (
  root: string,
  wirePath: string,
  options: { readonly allowMissing: boolean }
): Promise<ResolvedPath> => {
  const segments = wirePath.split('/');
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i]);
    const last = i === segments.length - 1;
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(current);
    } catch (error) {
      const code = errnoCode(error);
      if (code === 'ENOENT') {
        if (!options.allowMissing)
          throw new HttpError(404, 'not_found', `${wirePath} does not exist.`);
        return { absolute: join(root, ...segments), kind: null };
      }
      if (code === 'ENOTDIR') {
        throw new HttpError(409, 'not_a_directory', `A parent of ${wirePath} is not a directory.`);
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new HttpError(
        403,
        'symlink',
        `${wirePath} goes through a symbolic link; the workspace server does not follow them.`
      );
    }
    if (!last && !stats.isDirectory()) {
      throw new HttpError(409, 'not_a_directory', `A parent of ${wirePath} is not a directory.`);
    }
    if (last) {
      return {
        absolute: current,
        kind: stats.isFile() ? 'file' : stats.isDirectory() ? 'dir' : 'other',
      };
    }
  }
  // Unreachable: `parseWirePath` guarantees at least one segment.
  throw bad('Empty path.');
};

/** Parent wire path, or `null` for a top-level entry. */
export const parentOf = (wirePath: string): string | null => {
  const slash = wirePath.lastIndexOf('/');
  return slash < 0 ? null : wirePath.slice(0, slash);
};
