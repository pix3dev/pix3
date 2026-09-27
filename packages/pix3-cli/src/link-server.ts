import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import { CallRelay, parseToolResult, textResult, type ToolCallResult } from './call-relay.ts';
import { readProjectId } from './manifest.ts';
import {
  CALL_TIMEOUT_MS,
  CLAIM_TTL_MS,
  DEFAULT_LINK_PORTS,
  LEASE_TTL_MS,
  LINK_DIR,
  LINK_HOST,
  LINK_PROTOCOL,
  POLL_TIMEOUT_MS,
} from './protocol.ts';
import {
  HttpError,
  isAllowedOrigin,
  isLoopbackHost,
  readBody,
  readJson,
  sendJson,
} from './server/http.ts';
import { CLI_VERSION } from './version.ts';

/**
 * The loopback half of `pix3 mcp`: discovery, the one-folder challenge, the single-window lease,
 * and the long-poll the leased window answers tool calls through
 * (`.plans/external-agent-authoring.md` §1.2).
 *
 * Routes (JSON in, JSON out; errors are `{ error: <code>, message }`):
 *
 *   GET  /hello                → { projectId, sessionId, protocol, cliVersion, agent, pid }
 *   POST /claim                → { file }                      writes <project>/.pix3/link/<name>
 *   POST /claim/confirm        { nonce } → { leaseId, sessionId, leaseTtlMs, pollTimeoutMs }
 *                                          | 409 busy | 403 bad_nonce
 *   POST /claim/takeover       { nonce } → same as confirm, but replaces a live lease
 *   GET  /calls?lease=…        → { calls: [{ id, name, input }] }   long-poll, renews the lease
 *                                          | 409 lease_lost { reason: expired|taken_over|unknown }
 *   POST /calls/:id            { lease, result: { content: [{type:'text',text}], isError? } }
 *                              → { ok: true } | 404 unknown_call | 409 lease_lost
 *
 * Why the challenge proves "same folder": the nonce is only ever written to disk inside THIS
 * process's project directory, and only its file name goes over HTTP. A window whose File System
 * Access handle points at a copy, another checkout or a git worktree (same `projectId`, different
 * directory) looks for the file and does not find it. Every nonce is single-use: it is deleted on
 * the first confirm/takeover, right or wrong outcome, or after `claimTtlMs`.
 *
 * Trust boundary, stated honestly (plan §1.2): browsers are fenced by the `Origin` allowlist (a
 * page cannot forge `Origin`) plus a `Host` check against DNS rebinding; local processes of the
 * same user are trusted — one could run its own server in this folder and pass the challenge,
 * which is why `agent`/`pid` in `/hello` are self-declared and marked unverified.
 */

export interface LinkServerOptions {
  readonly projectDir: string;
  /** Ports tried in order; the first free one wins. Defaults to 8490–8499. `[0]` = OS-assigned (tests). */
  readonly ports?: readonly number[];
  /** Self-declared agent name (argv/env or the MCP client's `clientInfo`); never verified. */
  readonly agent?: () => string | null;
  readonly claimTtlMs?: number;
  readonly leaseTtlMs?: number;
  readonly pollTimeoutMs?: number;
  readonly log?: (line: string) => void;
}

export type LeaseLostReason = 'expired' | 'taken_over' | 'unknown';

/** What `project_status` needs to tell the agent when no window serves it. */
export interface LinkStatus {
  readonly port: number | null;
  readonly sessionId: string;
  readonly projectId: string | null;
  readonly leased: boolean;
  /** Epoch ms of the last `/hello` from a browser origin (a Pix3 window is scanning), or null. */
  readonly lastBrowserHelloAt: number | null;
  /**
   * Epoch ms of the last challenge a window started but could not complete (wrong nonce, or the
   * file was never read) — the signature of a window whose folder is a copy of this one.
   */
  readonly lastFailedClaimAt: number | null;
}

interface Claim {
  readonly nonce: string;
  readonly file: string;
  readonly timer: NodeJS.Timeout;
}

interface Lease {
  readonly leaseId: string;
  lastSeen: number;
}

interface Waiter {
  readonly leaseId: string;
  readonly res: ServerResponse;
  readonly timer: NodeJS.Timeout;
  readonly origin: string | null;
}

/** Outstanding challenges at once; a window needs one, a runaway loop gets 429. */
const MAX_PENDING_CLAIMS = 16;
/** How many ended leases are remembered for {@link LeaseLostReason}. */
const MAX_REMEMBERED_LEASES = 32;

