import {
  WorkspaceError,
  toEventsUrl,
  type WorkspaceCallFrame,
  type WorkspaceCallResult,
  type WorkspaceChangeFrame,
  type WorkspaceHelloFrame,
  type WorkspaceLeaseFrame,
  type WorkspaceServerFrame,
} from '@/services/project/workspace/workspace-protocol';

/** The part of `WebSocket` this client uses — a fake in tests. */
export interface WorkspaceSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WorkspaceSocketFactory = (url: string) => WorkspaceSocketLike;

export type WorkspaceEventsConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface WorkspaceHelloInfo {
  /** A hello after an earlier one on this client (the socket came back). */
  readonly reconnected: boolean;
}

export interface WorkspaceEventsHandlers {
  onHello?(hello: WorkspaceHelloFrame, info: WorkspaceHelloInfo): void;
  onChange?(frame: WorkspaceChangeFrame): void;
  onLease?(frame: WorkspaceLeaseFrame): void;
  /**
   * The socket came back: events may have been missed while it was down (nothing is replayed),
   * so the caller must re-scan `/ws/manifest`.
   */
  onRescanNeeded?(hello: WorkspaceHelloFrame): void;
  /**
   * An MCP call for the lease holder. Return the result (it is sent as `call-result` on whatever
   * socket is current when it settles, if this client still holds the lease), or null to have
   * the call answered "not served by this editor".
   */
  onCall?(frame: WorkspaceCallFrame): Promise<WorkspaceCallResult> | null;
  onConnectionState?(state: WorkspaceEventsConnectionState, error?: WorkspaceError): void;
}

/** A lease this tab held, remembered so the same tab can resume it after a reload. */
export interface StoredWorkspaceLease {
  readonly leaseId: string;
  /** The server run that issued it; a restarted server has a fresh lease table. */
  readonly serverSession: string;
}

/** Per-workspace lease memory. The default lives in `sessionStorage`: per tab, survives F5. */
export interface WorkspaceLeaseStore {
  get(workspaceId: string): StoredWorkspaceLease | null;
  set(workspaceId: string, lease: StoredWorkspaceLease): void;
  clear(workspaceId: string): void;
}

const LEASE_STORAGE_PREFIX = 'pix3.workspace.lease.';

/**
 * `sessionStorage` is per tab and survives a reload of that tab, which is exactly the scope of a
 * lease: the reloaded tab resumes it, a second tab does not share it (a duplicated tab copies the
 * value, but the server only resumes a lease whose holder is disconnected, so it just gets `busy`).
 * Every access is guarded: storage can be missing or throw (private mode, blocked site data).
 */
export const sessionLeaseStore: WorkspaceLeaseStore = {
  get(workspaceId) {
    try {
      const raw = globalThis.sessionStorage?.getItem(LEASE_STORAGE_PREFIX + workspaceId);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<StoredWorkspaceLease>;
      return typeof parsed.leaseId === 'string' && typeof parsed.serverSession === 'string'
        ? { leaseId: parsed.leaseId, serverSession: parsed.serverSession }
        : null;
    } catch {
      return null;
    }
  },
  set(workspaceId, lease) {
    try {
      globalThis.sessionStorage?.setItem(LEASE_STORAGE_PREFIX + workspaceId, JSON.stringify(lease));
    } catch {
      // Not persisted: a reload then waits out the grace instead of resuming.
    }
  },
  clear(workspaceId) {
    try {
      globalThis.sessionStorage?.removeItem(LEASE_STORAGE_PREFIX + workspaceId);
    } catch {
      // ignore
    }
  },
};

export interface WorkspaceEventsClientOptions {
  /** Where the held `leaseId` is remembered per workspace (default: {@link sessionLeaseStore}). */
  readonly leaseStore?: WorkspaceLeaseStore;
  readonly createSocket?: WorkspaceSocketFactory;
  /** Reconnect delays in ms; the last one repeats. */
  readonly backoffMs?: readonly number[];
  /** A socket with no frame for this long is considered dead (server pings every 10 s). */
  readonly silenceTimeoutMs?: number;
}

const OPEN = 1;
const DEFAULT_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];
const DEFAULT_SILENCE_TIMEOUT_MS = 30_000;
/** Retry delay after `busy {inGrace}` when the server's `hello` does not say how long grace is. */
const FALLBACK_LEASE_RETRY_MS = 11_000;
/** Added to the server's grace so the retry lands after the expiry, not on it. */
const LEASE_RETRY_MARGIN_MS = 500;

