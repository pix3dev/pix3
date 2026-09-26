import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { hashFile } from './scan.ts';

/**
 * Helpers of the workspace server's **agent lane** (`/ws/agent/*`): the routes a local
 * `pix3 mcp --workspace` process drives with the control secret of `.pix3/workspace.json`.
 *
 * - {@link ChangeLog}: the last {@link CHANGE_LOG_LIMIT} path changes with their `seq`, so the MCP
 *   process can ask "what changed since the barrier" (`GET /ws/agent/changes?since=<seq>`).
 * - {@link findRecoveryCopy} / {@link mergeLogMentions}: the hints of `disk_differs_from_agent`
 *   (plan §5 D, step 1): whether the editor's recovery journal holds a copy of exactly the bytes
 *   the agent expected, and whether the editor's merge log says the editor wrote the file.
 */

export const CHANGE_LOG_LIMIT = 5_000;

/** Journal directory of the editor (`RecoveryJournalService`): `<dir>/<encodeURIComponent(path)>/*`. */
export const RECOVERY_DIR = '.pix3/recovery';
/** The editor's merge decisions, one JSON object per line (`MergeLogService`). */
export const MERGE_LOG_FILE = '.pix3/merge-log.jsonl';

/** How far before the file's mtime a merge-log line may be and still describe that write. */
const MERGE_LOG_SLACK_MS = 5_000;

export interface ChangeLogEntry {
  readonly seq: number;
  readonly path: string;
  /** `external` = seen by the watcher / a scan; `api` = written through the file API (the editor). */
  readonly source: 'external' | 'api';
}

/** Ring of path changes of the revision set, in `seq` order. */
export class ChangeLog {
  private readonly entries: ChangeLogEntry[] = [];
  /** Highest `seq` whose entries were dropped from the ring (0 = nothing dropped yet). */
  private droppedThrough = 0;

  record(seq: number, paths: Iterable<string>, source: ChangeLogEntry['source']): void {
    for (const path of paths) this.entries.push({ seq, path, source });
    const overflow = this.entries.length - CHANGE_LOG_LIMIT;
    if (overflow > 0) {
      const dropped = this.entries.splice(0, overflow);
      this.droppedThrough = Math.max(this.droppedThrough, dropped[dropped.length - 1].seq);
    }
  }

  /**
   * Distinct paths changed after `since` (exclusive). `complete: false` when the ring no longer
   * reaches back that far — then the caller must not read an empty list as "nothing changed".
   */
  since(since: number): { paths: string[]; complete: boolean; entries: ChangeLogEntry[] } {
    const entries = this.entries.filter(entry => entry.seq > since);
    const paths = [...new Set(entries.map(entry => entry.path))].sort();
    return { paths, complete: since >= this.droppedThrough, entries };
  }
}

const errnoCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;

/**
 * The wire path of a recovery-journal file whose bytes hash to `sha256`, or null. Every version of
 * that scene is hashed (the ring keeps at most a few hundred), because the name carries only the
 * first 8 hex chars of a hash the editor computes on its own terms.
 */
export const findRecoveryCopy = async (
  root: string,
  wirePath: string,
  sha256: string
): Promise<string | null> => {
  const dirWire = `${RECOVERY_DIR}/${encodeURIComponent(wirePath)}`;
  const dirAbsolute = join(root, ...dirWire.split('/'));
  let names: string[];
  try {
    names = await readdir(dirAbsolute);
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
  // Names whose hash8 matches first: usually the only candidate that needs hashing.
  const prefix = sha256.slice(0, 8);
  names.sort((a, b) => Number(b.includes(prefix)) - Number(a.includes(prefix)) || (a < b ? 1 : -1));
  for (const name of names) {
    const absolute = join(dirAbsolute, name);
    try {
      const stats = await lstat(absolute);
      if (!stats.isFile()) continue;
      if ((await hashFile(absolute)) === sha256) return `${dirWire}/${name}`;
    } catch {
      // pruned meanwhile
    }
  }
  return null;
};

interface MergeLogLine {
  readonly at?: unknown;
  readonly file?: unknown;
  readonly mergedHash?: unknown;
  readonly hash?: unknown;
}

/** Parsed lines of `.pix3/merge-log.jsonl` (torn / malformed lines skipped; missing file = []). */
export const readMergeLog = async (root: string): Promise<MergeLogLine[]> => {
  let text: string;
  try {
    text = await readFile(join(root, ...MERGE_LOG_FILE.split('/')), 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return [];
    throw error;
  }
  const lines: MergeLogLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        lines.push(parsed as MergeLogLine);
      }
    } catch {
      // torn line
    }
  }
  return lines;
};

/**
 * True when the merge log shows the EDITOR wrote the file's current bytes: a line for this path
 * whose `mergedHash` / `hash` is the disk hash, or one no older than the file's mtime (minus a
 * few seconds — the editor logs a merge right before it writes the merged version).
 */
export const mergeLogMentions = (
  lines: readonly MergeLogLine[],
  wirePath: string,
  diskHash: string | null,
  mtimeMs: number | null
): boolean =>
  lines.some(line => {
    if (line.file !== wirePath) return false;
    if (diskHash && (line.mergedHash === diskHash || line.hash === diskHash)) return true;
    if (mtimeMs === null || typeof line.at !== 'string') return false;
    const at = Date.parse(line.at);
    return Number.isFinite(at) && at >= mtimeMs - MERGE_LOG_SLACK_MS;
  });
