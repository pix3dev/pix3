import { LINK_HOST } from '../protocol.ts';
import type { ToolCallResult } from '../call-relay.ts';
import { readState } from '../serve/state-file.ts';

/**
 * HTTP client of the workspace server's agent lane (`/ws/agent/*`, `/ws/revision`), as used by
 * `pix3 mcp --workspace`.
 *
 * **Discovery.** The running `pix3 serve` of the project root is found through
 * `.pix3/workspace.json` (`server.port` + `server.control`) and confirmed with
 * `GET /ws/agent/status` carrying that control secret — a stale file, or an unrelated process on
 * the recorded port, does not count. Discovery is lazy and repeated: when the server is not
 * running, every call fails with {@link NoWorkspaceServerError}; the next call looks again, so the
 * agent never has to restart its MCP server after `pix3 serve` comes up (or restarts on another
 * port).
 */

export class NoWorkspaceServerError extends Error {
  readonly root: string;
  constructor(root: string, detail?: string) {
    super(
      `Workspace server is not running. Run \`pix3 serve\` in ${root}` +
        (detail ? ` (${detail})` : '') +
        ', then open it in Pix3 (File → Connect to Workspace…).'
    );
    this.root = root;
  }
}

/** A non-2xx answer of the lane: `{error, message, ...}`. */
export class LaneHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown>;
  constructor(status: number, code: string, message: string, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export interface LaneStatus {
  readonly workspaceId: string;
  readonly serverSession: string;
  readonly root: string;
  readonly revision: string;
  readonly seq: number;
  readonly leased: boolean;
  readonly holder: 'connected' | 'grace' | null;
  readonly projectName: string | null;
  readonly port: number;
  readonly cliVersion: string;
  readonly protocol: number;
}

export interface ExpectDiff {
  readonly path: string;
  readonly diskHash: string | null;
  readonly agentHash: string;
  readonly recovery: string | null;
  readonly mergeLog?: true;
}

export interface ExpectReport {
  readonly matchesAgent: boolean;
  readonly differing: ExpectDiff[];
  readonly hashes: Record<string, string | null>;
  readonly seq: number;
}

export interface ChangesReport {
  readonly since: number;
  readonly seq: number;
  readonly revision: string;
  readonly paths: string[];
  readonly complete: boolean;
}

export interface AgentIdentity {
  readonly name: string | null;
  readonly session: string;
}

interface Connection {
  readonly base: string;
  readonly control: string;
  readonly serverSession: string;
}

const PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 15_000;
/** Longer than the server's own 120 s cap, so its 504 arrives instead of a client abort. */
const CALL_CLIENT_SLACK_MS = 5_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export class AgentLaneClient {
  readonly root: string;
  private connection: Connection | null = null;
  private readonly identity: () => AgentIdentity;

  constructor(root: string, identity: () => AgentIdentity) {
    this.root = root;
    this.identity = identity;
  }

  /** Forget the server (the next call discovers again). */
  reset(): void {
    this.connection = null;
  }

  async status(): Promise<LaneStatus> {
    return (await this.request('GET', '/ws/agent/status')) as unknown as LaneStatus;
  }

  async tools(): Promise<unknown[]> {
    const body = await this.request('GET', '/ws/agent/tools', undefined, 8_000);
    return Array.isArray(body.tools) ? body.tools : [];
  }

  /** Relay one tool call to the editor window; resolves to the window's result. */
  async call(name: string, input: unknown, timeoutMs = 120_000): Promise<ToolCallResult> {
    const body = await this.request(
      'POST',
      '/ws/agent/call',
      { name, input, timeoutMs, agent: this.identity() },
      timeoutMs + CALL_CLIENT_SLACK_MS
    );
    if (!isRecord(body.result) || !Array.isArray(body.result.content)) {
      throw new LaneHttpError(502, 'bad_editor_reply', 'The server sent no tool result.', body);
    }
    return body.result as ToolCallResult;
  }

  async hash(
    paths: readonly string[]
  ): Promise<{ hashes: Record<string, string | null>; seq: number }> {
    if (paths.length === 0) return { hashes: {}, seq: (await this.revision()).seq };
    const body = await this.request('POST', '/ws/agent/hash', { paths });
    return {
      hashes: isRecord(body.hashes) ? (body.hashes as Record<string, string | null>) : {},
      seq: typeof body.seq === 'number' ? body.seq : 0,
    };
  }

  async expect(expect: Record<string, string>): Promise<ExpectReport> {
    return (await this.request('POST', '/ws/agent/expect', { expect })) as unknown as ExpectReport;
  }

  async changes(since: number): Promise<ChangesReport> {
    return (await this.request(
      'GET',
      `/ws/agent/changes?since=${Math.max(0, Math.floor(since))}`
    )) as unknown as ChangesReport;
  }

  async revision(): Promise<{ revision: string; seq: number; serverSession: string }> {
    const body = await this.request('GET', '/ws/revision');
    return {
      revision: String(body.revision ?? ''),
      seq: typeof body.seq === 'number' ? body.seq : 0,
      serverSession: String(body.serverSession ?? ''),
    };
  }

  /** The live server of the root, discovering it when needed. */
  async connect(): Promise<Connection> {
    if (this.connection) return this.connection;
    const state = readState(this.root);
    if (!state) {
      throw new NoWorkspaceServerError(this.root, 'no .pix3/workspace.json');
    }
    const record = state.server;
    if (!record) throw new NoWorkspaceServerError(this.root);
    const base = `http://${LINK_HOST}:${record.port}`;
    let body: Record<string, unknown>;
    try {
      const response = await fetch(`${base}/ws/agent/status`, {
        headers: { 'X-Pix3-Control': record.control },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new NoWorkspaceServerError(
          this.root,
          `port ${record.port} answers ${response.status}; an older pix3 serve, or another process`
        );
      }
      body = (await response.json()) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof NoWorkspaceServerError) throw error;
      throw new NoWorkspaceServerError(this.root, `nothing answers on port ${record.port}`);
    }
    if (body.serverSession !== record.serverSession || body.workspaceId !== state.workspaceId) {
      throw new NoWorkspaceServerError(this.root, 'the recorded server is gone');
    }
    this.connection = { base, control: record.control, serverSession: record.serverSession };
    return this.connection;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<Record<string, unknown>> {
    // One retry after a transport failure: the server may have restarted on another port.
    for (let attempt = 0; ; attempt++) {
      const connection = await this.connect();
      let response: Response;
      try {
        response = await fetch(`${connection.base}${path}`, {
          method,
          headers: {
            'X-Pix3-Control': connection.control,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        this.connection = null;
        if (error instanceof Error && error.name === 'TimeoutError') {
          throw new LaneHttpError(
            504,
            'no_editor_reply',
            'The workspace server did not answer in time.',
            {}
          );
        }
        if (attempt === 0) continue;
        throw new NoWorkspaceServerError(this.root, 'the connection dropped');
      }
      const text = await response.text();
      let parsed: Record<string, unknown> = {};
      try {
        const value = text ? (JSON.parse(text) as unknown) : {};
        parsed = isRecord(value) ? value : {};
      } catch {
        parsed = {};
      }
      if (response.ok) return parsed;
      if (response.status === 401 && attempt === 0) {
        // The control secret rotates with every server run: rediscover once.
        this.connection = null;
        continue;
      }
      throw new LaneHttpError(
        response.status,
        typeof parsed.error === 'string' ? parsed.error : `http_${response.status}`,
        typeof parsed.message === 'string' ? parsed.message : `HTTP ${response.status}`,
        parsed
      );
    }
  }
}
