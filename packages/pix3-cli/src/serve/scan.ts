import { createHash } from 'node:crypto';
import { createReadStream, type BigIntStats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { isServerPrivatePath, RESERVED_ROOT_DIR } from './paths.ts';

/**
 * The revision set of plan §5 D and the file table the workspace server keeps of it.
 *
 * "Everything that ships" is decided the way `ProjectBuildService.collectShippableProjectFiles`
 * decides it: walk the whole root, skip directories named in `NON_SHIPPABLE_DIRECTORIES` at any
 * depth — plus `.pix3/` at the root (server state and the editor's bookkeeping; the manifest lists
 * the editor-reachable part of it separately, see `scanInternal`). Scenes, prefabs, scripts,
 * assets of every type, `design/tests/`, `locales/` and `pix3project.yaml` all fall inside that
 * walk; nothing is filtered by extension. Symlinks are neither listed nor followed.
 */

/**
 * Mirror of `NON_SHIPPABLE_DIRECTORIES` in `src/services/export/ProjectBuildService.ts` (the
 * editor cannot be imported from here). Keep the two in sync.
 */
export const NON_SHIPPABLE_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.yalc',
  '.vscode',
  '.idea',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
]);

/**
 * Name of the temp file a write uses when `.pix3/tmp/` is on another device than the target
 * (rename cannot cross devices). Never part of the table, so it never shows up as a change.
 */
export const SIBLING_TEMP_PATTERN = /^\..+\.pix3-tmp-[0-9a-f]+$/;

/** True when the wire path is outside the revision set (inside an excluded directory, or one itself). */
export const isExcludedPath = (wirePath: string): boolean => {
  const segments = wirePath.split('/');
  if (segments[0] === RESERVED_ROOT_DIR) return true;
  if (SIBLING_TEMP_PATTERN.test(segments[segments.length - 1])) return true;
  // The last segment is excluded only as a directory; a FILE named `dist` is ordinary.
  for (let i = 0; i < segments.length - 1; i++) {
    if (NON_SHIPPABLE_DIRECTORIES.has(segments[i])) return true;
  }
  return false;
};

const isExcludedDirectory = (wirePath: string, name: string): boolean =>
  wirePath === RESERVED_ROOT_DIR || NON_SHIPPABLE_DIRECTORIES.has(name);

/**
 * Inside `.pix3/` (the internal scan): everything the file API lets the editor reach, i.e. all but
 * the server-private entries and sibling temp files. `.pix3` itself is listed as a directory.
 */
const isExcludedInternalPath = (wirePath: string): boolean =>
  (wirePath !== RESERVED_ROOT_DIR && isServerPrivatePath(wirePath)) ||
  SIBLING_TEMP_PATTERN.test(wirePath.slice(wirePath.lastIndexOf('/') + 1));

export interface ScanOptions {
  /**
   * Scan `.pix3/` (the editor's bookkeeping) instead of the revision set. Such entries are listed
   * by `/ws/manifest` but never enter the file table, `revision` or `change` events.
   */
  readonly internal?: boolean;
}

export interface FileEntry {
  readonly kind: 'file' | 'dir';
  readonly size: number;
  /** Integer epoch milliseconds (what goes on the wire). */
  readonly mtime: number;
  /** `ino:size:mtimeNs` — the hash cache key; an atomic replace changes `ino` even at equal mtime. */
  readonly statKey: string;
  readonly sha256?: string;
}

export type FileTable = Map<string, FileEntry>;

export const statKeyOf = (stats: BigIntStats): string =>
  `${stats.ino}:${stats.size}:${stats.mtimeNs}`;

export const mtimeOf = (stats: BigIntStats): number => Number(stats.mtimeNs / 1_000_000n);

export const hashFile = (absolute: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absolute);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });

export const hashBytes = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * sha256 per wire path, reused while `(ino, size, mtimeNs)` is unchanged. Shared by the table
 * scans and the read-only routes (`/ws/file` ETag, `/ws/hash`).
 */
export class HashCache {
  private readonly entries = new Map<string, { key: string; sha256: string }>();
  private static readonly MAX_ENTRIES = 200_000;

  async hash(wirePath: string, absolute: string, stats: BigIntStats): Promise<string> {
    const key = statKeyOf(stats);
    const cached = this.entries.get(wirePath);
    if (cached && cached.key === key) return cached.sha256;
    const sha256 = await hashFile(absolute);
    this.remember(wirePath, key, sha256);
    return sha256;
  }

  remember(wirePath: string, key: string, sha256: string): void {
    if (this.entries.size >= HashCache.MAX_ENTRIES) this.entries.clear();
    this.entries.set(wirePath, { key, sha256 });
  }

  forget(wirePath: string): void {
    this.entries.delete(wirePath);
  }
}

const errnoCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;

/**
 * Scan `wirePath` (a file or a directory subtree; `''` = the whole root) into `out`.
 * Missing paths, symlinks and excluded directories contribute nothing.
 */
