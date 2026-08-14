import {
  BOT_DIRECTORY,
  BOT_FILE_SUFFIX,
  botFilePath,
  botNameFromPath,
  type BotStore,
  type StoredBot,
} from '@/services/agent/game-bots';
import {
  parseRoutineText,
  ROUTINE_DIRECTORY,
  ROUTINE_FILE_SUFFIX,
  routineFilePath,
  type GameRoutine,
  type RoutineStore,
} from '@/services/agent/game-routines';
import {
  REPORT_DIRECTORY,
  reportFilePath,
  type RunProtocolStore,
} from '@/services/agent/game-run-protocol';
import {
  parseTrace,
  serializeTrace,
  TRACE_DIRECTORY,
  type GameInputTrace,
  type TraceStore,
} from '@/services/agent/game-traces';
import type { ProjectStorageService } from '@/services/project/ProjectStorageService';

/**
 * The file backend behind {@link TraceStore}: traces become real
 * `design/tests/*.trace.json` files in the open project, so a recording survives
 * a reload, is diffed and reviewed like any other project file, and can be
 * committed next to the code it guards.
 *
 * **Why `ProjectStorageService` and nothing lower.** A project is either a
 * directory picked through the File System Access API, an OPFS directory
 * ("browser" projects), or a cloud workspace reached over the API with a local
 * cache. `ProjectStorageService` is the one seam that already answers all three
 * (it dispatches on `appState.project.backend`) *and* publishes the asset
 * mutations the Asset Browser and collaborators listen to. Writing through
 * `FileSystemAPIService` directly would work for exactly one of the three and
 * would drop a written trace out of the asset tree until a manual refresh.
 *
 * Three behaviours are load-bearing for the agent that calls this through
 * `game_trace`:
 *
 * - **A missing file is not an error.** `load()` returns `null`, which is what
 *   lets `GameTestService.replayTrace` answer "no trace stored at X, known
 *   traces: …" instead of surfacing a backend exception the model cannot act on.
 *   Only a *failed* read (permission revoked, network) throws.
 * - **A corrupt or foreign trace is a refusal, not a crash.** Bad JSON and a
 *   `formatVersion` from a newer build both come back from {@link parseTrace} as
 *   a sentence, which this store throws with the path attached; `replayTrace`
 *   turns it into `{ok:false, error}`. Replaying half-parsed garbage would
 *   produce a comparison verdict that means nothing, which is worse.
 * - **A missing `design/tests` directory lists as empty**, because a project
 *   that never recorded a trace is the normal case, not a broken one.
 */
export type TraceProjectStorage = Pick<
  ProjectStorageService,
  'readTextFile' | 'writeTextFile' | 'listDirectory' | 'createDirectory' | 'deleteEntry'
>;

const TRACE_FILE_SUFFIX = '.trace.json';

export class ProjectTraceStore implements TraceStore {
  constructor(private readonly storage: TraceProjectStorage) {}

  async save(path: string, trace: GameInputTrace): Promise<void> {
    // `writeTextFile` does not create parent directories, and a fresh project
    // has no `design/tests` until something writes there. `createDirectory`
    // walks the segments and is idempotent, so this is a no-op once the
    // directory exists. A failure here is swallowed deliberately: if the
    // directory could not be created the write below fails too, and its error
    // names the actual file the agent asked for.
    try {
      await this.storage.createDirectory(TRACE_DIRECTORY);
    } catch {
      /* fall through to the write, whose error is the useful one */
    }
    await this.storage.writeTextFile(path, serializeTrace(trace));
  }

  async load(path: string): Promise<GameInputTrace | null> {
    let text: string;
    try {
      text = await this.storage.readTextFile(path);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new Error(`Could not read trace "${path}": ${describeError(error)}`);
    }
    const parsed = parseTrace(text);
    if ('error' in parsed) {
      throw new Error(`Trace file "${path}" is unreadable: ${parsed.error}`);
    }
    return parsed.trace;
  }

