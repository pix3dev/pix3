import { inject, injectable } from '@/fw/di';
import { appState } from '@/state';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { sha256 } from '@/services/project/external-merge/hash';
import {
  RECOVERY_DIRECTORY,
  toProjectPath,
} from '@/services/project/coauthoring/coauthoring-paths';
import {
  IndexedDbRecoveryFallbackStore,
  type RecoveryFallbackStore,
} from '@/services/project/coauthoring/recovery-fallback-store';

/** Ring bounds of plan §4.3: ~200 versions or 7 days per project. */
export const RECOVERY_MAX_VERSIONS = 200;
export const RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type RecoveryReason = 'editor-write' | 'before-external';

export interface RecoveryRecord {
  readonly scenePath: string;
  readonly createdAt: number;
  /** First 8 hex chars of the content's sha256 (the file name suffix). */
  readonly hash8: string;
  readonly location: 'disk' | 'fallback';
  /** Disk: the project path of the journal file. Fallback: the store key. */
  readonly ref: string;
}

/**
 * Recovery journal of plan §4.3 — the half of the promise "a manual edit is never lost for good":
 * every version the editor writes to a scene/prefab, and every manual version an external version
 * is about to replace, is copied to
 *
 *   `.pix3/recovery/<encodeURIComponent(scene path)>/<UTC stamp>-<hash8>.pix3scene`
 *
 * BEFORE the replacing write. The stamp is ISO-8601 with `:`/`.` replaced by `-`
 * (`2026-09-26T12-30-05-123Z`) so the name is valid on every file system. Ring per project:
 * at most {@link RECOVERY_MAX_VERSIONS} versions, none older than {@link RECOVERY_MAX_AGE_MS} —
 * except the newest version of each scene, which age never prunes. Consecutive identical versions
 * of a scene are stored once.
 *
 * When `.pix3/` cannot be written (read-only folder, cloud project), versions go to the
 * {@link RecoveryFallbackStore} (IndexedDB) under the same ring. A journal failure never blocks the
 * save it precedes: losing the journal entry is strictly better than losing the edit.
 */
@injectable()
export class RecoveryJournalService {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  private fallback: RecoveryFallbackStore = new IndexedDbRecoveryFallbackStore();
  private index: RecoveryRecord[] | null = null;
  private indexProjectId: string | null = null;
  private diskUnavailable = false;
  /** Serialises journal writes so the ring bookkeeping never interleaves. */
  private queue: Promise<unknown> = Promise.resolve();
  private now: () => number = () => Date.now();

  /** Tests: a memory store instead of IndexedDB. */
  setFallbackStore(store: RecoveryFallbackStore): void {
    this.fallback = store;
  }

  /** Tests: a fixed clock. */
  setClock(now: () => number): void {
    this.now = now;
  }

