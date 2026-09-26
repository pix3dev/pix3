import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, type BigIntStats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { ToolCallResult } from '../call-relay.ts';
import { readProjectId } from '../manifest.ts';
import {
  CALL_TIMEOUT_MS,
  DEFAULT_WORKSPACE_PORTS,
  LINK_HOST,
  WATCH_DEBOUNCE_MS,
  WORKSPACE_PROTOCOL,
  WS_PING_INTERVAL_MS,
} from '../protocol.ts';
import {
  HttpError,
  isAllowedOrigin,
  isLoopbackHost,
  originOf,
  readJson,
  sendJson,
} from '../server/http.ts';
import { CLI_VERSION } from '../version.ts';
import { WorkspaceAuth } from './auth.ts';
import { contentTypeFor } from './content-type.ts';
import { EventHub } from './event-hub.ts';
import {
  parentOf,
  parseWirePath,
  resolveInsideRoot,
  RESERVED_ROOT_DIR,
  type ResolvedPath,
} from './paths.ts';
import { readProjectName } from './project-info.ts';
import {
  applySubtree,
  computeRevision,
  HashCache,
  isExcludedPath,
  mtimeOf,
  scanInto,
  statKeyOf,
  type ChangeEvent,
  type FileEntry,
  type FileTable,
} from './scan.ts';
import { clearServer, readState, recordServer } from './state-file.ts';
import { TreeWatcher } from './watcher.ts';

/**
 * `pix3 serve` — the workspace server (`.plans/external-agent-authoring-remote-ssh.md`, plan
 * §11.1): the Pix3 editor reaches a project folder that lives on another machine (VS Code Remote
 * SSH) through ONE forwarded loopback port, without File System Access.
 *
 * - HTTP `/ws/*`: manifest with hashes of the revision set, byte reads with hash ETags and
 *   ranges, conditional atomic writes, mkdir/delete/move, batch hashing for the sync barrier.
 * - WebSocket `/ws/events`: auth frame first, then `hello`, `change` batches from the watcher,
 *   ping/pong, the single editing lease, and MCP calls relayed to the lease holder.
 *
 * The wire contract is documented in `packages/pix3-cli/README.md`; keep the two in step.
 */

export interface WorkspaceServerOptions {
  /** Canonical (realpath'd) project root. The identity must already exist (`ensureIdentity`). */
  readonly root: string;
  /** Ports tried in order; the first free one wins. `[0]` = OS-assigned (tests). */
  readonly ports?: readonly number[];
  readonly log?: (line: string) => void;
  readonly authTimeoutMs?: number;
  readonly pingIntervalMs?: number;
  readonly leaseGraceMs?: number;
  readonly debounceMs?: number;
  /** How often the state file is re-checked for rotation/revocation. */
  readonly stateCheckIntervalMs?: number;
  /** Failed auth attempts allowed per window before every attempt gets 429. */
  readonly authFailureLimit?: number;
  readonly authFailureWindowMs?: number;
  /** Called once after the server has fully closed (the CLI releases its lock here). */
  readonly onClosed?: () => void;
}

interface MutationOutcome {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface JournalEntry {
  readonly fingerprint: string;
  readonly outcome: Promise<MutationOutcome>;
}

const MAX_PUT_BYTES = 1024 * 1024 * 1024;
/** Files up to this size are read whole, so the ETag is the hash of exactly the bytes sent. */
const WHOLE_READ_BYTES = 8 * 1024 * 1024;
const MAX_JOURNAL = 2_000;
const MAX_HASH_PATHS = 20_000;
const MUTATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Longest a burst of watch events may keep postponing its `change` frame. */
const MAX_DEBOUNCE_WAIT_MS = 1_000;

const CORS_ALLOW_HEADERS =
  'Authorization, Content-Type, If-Match, If-None-Match, X-Mutation-Id, Range';
const CORS_EXPOSE_HEADERS =
  'ETag, Content-Range, Content-Length, Accept-Ranges, X-Mutation-Replayed';

const errnoCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;

/** `"<hex>"` → hex; `W/"x"` is treated like `"x"` (weak comparison is enough for a hash). */
const parseEntityTags = (header: string): string[] =>
  header
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => (part.startsWith('W/') ? part.slice(2) : part))
    .map(part =>
      part.startsWith('"') && part.endsWith('"') && part.length >= 2 ? part.slice(1, -1) : part
    );