/** Close codes of `/ws/events` (README "Close codes"). */
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_RATE_LIMITED = 4429;

/**
 * Client of `WS /ws/events`: the auth frame goes first (the token is never in the URL), then
 * `hello`, pushed `change` batches, lease frames and server pings.
 *
 * Reconnects by itself with backoff after any close it did not ask for, except an auth failure
 * (`4401` / `unauthorized` / `revoked`), which is fatal: retrying a rejected token only burns the
 * server's rate limit. After a reconnect the lease is re-acquired with the previous `leaseId`
 * (resumes it inside the server's grace period) and {@link WorkspaceEventsHandlers.onRescanNeeded}
 * fires so the caller re-scans the manifest.
 *
 * The `leaseId` is also kept in a {@link WorkspaceLeaseStore} (per tab, `sessionStorage`), so a
 * reloaded tab resumes its own lease. When the answer is `busy {inGrace: true}` (the holder's
 * socket is gone but its grace runs), `acquire` is sent again once the grace is over, and again
 * after that, until the lease is granted or someone connected holds it (`busy {inGrace: false}`).
 */
export class WorkspaceEventsClient {
  private readonly createSocket: WorkspaceSocketFactory;
  private readonly backoffMs: readonly number[];
  private readonly silenceTimeoutMs: number;