export class LinkServer {
  readonly sessionId = randomUUID();
  readonly projectDir: string;
  private readonly relay = new CallRelay();
  private readonly claims = new Map<string, Claim>();
  /** Leases that ended, so their holder hears why (`taken_over` / `expired`) rather than `unknown`. */
  private readonly endedLeases = new Map<string, 'expired' | 'taken_over'>();
  private readonly options: LinkServerOptions;
  private readonly claimTtlMs: number;
  private readonly leaseTtlMs: number;
  private readonly pollTimeoutMs: number;
  private server: Server | null = null;
  private boundPort: number | null = null;
  private lease: Lease | null = null;
  private waiter: Waiter | null = null;
  private lastBrowserHelloAt: number | null = null;
  private lastFailedClaimAt: number | null = null;

  constructor(options: LinkServerOptions) {
    this.options = options;
    this.projectDir = options.projectDir;
    this.claimTtlMs = options.claimTtlMs ?? CLAIM_TTL_MS;
    this.leaseTtlMs = options.leaseTtlMs ?? LEASE_TTL_MS;
    this.pollTimeoutMs = options.pollTimeoutMs ?? POLL_TIMEOUT_MS;
    this.relay.setParkListener(() => this.flushToWaiter());
  }

  get port(): number | null {
    return this.boundPort;
  }

