import type { ToolCallResult, ToolContentBlock } from '../call-relay.ts';
import {
  LaneHttpError,
  NoWorkspaceServerError,
  type AgentLaneClient,
  type ExpectDiff,
} from './lane-client.ts';
import {
  BARRIER_TOOLS,
  OBSERVING_TOOLS,
  WORKSPACE_TOOL_NAMES,
  buildToolList,
  type McpToolSpec,
} from './tools.ts';

/**
 * The tools of `pix3 mcp --workspace` and the sync barrier of plan §5 D.
 *
 * Every tool is relayed to the editor window holding the workspace lease (through `pix3 serve`'s
 * agent lane). `play_start`, `play_restart` and `game_run` go through the **barrier** — three
 * sides, three checks:
 *
 * 1. **Agent's expectations** (`expect: {path: sha256}`) against the disk, BEFORE any sync.
 *    Mismatch → `disk_differs_from_agent`, per file: merged by the editor (re-read it), or
 *    overwritten — with the recovery copy only when one with exactly those bytes exists.
 * 2. **Editor = disk.** The window holds autosave, stops play, runs `syncNow()` and returns the
 *    hashes of what it has loaded (`sync_barrier`); those are compared with the disk at that
 *    moment, retrying the editor's sync for up to {@link SYNC_BUDGET_MS}. Loader/compiler errors →
 *    `load_failed`; a file that stays unreadable → `pending_external`; hashes that never agree →
 *    `sync_timeout`.
 * 3. **After the run**, the verified files are hashed again and the server's change log since the
 *    verification is read: `changedDuringRun`. Detection, not proof — `v1 → v2 → v1` between the
 *    two checks is invisible.
 *
 * Observing tools do not stop or sync: they report the revision the running game started from and
 * `stale` when the disk moved since.
 */

export const SYNC_BUDGET_MS = 5_000;
const SYNC_RETRY_DELAY_MS = 250;
/** How long one `sync_barrier` call may take (it waits for the editor's stabilisation window). */
const SYNC_CALL_TIMEOUT_MS = 30_000;

export type BarrierErrorCode =
  | 'disk_differs_from_agent'
  | 'sync_timeout'
  | 'load_failed'
  | 'pending_external'
  | 'no_editor'
  | 'permission_denied'
  | 'no_workspace_server';

export interface McpToolResult {
  content: ToolContentBlock[];
  isError?: boolean;
  [key: string]: unknown;
}

interface SyncError {
  readonly file: string | null;
  readonly line?: number;
  readonly message: string;
  readonly kind: 'load' | 'compile' | 'pending';
}

interface SyncReport {
  readonly loaded: Record<string, string>;
  readonly errors: SyncError[];
  readonly holdId: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const json = (value: unknown): string => JSON.stringify(value, null, 2);

export const toolError = (
  code: BarrierErrorCode,
  message: string,
  details: Record<string, unknown> = {}
): McpToolResult => ({
  content: [{ type: 'text', text: json({ error: code, message, ...details }) }],
  isError: true,
});

/** The editor result's first text block as JSON (or the raw text), plus its images. */
const splitResult = (result: ToolCallResult): { payload: unknown; images: ToolContentBlock[] } => {
  const texts = result.content.flatMap(block => (block.type === 'text' ? [block.text] : []));
  const images = result.content.filter(block => block.type === 'image');
  const text = texts.join('\n');
  let payload: unknown = text;
  try {
    payload = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    payload = text;
  }
  return { payload, images };
};

const hintFor = (diff: ExpectDiff): string => {
  if (diff.mergeLog) {
    return (
      `The editor merged your write of ${diff.path} with the human's manual edits (see ` +
      '.pix3/merge-log.jsonl). Re-read the file: the merged version is what runs now.'
    );
  }
  if (diff.diskHash === null) {
    return `${diff.path} is missing on disk. Write it again.`;
  }
  if (diff.recovery) {
    return `Your write of ${diff.path} was overwritten. A copy of your version: ${diff.recovery}.`;
  }
  return `Your write of ${diff.path} was overwritten and no copy exists — write the file again.`;
};

const parseSyncReport = (payload: unknown): SyncReport | null => {
  if (!isRecord(payload) || !isRecord(payload.loaded)) return null;
  const loaded: Record<string, string> = {};
  for (const [path, hash] of Object.entries(payload.loaded)) {
    if (typeof hash === 'string') loaded[path] = hash;
  }
  const errors: SyncError[] = [];
  for (const raw of Array.isArray(payload.errors) ? payload.errors : []) {
    if (!isRecord(raw) || typeof raw.message !== 'string') continue;
    const kind = raw.kind === 'compile' || raw.kind === 'pending' ? raw.kind : 'load';
    errors.push({
      file: typeof raw.file === 'string' ? raw.file : null,
      ...(typeof raw.line === 'number' ? { line: raw.line } : {}),
      message: raw.message,
      kind,
    });
  }
  return { loaded, errors, holdId: typeof payload.holdId === 'string' ? payload.holdId : null };
};

export interface WorkspaceAgentToolsOptions {
  readonly log?: (line: string) => void;
  readonly syncBudgetMs?: number;
}

export class WorkspaceAgentTools {
  private readonly lane: AgentLaneClient;
  private readonly log: (line: string) => void;
  private readonly syncBudgetMs: number;
  /** Tool schemas advertised by the window, per server session. */
  private advertised: { serverSession: string; tools: unknown[] } | null = null;

