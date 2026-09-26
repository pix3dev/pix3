import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import { CallRelay, parseToolResult, relayFailure, type ToolCallResult } from '../call-relay.ts';
import { CALL_TIMEOUT_MS, WS_AUTH_TIMEOUT_MS, WS_LEASE_GRACE_MS } from '../protocol.ts';
import { isAllowedOrigin, isLoopbackHost, isRecord, originOf } from '../server/http.ts';
import type { WorkspaceAuth } from './auth.ts';

/**
 * `/ws/events` — the workspace server's one WebSocket: auth frame, hello, change broadcast,
 * ping/pong, the single editing lease, and MCP calls relayed to the lease holder.
 *
 * Kept apart from the file routes so a later `pix3 mcp --workspace` can drive the same lease and
 * relay (`enqueueCall`) without knowing anything about HTTP. Frames are documented in
 * `packages/pix3-cli/README.md`.
 */

export type Frame = Record<string, unknown>;

export interface EventHubOptions {
  readonly auth: WorkspaceAuth;
  /** Built fresh for every authenticated socket (revision/seq/lease move). */
  readonly hello: () => Frame;
  readonly log: (line: string) => void;
  readonly authTimeoutMs?: number;
  readonly leaseGraceMs?: number;
}

interface Client {
  readonly socket: WebSocket;
  authed: boolean;
  /** Hash of the token this socket authenticated with — revoked when it stops being current. */
  tokenHash: string | null;
  lastSeen: number;
  authTimer: NodeJS.Timeout | null;
}

interface Lease {
  readonly leaseId: string;
  /** `null` while in grace after the holder's socket closed. */
  client: Client | null;
  graceTimer: NodeJS.Timeout | null;
}

type LeaseLostReason = 'taken_over' | 'expired' | 'revoked';

/** Close codes (4000–4999 is the application range). */
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_RATE_LIMITED = 4429;
const CLOSE_UNSUPPORTED = 1003;
const CLOSE_GOING_AWAY = 1001;

/** Big enough for a call result carrying a screenshot as text. */
const WS_MAX_PAYLOAD = 64 * 1024 * 1024;