export const scanInto = async (
  root: string,
  wirePath: string,
  cache: HashCache,
  out: FileTable,
  options: ScanOptions = {}
): Promise<void> => {
  const absolute = wirePath ? join(root, ...wirePath.split('/')) : root;
  const internal = options.internal === true;
  if (internal ? isExcludedInternalPath(wirePath) : wirePath && isExcludedPath(wirePath)) return;
  let stats: BigIntStats;
  try {
    stats = await lstat(absolute, { bigint: true });
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw error;
  }
  if (stats.isFile()) {
    if (!wirePath) return;
    let sha256: string;
    try {
      sha256 = await cache.hash(wirePath, absolute, stats);
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return; // vanished mid-scan; the next event says so
      throw error;
    }
    out.set(wirePath, {
      kind: 'file',
      size: Number(stats.size),
      mtime: mtimeOf(stats),
      statKey: statKeyOf(stats),
      sha256,
    });
    return;
  }
  if (!stats.isDirectory()) return;
  const name = wirePath.slice(wirePath.lastIndexOf('/') + 1);
  if (!internal && wirePath && isExcludedDirectory(wirePath, name)) return;
  if (wirePath) {
    out.set(wirePath, { kind: 'dir', size: 0, mtime: mtimeOf(stats), statKey: statKeyOf(stats) });
  }
  let names: string[];
  try {
    names = await readdir(absolute);
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw error;
  }
  names.sort();
  for (const child of names) {
    await scanInto(root, wirePath ? `${wirePath}/${child}` : child, cache, out, options);
  }
};

/** The editor-reachable part of `.pix3/` (see {@link ScanOptions.internal}). */
export const scanInternal = async (root: string, cache: HashCache): Promise<FileTable> => {
  const table: FileTable = new Map();
  await scanInto(root, RESERVED_ROOT_DIR, cache, table, { internal: true });
  return table;
};

export const scanTree = async (root: string, cache: HashCache): Promise<FileTable> => {
  const table: FileTable = new Map();
  await scanInto(root, '', cache, table);
  return table;
};

/** `revision` = sha256 over the sorted `path:sha256` lines of every FILE, joined by `\n`. */
export const computeRevision = (table: FileTable): string => {
  const lines: string[] = [];
  for (const [path, entry] of table) {
    if (entry.kind === 'file' && entry.sha256) lines.push(`${path}:${entry.sha256}`);
  }
  lines.sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
};

export interface ChangeEvent {
  readonly op: 'create' | 'modify' | 'delete' | 'rename';
  readonly path: string;
  readonly kind: 'file' | 'dir';
  readonly sha256?: string;
  /** Only on `rename`: where the file was. */
  readonly from?: string;
}

const isUnder = (path: string, prefix: string): boolean =>
  prefix === '' || path === prefix || path.startsWith(`${prefix}/`);

/**
 * Replace the part of `table` at/under `prefix` with `fresh` (a scan of that prefix) and return
 * what changed. A file whose stat changed but whose content did not is updated silently.
 *
 * A `delete` + `create` of identical content in the same batch becomes one `rename` when the
 * pairing is unambiguous (exactly one deleted and one created file carry that hash).
 */
export const applySubtree = (
  table: FileTable,
  prefixes: readonly string[],
  fresh: FileTable
): ChangeEvent[] => {
  const created: ChangeEvent[] = [];
  const deleted: ChangeEvent[] = [];
  const modified: ChangeEvent[] = [];
  for (const [path, entry] of [...table]) {
    if (!prefixes.some(prefix => isUnder(path, prefix))) continue;
    if (fresh.has(path)) continue;
    table.delete(path);
    deleted.push(deletion(path, entry));
  }
  for (const [path, entry] of fresh) {
    const previous = table.get(path);
    table.set(path, entry);
    if (!previous) {
      created.push({
        op: 'create',
        path,
        kind: entry.kind,
        ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
      });
    } else if (previous.kind !== entry.kind) {
      deleted.push(deletion(path, previous));
      created.push({
        op: 'create',
        path,
        kind: entry.kind,
        ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
      });
    } else if (entry.kind === 'file' && previous.sha256 !== entry.sha256) {
      modified.push({
        op: 'modify',
        path,
        kind: 'file',
        ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
      });
    }
  }
  return pairRenames(deleted, created, modified);
};

/** Deletes carry the hash they had only until pairing; `pairRenames` strips it from the output. */
const deletion = (path: string, entry: FileEntry): ChangeEvent => ({
  op: 'delete',
  path,
  kind: entry.kind,
  ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
});

const pairRenames = (
  deleted: ChangeEvent[],
  created: ChangeEvent[],
  modified: ChangeEvent[]
): ChangeEvent[] => {
  const countBy = (events: ChangeEvent[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const event of events) {
      if (event.kind === 'file' && event.sha256)
        counts.set(event.sha256, (counts.get(event.sha256) ?? 0) + 1);
    }
    return counts;
  };
  const deletedCounts = countBy(deleted);
  const createdCounts = countBy(created);
  const renames: ChangeEvent[] = [];
  const pairedDeletes = new Set<ChangeEvent>();
  const pairedCreates = new Set<ChangeEvent>();
  for (const create of created) {
    const hash = create.sha256;
    if (create.kind !== 'file' || !hash) continue;
    if (deletedCounts.get(hash) !== 1 || createdCounts.get(hash) !== 1) continue;
    const del = deleted.find(event => event.sha256 === hash);
    if (!del) continue;
    pairedDeletes.add(del);
    pairedCreates.add(create);
    renames.push({ op: 'rename', path: create.path, from: del.path, kind: 'file', sha256: hash });
  }
  const strip = (event: ChangeEvent): ChangeEvent =>
    event.op === 'delete' ? { op: 'delete', path: event.path, kind: event.kind } : event;
  return [
    ...deleted.filter(event => !pairedDeletes.has(event)).map(strip),
    ...renames,
    ...created.filter(event => !pairedCreates.has(event)),
    ...modified,
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};