  constructor(lane: AgentLaneClient, options: WorkspaceAgentToolsOptions = {}) {
    this.lane = lane;
    this.log = options.log ?? (() => undefined);
    this.syncBudgetMs = options.syncBudgetMs ?? SYNC_BUDGET_MS;
  }

  /** `tools/list`: the window's schemas when a window is there, the static fallback otherwise. */
  async list(): Promise<McpToolSpec[]> {
    return buildToolList(await this.advertisedTools());
  }

  /** True when the last {@link list} used the window's schemas. */
  hasAdvertisedTools(): boolean {
    return this.advertised !== null;
  }

  private async advertisedTools(): Promise<unknown[] | null> {
    try {
      const status = await this.lane.status();
      if (this.advertised?.serverSession === status.serverSession) return this.advertised.tools;
      if (status.holder !== 'connected') return null;
      const tools = await this.lane.tools();
      this.advertised = { serverSession: status.serverSession, tools };
      return tools;
    } catch {
      return null;
    }
  }

  async call(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (!WORKSPACE_TOOL_NAMES.includes(name)) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      if (name === 'project_status') return await this.projectStatus();
      if (BARRIER_TOOLS.has(name)) return await this.barrierTool(name, args);
      if (OBSERVING_TOOLS.has(name)) return await this.observingTool(name, args);
      return this.passthrough(await this.lane.call(name, args));
    } catch (error) {
      return this.transportError(error);
    }
  }

  // --- transport errors -------------------------------------------------------------------------