  private socket: WorkspaceSocketLike | null = null;
  private endpoint: string | null = null;
  private token: string | null = null;
  private handlers: WorkspaceEventsHandlers = {};
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private helloCount = 0;
  private lastRevision: string | null = null;
  private lastServerSession: string | null = null;
  private leaseId: string | null = null;
  private pendingRetryAfterMs: number | null = null;
  private readonly leaseStore: WorkspaceLeaseStore;
  private workspaceId: string | null = null;
  private leaseGraceMs: number | null = null;
  private leaseRetryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: WorkspaceEventsClientOptions = {}) {
    this.leaseStore = options.leaseStore ?? sessionLeaseStore;
    this.createSocket =
      options.createSocket ?? ((url: string) => new WebSocket(url) as WorkspaceSocketLike);
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.silenceTimeoutMs = options.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;
  }

  connect(endpoint: string, token: string, handlers: WorkspaceEventsHandlers): void {
    this.close();
    this.endpoint = endpoint;
    this.token = token;
    this.handlers = handlers;
    this.stopped = false;
    this.attempt = 0;
    this.helloCount = 0;
    this.lastRevision = null;
    this.lastServerSession = null;
    this.leaseId = null;
    this.workspaceId = null;
    this.leaseGraceMs = null;
    this.open('connecting');
  }

  /** Stop for good: releases the lease if held, closes the socket, cancels any reconnect. */
  close(): void {
    const wasRunning = !this.stopped;
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (wasRunning) {
      // Given up on purpose (disconnect / another project): nothing to resume later.
      this.forgetStoredLease();
    }
    if (socket) {
      if (this.leaseId && socket.readyState === OPEN) {
        this.sendOn(socket, { type: 'lease', action: 'release' });
      }
      detach(socket);
      try {
        socket.close(1000, 'client closed');
      } catch {
        // already closing
      }
    }
    this.leaseId = null;
    if (wasRunning) {
      this.handlers.onConnectionState?.('closed');
    }
  }

  /** Revision after the last `hello` / `change` frame this client saw. */
  getLastRevision(): string | null {
    return this.lastRevision;
  }

  getLeaseId(): string | null {
    return this.leaseId;
  }

  acquireLease(): void {
    this.send({
      type: 'lease',
      action: 'acquire',
      ...(this.leaseId ? { leaseId: this.leaseId } : {}),
    });
  }

  takeOverLease(): void {
    this.send({ type: 'lease', action: 'takeover' });
  }

  releaseLease(): void {
    this.send({ type: 'lease', action: 'release' });
  }

  private open(state: 'connecting' | 'reconnecting'): void {
    if (this.stopped || !this.endpoint) {
      return;
    }
    this.handlers.onConnectionState?.(state);

    let socket: WorkspaceSocketLike;
    try {
      socket = this.createSocket(toEventsUrl(this.endpoint));
    } catch (error) {
      console.warn('[WorkspaceEventsClient] Could not open the events socket', error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      // First frame, within 5 s, or the server drops the socket.
      this.sendOn(socket, { type: 'auth', token: this.token ?? '' });
      this.armSilenceTimer();
    };
    socket.onmessage = event => {
      this.armSilenceTimer();
      this.handleMessage(socket, event.data);
    };
    socket.onerror = () => {
      // A close event always follows; reconnect is decided there.
    };
    socket.onclose = event => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      this.clearSilenceTimer();
      // The next hello re-sends `acquire` anyway.
      this.clearLeaseRetry();
      this.handleClose(event.code, event.reason);
    };
  }

  private handleMessage(socket: WorkspaceSocketLike, data: unknown): void {
    if (typeof data !== 'string') {
      return;
    }
    let frame: WorkspaceServerFrame;
    try {
      frame = JSON.parse(data) as WorkspaceServerFrame;
    } catch {
      console.warn('[WorkspaceEventsClient] Ignoring a malformed frame');
      return;
    }

    switch (frame.type) {
      case 'hello':
        this.handleHello(socket, frame);
        return;
      case 'ping':
        this.sendOn(socket, { type: 'pong' });
        return;
      case 'pong':
        return;
      case 'change':
        this.lastRevision = frame.revision;
        this.handlers.onChange?.(frame);
        return;
      case 'lease':
        this.handleLeaseFrame(frame);
        return;
      case 'call':
        this.handleCall(socket, frame);
        return;
      case 'error':
        this.handleErrorFrame(frame.error, frame.message, frame.retryAfter);
        return;
      default:
        return;
    }
  }

  private handleLeaseFrame(frame: WorkspaceLeaseFrame): void {
    this.clearLeaseRetry();
    if (frame.state === 'granted') {
      this.leaseId = frame.leaseId;
      if (this.workspaceId && this.lastServerSession) {
        this.leaseStore.set(this.workspaceId, {
          leaseId: frame.leaseId,
          serverSession: this.lastServerSession,
        });
      }
    } else if (frame.state === 'lost' || frame.state === 'released') {
      this.leaseId = null;
      this.forgetStoredLease();
    } else if (frame.state === 'busy' && frame.inGrace) {
      // The holder is disconnected: its lease frees itself when the grace ends (the server does
      // not announce that), so ask again then.
      this.scheduleLeaseRetry();
    }
    this.handlers.onLease?.(frame);
  }

  private scheduleLeaseRetry(): void {
    const delay =
      this.leaseGraceMs !== null
        ? this.leaseGraceMs + LEASE_RETRY_MARGIN_MS
        : FALLBACK_LEASE_RETRY_MS;
    this.leaseRetryTimer = setTimeout(() => {
      this.leaseRetryTimer = null;
      this.acquireLease();
    }, delay);
  }

  private clearLeaseRetry(): void {
    if (this.leaseRetryTimer !== null) {
      clearTimeout(this.leaseRetryTimer);
      this.leaseRetryTimer = null;
    }
  }

  private forgetStoredLease(): void {
    if (this.workspaceId) {
      this.leaseStore.clear(this.workspaceId);
    }
  }

  private handleHello(socket: WorkspaceSocketLike, hello: WorkspaceHelloFrame): void {
    const reconnected = this.helloCount > 0;
    // Always re-scan after a reconnect. Comparing revisions would not save anything: this
    // editor's own writes move the revision without an event, so it differs almost every time.
    const needsRescan = reconnected;
    if (hello.serverSession !== this.lastServerSession) {
      // A restarted server has a fresh lease table: a leaseId from the old session means nothing.
      if (this.lastServerSession !== null) {
        this.leaseId = null;
      }
    }
    if (this.workspaceId !== null && this.workspaceId !== hello.workspaceId) {
      // The address now serves another workspace: our lease belongs to the old one.
      this.leaseId = null;
    }
    this.workspaceId = hello.workspaceId;
    this.leaseGraceMs =
      typeof hello.leaseGraceMs === 'number' && hello.leaseGraceMs >= 0 ? hello.leaseGraceMs : null;
    if (this.leaseId === null) {
      // First hello of this page (e.g. after F5): the lease this tab held before, if any.
      const stored = this.leaseStore.get(hello.workspaceId);
      if (stored && stored.serverSession === hello.serverSession) {
        this.leaseId = stored.leaseId;
      } else if (stored) {
        this.leaseStore.clear(hello.workspaceId);
      }
    }
    this.helloCount += 1;
    this.attempt = 0;
    this.lastRevision = hello.revision;
    this.lastServerSession = hello.serverSession;
    this.handlers.onConnectionState?.('open');
    this.handlers.onHello?.(hello, { reconnected });
    if (needsRescan) {
      this.handlers.onRescanNeeded?.(hello);
    }
    this.sendOn(socket, {
      type: 'lease',
      action: 'acquire',
      ...(this.leaseId ? { leaseId: this.leaseId } : {}),
    });
  }

  /**
   * Hand an MCP call to {@link WorkspaceEventsHandlers.onCall}; the answer goes back on the socket
   * that is current when it settles (a reconnect in between is fine: the server resumes the lease
   * and matches the id). Without a handler the call is answered at once, so the agent is not left
   * hanging.
   */
  private handleCall(socket: WorkspaceSocketLike, frame: WorkspaceCallFrame): void {
    const pending = this.handlers.onCall?.(frame) ?? null;
    if (!pending) {
      this.sendOn(socket, {
        type: 'call-result',
        id: frame.id,
        result: {
          content: [
            {
              type: 'text',
              text: `Pix3 editor: tool "${frame.name}" is not served over the workspace channel.`,
            },
          ],
          isError: true,
        },
      });
      return;
    }
    void pending.then(
      result => this.sendCallResult(frame.id, result),
      (error: unknown) =>
        this.sendCallResult(frame.id, {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        })
    );
  }

  private sendCallResult(id: string, result: WorkspaceCallResult): void {
    // Lost the lease meanwhile: the server re-queues the call for the new holder (takeover) or
    // failed it already; an answer from here would only be refused (`not_lease_holder`).
    if (this.stopped || this.leaseId === null) {
      return;
    }
    this.send({ type: 'call-result', id, result });
  }

  private handleErrorFrame(code: string, message?: string, retryAfter?: number): void {
    if (code === 'unauthorized' || code === 'auth_timeout' || code === 'revoked') {
      this.fail(
        new WorkspaceError(
          'unauthorized',
          code === 'revoked'
            ? 'The workspace token was revoked on the server. Copy the new token from `pix3 serve` and connect again.'
            : 'The workspace server rejected the token. Copy the current token printed by `pix3 serve` and connect again.',
          { serverCode: code }
        )
      );
      return;
    }
    if (code === 'rate_limited') {
      this.pendingRetryAfterMs = typeof retryAfter === 'number' ? retryAfter * 1000 : null;
      return;
    }
    console.warn(`[WorkspaceEventsClient] Server error frame: ${code}`, message ?? '');
  }

  private handleClose(code: number, reason: string): void {
    if (this.stopped) {
      return;
    }
    if (code === CLOSE_UNAUTHORIZED) {
      this.fail(
        new WorkspaceError(
          'unauthorized',
          'The workspace server closed the connection: the token is not (or no longer) valid.',
          { serverCode: reason || null }
        )
      );
      return;
    }
    if (code === CLOSE_RATE_LIMITED && this.pendingRetryAfterMs === null) {
      this.pendingRetryAfterMs = 60_000;
    }
    this.scheduleReconnect();
  }

  private fail(error: WorkspaceError): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      detach(socket);
      try {
        socket.close(1000, 'client stopping');
      } catch {
        // ignore
      }
    }
    this.leaseId = null;
    this.handlers.onConnectionState?.('closed', error);
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    const base = this.backoffMs[Math.min(this.attempt, this.backoffMs.length - 1)] ?? 1_000;
    const delay = Math.max(base, this.pendingRetryAfterMs ?? 0);
    this.pendingRetryAfterMs = null;
    this.attempt += 1;
    this.handlers.onConnectionState?.('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open('reconnecting');
    }, delay);
  }

  private armSilenceTimer(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      const socket = this.socket;
      if (!socket) {
        return;
      }
      // Half-open tunnel: the server stopped talking. Drop it and reconnect.
      this.socket = null;
      this.clearLeaseRetry();
      detach(socket);
      try {
        socket.close(4000, 'silent');
      } catch {
        // ignore
      }
      this.scheduleReconnect();
    }, this.silenceTimeoutMs);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearSilenceTimer();
    this.clearLeaseRetry();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private send(frame: Record<string, unknown>): void {
    if (this.socket) {
      this.sendOn(this.socket, frame);
    }
  }

  private sendOn(socket: WorkspaceSocketLike, frame: Record<string, unknown>): void {
    if (socket.readyState !== OPEN) {
      return;
    }
    try {
      socket.send(JSON.stringify(frame));
    } catch (error) {
      console.warn('[WorkspaceEventsClient] Could not send a frame', error);
    }
  }
}

function detach(socket: WorkspaceSocketLike): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
}
