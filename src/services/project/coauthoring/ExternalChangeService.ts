import { subscribe } from 'valtio/vanilla';
import { inject, injectable } from '@/fw/di';
import { appState } from '@/state';
import { LoggingService } from '@/services/core/LoggingService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { SceneDiskStateService } from '@/services/project/coauthoring/SceneDiskStateService';
import { RecoveryJournalService } from '@/services/project/coauthoring/RecoveryJournalService';
import {
  isPix3InternalPath,
  isSceneFilePath,
  toProjectPath,
} from '@/services/project/coauthoring/coauthoring-paths';
import { readDiskVersion } from '@/services/project/coauthoring/disk-version';
import { checkDocShape, parseSceneText } from '@/services/project/external-merge/scene-doc';

/** Two snapshots this far apart must match before a version counts as arrived (plan §4.1). */
export const STABILITY_INTERVAL_MS = 300;
/** A pending version that has not parsed for this long gets a "file not readable" notice. */
export const UNREADABLE_NOTICE_MS = 5000;
/** Retry cadence for a version that does not parse / failed to load (backoff cap). */
const MAX_RETRY_MS = 2000;
const PARSE_PREFIX = 'parse: ';

export interface ExternalBatchResult {
  /** Paths the consumer could not apply (load failed): they stay pending and are retried. */
  readonly failed?: readonly string[];
}

/** Consumer of a settled batch — `ExternalMergeService.handleBatch` (via the editor shell). */
export type ExternalBatchListener = (
  paths: readonly string[]
) => Promise<ExternalBatchResult | void> | ExternalBatchResult | void;

interface Snapshot {
  readonly missing: boolean;
  readonly size: number;
  readonly hash: string;
  readonly text: string;
}

interface PendingEntry {
  readonly path: string;
  last: Snapshot | null;
  stable: boolean;
  /** When the settled content first failed to parse / load (null = it parses). */
  failingSince: number | null;
  failure: string | null;
  noticeShown: boolean;
  retries: number;
}

/**
 * The external-change path of the co-authoring mode — plan §4.1 "обещаем поведение на
 * промежуточном состоянии" and §5 C2:
 *
 * 1. **Stabilisation.** A reported path (FileWatch poll, workspace push, a refused pre-write
 *    check, `syncNow`) is re-read every {@link STABILITY_INTERVAL_MS}; it has arrived once two
 *    consecutive snapshots (size + sha256) match. Every path reported while any of them is still
 *    moving belongs to the same batch, and a batch is delivered together
 *    (`onExternalBatch(paths)`), so "script + prefab + scene" loads as one.
 * 2. **Own writes** are recognised by hash (`SceneDiskStateService`: the version the editor last
 *    read or wrote) and dropped without reaching the consumer.
 * 3. **Last good graph.** A scene/prefab version that does not parse is not delivered: the path
 *    stays pending (autosave holds it), retried with backoff; after {@link UNREADABLE_NOTICE_MS}
 *    a non-blocking notice "file not readable: …" goes to the log/status bar, and the batch is no
 *    longer held for it. A consumer failure (the loader rejected it) is treated the same way.
 * 4. **Play mode.** Detected but not delivered while playing: `coauthoring.stale` is set, and the
 *    batch goes out when play stops.
 *
 * While a path is pending, `SceneDiskStateService.isPendingExternal(path)` is true.
 */
@injectable()
export class ExternalChangeService {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(SceneDiskStateService)
  private readonly diskState!: SceneDiskStateService;

  @inject(LoggingService)
  private readonly logger!: LoggingService;

  @inject(RecoveryJournalService)
  private readonly journal!: RecoveryJournalService;

  private projectKey: string | null = null;
  private disposeProjectSubscription: (() => void) | null = null;

  private readonly entries = new Map<string, PendingEntry>();
  private readonly listeners = new Set<ExternalBatchListener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private tickRequested = false;
  private settleWaiters: Array<() => void> = [];
  private disposePlaySubscription: (() => void) | null = null;
  private now: () => number = () => Date.now();
  private stabilityIntervalMs = STABILITY_INTERVAL_MS;

  /** Tests: fixed clock and interval. */
  configureForTests(options: { now?: () => number; stabilityIntervalMs?: number }): void {
    if (options.now) this.now = options.now;
    if (options.stabilityIntervalMs !== undefined) {
      this.stabilityIntervalMs = options.stabilityIntervalMs;
    }
  }

  /**
   * Follow the open project: switching or closing it drops every per-file memory of the
   * co-authoring mode (pending versions here, known disk hashes, the journal index).
   */
  initialize(): void {
    if (this.disposeProjectSubscription) {
      return;
    }
    const sync = (): void => {
      const project = appState.project;
      const key =
        project.status === 'ready' && project.id ? `${project.backend}:${project.id}` : null;
      if (key === this.projectKey) {
        return;
      }
      this.projectKey = key;
      this.reset();
      this.diskState.reset();
      this.journal.reset();
    };
    this.disposeProjectSubscription = subscribe(appState.project, sync);
    this.projectKey =
      appState.project.status === 'ready' && appState.project.id
        ? `${appState.project.backend}:${appState.project.id}`
        : null;
  }