  private transportError(error: unknown): McpToolResult {
    if (error instanceof NoWorkspaceServerError) {
      this.log(error.message);
      return toolError('no_workspace_server', error.message, { root: error.root });
    }
    if (error instanceof LaneHttpError) {
      if (error.code === 'no_editor') return toolError('no_editor', error.message);
      if (error.code === 'lease_lost') {
        return toolError('no_editor', `${error.message} Open the project in Pix3 again.`, {
          reason: 'lease_lost',
        });
      }
      if (error.code === 'no_editor_reply') {
        return toolError(
          'no_editor',
          'The Pix3 editor holds this project but did not answer in time (a background tab may ' +
            'be throttled — bring the editor window to the front and retry).',
          { reason: 'no_reply' }
        );
      }
      return {
        content: [{ type: 'text', text: json({ error: error.code, message: error.message }) }],
        isError: true,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: message }], isError: true };
  }

  private passthrough(result: ToolCallResult): McpToolResult {
    return {
      content: result.content,
      ...(result.isError ? { isError: true } : {}),
    };
  }

  // --- project_status ---------------------------------------------------------------------------

  private async projectStatus(): Promise<McpToolResult> {
    const status = await this.lane.status();
    const server = {
      root: status.root,
      projectName: status.projectName,
      revision: status.revision,
      seq: status.seq,
      serverSession: status.serverSession,
      cliVersion: status.cliVersion,
    };
    try {
      const result = await this.lane.call('project_status', {}, 15_000);
      const { payload } = splitResult(result);
      return {
        content: [{ type: 'text', text: json({ connected: true, server, editor: payload }) }],
        ...(result.isError ? { isError: true } : {}),
      };
    } catch (error) {
      if (error instanceof LaneHttpError && error.code === 'no_editor') {
        return {
          content: [
            {
              type: 'text',
              text: json({ connected: false, server, editor: null, message: error.message }),
            },
          ],
        };
      }
      throw error;
    }
  }

  // --- observing tools --------------------------------------------------------------------------

  private async observingTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.lane.call(name, args);
    const meta = isRecord(result._meta) && isRecord(result._meta.pix3) ? result._meta.pix3 : {};
    const revision = isRecord(meta.playRevision)
      ? (Object.fromEntries(
          Object.entries(meta.playRevision).filter(([, hash]) => typeof hash === 'string')
        ) as Record<string, string>)
      : null;
    let stale = meta.stale === true;
    if (revision && !stale) {
      const { hashes } = await this.lane.hash(Object.keys(revision));
      stale = Object.entries(revision).some(([path, hash]) => hashes[path] !== hash);
    }
    const { payload, images } = splitResult(result);
    return {
      content: [{ type: 'text', text: json({ revision, stale, result: payload }) }, ...images],
      ...(result.isError ? { isError: true } : {}),
    };
  }

  // --- barrier tools ----------------------------------------------------------------------------

  private async barrierTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const { expect: rawExpect, ...input } = args;
    let expect: Record<string, string> | null = null;
    if (rawExpect !== undefined && rawExpect !== null) {
      if (!isRecord(rawExpect)) {
        return {
          content: [{ type: 'text', text: '`expect` must be an object {path: sha256}.' }],
          isError: true,
        };
      }
      expect = {};
      for (const [path, hash] of Object.entries(rawExpect)) {
        if (typeof hash === 'string') expect[path.replace(/^res:\/\//, '')] = hash.toLowerCase();
      }
    }

    // 1. The agent's expectations against the disk, before anything syncs.
    if (expect && Object.keys(expect).length > 0) {
      const report = await this.lane.expect(expect);
      if (!report.matchesAgent) {
        return toolError(
          'disk_differs_from_agent',
          'The disk does not hold the versions you wrote; nothing was started.',
          { differing: report.differing.map(diff => ({ ...diff, hint: hintFor(diff) })) }
        );
      }
    } else {
      expect = null;
    }

    // 2. Editor = disk.
    let holdId: string | null = null;
    try {
      const deadline = Date.now() + this.syncBudgetMs;
      let verified: Record<string, string> | null = null;
      let verifiedSeq = 0;
      for (;;) {
        const syncResult = await this.lane.call(
          'sync_barrier',
          { tool: name },
          SYNC_CALL_TIMEOUT_MS
        );
        const { payload } = splitResult(syncResult);
        if (syncResult.isError) {
          return this.passthrough(syncResult);
        }
        const report = parseSyncReport(payload);
        if (!report) {
          return {
            content: [{ type: 'text', text: 'The editor answered sync_barrier without hashes.' }],
            isError: true,
          };
        }
        if (report.holdId && holdId && report.holdId !== holdId) {
          // A retry took a new hold: give the previous one back now, not at its safety timeout.
          const previous = holdId;
          await this.lane.call('sync_release', { holdId: previous }, 5_000).catch(() => undefined);
        }
        holdId = report.holdId ?? holdId;
        const checked = { ...report.loaded, ...(expect ?? {}) };
        const disk = await this.lane.hash(Object.keys(checked));
        const differing = Object.entries(checked)
          .filter(([path, hash]) => disk.hashes[path] !== hash)
          .map(([path, hash]) => ({
            path,
            diskHash: disk.hashes[path] ?? null,
            ...(expect && path in expect ? { agentHash: hash } : {}),
            ...(path in report.loaded ? { loadedHash: report.loaded[path] } : {}),
          }));
        const loadErrors = report.errors.filter(error => error.kind !== 'pending');
        const pending = report.errors.filter(error => error.kind === 'pending');
        if (differing.length === 0) {
          if (loadErrors.length > 0) {
            return toolError('load_failed', 'The editor could not load the current files.', {
              errors: loadErrors,
            });
          }
          if (pending.length > 0) {
            return toolError('pending_external', pendingMessage(pending), { errors: pending });
          }
          verified = checked;
          verifiedSeq = disk.seq;
          break;
        }
        if (Date.now() >= deadline) {
          if (pending.length > 0) {
            return toolError('pending_external', pendingMessage(pending), { errors: pending });
          }
          if (loadErrors.length > 0) {
            return toolError('load_failed', 'The editor could not load the current files.', {
              errors: loadErrors,
            });
          }
          return toolError(
            'sync_timeout',
            `The editor's files did not match the disk within ${Math.round(this.syncBudgetMs / 1000)} s ` +
              '(still being written?). Nothing was started; call again when the writes are done.',
            { differing }
          );
        }
        await sleep(SYNC_RETRY_DELAY_MS);
      }

      // 3. Run, then look again.
      const result = await this.lane.call(name, input);
      const after = await this.lane.hash(Object.keys(verified));
      const changes = await this.lane.changes(verifiedSeq);
      const changedDuringRun = new Set<string>(changes.paths);
      for (const [path, hash] of Object.entries(verified)) {
        if (after.hashes[path] !== hash) changedDuringRun.add(path);
      }
      const matchesDisk = Object.entries(verified).every(
        ([path, hash]) => after.hashes[path] === hash
      );
      let editorChangedSinceAgentWrite: string[] = [];
      if (expect) {
        const post = await this.lane.expect(expect);
        editorChangedSinceAgentWrite = post.differing
          .filter(diff => diff.mergeLog)
          .map(diff => diff.path);
      }
      const { payload, images } = splitResult(result);
      const envelope = {
        revision: verified,
        matchesAgent: expect ? true : null,
        ...(expect ? {} : { agentExpectations: 'none' }),
        matchesDisk,
        changedDuringRun: [...changedDuringRun].sort(),
        ...(changes.complete ? {} : { changeLogIncomplete: true }),
        editorChangedSinceAgentWrite,
        result: payload,
      };
      return {
        content: [{ type: 'text', text: json(envelope) }, ...images],
        ...(result.isError ? { isError: true } : {}),
      };
    } finally {
      if (holdId) {
        await this.lane.call('sync_release', { holdId }, 5_000).catch(() => undefined);
      }
    }
  }
}

const pendingMessage = (pending: readonly SyncError[]): string => {
  const files = pending.map(error => error.file ?? '?').join(', ');
  return (
    `${files} cannot be read as a valid file (the editor keeps its last good version). Finish or ` +
    'fix the write, then call again.'
  );
};