  async list(): Promise<string[]> {
    let entries;
    try {
      entries = await this.storage.listDirectory(TRACE_DIRECTORY);
    } catch (error) {
      // A project with no recordings yet has no directory — that is "no traces",
      // not a fault. Anything else is a real storage failure and is reported.
      if (isNotFound(error)) return [];
      throw new Error(`Could not list ${TRACE_DIRECTORY}: ${describeError(error)}`);
    }
    return entries
      .filter(
        entry => entry.kind === 'file' && entry.name.toLowerCase().endsWith(TRACE_FILE_SUFFIX)
      )
      .map(entry => entry.path || `${TRACE_DIRECTORY}/${entry.name}`)
      .sort();
  }
}

/**
 * The same file backend for routines (`design/tests/routines/*.json`, §5.7).
 *
 * It lives in this file rather than in one of its own because every hard part is
 * already solved above and is the same three answers: a **missing file is `null`**
 * (so `game_run` can answer "no routine called X, stored: …" instead of surfacing a
 * backend exception), a **corrupt file is a sentence, not a crash** (a
 * half-understood routine would run some steps and skip others, which is worse
 * than refusing), and a **missing directory lists as empty** (a project that never
 * wrote a routine is the normal case). Duplicating those three would be
 * duplicating the only interesting part of a store.
 *
 * `loadAll` returns broken files alongside the good ones instead of throwing: one
 * unparseable routine must not make the whole library — and with it the index in
 * the agent's context — disappear.
 */
export class ProjectRoutineStore implements RoutineStore {
  constructor(private readonly storage: TraceProjectStorage) {}

  async load(path: string): Promise<GameRoutine | null> {
    const full = routineFilePath(path);
    let text: string;
    try {
      text = await this.storage.readTextFile(full);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new Error(`Could not read routine "${full}": ${describeError(error)}`);
    }
    const parsed = parseRoutineText(text);
    if ('error' in parsed) {
      throw new Error(`Routine file "${full}" is unreadable: ${parsed.error}`);
    }
    return parsed.routine;
  }

  async loadAll(): Promise<{
    routines: GameRoutine[];
    broken: Array<{ path: string; error: string }>;
  }> {
    let entries;
    try {
      entries = await this.storage.listDirectory(ROUTINE_DIRECTORY);
    } catch (error) {
      if (isNotFound(error)) return { routines: [], broken: [] };
      throw new Error(`Could not list ${ROUTINE_DIRECTORY}: ${describeError(error)}`);
    }
    const routines: GameRoutine[] = [];
    const broken: Array<{ path: string; error: string }> = [];
    const files = entries
      .filter(
        entry => entry.kind === 'file' && entry.name.toLowerCase().endsWith(ROUTINE_FILE_SUFFIX)
      )
      .map(entry => entry.path || `${ROUTINE_DIRECTORY}/${entry.name}`)
      .sort();
    for (const path of files) {
      try {
        const parsed = parseRoutineText(await this.storage.readTextFile(path));
        if ('error' in parsed) {
          broken.push({ path, error: parsed.error });
        } else {
          routines.push(parsed.routine);
        }
      } catch (error) {
        broken.push({ path, error: describeError(error) });
      }
    }
    return { routines, broken };
  }
}

/**
 * The same file backend for run protocols (`design/tests/reports/NNNN-*.json`, §6).
 *
 * Third store in this file for the third time the same three answers are needed: a
 * **missing directory lists as empty** (a project whose first run is happening right
 * now is the normal case, and a report the agent cannot find is a report that never
 * existed), a **write creates the directory first** (`writeTextFile` does not, and
 * the swallow is deliberate — the write's own error names the file the agent asked
 * about), and a **missing file is not a failed delete**: rotation deletes by name
 * from a listing that may be a few milliseconds old, and a concurrent editor (or a
 * human in a file manager) removing one first must not turn a successful save into
 * a failed artifact.
 *
 * Unlike the trace and routine stores it reads nothing back. That is not an
 * omission: the reports are written for `fs_read` — the agent slices them with
 * `{offset, limit}` through the ordinary filesystem tools — and a parser here would
 * be a second, drifting definition of a document that has exactly one writer.
 */
