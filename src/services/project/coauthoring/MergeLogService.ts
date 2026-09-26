import { inject, injectable } from '@/fw/di';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { ProjectOwnershipService } from '@/services/project/coauthoring/ProjectOwnershipService';
import { MERGE_LOG_FILE, toProjectPath } from '@/services/project/coauthoring/coauthoring-paths';
import type { MergeLogEntry } from '@/services/project/external-merge/merge-external-version';

/** Ring size of `.pix3/merge-log.jsonl` (lines). */
export const MERGE_LOG_MAX_LINES = 500;

/** Events the editor adds to the engine's own `MergeLogEntry` kinds. */
export type EditorMergeLogEvent =
  | { event: 'accept-agent'; conflicts: string[]; all: boolean }
  | { event: 'keep-mine'; hash: string | null }
  | { event: 'restore-version'; ref: string; createdAt: number }
  | { event: 'reload'; hash: string; reason: 'no-protected-edits' | 'not-owner' };

/** One line of `.pix3/merge-log.jsonl`: `{ at, file, ...entry }`. */
export type MergeLogLine = { at: string; file: string | null } & (
  | MergeLogEntry
  | EditorMergeLogEvent
);

/**
 * `.pix3/merge-log.jsonl` — plan §4.3 "Видимость для агента": every merge decision (which file,
 * which properties, whose version stayed, the hash of M as written, what is still protected) and
 * every ack event, one JSON object per line, newest last. The agent reads it (`pix3 check`,
 * `project_status`) to learn why its write did not land.
 *
 * Written by the OWNER window only, unconditionally (the editor owns this file), as a ring of
 * {@link MERGE_LOG_MAX_LINES} lines. Appends are serialised; a failed write is logged and dropped —
 * the log is diagnostics, never a precondition of a merge.
 */
@injectable()
export class MergeLogService {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(ProjectOwnershipService)
  private readonly ownership!: ProjectOwnershipService;

  private queue: Promise<unknown> = Promise.resolve();
  private now: () => Date = () => new Date();

  /** Tests: a fixed clock. */
  setClock(now: () => Date): void {
    this.now = now;
  }

  append(
    file: string | null,
    entries: readonly (MergeLogEntry | EditorMergeLogEvent)[]
  ): Promise<void> {
    if (entries.length === 0 || !this.ownership.isOwner()) {
      return Promise.resolve();
    }
    const at = this.now().toISOString();
    const key = file === null ? null : toProjectPath(file);
    const lines = entries.map(entry => {
      const line = { at, ...entry, file: 'file' in entry && entry.file ? entry.file : key };
      return JSON.stringify(line);
    });
    const run = this.queue.then(() => this.appendNow(lines));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Every line currently in the log, parsed (malformed lines skipped). */
  async read(): Promise<MergeLogLine[]> {
    await this.queue;
    const text = await this.readText();
    const out: MergeLogLine[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as MergeLogLine);
      } catch {
        // skip a torn line
      }
    }
    return out;
  }

  private async readText(): Promise<string> {
    try {
      if (await this.storage.fileExists(MERGE_LOG_FILE)) {
        return await this.storage.readTextFile(MERGE_LOG_FILE);
      }
    } catch {
      // unreadable: start over
    }
    return '';
  }

  private async appendNow(lines: string[]): Promise<void> {
    const existing = (await this.readText()).split('\n').filter(line => line.trim().length > 0);
    const all = [...existing, ...lines].slice(-MERGE_LOG_MAX_LINES);
    try {
      await this.storage.writeTextFile(MERGE_LOG_FILE, `${all.join('\n')}\n`, {
        unconditional: true,
      });
    } catch (error) {
      console.warn(`[MergeLogService] Could not write ${MERGE_LOG_FILE}`, error);
    }
  }
}
