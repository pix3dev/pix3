import { subscribe } from 'valtio/vanilla';
import { inject, injectable } from '@/fw/di';
import { appState } from '@/state';
import { isDocumentVisible } from '@/services/core/page-activity';
import { FileWatchService } from '@/services/project/FileWatchService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { ProjectOwnershipService } from '@/services/project/coauthoring/ProjectOwnershipService';
import { ACK_FILE, toProjectPath } from '@/services/project/coauthoring/coauthoring-paths';
import { readDiskVersion } from '@/services/project/coauthoring/disk-version';
import { isRecord } from '@/services/project/external-merge/scene-doc';

/** Poll cadence of `.pix3/ack.json` while the document is visible (FSA has no push). */
export const ACK_POLL_MS = 2000;

export interface AckRecord {
  readonly path: string;
  readonly sha256: string;
  readonly at: string;
}

/** Parse `.pix3/ack.json`; anything malformed reads as "no acks" (an ack only ever releases). */
export function parseAckFile(text: string): AckRecord[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(raw) || !Array.isArray(raw.acks)) return [];
  const out: AckRecord[] = [];
  for (const item of raw.acks) {
    if (!isRecord(item) || typeof item.path !== 'string' || typeof item.sha256 !== 'string') {
      continue;
    }
    out.push({
      path: toProjectPath(item.path),
      sha256: item.sha256.toLowerCase(),
      at: typeof item.at === 'string' ? item.at : '',
    });
  }
  return out;
}

/**
 * The agent's read confirmations — plan §4.3, exit 2 from `P`: `pix3 read <path>` / `pix3 ack
 * <path> --sha256 <h>` append `{ path, sha256, at }` to `.pix3/ack.json`. The external merge of the
 * next version of `path` passes those hashes to `mergeExternalVersion` (`acks`); the ones it
 * reports in `consumedAcks` are removed from the file ({@link consume}) — one-shot.
 *
 * `.pix3/` is outside the normal file watcher, so this one file is watched explicitly: polled
 * every {@link ACK_POLL_MS} while the document is visible (local folder), and pushed through
 * `FileWatchService` on a workspace. The merge re-reads the file anyway before it uses the acks
 * ({@link acksFor}), so a missed poll never loses an ack; the watch keeps {@link current} fresh
 * for status displays and tests.
 */
@injectable()
export class AckService {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(ProjectOwnershipService)
  private readonly ownership!: ProjectOwnershipService;

  @inject(FileWatchService)
  private readonly fileWatch!: FileWatchService;

  private acks: AckRecord[] = [];
  private lastHash: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposers: Array<() => void> = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly onPushedChange = (): void => {
    void this.refresh();
  };

  initialize(): void {
    if (this.disposers.length > 0) return;
    this.disposers.push(subscribe(appState.project, () => this.syncWatch()));
    this.syncWatch();
  }

  /** The acks last read (all paths). */
  current(): readonly AckRecord[] {
    return this.acks;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Re-read `.pix3/ack.json`. Returns every ack in it. */
  refresh(): Promise<readonly AckRecord[]> {
    const run = this.queue.then(() => this.refreshNow());
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Fresh acks for one file (hashes, in file order). */
  async acksFor(path: string): Promise<string[]> {
    const key = toProjectPath(path);
    const all = await this.refresh();
    return [...new Set(all.filter(a => a.path === key).map(a => a.sha256))];
  }

  /**
   * One-shot: drop the acks of `path` whose hash is in `hashes` and rewrite the file. Owner only
   * (another window's merge did not happen). Re-reads first, so an ack appended meanwhile stays.
   */
  consume(path: string, hashes: readonly string[]): Promise<void> {
    if (hashes.length === 0 || !this.ownership.isOwner()) return Promise.resolve();
    const run = this.queue.then(() => this.consumeNow(toProjectPath(path), new Set(hashes)));
    this.queue = run.catch(() => undefined);
    return run;
  }

  dispose(): void {
    this.stopWatch();
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.listeners.clear();
  }

  // --- internals ------------------------------------------------------------------------------

  private async refreshNow(): Promise<readonly AckRecord[]> {
    let next: AckRecord[] = [];
    let hash: string | null = null;
    try {
      const version = await readDiskVersion(this.storage, ACK_FILE);
      if (version) {
        hash = version.hash;
        next = version.hash === this.lastHash ? this.acks : parseAckFile(version.text);
      }
    } catch {
      next = [];
    }
    const changed = hash !== this.lastHash;
    this.acks = next;
    this.lastHash = hash;
    if (changed) this.notify();
    return next;
  }

  private async consumeNow(path: string, hashes: Set<string>): Promise<void> {
    const all = await this.refreshNow();
    const kept = all.filter(a => !(a.path === path && hashes.has(a.sha256)));
    if (kept.length === all.length) return;
    try {
      await this.storage.writeTextFile(ACK_FILE, `${JSON.stringify({ acks: kept }, null, 2)}\n`, {
        unconditional: true,
      });
    } catch (error) {
      console.warn(`[AckService] Could not rewrite ${ACK_FILE}`, error);
      return;
    }
    this.acks = kept;
    this.lastHash = null; // the next refresh re-hashes what we wrote
    this.notify();
  }

  private watchKey: string | null = null;

  private syncWatch(): void {
    const project = appState.project;
    const active = project.status === 'ready' && project.backend !== 'cloud';
    const key = active ? `${project.backend}:${project.id}` : null;
    if (key === this.watchKey) return;
    this.watchKey = key;
    this.stopWatch();
    this.acks = [];
    this.lastHash = null;
    if (!active) return;
    if (this.fileWatch.isPushMode()) {
      this.fileWatch.watch(ACK_FILE, null, null, this.onPushedChange);
    }
    this.timer = setInterval(() => {
      if (typeof document === 'undefined' || isDocumentVisible(document)) {
        void this.refresh();
      }
    }, ACK_POLL_MS);
    void this.refresh();
  }

  private stopWatch(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.fileWatch.unwatch(ACK_FILE, this.onPushedChange);
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener();
      } catch (error) {
        console.error('[AckService] Listener error', error);
      }
    }
  }
}