  /**
   * Store `content` as a version of `scenePath` (skipped when it equals that scene's newest
   * journaled version). Resolves to the record, or null when skipped or when every sink failed.
   */
  recordVersion(
    scenePath: string,
    content: string,
    reason: RecoveryReason = 'editor-write'
  ): Promise<RecoveryRecord | null> {
    const run = this.queue.then(() => this.recordVersionNow(scenePath, content, reason));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Versions of one scene (newest first) from the disk journal and the fallback store. */
  async listVersions(scenePath: string): Promise<RecoveryRecord[]> {
    const key = toProjectPath(scenePath);
    const index = await this.loadIndex();
    const fallback = (await this.fallback.list(this.projectId()))
      .filter(r => r.scenePath === key)
      .map(toFallbackRecord);
    return [...index.filter(r => r.scenePath === key), ...fallback].sort(
      (a, b) => b.createdAt - a.createdAt
    );
  }

  async readVersion(record: RecoveryRecord): Promise<string | null> {
    if (record.location === 'disk') {
      return this.storage.readTextFile(record.ref);
    }
    const found = (await this.fallback.list(this.projectId())).find(r => r.key === record.ref);
    return found?.content ?? null;
  }

  /** Forget the in-memory index (project switched). */
  reset(): void {
    this.index = null;
    this.indexProjectId = null;
    this.diskUnavailable = false;
  }

  dispose(): void {
    this.reset();
  }

  // --- internals ------------------------------------------------------------------------------

  private async recordVersionNow(
    scenePath: string,
    content: string,
    reason: RecoveryReason
  ): Promise<RecoveryRecord | null> {
    const key = toProjectPath(scenePath);
    const hash = await sha256(content);
    const hash8 = hash.slice(0, 8);
    const createdAt = this.now();

    const latest = (await this.listVersions(key))[0];
    if (latest && latest.hash8 === hash8) {
      return null;
    }

    if (!this.diskUnavailable && this.canUseDisk()) {
      const fileName = `${formatStamp(createdAt)}-${hash8}.pix3scene`;
      const path = `${RECOVERY_DIRECTORY}/${encodeURIComponent(key)}/${fileName}`;
      try {
        await this.storage.writeTextFile(path, content);
        const record: RecoveryRecord = {
          scenePath: key,
          createdAt,
          hash8,
          location: 'disk',
          ref: path,
        };
        (await this.loadIndex()).push(record);
        await this.pruneDisk();
        return record;
      } catch (error) {
        this.diskUnavailable = true;
        console.warn(
          `[RecoveryJournal] Cannot write ${RECOVERY_DIRECTORY}/ (${reason}); using browser storage`,
          error
        );
      }
    }

    try {
      const record = {
        key: `${this.projectId()}|${key}|${formatStamp(createdAt)}|${hash8}`,
        projectId: this.projectId(),
        scenePath: key,
        createdAt,
        hash,
        content,
      };
      await this.fallback.put(record);
      await this.pruneFallback();
      return toFallbackRecord(record);
    } catch (error) {
      console.error('[RecoveryJournal] Could not store a recovery version anywhere', error);
      return null;
    }
  }

  private canUseDisk(): boolean {
    const backend = this.storage.getBackend();
    return backend === 'local' || backend === 'workspace';
  }

  private projectId(): string {
    return appState.project.id ?? 'no-project';
  }

  private async loadIndex(): Promise<RecoveryRecord[]> {
    const projectId = this.projectId();
    if (this.index && this.indexProjectId === projectId) {
      return this.index;
    }
    const records: RecoveryRecord[] = [];
    if (this.canUseDisk()) {
      try {
        const sceneDirs = await this.storage.listDirectory(RECOVERY_DIRECTORY);
        for (const dir of sceneDirs) {
          if (dir.kind !== 'directory') continue;
          let scenePath: string;
          try {
            scenePath = decodeURIComponent(dir.name);
          } catch {
            continue;
          }
          const files = await this.storage.listDirectory(`${RECOVERY_DIRECTORY}/${dir.name}`);
          for (const file of files) {
            const parsed = parseVersionFileName(file.name);
            if (file.kind !== 'file' || !parsed) continue;
            records.push({
              scenePath,
              createdAt: parsed.createdAt,
              hash8: parsed.hash8,
              location: 'disk',
              ref: `${RECOVERY_DIRECTORY}/${dir.name}/${file.name}`,
            });
          }
        }
      } catch {
        // No journal yet (the directory does not exist) — start empty.
      }
    }
    this.index = records;
    this.indexProjectId = projectId;
    return records;
  }

  private async pruneDisk(): Promise<void> {
    const index = await this.loadIndex();
    const doomed = selectPruned(index, this.now());
    for (const record of doomed) {
      try {
        await this.storage.deleteEntry(record.ref);
      } catch (error) {
        console.warn(`[RecoveryJournal] Could not prune ${record.ref}`, error);
      }
    }
    const gone = new Set(doomed);
    this.index = index.filter(r => !gone.has(r));
  }

  private async pruneFallback(): Promise<void> {
    const records = (await this.fallback.list(this.projectId())).map(toFallbackRecord);
    for (const record of selectPruned(records, this.now())) {
      await this.fallback.delete(record.ref);
    }
  }
}

/**
 * Records the ring drops: beyond the newest {@link RECOVERY_MAX_VERSIONS} overall, or older than
 * {@link RECOVERY_MAX_AGE_MS} — never the newest version of a scene (to age).
 */
export function selectPruned(records: readonly RecoveryRecord[], now: number): RecoveryRecord[] {
  const newestFirst = [...records].sort((a, b) => b.createdAt - a.createdAt);
  const newestPerScene = new Set<RecoveryRecord>();
  const seen = new Set<string>();
  for (const record of newestFirst) {
    if (!seen.has(record.scenePath)) {
      seen.add(record.scenePath);
      newestPerScene.add(record);
    }
  }
  return newestFirst.filter(
    (record, index) =>
      index >= RECOVERY_MAX_VERSIONS ||
      (now - record.createdAt > RECOVERY_MAX_AGE_MS && !newestPerScene.has(record))
  );
}

function toFallbackRecord(record: {
  key: string;
  scenePath: string;
  createdAt: number;
  hash: string;
}): RecoveryRecord {
  return {
    scenePath: record.scenePath,
    createdAt: record.createdAt,
    hash8: record.hash.slice(0, 8),
    location: 'fallback',
    ref: record.key,
  };
}

/** `2026-09-26T12:30:05.123Z` → `2026-09-26T12-30-05-123Z` (valid on Windows, sorts by time). */
export function formatStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

const VERSION_FILE =
  /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-([0-9a-f]{8})\.pix3scene$/;

export function parseVersionFileName(name: string): { createdAt: number; hash8: string } | null {
  const match = VERSION_FILE.exec(name);
  if (!match) return null;
  const [, date, hh, mm, ss, ms, hash8] = match;
  const createdAt = Date.parse(`${date}T${hh}:${mm}:${ss}.${ms}Z`);
  return Number.isNaN(createdAt) ? null : { createdAt, hash8 };
}