  /** Bind the first free port of the range on 127.0.0.1. Throws when every port is taken. */
  async start(): Promise<number> {
    const ports = this.options.ports ?? DEFAULT_LINK_PORTS;
    let lastError: unknown = null;
    for (const port of ports) {
      const server = createServer((req, res) => void this.handle(req, res));
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          // Never anything but loopback: not `0.0.0.0`, not `::`, not `localhost` (which may
          // resolve to `::1` only and would then miss the editor's `http://127.0.0.1:…` fetch).
          server.listen(port, LINK_HOST, () => {
            server.off('error', reject);
            resolve();
          });
        });
      } catch (error) {
        lastError = error;
        continue;
      }
      const address = server.address();
      this.server = server;
      this.boundPort = typeof address === 'object' && address ? address.port : port;
      return this.boundPort;
    }
    throw new Error(
      `No free port for the Pix3 link server in ${ports.join(', ')}` +
        (lastError instanceof Error ? ` (${lastError.message})` : '') +
        '. Another `pix3 mcp` per port is running — close one of them.'
    );
  }

  async close(): Promise<void> {
    for (const claim of this.claims.values()) {
      clearTimeout(claim.timer);
      rmSync(claim.file, { force: true });
    }
    this.claims.clear();
    this.relay.cancelAll('The Pix3 link server is shutting down.');
    if (this.waiter) this.answerWaiter([]);
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  status(): LinkStatus {
    return {
      port: this.boundPort,
      sessionId: this.sessionId,
      projectId: readProjectId(this.projectDir),
      leased: this.currentLease() !== null,
      lastBrowserHelloAt: this.lastBrowserHelloAt,
      lastFailedClaimAt: this.lastFailedClaimAt,
    };
  }

  isLeased(): boolean {
    return this.currentLease() !== null;
  }

  /** Forward a tool call to the leased window. Fails fast when no window holds the lease. */
  callEditor(name: string, input: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<ToolCallResult> {
    if (!this.isLeased()) {
      return Promise.resolve(textResult('No Pix3 editor window is connected.', true));
    }
    return this.relay.park(name, input, timeoutMs);
  }

  // ---------------------------------------------------------------------------------------------

  /** The live lease, expiring it lazily: a lease is alive while polled, and `leaseTtlMs` after. */
  private currentLease(): Lease | null {
    const lease = this.lease;
    if (!lease) return null;
    const polling = this.waiter?.leaseId === lease.leaseId;
    if (!polling && Date.now() - lease.lastSeen > this.leaseTtlMs) {
      this.dropLease('expired');
      return null;
    }
    return lease;
  }

  private dropLease(reason: 'expired' | 'taken_over'): void {
    const lease = this.lease;
    if (!lease) return;
    this.options.log?.(`lease ${lease.leaseId.slice(0, 8)} ${reason}`);
    this.lease = null;
    this.rememberEnded(lease.leaseId, reason);
    if (this.waiter?.leaseId === lease.leaseId) {
      const waiter = this.waiter;
      this.clearWaiter();
      this.send(
        waiter.res,
        409,
        { error: 'lease_lost', reason, message: 'Lease lost.' },
        waiter.origin
      );
    }
    // Whatever the old window was handed but never answered goes to the next holder.
    this.relay.requeueDelivered();
  }

  private rememberEnded(leaseId: string, reason: 'expired' | 'taken_over'): void {
    this.endedLeases.set(leaseId, reason);
    if (this.endedLeases.size > MAX_REMEMBERED_LEASES) {
      const oldest = this.endedLeases.keys().next().value;
      if (oldest !== undefined) this.endedLeases.delete(oldest);
    }
  }

  private grantLease(): Lease {
    const lease: Lease = { leaseId: randomUUID(), lastSeen: Date.now() };
    this.lease = lease;
    this.options.log?.(`lease ${lease.leaseId.slice(0, 8)} granted`);
    return lease;
  }

  private requireLease(leaseId: string): Lease {
    const lease = this.currentLease();
    if (lease && lease.leaseId === leaseId) return lease;
    const reason: LeaseLostReason = this.endedLeases.get(leaseId) ?? 'unknown';
    throw new HttpError(409, 'lease_lost', 'This window does not hold the lease.', { reason });
  }

  private clearWaiter(): void {
    if (!this.waiter) return;
    clearTimeout(this.waiter.timer);
    this.waiter = null;
  }

  private answerWaiter(calls: unknown[]): void {
    const waiter = this.waiter;
    if (!waiter) return;
    this.clearWaiter();
    if (this.lease?.leaseId === waiter.leaseId) this.lease.lastSeen = Date.now();
    this.send(waiter.res, 200, { calls }, waiter.origin);
  }

  private flushToWaiter(): void {
    if (this.waiter && this.relay.hasUnflushed()) this.answerWaiter(this.relay.takeUnflushed());
  }

  private createClaim(): string {
    if (this.claims.size >= MAX_PENDING_CLAIMS) {
      throw new HttpError(429, 'too_many_claims', 'Too many pending claims.');
    }
    const name = `claim-${randomBytes(12).toString('hex')}`;
    const relativeFile = `${LINK_DIR}/${name}`;
    const file = join(this.projectDir, ...relativeFile.split('/'));
    const nonce = randomBytes(32).toString('hex');
    mkdirSync(join(this.projectDir, ...LINK_DIR.split('/')), { recursive: true });
    writeFileSync(file, nonce + '\n', { mode: 0o600 });
    const timer = setTimeout(() => {
      if (this.claims.delete(nonce)) {
        rmSync(file, { force: true });
        // Nobody read the file in time: most likely a window whose folder is a copy of this one.
        this.lastFailedClaimAt = Date.now();
      }
    }, this.claimTtlMs);
    timer.unref();
    this.claims.set(nonce, { nonce, file, timer });
    return relativeFile;
  }

  /** Consume a nonce (single use). Throws `bad_nonce` when it is not one we wrote. */
  private consumeNonce(body: Record<string, unknown>): void {
    const nonce = typeof body.nonce === 'string' ? body.nonce.trim() : '';
    const claim = nonce ? this.claims.get(nonce) : undefined;
    if (!claim) {
      this.lastFailedClaimAt = Date.now();
      throw new HttpError(
        403,
        'bad_nonce',
        'Nonce does not match a pending claim — the window has a different folder open, or the claim expired.'
      );
    }
    this.claims.delete(nonce);
    clearTimeout(claim.timer);
    rmSync(claim.file, { force: true });
  }

  private leaseReply(lease: Lease): Record<string, unknown> {
    return {
      leaseId: lease.leaseId,
      sessionId: this.sessionId,
      leaseTtlMs: this.leaseTtlMs,
      pollTimeoutMs: this.pollTimeoutMs,
    };
  }

  // ---------------------------------------------------------------------------------------------

  private send(
    res: ServerResponse,
    status: number,
    body: Record<string, unknown>,
    origin: string | null
  ): void {
    sendJson(res, status, body, origin);
  }

  private hostAllowed(req: IncomingMessage): boolean {
    // DNS rebinding: only literal loopback names, any port (a forwarded port may differ).
    return this.boundPort !== null && isLoopbackHost(req.headers.host);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const originHeader = req.headers.origin;
    const origin = typeof originHeader === 'string' ? originHeader : null;
    try {
      if (!this.hostAllowed(req)) {
        throw new HttpError(403, 'forbidden_host', 'Forbidden host.');
      }
      // A request with no Origin is a local process (curl, tests, another CLI) — trusted by the
      // threat model. A browser always sends Origin on these requests; only ours are answered, and
      // a refused origin gets no CORS headers, so the page cannot even read the 403.
      if (!isAllowedOrigin(origin)) {
        this.options.log?.(`403 origin ${origin}`);
        this.send(res, 403, { error: 'forbidden_origin', message: 'Origin not allowed.' }, null);
        return;
      }
      await this.route(req, res, origin);
    } catch (error) {
      if (error instanceof HttpError) {
        this.send(
          res,
          error.status,
          { error: error.code, message: error.message, ...error.extra },
          error.code === 'forbidden_host' ? null : origin
        );
        return;
      }
      this.options.log?.(`500 ${String(error)}`);
      this.send(res, 500, { error: 'internal', message: 'Internal error.' }, origin);
    }
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    origin: string | null
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') {
      // CORS preflight for `POST` with `Content-Type: application/json` (not a "simple" request).
      //
      // Local Network Access (https://developer.chrome.com/blog/local-network-access): a public
      // HTTPS origin (editor.pix3.dev) fetching 127.0.0.1 is gated by a one-time user PERMISSION
      // prompt in current Chrome, not by server headers — LNA replaced Private Network Access and
      // its `Access-Control-Request-Private-Network` preflight. Nothing here depends on that
      // header; it is echoed only because it costs nothing for a Chrome still in the PNA
      // transition. What the installed PWA's `fetch` needs (e.g. `targetAddressSpace: 'local'`),
      // and whether long-polls survive a backgrounded window, is phase 0 browser work that this
      // server cannot test — if LNA turns out to need a response header, it goes here and in `send`.
      const headers: Record<string, string> = {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Max-Age': '600',
        'Cache-Control': 'no-store',
      };
      if (origin) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Vary'] = 'Origin';
      }
      if (req.headers['access-control-request-private-network'] === 'true') {
        headers['Access-Control-Allow-Private-Network'] = 'true';
      }
      res.writeHead(204, headers);
      res.end();
      return;
    }

    if (method === 'GET' && path === '/hello') {
      if (origin) this.lastBrowserHelloAt = Date.now();
      const agent = this.options.agent?.() ?? null;
      this.send(
        res,
        200,
        {
          projectId: readProjectId(this.projectDir),
          sessionId: this.sessionId,
          protocol: LINK_PROTOCOL,
          cliVersion: CLI_VERSION,
          // Self-declared by the process (argv/env or the MCP client's clientInfo). The editor
          // must label both as unverified.
          agent: agent ? { name: agent, verified: false } : null,
          pid: process.pid,
        },
        origin
      );
      return;
    }

    if (method === 'POST' && path === '/claim') {
      await readBody(req);
      this.send(res, 200, { file: this.createClaim() }, origin);
      return;
    }

    if (method === 'POST' && (path === '/claim/confirm' || path === '/claim/takeover')) {
      const body = await readJson(req);
      this.consumeNonce(body);
      if (path === '/claim/confirm') {
        const live = this.currentLease();
        if (live) {
          throw new HttpError(
            409,
            'busy',
            'Another Pix3 window already serves this agent session.',
            {
              sessionId: this.sessionId,
            }
          );
        }
      } else if (this.currentLease()) {
        this.dropLease('taken_over');
      }
      this.send(res, 200, this.leaseReply(this.grantLease()), origin);
      return;
    }

    if (method === 'GET' && path === '/calls') {
      const lease = this.requireLease(url.searchParams.get('lease') ?? '');
      lease.lastSeen = Date.now();
      // One poll per lease: a newer poll answers the older one empty.
      if (this.waiter) this.answerWaiter([]);
      if (this.relay.hasUnflushed()) {
        this.send(res, 200, { calls: this.relay.takeUnflushed() }, origin);
        return;
      }
      const timer = setTimeout(() => {
        if (this.waiter?.res === res) this.answerWaiter([]);
      }, this.pollTimeoutMs);
      this.waiter = { leaseId: lease.leaseId, res, timer, origin };
      res.on('close', () => {
        if (this.waiter?.res !== res) return;
        // Client went away mid-poll: the lease clock starts from now.
        this.clearWaiter();
        if (this.lease?.leaseId === lease.leaseId) this.lease.lastSeen = Date.now();
      });
      return;
    }

    const callMatch = /^\/calls\/([A-Za-z0-9_-]+)$/.exec(path);
    if (method === 'POST' && callMatch) {
      const body = await readJson(req);
      const lease = this.requireLease(typeof body.lease === 'string' ? body.lease : '');
      lease.lastSeen = Date.now();
      const result = parseToolResult(body.result);
      if (!result) {
        throw new HttpError(
          400,
          'bad_result',
          '`result` must be { content: [{ type: "text", text }], isError? }.'
        );
      }
      if (!this.relay.resolve(callMatch[1], result)) {
        throw new HttpError(404, 'unknown_call', 'No pending call with that id.');
      }
      this.send(res, 200, { ok: true }, origin);
      return;
    }

    throw new HttpError(404, 'not_found', 'Not found.');
  }
}