  onExternalBatch(listener: ExternalBatchListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A file may have changed on disk. Cheap and idempotent; `.pix3/` is ignored. */
  report(path: string): void {
    const key = toProjectPath(path);
    if (!key || isPix3InternalPath(key)) {
      return;
    }
    const existing = this.entries.get(key);
    if (existing) {
      // Moving again: it must settle anew.
      existing.stable = false;
    } else {
      this.entries.set(key, {
        path: key,
        last: null,
        stable: false,
        failingSince: null,
        failure: null,
        noticeShown: false,
        retries: 0,
      });
    }
    this.diskState.markPendingExternal(key);
    this.schedule(this.stabilityIntervalMs);
  }

  isPending(path: string): boolean {
    return this.entries.has(toProjectPath(path));
  }

  /**
   * Resolves when nothing is left to settle: every reported path was delivered, dropped as an own
   * write, or is past its "not readable" notice (still pending, but nothing more will happen until
   * the file changes again).
   */
  whenSettled(): Promise<void> {
    if (this.isSettled()) {
      return Promise.resolve();
    }
    return new Promise(resolve => this.settleWaiters.push(resolve));
  }

  /** Drop everything (project closed / switched). */
  reset(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const path of this.entries.keys()) {
      this.diskState.clearPendingExternal(path);
    }
    this.entries.clear();
    this.setUnreadable();
    this.setStale(false);
    this.resolveSettled();
  }

  dispose(): void {
    this.reset();
    this.disposeProjectSubscription?.();
    this.disposeProjectSubscription = null;
    this.disposePlaySubscription?.();
    this.disposePlaySubscription = null;
    this.listeners.clear();
  }

  // --- internals ------------------------------------------------------------------------------