export class ProjectReportStore implements RunProtocolStore {
  constructor(private readonly storage: TraceProjectStorage) {}

  async list(): Promise<string[]> {
    let entries;
    try {
      entries = await this.storage.listDirectory(REPORT_DIRECTORY);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw new Error(`Could not list ${REPORT_DIRECTORY}: ${describeError(error)}`);
    }
    return (
      entries
        .filter(entry => entry.kind === 'file' && entry.name.toLowerCase().endsWith('.json'))
        // NAMES, not paths: the numbering and the rotation plan are both computed from
        // the file names, and a backend that reports full paths would break both.
        .map(entry => entry.name)
        .sort()
    );
  }

  async save(name: string, text: string): Promise<void> {
    try {
      await this.storage.createDirectory(REPORT_DIRECTORY);
    } catch {
      /* fall through to the write, whose error is the useful one */
    }
    await this.storage.writeTextFile(reportFilePath(name), text);
  }

  async delete(name: string): Promise<void> {
    try {
      await this.storage.deleteEntry(reportFilePath(name));
    } catch (error) {
      if (isNotFound(error)) return;
      throw new Error(`Could not delete ${reportFilePath(name)}: ${describeError(error)}`);
    }
  }
}

/**
 * The same file backend for bot policies (`design/tests/bots/<name>.ts`, §5.3).
 *
 * Fourth store in this file, and the one that reads the least: a policy is
 * TypeScript, so this store hands back **text** and never parses. Only the compiler
 * can say whether a policy is valid, and a parser here would be a second, worse
 * opinion about a file the compiler already judges — the same reasoning that keeps
 * {@link ProjectReportStore} from parsing what it writes.
 *
 * The one filtering rule is `.d.ts`: the host writes the authoring declarations into
 * this very folder, and a listing that offered `pix3-test-bot.d` as a runnable policy
 * would be a name the model would eventually try.
 */
export class ProjectBotStore implements BotStore {
  constructor(private readonly storage: TraceProjectStorage) {}

  async load(name: string): Promise<StoredBot | null> {
    const path = botFilePath(name);
    let source: string;
    try {
      source = await this.storage.readTextFile(path);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new Error(`Could not read policy "${path}": ${describeError(error)}`);
    }
    return { name: botNameFromPath(path), path, source };
  }

  async list(): Promise<StoredBot[]> {
    let entries;
    try {
      entries = await this.storage.listDirectory(BOT_DIRECTORY);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw new Error(`Could not list ${BOT_DIRECTORY}: ${describeError(error)}`);
    }
    const paths = entries
      .filter(entry => {
        if (entry.kind !== 'file') return false;
        const lower = entry.name.toLowerCase();
        return lower.endsWith(BOT_FILE_SUFFIX) && !lower.endsWith('.d.ts');
      })
      .map(entry => entry.path || `${BOT_DIRECTORY}/${entry.name}`)
      .sort();

    const bots: StoredBot[] = [];
    for (const path of paths) {
      try {
        bots.push({
          name: botNameFromPath(path),
          path,
          source: await this.storage.readTextFile(path),
        });
      } catch {
        // A file that cannot be read is left out of the listing rather than
        // failing it: the policy the caller asked for is loaded by `load()`, whose
        // own error names it, and one unreadable sibling must not hide the rest.
      }
    }
    return bots;
  }
}

/**
 * Whether a storage error means "it is not there".
 *
 * Each backend words it differently — `FileSystemAPIService` normalises to a
 * `FileSystemAPIError` with `code: 'not-found'`, raw File System Access calls
 * throw a `DOMException` named `NotFoundError`, and the cloud path surfaces an
 * HTTP 404 — so the check covers all three rather than pinning one. Getting this
 * wrong in the permissive direction would hide a permission failure as "no such
 * trace", hence the narrow patterns.
 */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; name?: unknown; message?: unknown };
  if (candidate.code === 'not-found') return true;
  if (candidate.name === 'NotFoundError') return true;
  const message = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : '';
  return /\bnot found\b|\bno such file\b|\b404\b/.test(message);
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
