/**
 * The Antigravity (`agy`) lane, assembled: detection cache + model catalog + session pool + the MCP
 * relay endpoint the shim posts to. `index.ts` owns HTTP and delegates every agy route here, so the
 * server file stays a router and this file stays the lane.
 *
 * Two pieces of state deserve a note:
 *
 *   - **A second `SessionManager`, not a shared one.** A wedged Claude Code session must not be able
 *     to evict an agy chat (and vice versa), and the two lanes cost very different amounts per
 *     session — an agy session is a native process that in turn spawns every MCP server in the
 *     user's own config.
 *   - **A session registry by id.** The shim addresses its relay posts as
 *     `/agents/agy/mcp/<sessionId>`, which is the only reliable way to tell whose tool call this is:
 *     agy connects its MCP servers eagerly at process start, so correlating by timing would be
 *     guesswork.
 */

import {
  AGY_AGENT_ID,
  AGY_LABEL,
  AgyModelCatalog,
  detectAgy,
  toAgyModel,
  type AgyDiagnostic,
  type AgyModel,
  type AgyStatus,
} from './agy.ts';
import { AgySession } from './agy-session.ts';
import type { AgySpawner } from './agy-session.ts';
import { ConversationStore, conversationKey } from './agy-conversations.ts';
import { SessionManager, type BridgeResponse, type ManagedSession } from './sessions.ts';
import type { Logger } from './util.ts';
import { HttpError } from './wire.ts';
import type { WireMessagesRequest } from './wire.ts';
import type { BridgeConfig } from './config.ts';

/** How long a detection result is served before the next probe. `agy models` is a network call. */
const STATUS_TTL_MS = 60_000;

/** Default pool size for this lane — see {@link import('./config.ts').AgyConfig.maxSessions}. */
const DEFAULT_MAX_SESSIONS = 2;

/** How long `GET /v1/providers` may wait on a cold detection before answering "still probing". */
const DISCOVERY_PROBE_BUDGET_MS = 8_000;

/** Discovery shape for `GET /v1/providers` → `agents[]`. Additive: old editors ignore the key. */
export interface AgentDiscoveryEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: 'agent-cli';
  readonly available: boolean;
  readonly version?: string;
  readonly auth: 'ok' | 'missing' | 'unknown';
  readonly mcp: 'registered' | 'missing';
  readonly tools: 'enabled' | 'disabled';
  readonly path?: string;
  readonly diagnostics?: AgyDiagnostic[];
}

export interface AgyLaneOptions {
  /** Test seam: spawn a fake process instead of a real `agy`. */
  readonly spawner?: AgySpawner;
  /** Test seam: skip the real detection probe. */
  readonly detect?: (config: BridgeConfig) => Promise<AgyStatus>;
}

export class AgyLane {
  readonly manager: SessionManager;

  private readonly log: Logger;
  private readonly config: BridgeConfig;
  private readonly catalog = new AgyModelCatalog();
  private readonly conversations = new ConversationStore();
  private readonly sessions = new Map<string, AgySession>();
  private readonly options: AgyLaneOptions;

  private status: AgyStatus | null = null;
  private statusAt = 0;
  private statusInFlight: Promise<AgyStatus> | null = null;

  constructor(config: BridgeConfig, log: Logger, options: AgyLaneOptions = {}) {
    this.config = config;
    this.log = log;
    this.options = options;
    this.manager = new SessionManager(log, {
      stallTimeoutMs: config.stallTimeoutMs,
      maxSessions: config.agy.maxSessions ?? DEFAULT_MAX_SESSIONS,
      label: '[agy]',
      createSession: (request, logger) => this.createSession(request, logger),
    });
  }

  /** Cached detection. Never throws — a lane that cannot be probed reports itself unavailable. */
  async getStatus(force = false): Promise<AgyStatus> {
    const fresh = !force && this.status !== null && Date.now() - this.statusAt < STATUS_TTL_MS;
    if (fresh && this.status) return this.status;
    if (this.statusInFlight) return this.statusInFlight;
    const detect = this.options.detect ?? ((config: BridgeConfig) => detectAgy(config.agy));
    this.statusInFlight = detect(this.config)
      .catch(error => {
        this.log(`agy detection failed: ${error instanceof Error ? error.message : String(error)}`);
        return {
          available: false,
          auth: 'unknown',
          mcp: 'missing',
          toolsEnabled: false,
          diagnostics: [
            {
              reason: 'detection-failed',
              severity: 'error',
              message: 'Could not probe the Antigravity CLI.',
              detail: error instanceof Error ? error.message : String(error),
            },
          ],
        } satisfies AgyStatus;
      })
      .then(status => {
        this.status = status;
        this.statusAt = Date.now();
        this.statusInFlight = null;
        return status;
      });
    return this.statusInFlight;
  }