  private schedule(delay: number): void {
    if (this.ticking) {
      this.tickRequested = true;
      return;
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
  }

  /** One stabilisation step. Visible for tests. */
  async tick(): Promise<void> {
    if (this.ticking) {
      this.tickRequested = true;
      return;
    }
    this.ticking = true;
    this.tickRequested = false;
    let next: number | null = null;
    try {
      next = await this.step();
    } finally {
      this.ticking = false;
    }
    if (this.tickRequested) {
      this.schedule(this.stabilityIntervalMs);
    } else if (next !== null) {
      this.schedule(next);
    }
    if (this.isSettled()) {
      this.resolveSettled();
    }
  }

  /** Returns the delay of the next tick, or null when nothing is left to do. */
  private async step(): Promise<number | null> {
    if (this.entries.size === 0) {
      return null;
    }

    // 1. Snapshot every pending path; any change restarts the quiet window for the whole batch.
    let moving = false;
    for (const entry of Array.from(this.entries.values())) {
      const snapshot = await this.snapshot(entry.path);
      if (!entry.last || !sameSnapshot(entry.last, snapshot)) {
        if (entry.last) {
          // Changed again since the last look: a failure of an older content no longer counts.
          entry.failingSince = null;
          entry.failure = null;
          entry.noticeShown = false;
          entry.retries = 0;
        }
        entry.last = snapshot;
        entry.stable = false;
        moving = true;
      } else {
        entry.stable = true;
      }
    }
    if (moving || Array.from(this.entries.values()).some(e => !e.stable)) {
      return this.stabilityIntervalMs;
    }

    // 2. Settled. Drop own writes / deletions; check that scene files parse.
    const now = this.now();
    const deliverable: PendingEntry[] = [];
    const failing: PendingEntry[] = [];
    for (const entry of Array.from(this.entries.values())) {
      const snapshot = entry.last!;
      if (snapshot.missing || this.diskState.isKnownHash(entry.path, snapshot.hash)) {
        this.drop(entry.path);
        continue;
      }
      const parseFailure = isSceneFilePath(entry.path) ? parseProblem(snapshot.text) : null;
      if (parseFailure !== null) {
        entry.failingSince ??= now;
        entry.failure = `${PARSE_PREFIX}${parseFailure}`;
        failing.push(entry);
        continue;
      }
      if (entry.failure !== null && entry.noticeShown) {
        // The loader keeps rejecting this content and the user was told: wait for a new version.
        continue;
      }
      deliverable.push(entry);
    }

    for (const entry of this.entries.values()) {
      if (
        entry.failure !== null &&
        !entry.noticeShown &&
        now - (entry.failingSince ?? now) >= UNREADABLE_NOTICE_MS
      ) {
        entry.noticeShown = true;
        this.logger.warn(
          `File not readable: ${entry.path} (${entry.failure.replace(PARSE_PREFIX, '')}). ` +
            'Keeping the last good version; it loads as soon as the file is valid.'
        );
      }
    }
    this.setUnreadable();

    // The batch waits for a broken member for a while (it may be mid-write), then goes without it.
    const youngFailure = failing.some(
      e => !e.noticeShown && now - (e.failingSince ?? now) < UNREADABLE_NOTICE_MS
    );
    const retryDelay = (): number => {
      const retries = Math.max(0, ...Array.from(this.entries.values(), e => e.retries));
      for (const entry of this.entries.values()) {
        if (entry.failure !== null) entry.retries += 1;
      }
      return Math.min(MAX_RETRY_MS, this.stabilityIntervalMs * 2 ** retries);
    };
    const hasOpenFailure = (): boolean =>
      Array.from(this.entries.values()).some(e => e.failure !== null && !e.noticeShown);
    if (deliverable.length === 0 || youngFailure) {
      return hasOpenFailure() ? retryDelay() : null;
    }

    // 3. Play mode: detect, do not reload.
    if (appState.ui.isPlaying) {
      this.setStale(true);
      this.waitForPlayToStop();
      return null;
    }
    this.setStale(false);

    // 4. Deliver. Entries leave the map first, so a report during delivery starts a new batch.
    const paths = deliverable.map(e => e.path);
    for (const entry of deliverable) {
      this.entries.delete(entry.path);
    }
    const failed = new Set<string>();
    for (const listener of Array.from(this.listeners)) {
      try {
        const result = await listener(paths);
        for (const path of result?.failed ?? []) failed.add(toProjectPath(path));
      } catch (error) {
        console.error('[ExternalChangeService] Batch listener failed', error);
        for (const path of paths) failed.add(path);
      }
    }
    for (const entry of deliverable) {
      if (this.entries.has(entry.path)) {
        continue; // reported again meanwhile: the new entry owns the pending flag
      }
      if (failed.has(entry.path)) {
        entry.failure = 'the scene loader rejected it';
        entry.failingSince ??= now;
        this.entries.set(entry.path, entry);
      } else {
        this.diskState.clearPendingExternal(entry.path);
      }
    }
    this.setUnreadable();
    if (Array.from(this.entries.values()).some(e => e.failure === null)) {
      return this.stabilityIntervalMs;
    }
    return hasOpenFailure() ? retryDelay() : null;
  }

  private drop(path: string): void {
    this.entries.delete(path);
    this.diskState.clearPendingExternal(path);
  }

  private async snapshot(path: string): Promise<Snapshot> {
    try {
      const version = await readDiskVersion(this.storage, path);
      if (!version) {
        return { missing: true, size: 0, hash: '', text: '' };
      }
      // Size and hash of the RAW bytes: the same hash the editor records for its own writes.
      return {
        missing: false,
        size: version.bytes.length,
        hash: version.hash,
        text: version.text,
      };
    } catch {
      return { missing: true, size: 0, hash: '', text: '' };
    }
  }

  private waitForPlayToStop(): void {
    if (this.disposePlaySubscription) {
      return;
    }
    this.disposePlaySubscription = subscribe(appState.ui, () => {
      if (!appState.ui.isPlaying) {
        this.disposePlaySubscription?.();
        this.disposePlaySubscription = null;
        // Re-read everything: the disk may have moved on during play.
        for (const entry of this.entries.values()) entry.stable = false;
        this.schedule(0);
      }
    });
  }

  private isSettled(): boolean {
    if (this.disposePlaySubscription) {
      return true; // held for play mode: nothing more happens until play stops
    }
    return Array.from(this.entries.values()).every(e => e.noticeShown);
  }

  private resolveSettled(): void {
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private setStale(stale: boolean): void {
    if (appState.project.coauthoring.stale !== stale) {
      appState.project.coauthoring.stale = stale;
    }
  }

  private setUnreadable(): void {
    const unreadable = Array.from(this.entries.values())
      .filter(e => e.noticeShown)
      .map(e => e.path);
    const current = appState.project.coauthoring.unreadablePaths;
    if (current.length !== unreadable.length || current.some((p, i) => p !== unreadable[i])) {
      appState.project.coauthoring.unreadablePaths = unreadable;
    }
  }
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return a.missing === b.missing && a.size === b.size && a.hash === b.hash;
}

/** Null when `text` is a structurally valid scene document, else a short reason. */
function parseProblem(text: string): string | null {
  if (text.trim().length === 0) {
    return 'the file is empty';
  }
  let doc: unknown;
  try {
    doc = parseSceneText(text);
  } catch (error) {
    return error instanceof Error ? error.message.split('\n')[0] : 'YAML error';
  }
  const problems = checkDocShape(doc);
  return problems.length > 0 ? problems[0].message : null;
}