const headerValue = (req: IncomingMessage, name: string): string | null => {
  const value = req.headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(', ');
  return null;
};

/** One `bytes=` range; null = serve the whole file (absent, multi-range or unparsable). */
const parseRange = (
  header: string | null,
  size: number
): { start: number; end: number } | 'unsatisfiable' | null => {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) return null;
  if (!startRaw) {
    const suffix = Number(endRaw);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startRaw);
  const end = endRaw ? Math.min(Number(endRaw), size - 1) : size - 1;
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
};

const hashHandle = async (handle: FileHandle): Promise<string> => {
  const hash = createHash('sha256');
  const stream = handle.createReadStream({ start: 0, autoClose: false });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
};

export class WorkspaceServer {
  readonly serverSession = randomUUID();
  readonly root: string;
  readonly workspaceId: string;
  private readonly control = randomBytes(24).toString('base64url');
  private readonly options: WorkspaceServerOptions;
  private readonly log: (line: string) => void;
  private readonly cache = new HashCache();
  private readonly table: FileTable = new Map();
  private readonly journal = new Map<string, JournalEntry>();
  private readonly auth: WorkspaceAuth;
  private readonly hub: EventHub;
  private readonly watcher: TreeWatcher;
  private server: Server | null = null;
  private boundPort: number | null = null;
  private seq = 0;
  private revisionMemo: string | null = null;
  private serialTail: Promise<unknown> = Promise.resolve();
  private dirty = new Set<string>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private firstDirtyAt = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private stateTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: WorkspaceServerOptions) {
    this.options = options;
    this.root = options.root;
    this.log = options.log ?? (() => undefined);
    const state = readState(options.root);
    if (!state) throw new Error(`No workspace identity in ${options.root}/.pix3/workspace.json.`);
    this.workspaceId = state.workspaceId;
    this.auth = new WorkspaceAuth({
      root: options.root,
      workspaceId: state.workspaceId,
      failureLimit: options.authFailureLimit ?? 10,
      failureWindowMs: options.authFailureWindowMs ?? 60_000,
    });
    this.hub = new EventHub({
      auth: this.auth,
      hello: () => this.helloFrame(),
      log: this.log,
      authTimeoutMs: options.authTimeoutMs,
      leaseGraceMs: options.leaseGraceMs,
    });
    this.watcher = new TreeWatcher(options.root, path => this.markDirty(path), this.log);
  }

  get port(): number | null {
    return this.boundPort;
  }

  /** Current revision of the file table (see `computeRevision`). */
  revision(): string {
    this.revisionMemo ??= computeRevision(this.table);
    return this.revisionMemo;
  }

  get currentSeq(): number {
    return this.seq;
  }

  /** Initial scan, bind, start watching, record pid/port. Throws when no port can be bound. */
  async start(): Promise<number> {
    await this.serial(async () => {
      const fresh: FileTable = new Map();
      await scanInto(this.root, '', this.cache, fresh);
      applySubtree(this.table, [''], fresh);
      this.revisionMemo = null;
      this.syncWatcher();
    });
    const ports = this.options.ports ?? DEFAULT_WORKSPACE_PORTS;
    let lastError: unknown = null;
    for (const port of ports) {
      const server = createServer((req, res) => void this.handle(req, res));
      server.on('upgrade', (req, socket, head) => this.hub.handleUpgrade(req, socket, head));
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          // Loopback only — never 0.0.0.0 / :: ; the user reaches it through their SSH forward.
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
      break;
    }
    if (this.server === null || this.boundPort === null) {
      this.watcher.close();
      const busy = errnoCode(lastError) === 'EADDRINUSE';
      throw new Error(
        ports.length === 1
          ? `Port ${ports[0]} on ${LINK_HOST} is ${busy ? 'already in use' : 'not available'}` +
            (lastError instanceof Error && !busy ? ` (${lastError.message})` : '') +
            '. Pick another with --port, or omit --port to take the first free one of 8490–8499.'
          : `No free port for pix3 serve in ${ports[0]}–${ports[ports.length - 1]}.`
      );
    }
    recordServer(this.root, {
      pid: process.pid,
      port: this.boundPort,
      serverSession: this.serverSession,
      control: this.control,
      startedAt: new Date().toISOString(),
    });
    const pingEvery = this.options.pingIntervalMs ?? WS_PING_INTERVAL_MS;
    this.pingTimer = setInterval(() => this.hub.ping(pingEvery), pingEvery);
    this.pingTimer.unref();
    // Rotation (`serve --new-token`) and revocation (file deleted) reach live sockets here.
    this.stateTimer = setInterval(
      () => this.hub.enforceToken(this.auth.current()?.sha256 ?? null),
      this.options.stateCheckIntervalMs ?? 2_000
    );
    this.stateTimer.unref();
    return this.boundPort;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.stateTimer) clearInterval(this.stateTimer);
    this.watcher.close();
    this.hub.close();
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await this.serialTail.catch(() => undefined);
    clearServer(this.root, this.serverSession);
    this.boundPort = null;
    this.options.onClosed?.();
  }

  /** Secret another local `pix3` process reads from `.pix3/workspace.json` to probe `/ws/status`. */
  get controlSecret(): string {
    return this.control;
  }

  // --- MCP relay (in-process API for a later `pix3 mcp --workspace`) ---------------------------

  /** True while a window holds the lease (or it is in its reconnect grace). */
  isLeased(): boolean {
    return this.hub.isLeased();
  }

  /**
   * Deliver a tool call to the lease holder as `{type:'call', id, name, input}` and wait for its
   * `{type:'call-result', id, result}`. Fails fast when no window holds the lease; during the
   * holder's reconnect grace the call waits for the reconnect.
   */
  enqueueCall(
    name: string,
    input: unknown,
    timeoutMs: number = CALL_TIMEOUT_MS
  ): Promise<ToolCallResult> {
    return this.hub.enqueueCall(name, input, timeoutMs);
  }

  // --- Serialisation, table, events ------------------------------------------------------------

  /** Every table mutation (own writes, watcher batches, scans) runs one at a time. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.serialTail.then(work, work);
    this.serialTail = run.catch(() => undefined);
    return run;
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private syncWatcher(): void {
    const dirs: string[] = [];
    for (const [path, entry] of this.table) if (entry.kind === 'dir') dirs.push(path);
    this.watcher.sync(dirs);
  }

  /** Re-scan `prefixes` into the table. Returns what changed (the caller decides whether to tell). */
  private async rescan(prefixes: readonly string[]): Promise<ChangeEvent[]> {
    const fresh: FileTable = new Map();
    for (const prefix of prefixes) await scanInto(this.root, prefix, this.cache, fresh);
    const events = applySubtree(this.table, prefixes, fresh);
    if (events.length > 0) this.revisionMemo = null;
    this.syncWatcher();
    return events;
  }

  private broadcastChange(events: ChangeEvent[]): void {
    if (events.length === 0) return;
    const seq = this.nextSeq();
    this.hub.broadcast({ type: 'change', seq, revision: this.revision(), events });
  }

  private markDirty(path: string): void {
    if (this.closed) return;
    if (path && isExcludedPath(path)) return;
    if (this.dirty.size === 0) this.firstDirtyAt = Date.now();
    this.dirty.add(path);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const debounce = this.options.debounceMs ?? WATCH_DEBOUNCE_MS;
    const waited = Date.now() - this.firstDirtyAt;
    const delay = Math.max(0, Math.min(debounce, MAX_DEBOUNCE_WAIT_MS - waited));
    this.debounceTimer = setTimeout(() => void this.flushDirty(), delay);
  }

  private async flushDirty(): Promise<void> {
    this.debounceTimer = null;
    const paths = [...this.dirty].sort();
    this.dirty = new Set();
    // Keep only the outermost paths: a directory's rescan covers everything under it.
    const prefixes: string[] = [];
    for (const path of paths) {
      if (
        prefixes.some(prefix => prefix === '' || path === prefix || path.startsWith(`${prefix}/`))
      )
        continue;
      prefixes.push(path);
    }
    try {
      await this.serial(async () => {
        if (this.closed) return;
        this.broadcastChange(await this.rescan(prefixes));
      });
    } catch (error) {
      this.log(`rescan failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Record an own write in the table without an event (so the watcher's echo finds nothing new). */
  private recordOwnFile(wirePath: string, stats: BigIntStats, sha256: string): void {
    if (isExcludedPath(wirePath)) return;
    const entry: FileEntry = {
      kind: 'file',
      size: Number(stats.size),
      mtime: mtimeOf(stats),
      statKey: statKeyOf(stats),
      sha256,
    };
    this.cache.remember(wirePath, entry.statKey, sha256);
    this.table.set(wirePath, entry);
    this.revisionMemo = null;
  }

  /** Make sure every ancestor directory of `wirePath` that now exists is in the table. */
  private async recordAncestors(wirePath: string): Promise<void> {
    const parents: string[] = [];
    for (let parent = parentOf(wirePath); parent !== null; parent = parentOf(parent))
      parents.unshift(parent);
    let added = false;
    for (const parent of parents) {
      if (this.table.has(parent) || isExcludedPath(`${parent}/x`)) continue;
      try {
        const stats = await lstat(join(this.root, ...parent.split('/')), { bigint: true });
        if (!stats.isDirectory()) continue;
        this.table.set(parent, {
          kind: 'dir',
          size: 0,
          mtime: mtimeOf(stats),
          statKey: statKeyOf(stats),
        });
        added = true;
      } catch {
        // raced away; the watcher reports it
      }
    }
    if (added) this.syncWatcher();
  }

  // --- Auth ----------------------------------------------------------------------------------------

  private authorize(req: IncomingMessage, allowControl: boolean): void {
    if (allowControl) {
      const control = headerValue(req, 'x-pix3-control');
      if (control && control === this.control) return;
    }
    const header = headerValue(req, 'authorization') ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    const outcome = this.auth.check(match ? match[1] : '');
    if (outcome.ok) return;
    if (outcome.code === 'rate_limited') {
      throw new HttpError(
        429,
        'rate_limited',
        `Too many failed attempts; retry in ${outcome.retryAfter} s.`,
        { retryAfter: outcome.retryAfter }
      );
    }
    throw new HttpError(
      401,
      'unauthorized',
      'Missing, wrong or revoked token (Authorization: Bearer <token>).'
    );
  }

  private helloFrame(): Record<string, unknown> {
    return {
      type: 'hello',
      workspaceId: this.workspaceId,
      serverSession: this.serverSession,
      protocol: WORKSPACE_PROTOCOL,
      cliVersion: CLI_VERSION,
      revision: this.revision(),
      seq: this.seq,
      root: this.root,
      projectId: readProjectId(this.root),
      projectName: readProjectName(this.root),
      lease: this.hub.leaseState,
    };
  }

  // --- HTTP ----------------------------------------------------------------------------------------

  private corsHeaders(origin: string | null): Record<string, string> {
    return origin
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Expose-Headers': CORS_EXPOSE_HEADERS,
          Vary: 'Origin',
        }
      : {};
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = originOf(req);
    try {
      if (!isLoopbackHost(req.headers.host)) {
        sendJson(res, 403, { error: 'forbidden_host', message: 'Forbidden host.' }, null);
        return;
      }
      if (!isAllowedOrigin(origin)) {
        this.log(`403 origin ${origin}`);
        sendJson(res, 403, { error: 'forbidden_origin', message: 'Origin not allowed.' }, null);
        return;
      }
      if (req.method === 'OPTIONS') {
        this.preflight(req, res, origin);
        return;
      }
      await this.route(req, res, origin);
    } catch (error) {
      if (!(error instanceof HttpError)) {
        this.log(
          `500 ${req.method} ${req.url}: ${error instanceof Error ? error.stack : String(error)}`
        );
      }
      const outcome = this.errorOutcome(error);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const extra: Record<string, string> = this.corsHeaders(origin);
      if (outcome.status === 401) extra['WWW-Authenticate'] = 'Bearer';
      if (outcome.status === 429 && typeof outcome.body.retryAfter === 'number') {
        extra['Retry-After'] = String(outcome.body.retryAfter);
      }
      // Drain what the client is still sending, so it reads our answer instead of EPIPE.
      req.resume();
      sendJson(res, outcome.status, outcome.body, null, extra);
    }
  }

  private errorOutcome(error: unknown): MutationOutcome {
    if (error instanceof HttpError) {
      return {
        status: error.status,
        body: { error: error.code, message: error.message, ...error.extra },
      };
    }
    return { status: 500, body: { error: 'internal', message: 'Internal error.' } };
  }

  private preflight(req: IncomingMessage, res: ServerResponse, origin: string | null): void {
    const headers: Record<string, string> = {
      'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
      'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store',
      ...this.corsHeaders(origin),
    };
    // Chrome's Local Network Access replaced PNA's preflight header; echoing it is harmless.
    if (req.headers['access-control-request-private-network'] === 'true') {
      headers['Access-Control-Allow-Private-Network'] = 'true';
    }
    res.writeHead(204, headers);
    res.end();
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    origin: string | null
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/ws/status') {
      this.authorize(req, true);
      sendJson(res, 200, this.statusBody(), origin, this.corsHeaders(origin));
      return;
    }
    this.authorize(req, false);

    if ((method === 'GET' || method === 'HEAD') && path === '/ws/file') {
      await this.readFile(req, res, url, origin, method === 'HEAD');
      return;
    }
    if (method === 'GET' && path === '/ws/manifest') {
      const body = await this.manifest();
      sendJson(res, 200, body, origin, this.corsHeaders(origin));
      return;
    }
    if (method === 'POST' && path === '/ws/hash') {
      const body = await readJson(req);
      sendJson(res, 200, await this.hashPaths(body), origin, this.corsHeaders(origin));
      return;
    }
    if (method === 'PUT' && path === '/ws/file') {
      await this.writeFile(req, res, url, origin);
      return;
    }
    if (
      method === 'POST' &&
      (path === '/ws/mkdir' || path === '/ws/delete' || path === '/ws/move')
    ) {
      const body = await readJson(req);
      await this.jsonMutation(
        req,
        res,
        origin,
        path.slice('/ws/'.length) as 'mkdir' | 'delete' | 'move',
        body
      );
      return;
    }
    throw new HttpError(404, 'not_found', 'Not found.');
  }

  private statusBody(): Record<string, unknown> {
    return {
      workspaceId: this.workspaceId,
      serverSession: this.serverSession,
      protocol: WORKSPACE_PROTOCOL,
      cliVersion: CLI_VERSION,
      root: this.root,
      pid: process.pid,
      port: this.boundPort,
      revision: this.revision(),
      seq: this.seq,
      leased: this.hub.isLeased(),
    };
  }

  private async manifest(): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      // A full scan, not the watcher's view: the manifest is what reconciles missed events.
      this.broadcastChange(await this.rescan(['']));
      const files = [...this.table.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, entry]) => ({
          path,
          kind: entry.kind,
          size: entry.size,
          mtime: entry.mtime,
          ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
        }));
      return {
        workspaceId: this.workspaceId,
        serverSession: this.serverSession,
        revision: this.revision(),
        seq: this.seq,
        files,
      };
    });
  }

  private async hashPaths(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const raw = body.paths;
    if (!Array.isArray(raw))
      throw new HttpError(400, 'bad_request', '`paths` must be an array of strings.');
    if (raw.length > MAX_HASH_PATHS)
      throw new HttpError(413, 'too_many_paths', `At most ${MAX_HASH_PATHS} paths.`);
    const paths = raw.map((value, index) => parseWirePath(value, `paths[${index}]`));
    const hashes: Record<string, string | null> = {};
    for (const wirePath of paths) {
      let resolved: ResolvedPath;
      try {
        resolved = await resolveInsideRoot(this.root, wirePath, { allowMissing: true });
      } catch (error) {
        if (error instanceof HttpError && error.code === 'not_a_directory') {
          hashes[wirePath] = null;
          continue;
        }
        throw error;
      }
      if (resolved.kind !== 'file') {
        hashes[wirePath] = null;
        continue;
      }
      try {
        const stats = await lstat(resolved.absolute, { bigint: true });
        hashes[wirePath] = await this.cache.hash(wirePath, resolved.absolute, stats);
      } catch (error) {
        if (errnoCode(error) !== 'ENOENT') throw error;
        hashes[wirePath] = null;
      }
    }
    return { hashes, seq: this.seq };
  }

  private async readFile(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    origin: string | null,
    headOnly: boolean
  ): Promise<void> {
    const wirePath = parseWirePath(url.searchParams.get('path') ?? '');
    const resolved = await resolveInsideRoot(this.root, wirePath, { allowMissing: false });
    if (resolved.kind !== 'file')
      throw new HttpError(400, 'not_a_file', `${wirePath} is not a file.`);
    const handle = await open(resolved.absolute, 'r');
    let handedOff = false;
    try {
      const stats = await handle.stat({ bigint: true });
      const size = Number(stats.size);
      let whole: Buffer | null = null;
      let sha256: string;
      if (size <= WHOLE_READ_BYTES) {
        whole = await handle.readFile();
        sha256 = createHash('sha256').update(whole).digest('hex');
        this.cache.remember(wirePath, statKeyOf(stats), sha256);
      } else {
        const key = statKeyOf(stats);
        sha256 = this.cachedHash(wirePath, key) ?? (await hashHandle(handle));
        this.cache.remember(wirePath, key, sha256);
      }
      const etag = `"${sha256}"`;
      const base: Record<string, string> = {
        ETag: etag,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-cache',
        'X-Content-Type-Options': 'nosniff',
        ...this.corsHeaders(origin),
      };
      const ifNoneMatch = headerValue(req, 'if-none-match');
      if (ifNoneMatch && parseEntityTags(ifNoneMatch).some(tag => tag === '*' || tag === sha256)) {
        res.writeHead(304, base);
        res.end();
        return;
      }
      const range = parseRange(headerValue(req, 'range'), size);
      if (range === 'unsatisfiable') {
        res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      const start = range ? range.start : 0;
      const end = range ? range.end : size - 1;
      const length = size === 0 ? 0 : end - start + 1;
      const headers: Record<string, string> = {
        ...base,
        'Content-Type': contentTypeFor(wirePath),
        'Content-Length': String(length),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      };
      res.writeHead(range ? 206 : 200, headers);
      if (headOnly || length === 0) {
        res.end();
        return;
      }
      if (whole) {
        res.end(range ? whole.subarray(start, end + 1) : whole);
        return;
      }
      handedOff = true;
      const stream = handle.createReadStream({ start, end, autoClose: true });
      await pipeline(stream, res).catch(() => undefined);
    } finally {
      if (!handedOff) await handle.close();
    }
  }

  private cachedHash(wirePath: string, key: string): string | null {
    const entry = this.table.get(wirePath);
    return entry && entry.statKey === key && entry.sha256 ? entry.sha256 : null;
  }

  // --- Mutations -----------------------------------------------------------------------------------

  private mutationId(req: IncomingMessage): string | null {
    const id = headerValue(req, 'x-mutation-id');
    if (id === null) return null;
    if (!MUTATION_ID_PATTERN.test(id)) {
      throw new HttpError(
        400,
        'bad_mutation_id',
        'X-Mutation-Id must be 1–128 chars of [A-Za-z0-9_.:-].'
      );
    }
    return id;
  }

  /**
   * Run `work` at most once per mutation id in this server session. A retry of an id already
   * applied (or still in flight) gets the recorded answer and `X-Mutation-Replayed: true`, and
   * `work` does not run again — the rule that keeps a lost response from deleting or moving twice.
   * Reusing an id for a different request is refused (422), not silently replayed.
   */
  private async journaled(
    req: IncomingMessage,
    res: ServerResponse,
    origin: string | null,
    fingerprint: string,
    work: () => Promise<MutationOutcome>
  ): Promise<void> {
    const id = this.mutationId(req);
    const known = id ? this.journal.get(id) : undefined;
    if (id && known) {
      req.resume();
      if (known.fingerprint !== fingerprint) {
        throw new HttpError(
          422,
          'mutation_id_reused',
          'That X-Mutation-Id was used for a different request.'
        );
      }
      const outcome = await known.outcome;
      sendJson(res, outcome.status, outcome.body, null, {
        ...this.corsHeaders(origin),
        'X-Mutation-Replayed': 'true',
      });
      return;
    }
    const outcome = work().catch((error: unknown) => {
      if (!(error instanceof HttpError))
        this.log(`mutation failed: ${error instanceof Error ? error.stack : String(error)}`);
      return this.errorOutcome(error);
    });
    if (id) {
      this.journal.set(id, { fingerprint, outcome });
      if (this.journal.size > MAX_JOURNAL) {
        const oldest = this.journal.keys().next().value;
        if (oldest !== undefined) this.journal.delete(oldest);
      }
    }
    const result = await outcome;
    req.resume();
    sendJson(res, result.status, result.body, null, this.corsHeaders(origin));
  }

  private async currentHashOf(wirePath: string, absolute: string): Promise<string | null> {
    try {
      const stats = await lstat(absolute, { bigint: true });
      if (!stats.isFile()) return null;
      return await this.cache.hash(wirePath, absolute, stats);
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return null;
      throw error;
    }
  }

  private async writeFile(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    origin: string | null
  ): Promise<void> {
    const wirePath = parseWirePath(url.searchParams.get('path') ?? '');
    const ifMatchRaw = headerValue(req, 'if-match');
    const ifNoneMatchRaw = headerValue(req, 'if-none-match');
    const ifMatch = ifMatchRaw ? parseEntityTags(ifMatchRaw) : null;
    const createOnly = ifNoneMatchRaw !== null && parseEntityTags(ifNoneMatchRaw).includes('*');
    const fingerprint = `put\n${wirePath}\n${ifMatchRaw ?? ''}\n${ifNoneMatchRaw ?? ''}`;
    await this.journaled(req, res, origin, fingerprint, () =>
      this.performPut(req, wirePath, ifMatch, createOnly)
    );
  }

  private async performPut(
    req: IncomingMessage,
    wirePath: string,
    ifMatch: string[] | null,
    createOnly: boolean
  ): Promise<MutationOutcome> {
    const declared = Number(headerValue(req, 'content-length') ?? '0');
    if (declared > MAX_PUT_BYTES) throw new HttpError(413, 'too_large', 'File too large.');
    // Validate the target before accepting a body (parents too — a symlinked parent is refused).
    await resolveInsideRoot(this.root, wirePath, { allowMissing: true });
    const tempDir = join(this.root, RESERVED_ROOT_DIR, 'tmp');
    await mkdir(tempDir, { recursive: true, mode: 0o700 });
    const temp = join(tempDir, `put-${randomBytes(8).toString('hex')}`);
    let tempLive = true;
    try {
      const { sha256, size } = await this.streamBodyTo(req, temp);
      return await this.serial(async () => {
        const resolved = await resolveInsideRoot(this.root, wirePath, { allowMissing: true });
        if (resolved.kind === 'dir' || resolved.kind === 'other') {
          throw new HttpError(409, 'not_a_file', `${wirePath} exists and is not a file.`);
        }
        const currentHash =
          resolved.kind === 'file' ? await this.currentHashOf(wirePath, resolved.absolute) : null;
        if (createOnly && currentHash !== null) {
          throw new HttpError(409, 'exists', `${wirePath} already exists.`, { currentHash });
        }
        if (ifMatch && !ifMatch.includes('*') && !ifMatch.includes(currentHash ?? '')) {
          throw new HttpError(
            409,
            'base_mismatch',
            `${wirePath} changed since the base you edited.`,
            { currentHash }
          );
        }
        if (ifMatch && ifMatch.includes('*') && currentHash === null) {
          throw new HttpError(409, 'base_mismatch', `${wirePath} does not exist.`, {
            currentHash: null,
          });
        }
        const parent = dirname(resolved.absolute);
        await mkdir(parent, { recursive: true });
        if (resolved.kind === 'file') {
          const previous = await stat(resolved.absolute);
          await chmod(temp, previous.mode & 0o7777);
        }
        await this.renameIntoPlace(temp, resolved.absolute);
        tempLive = false;
        const stats = await lstat(resolved.absolute, { bigint: true });
        await this.recordAncestors(wirePath);
        this.recordOwnFile(wirePath, stats, sha256);
        const seq = this.nextSeq();
        return { status: 200, body: { path: wirePath, sha256, size, mtime: mtimeOf(stats), seq } };
      });
    } finally {
      if (tempLive) await rm(temp, { force: true });
    }
  }

  private async renameIntoPlace(temp: string, target: string): Promise<void> {
    try {
      await rename(temp, target);
    } catch (error) {
      if (errnoCode(error) !== 'EXDEV') throw error;
      // `.pix3/tmp` is on another device than the target: stage next to it instead.
      const sibling = join(
        dirname(target),
        `.${basename(target)}.pix3-tmp-${randomBytes(6).toString('hex')}`
      );
      const source = await open(temp, 'r');
      try {
        await pipeline(source.createReadStream(), createWriteStream(sibling, { flags: 'wx' }));
      } finally {
        await source.close().catch(() => undefined);
      }
      await rename(sibling, target);
      await rm(temp, { force: true });
    }
  }

  private async streamBodyTo(
    req: IncomingMessage,
    temp: string
  ): Promise<{ sha256: string; size: number }> {
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > MAX_PUT_BYTES) {
          callback(new HttpError(413, 'too_large', 'File too large.'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(req, meter, createWriteStream(temp, { flags: 'wx' }));
    return { sha256: hash.digest('hex'), size };
  }

  private async jsonMutation(
    req: IncomingMessage,
    res: ServerResponse,
    origin: string | null,
    op: 'mkdir' | 'delete' | 'move',
    body: Record<string, unknown>
  ): Promise<void> {
    if (op === 'mkdir') {
      const wirePath = parseWirePath(body.path);
      await this.journaled(req, res, origin, `mkdir\n${wirePath}`, () =>
        this.serial(() => this.performMkdir(wirePath))
      );
      return;
    }
    if (op === 'delete') {
      const wirePath = parseWirePath(body.path);
      const recursive = body.recursive === true;
      await this.journaled(req, res, origin, `delete\n${wirePath}\n${recursive}`, () =>
        this.serial(() => this.performDelete(wirePath, recursive))
      );
      return;
    }
    const from = parseWirePath(body.from, 'from');
    const to = parseWirePath(body.to, 'to');
    const overwrite = body.overwrite === true;
    await this.journaled(req, res, origin, `move\n${from}\n${to}\n${overwrite}`, () =>
      this.serial(() => this.performMove(from, to, overwrite))
    );
  }

  private async performMkdir(wirePath: string): Promise<MutationOutcome> {
    const resolved = await resolveInsideRoot(this.root, wirePath, { allowMissing: true });
    if (resolved.kind === 'dir')
      return { status: 200, body: { path: wirePath, created: false, seq: this.seq } };
    if (resolved.kind !== null)
      throw new HttpError(409, 'exists', `${wirePath} exists and is not a directory.`);
    await mkdir(resolved.absolute, { recursive: true });
    await this.rescan([this.topmostNew(wirePath)]);
    return { status: 200, body: { path: wirePath, created: true, seq: this.nextSeq() } };
  }

  /** The outermost ancestor (or the path itself) the table did not know — what an own write created. */
  private topmostNew(wirePath: string): string {
    let top = wirePath;
    for (let parent = parentOf(wirePath); parent !== null; parent = parentOf(parent)) {
      if (this.table.has(parent)) break;
      top = parent;
    }
    return top;
  }

  private async performDelete(wirePath: string, recursive: boolean): Promise<MutationOutcome> {
    const resolved = await resolveInsideRoot(this.root, wirePath, { allowMissing: false });
    if (resolved.kind === 'dir') {
      if (recursive) {
        await rm(resolved.absolute, { recursive: true });
      } else {
        try {
          await rmdir(resolved.absolute);
        } catch (error) {
          if (errnoCode(error) === 'ENOTEMPTY' || errnoCode(error) === 'EEXIST') {
            throw new HttpError(
              409,
              'not_empty',
              `${wirePath} is not empty; pass recursive: true.`
            );
          }
          throw error;
        }
      }
    } else {
      await unlink(resolved.absolute);
    }
    await this.rescan([wirePath]);
    return {
      status: 200,
      body: { path: wirePath, kind: resolved.kind === 'dir' ? 'dir' : 'file', seq: this.nextSeq() },
    };
  }

  private async performMove(
    from: string,
    to: string,
    overwrite: boolean
  ): Promise<MutationOutcome> {
    if (to === from || to.startsWith(`${from}/`)) {
      throw new HttpError(400, 'bad_move', '`to` must not be `from` or inside it.');
    }
    const source = await resolveInsideRoot(this.root, from, { allowMissing: false });
    const target = await resolveInsideRoot(this.root, to, { allowMissing: true });
    if (target.kind !== null) {
      if (!overwrite) throw new HttpError(409, 'exists', `${to} already exists.`);
      if (target.kind === 'dir' || source.kind === 'dir') {
        throw new HttpError(409, 'exists', `${to} exists; only a file may overwrite a file.`);
      }
    }
    await mkdir(dirname(target.absolute), { recursive: true });
    // rename keeps ino/size/mtime, so seed the hash cache with the new paths: no re-hashing.
    for (const [path, entry] of this.table) {
      if ((path === from || path.startsWith(`${from}/`)) && entry.sha256) {
        this.cache.remember(to + path.slice(from.length), entry.statKey, entry.sha256);
      }
    }
    await rename(source.absolute, target.absolute);
    await this.rescan([from, this.topmostNew(to)]);
    const moved = this.table.get(to);
    return {
      status: 200,
      body: {
        from,
        to,
        kind: source.kind === 'dir' ? 'dir' : 'file',
        ...(moved?.sha256 ? { sha256: moved.sha256 } : {}),
        seq: this.nextSeq(),
      },
    };
  }
}