  /**
   * Discovery must stay snappy. Detection spawns `agy --version` and `agy models`, so the very
   * first probe can take tens of seconds — the server warms it at boot, but an editor that comes up
   * at the same moment would otherwise sit and wait. Past the cap the lane reports itself as still
   * being probed, and the editor's next probe gets the cached answer.
   */
  private async statusForDiscovery(): Promise<AgyStatus> {
    if (this.status && Date.now() - this.statusAt < STATUS_TTL_MS) return this.status;
    const pending = this.getStatus();
    let timer: NodeJS.Timeout | undefined;
    const probing = new Promise<AgyStatus>(resolve => {
      timer = setTimeout(
        () =>
          resolve({
            available: false,
            auth: 'unknown',
            mcp: 'missing',
            toolsEnabled: false,
            diagnostics: [
              {
                reason: 'probing',
                severity: 'warning',
                message: 'Still checking whether the Antigravity CLI is usable.',
              },
            ],
          }),
        DISCOVERY_PROBE_BUDGET_MS
      );
      timer.unref();
    });
    try {
      return await Promise.race([pending, probing]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async discoveryEntry(): Promise<AgentDiscoveryEntry> {
    const status = await this.statusForDiscovery();
    return {
      id: AGY_AGENT_ID,
      label: AGY_LABEL,
      kind: 'agent-cli',
      available: status.available,
      ...(status.version ? { version: status.version } : {}),
      auth: status.auth,
      mcp: status.mcp,
      tools: status.toolsEnabled ? 'enabled' : 'disabled',
      ...(status.path ? { path: status.path } : {}),
      ...(status.diagnostics.length > 0 ? { diagnostics: status.diagnostics } : {}),
    };
  }

  async listModels(): Promise<AgyModel[]> {
    const status = await this.getStatus();
    if (!status.available) {
      throw new HttpError(503, this.unavailableMessage(status));
    }
    const entries = await this.catalog.list(status.path);
    return entries.map(entry => toAgyModel(entry, status.toolsEnabled));
  }

  async handleMessages(request: WireMessagesRequest, signal: AbortSignal): Promise<BridgeResponse> {
    const status = await this.getStatus();
    if (!status.available) throw new HttpError(503, this.unavailableMessage(status));
    if (status.auth === 'missing') {
      throw new HttpError(
        401,
        'agy is installed but not signed in. Run `agy` once in a terminal, complete the sign-in, then try again.'
      );
    }
    return this.manager.handle(request, signal);
  }

  /**
   * The relay endpoint. `sessionId` comes from the environment the bridge set on the agy process,
   * so an unknown one means the session is gone (evicted, cancelled, restarted) — a plain 404 the
   * shim turns into a JSON-RPC error, which agy shows the model as a failed tool call.
   */
  async handleMcp(
    sessionId: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      this.pruneSessions();
      throw new HttpError(404, `No live agy session "${sessionId}".`);
    }
    if (method === 'tools/list') return session.listTools();
    if (method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      if (!name) throw new HttpError(400, 'tools/call needs a tool name.');
      return session.callTool(name, params.arguments ?? {});
    }
    throw new HttpError(400, `Unsupported MCP method "${method}".`);
  }

  closeAll(reason: string): void {
    this.manager.closeAll(reason);
    this.sessions.clear();
  }

  // -- internals --------------------------------------------------------------

  private unavailableMessage(status: AgyStatus): string {
    const first = status.diagnostics.find(diagnostic => diagnostic.severity === 'error');
    return first
      ? `${first.message}${first.detail ? ` ${first.detail}` : ''}`
      : 'The Antigravity CLI (agy) is not available on this machine.';
  }

  private createSession(request: WireMessagesRequest, log: Logger): ManagedSession {
    const status = this.status;
    if (!status?.available || !status.path) {
      // getStatus() gates every entry point, so this is a programming error rather than a user one.
      throw new HttpError(503, 'The Antigravity CLI is not available.');
    }
    const key = conversationKey(request.messages);
    const remembered = this.conversations.get(key);
    // Resume only when this chat is exactly one message further along than the conversation agy
    // already heard; anything else (an edit, a regenerate, a branch) would double-apply history.
    const resumable =
      remembered && remembered.transcriptLen === request.messages.length - 1
        ? remembered.conversationId
        : undefined;

    const session = new AgySession(request, log, {
      binary: status.path,
      allowTools: status.toolsEnabled,
      mcpUrl: `http://127.0.0.1:${this.config.port}/agents/${AGY_AGENT_ID}/mcp`,
      mcpToken: this.config.mcpToken,
      ...(resumable ? { conversationId: resumable } : {}),
      ...(this.options.spawner ? { spawner: this.options.spawner } : {}),
      // The key is recomputed per request rather than fixed at creation: it hashes the opening
      // EXCHANGE, which does not exist yet when a chat's first message arrives.
      onTurnEnd: (conversationId, transcriptLen, chatKey) => {
        if (!conversationId) return;
        this.conversations.remember(chatKey, {
          conversationId,
          model: request.model,
          transcriptLen,
          updatedAt: Date.now(),
        });
      },
    });
    this.sessions.set(session.id, session);
    this.pruneSessions();
    return session;
  }

  private pruneSessions(): void {
    for (const [id, session] of this.sessions) {
      if (session.closed) this.sessions.delete(id);
    }
  }
}
