import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

import { isExcludedPath } from './scan.ts';

/**
 * One non-recursive `fs.watch` per directory of the revision set.
 *
 * Not `fs.watch(root, { recursive: true })`: on Linux that walks and watches EVERY subdirectory,
 * `node_modules` and `.git` included, which spends the user's inotify budget on trees the server
 * ignores anyway. Watching only the table's directories keeps the watch count equal to the number
 * of project folders. The server calls {@link sync} after every batch so new folders get a watch
 * and removed ones lose theirs.
 *
 * Events are hints, never truth: the server re-stats every path it is told about, and a full
 * scan (`/ws/manifest`) reconciles whatever inotify dropped.
 */
export class TreeWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly root: string;
  private readonly onPath: (wirePath: string) => void;
  private readonly log: (line: string) => void;
  private warnedLimit = false;

  constructor(root: string, onPath: (wirePath: string) => void, log: (line: string) => void) {
    this.root = root;
    this.onPath = onPath;
    this.log = log;
  }

  /**
   * Watch exactly `''` (the root) plus `dirs` (minus excluded ones) plus `extra` (taken as is —
   * the server watches `.pix3` itself for `ack.json`).
   */
  sync(dirs: Iterable<string>, extra: Iterable<string> = []): void {
    const wanted = new Set<string>(['', ...extra]);
    for (const dir of dirs) if (!isExcludedPath(dir)) wanted.add(dir);
    for (const [dir, watcher] of this.watchers) {
      if (!wanted.has(dir)) {
        watcher.close();
        this.watchers.delete(dir);
      }
    }
    for (const dir of wanted) {
      if (!this.watchers.has(dir)) this.add(dir);
    }
  }

  close(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  get size(): number {
    return this.watchers.size;
  }

  private add(dir: string): void {
    const absolute = dir ? join(this.root, ...dir.split('/')) : this.root;
    let watcher: FSWatcher;
    try {
      watcher = watch(absolute, { persistent: false }, (_event, filename) => {
        const name = typeof filename === 'string' ? filename : null;
        if (name === null) {
          this.onPath(dir);
          return;
        }
        this.onPath(dir ? `${dir}/${name}` : name);
      });
    } catch (error) {
      this.reportError(dir, error);
      return;
    }
    watcher.on('error', error => {
      // The directory went away (or the watch limit bit): drop it; the parent's event covers it.
      watcher.close();
      if (this.watchers.get(dir) === watcher) this.watchers.delete(dir);
      this.reportError(dir, error);
      this.onPath(dir);
    });
    this.watchers.set(dir, watcher);
  }

  private reportError(dir: string, error: unknown): void {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT' || code === 'EPERM') return;
    if (code === 'ENOSPC' || code === 'EMFILE') {
      if (!this.warnedLimit) {
        this.warnedLimit = true;
        this.log(
          `file watch limit reached (${code}) — some folders are not watched; the editor still ` +
            'sees their changes on its next full scan. Raise fs.inotify.max_user_watches to fix.'
        );
      }
      return;
    }
    this.log(`watch ${dir || '.'}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