export class EventHub {
  private readonly options: EventHubOptions;
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: WS_MAX_PAYLOAD,
    perMessageDeflate: false,
  });
  private readonly clients = new Set<Client>();
  private readonly relay = new CallRelay();
  private lease: Lease | null = null;
  private closed = false;

  constructor(options: EventHubOptions) {
    this.options = options;
    this.relay.setParkListener(() => this.flushCalls());
  }

  /** `upgrade` handler of the HTTP server. Same Host/Origin fence as the HTTP routes. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const reject = (status: number, text: string): void => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!isLoopbackHost(req.headers.host)) return reject(403, 'Forbidden');
    // CORS does not cover WebSockets: without this check any web page could open one.
    if (!isAllowedOrigin(originOf(req))) return reject(403, 'Forbidden');
    if (url.pathname !== '/ws/events') return reject(404, 'Not Found');
    if (this.closed) return reject(503, 'Service Unavailable');
    this.wss.handleUpgrade(req, socket, head, ws => this.onSocket(ws));
  }

  /** Send to every authenticated socket. */
  broadcast(frame: Frame): void {
    const text = JSON.stringify(frame);
    for (const client of this.clients) {
      if (client.authed && client.socket.readyState === client.socket.OPEN) {
        client.socket.send(text);
      }
    }
  }

  get leaseState(): 'held' | 'free' {
    return this.lease ? 'held' : 'free';
  }

  /** True while a window holds the lease (or it is in its reconnect grace). */
  isLeased(): boolean {
    return this.lease !== null;
  }

  /**
   * Deliver a tool call to the lease holder as `{type:'call', id, name, input}` and wait for its
   * `{type:'call-result', id, result}`. Fails fast when no window holds the lease; during the
   * holder's reconnect grace the call waits for the reconnect.
   */
  enqueueCall(
    name: string,
    input: unknown,
    timeoutMs: number = CALL_TIMEOUT_MS,
    extra?: Record<string, unknown>
  ): Promise<ToolCallResult> {
    if (!this.lease) {
      return Promise.resolve(
        relayFailure('no_editor', 'No Pix3 editor window holds this workspace.')
      );
    }
    return this.relay.park(name, input, timeoutMs, extra);
  }

  /** `connected`: a live socket holds the lease; `grace`: its holder is gone but may come back. */
  get holderState(): 'connected' | 'grace' | null {
    if (!this.lease) return null;
    return this.lease.client ? 'connected' : 'grace';
  }

  /** Ping every authenticated socket; terminate the ones silent for three intervals. */
  ping(interval: number): void {
    const now = Date.now();
    for (const client of this.clients) {
      if (!client.authed) continue;
      if (now - client.lastSeen > interval * 3) {
        client.socket.terminate();
        continue;
      }
      this.send(client, { type: 'ping' });
    }
  }

  /** Close every socket whose token is no longer the current one (rotation / revocation). */
  enforceToken(currentHash: string | null): void {
    for (const client of this.clients) {
      if (!client.authed || client.tokenHash === currentHash) continue;
      if (this.lease?.client === client) this.endLease('revoked', { requeue: false });
      this.closeClient(
        client,
        CLOSE_UNAUTHORIZED,
        'revoked',
        'The pairing token was rotated or revoked.'
      );
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.lease?.graceTimer) clearTimeout(this.lease.graceTimer);
    this.lease = null;
    this.relay.cancelAll('The Pix3 workspace server is shutting down.');
    for (const client of this.clients) {
      if (client.authTimer) clearTimeout(client.authTimer);
      client.socket.close(CLOSE_GOING_AWAY, 'server shutting down');
      client.socket.terminate();
    }
    this.clients.clear();
    this.wss.close();
  }

  // ---------------------------------------------------------------------------------------------

  private onSocket(socket: WebSocket): void {
    const client: Client = {
      socket,
      authed: false,
      tokenHash: null,
      lastSeen: Date.now(),
      authTimer: null,
    };
    this.clients.add(client);
    client.authTimer = setTimeout(() => {
      if (!client.authed) {
        this.closeClient(client, CLOSE_UNAUTHORIZED, 'auth_timeout', 'No auth frame in time.');
      }
    }, this.options.authTimeoutMs ?? WS_AUTH_TIMEOUT_MS);
    socket.on('message', (data: RawData, isBinary: boolean) =>
      this.onFrame(client, data, isBinary)
    );
    socket.on('close', () => this.onSocketClosed(client));
    socket.on('error', () => socket.terminate());
  }

  private send(client: Client, frame: Frame): void {
    if (client.socket.readyState === client.socket.OPEN) client.socket.send(JSON.stringify(frame));
  }

  private error(client: Client, error: string, message: string, extra: Frame = {}): void {
    this.send(client, { type: 'error', error, message, ...extra });
  }

  private closeClient(client: Client, code: number, error: string, message: string): void {
    this.error(client, error, message);
    client.socket.close(code, error);
  }

  private onFrame(client: Client, data: RawData, isBinary: boolean): void {
    client.lastSeen = Date.now();
    if (isBinary) {
      this.closeClient(client, CLOSE_UNSUPPORTED, 'bad_frame', 'Frames are JSON text.');
      return;
    }
    let frame: Frame;
    try {
      const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : data.toString();
      const parsed = JSON.parse(text) as unknown;
      if (!isRecord(parsed)) throw new Error('not an object');
      frame = parsed;
    } catch {
      if (!client.authed) {
        this.closeClient(
          client,
          CLOSE_UNAUTHORIZED,
          'unauthorized',
          'The first frame must be JSON.'
        );
      } else {
        this.error(client, 'bad_frame', 'Frames are JSON objects.');
      }
      return;
    }
    if (!client.authed) {
      this.onAuthFrame(client, frame);
      return;
    }
    switch (frame.type) {
      case 'ping':
        this.send(client, { type: 'pong' });
        return;
      case 'pong':
        return;
      case 'lease':
        this.onLeaseFrame(client, frame);
        return;
      case 'call-result':
        this.onCallResult(client, frame);
        return;
      default:
        this.error(client, 'unknown_frame', 'Unknown frame type.');
    }
  }

  private onAuthFrame(client: Client, frame: Frame): void {
    if (frame.type !== 'auth' || typeof frame.token !== 'string') {
      this.closeClient(
        client,
        CLOSE_UNAUTHORIZED,
        'unauthorized',
        'The first frame must be {type:"auth", token}.'
      );
      return;
    }
    const outcome = this.options.auth.check(frame.token);
    if (!outcome.ok) {
      if (outcome.code === 'rate_limited') {
        this.closeClient(
          client,
          CLOSE_RATE_LIMITED,
          'rate_limited',
          `Too many failed attempts; retry in ${outcome.retryAfter} s.`
        );
      } else {
        this.closeClient(client, CLOSE_UNAUTHORIZED, 'unauthorized', 'Wrong or revoked token.');
      }
      return;
    }
    client.authed = true;
    client.tokenHash = outcome.tokenHash;
    if (client.authTimer) clearTimeout(client.authTimer);
    client.authTimer = null;
    this.send(client, this.options.hello());
  }

  private granted(client: Client, lease: Lease, resumed: boolean): void {
    this.send(client, { type: 'lease', state: 'granted', leaseId: lease.leaseId, resumed });
  }

  private onLeaseFrame(client: Client, frame: Frame): void {
    const action = frame.action;
    const lease = this.lease;
    if (action === 'acquire') {
      if (!lease) {
        this.grantLease(client);
      } else if (lease.client === client) {
        this.granted(client, lease, false);
      } else if (
        lease.client === null &&
        typeof frame.leaseId === 'string' &&
        frame.leaseId === lease.leaseId
      ) {
        // The holder reconnected within grace: same lease; what it was handed goes out again.
        if (lease.graceTimer) clearTimeout(lease.graceTimer);
        lease.graceTimer = null;
        lease.client = client;
        this.options.log(`lease ${lease.leaseId.slice(0, 8)} resumed`);
        this.granted(client, lease, true);
        this.relay.requeueDelivered();
        this.flushCalls();
      } else {
        this.send(client, { type: 'lease', state: 'busy', inGrace: lease.client === null });
      }
      return;
    }
    if (action === 'takeover') {
      if (lease && lease.client === client) {
        this.granted(client, lease, false);
        return;
      }
      if (lease) this.endLease('taken_over', { requeue: true });
      this.grantLease(client);
      return;
    }
    if (action === 'release') {
      if (lease && lease.client === client) {
        this.lease = null;
        this.options.log(`lease ${lease.leaseId.slice(0, 8)} released`);
        this.relay.cancelAll('The Pix3 editor window released the workspace.');
      }
      this.send(client, { type: 'lease', state: 'released' });
      return;
    }
    this.error(client, 'bad_frame', 'lease.action must be acquire, release or takeover.');
  }

  private grantLease(client: Client): void {
    const lease: Lease = { leaseId: randomUUID(), client, graceTimer: null };
    this.lease = lease;
    this.options.log(`lease ${lease.leaseId.slice(0, 8)} granted`);
    this.granted(client, lease, false);
    this.flushCalls();
  }

  /**
   * End the current lease. `requeue` hands undelivered/unanswered calls to the next holder
   * (takeover); otherwise they fail at once, since nobody is left to answer them.
   */
  private endLease(reason: LeaseLostReason, options: { readonly requeue: boolean }): void {
    const lease = this.lease;
    if (!lease) return;
    this.lease = null;
    if (lease.graceTimer) clearTimeout(lease.graceTimer);
    this.options.log(`lease ${lease.leaseId.slice(0, 8)} ${reason}`);
    if (lease.client) {
      this.send(lease.client, { type: 'lease', state: 'lost', reason, leaseId: lease.leaseId });
    }
    if (options.requeue) this.relay.requeueDelivered();
    else this.relay.cancelAll(`The Pix3 editor window lost the workspace lease (${reason}).`);
  }

  private onSocketClosed(client: Client): void {
    if (client.authTimer) clearTimeout(client.authTimer);
    this.clients.delete(client);
    const lease = this.lease;
    if (!lease || lease.client !== client || this.closed) return;
    lease.client = null;
    lease.graceTimer = setTimeout(() => {
      if (this.lease === lease && lease.client === null) {
        this.endLease('expired', { requeue: false });
      }
    }, this.options.leaseGraceMs ?? WS_LEASE_GRACE_MS);
    lease.graceTimer.unref();
  }

  private flushCalls(): void {
    const holder = this.lease?.client;
    if (!holder || holder.socket.readyState !== holder.socket.OPEN) return;
    for (const call of this.relay.takeUnflushed()) {
      this.send(holder, {
        ...call.extra,
        type: 'call',
        id: call.id,
        name: call.name,
        input: call.input,
      });
    }
  }

  private onCallResult(client: Client, frame: Frame): void {
    const id = frame.id ?? null;
    if (this.lease?.client !== client) {
      this.error(client, 'not_lease_holder', 'Only the lease holder answers calls.', { id });
      return;
    }
    const result = parseToolResult(frame.result);
    if (typeof frame.id !== 'string' || !result) {
      this.error(
        client,
        'bad_result',
        'call-result needs { id, result: { content: [{ type: "text", text }], isError? } }.',
        { id }
      );
      return;
    }
    if (!this.relay.resolve(frame.id, result)) {
      this.error(client, 'unknown_call', 'No pending call with that id.', { id });
    }
  }
}
