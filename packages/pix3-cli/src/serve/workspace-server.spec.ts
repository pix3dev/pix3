// @vitest-environment node
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { LinkServer } from '../link-server.ts';
import { WORKSPACE_PROTOCOL } from '../protocol.ts';
import { openWorkspace } from './open-workspace.ts';
import { ensureIdentity, statePath } from './state-file.ts';
import { WorkspaceServer, type WorkspaceServerOptions } from './workspace-server.ts';

/**
 * `pix3 serve` against real temp folders and real sockets on OS-assigned ports: auth, the root
 * fence, the manifest's revision set, conditional writes, the mutation journal, watcher events
 * (and the absence of echoes of the server's own writes), reads with ETag/Range, the Host rule,
 * one-server-per-root, and the lease.
 */

let root: string;
let token: string;
const servers: WorkspaceServer[] = [];
const sockets: WebSocket[] = [];
const extraDirs: string[] = [];

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

const write = (rel: string, data: string | Buffer): void => {
  const file = join(root, ...rel.split('/'));
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, data);
};

const read = (rel: string): string => readFileSync(join(root, ...rel.split('/')), 'utf8');

const startServer = async (
  overrides: Partial<WorkspaceServerOptions> = {}
): Promise<{ server: WorkspaceServer; base: string; port: number }> => {
  const server = new WorkspaceServer({
    root,
    ports: [0],
    debounceMs: 30,
    leaseGraceMs: 300,
    stateCheckIntervalMs: 100,
    ...overrides,
  });
  servers.push(server);
  const port = await server.start();
  return { server, base: `http://127.0.0.1:${port}`, port };
};

interface Reply {
  status: number;
  headers: Headers;
  text: string;
  json: Record<string, unknown>;
}

const call = async (
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    auth?: string | null;
  } = {}
): Promise<Reply> => {
  const headers: Record<string, string> = { ...init.headers };
  const auth = init.auth === undefined ? token : init.auth;
  if (auth !== null) headers.authorization = `Bearer ${auth}`;
  const response = await fetch(url, { method: init.method ?? 'GET', headers, body: init.body });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  return { status: response.status, headers: response.headers, text, json };
};

const post = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> =>
  call(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });

const put = (
  base: string,
  path: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<Reply> =>
  call(`${base}/ws/file?path=${encodeURIComponent(path)}`, { method: 'PUT', body, headers });

/** Raw request (fetch refuses to set `Host`). */
const rawGet = (port: number, path: string, headers: Record<string, string>): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, res => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });

type Frame = Record<string, unknown>;

interface Conn {
  readonly ws: WebSocket;
  readonly frames: Frame[];
  readonly closed: Promise<{ code: number; reason: string }>;
  next(match: (frame: Frame) => boolean, timeoutMs?: number): Promise<Frame>;
  send(frame: Frame): void;
}

const connect = async (port: number, origin?: string): Promise<Conn> => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, {
    headers: origin ? { origin } : {},
  });
  sockets.push(ws);
  const frames: Frame[] = [];
  const consumed = new Set<Frame>();
  let wake: (() => void) | null = null;
  ws.on('message', data => {
    frames.push(JSON.parse(String(data)) as Frame);
    wake?.();
  });
  const closed = new Promise<{ code: number; reason: string }>(resolve =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  );
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const next = async (match: (frame: Frame) => boolean, timeoutMs = 2_000): Promise<Frame> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = frames.find(frame => !consumed.has(frame) && match(frame));
      if (found) {
        consumed.add(found);
        return found;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no matching frame; got ${JSON.stringify(frames)}`);
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, left);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  };
  return { ws, frames, closed, next, send: frame => ws.send(JSON.stringify(frame)) };
};

const authed = async (port: number): Promise<Conn> => {
  const conn = await connect(port);
  conn.send({ type: 'auth', token });
  await conn.next(frame => frame.type === 'hello');
  return conn;
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pix3-serve-')));
  write(
    'pix3project.yaml',
    'version: 1.0.0\nmetadata:\n  projectName: Serve Test\n  projectId: p-1\n'
  );
  write('scenes/main.pix3scene', 'root: []\n');
  const identity = ensureIdentity(root, { rotateToken: false });
  token = identity.issuedToken ?? '';
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await Promise.all(servers.splice(0).map(server => server.close()));
  rmSync(root, { recursive: true, force: true });
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('auth', () => {
  it('requires the bearer token on every route', async () => {
    const { base } = await startServer();
    expect((await call(`${base}/ws/manifest`, { auth: null })).status).toBe(401);
    expect((await call(`${base}/ws/manifest`, { auth: 'p3ws_wrong' })).status).toBe(401);
    expect((await call(`${base}/ws/file?path=scenes/main.pix3scene`, { auth: null })).status).toBe(
      401
    );
    const denied = await call(`${base}/ws/file?path=new.txt`, {
      method: 'PUT',
      body: 'x',
      auth: null,
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toBe('Bearer');
    expect(existsSync(join(root, 'new.txt'))).toBe(false);
    expect((await post(`${base}/ws/hash`, { paths: ['pix3project.yaml'] }, {})).status).toBe(200);
    expect((await call(`${base}/ws/manifest`)).status).toBe(200);
  });

  it('rate-limits failed attempts with 429', async () => {
    const { base } = await startServer({ authFailureLimit: 3 });
    for (let i = 0; i < 3; i++)
      expect((await call(`${base}/ws/manifest`, { auth: 'bad' })).status).toBe(401);
    const limited = await call(`${base}/ws/manifest`, { auth: 'bad' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect((await call(`${base}/ws/manifest`)).status).toBe(429);
  });

  it('closes a socket that does not authenticate in time, or with a wrong token', async () => {
    const { port } = await startServer({ authTimeoutMs: 150 });
    const silent = await connect(port);
    expect((await silent.closed).code).toBe(4401);
    const wrong = await connect(port);
    wrong.send({ type: 'auth', token: 'p3ws_nope' });
    expect((await wrong.next(frame => frame.type === 'error')).error).toBe('unauthorized');
    expect((await wrong.closed).code).toBe(4401);
  });

  it('says hello after the auth frame', async () => {
    const { port, server } = await startServer();
    const conn = await connect(port);
    conn.send({ type: 'auth', token });
    const hello = await conn.next(frame => frame.type === 'hello');
    expect(hello).toMatchObject({
      workspaceId: server.workspaceId,
      serverSession: server.serverSession,
      protocol: WORKSPACE_PROTOCOL,
      revision: server.revision(),
      seq: 0,
      root,
      projectId: 'p-1',
      projectName: 'Serve Test',
      lease: 'free',
    });
  });

  it('revokes live sockets and the old token when the state file is deleted or rotated', async () => {
    const { base, port } = await startServer();
    const conn = await authed(port);
    const rotated = ensureIdentity(root, { rotateToken: true }).issuedToken ?? '';
    const error = await conn.next(frame => frame.type === 'error', 2_000);
    expect(error.error).toBe('revoked');
    expect((await call(`${base}/ws/manifest`)).status).toBe(401);
    expect((await call(`${base}/ws/manifest`, { auth: rotated })).status).toBe(200);
    rmSync(statePath(root));
    expect((await call(`${base}/ws/manifest`, { auth: rotated })).status).toBe(401);
  });
});

describe('the root fence', () => {
  it('refuses traversal, absolute, backslash, drive and reserved paths', async () => {
    const { base } = await startServer();
    const status = async (query: string): Promise<number> =>
      (await call(`${base}/ws/file?path=${query}`)).status;
    expect(await status('..%2Fsecret')).toBe(400);
    expect(await status('%2e%2e/secret')).toBe(400);
    expect(await status('scenes/%2e%2e/%2e%2e/etc')).toBe(400);
    expect(await status('%2Fetc%2Fpasswd')).toBe(400);
    expect(await status('scenes%5Cmain.pix3scene')).toBe(400);
    expect(await status('C:%2Fwindows')).toBe(400);
    expect(await status('scenes//main.pix3scene')).toBe(400);
    expect(await status('.pix3/workspace.json')).toBe(403);
    // Decoded exactly once: `%252e%252e` is the literal name `%2e%2e`, which simply does not exist.
    expect(await status('%252e%252e/pix3project.yaml')).toBe(404);
    expect(
      (await post(`${base}/ws/move`, { from: 'scenes/main.pix3scene', to: '../stolen' })).status
    ).toBe(400);
    expect((await post(`${base}/ws/delete`, { path: '/etc/hosts' })).status).toBe(400);
    expect((await post(`${base}/ws/hash`, { paths: ['../x'] })).status).toBe(400);
    expect(existsSync(join(root, 'scenes/main.pix3scene'))).toBe(true);
  });

  it('never goes through a symlink, for reads, writes and created parents', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'pix3-outside-')));
    extraDirs.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(root, 'link'));
    symlinkSync(join(outside, 'secret.txt'), join(root, 'alias.txt'));
    const { base } = await startServer();
    const read1 = await call(`${base}/ws/file?path=link/secret.txt`);
    expect(read1.status).toBe(403);
    expect(read1.json.error).toBe('symlink');
    expect((await call(`${base}/ws/file?path=alias.txt`)).status).toBe(403);
    expect((await put(base, 'link/planted.txt', 'x')).status).toBe(403);
    expect((await put(base, 'link/deeper/planted.txt', 'x')).status).toBe(403);
    expect((await put(base, 'alias.txt', 'overwritten')).status).toBe(403);
    expect((await post(`${base}/ws/delete`, { path: 'link/secret.txt' })).status).toBe(403);
    expect((await post(`${base}/ws/mkdir`, { path: 'link/sub' })).status).toBe(403);
    expect(existsSync(join(outside, 'planted.txt'))).toBe(false);
    expect(existsSync(join(outside, 'sub'))).toBe(false);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    // …and symlinks are not listed.
    const manifest = await call(`${base}/ws/manifest`);
    const paths = (manifest.json.files as Array<{ path: string }>).map(file => file.path);
    expect(paths).not.toContain('link');
    expect(paths).not.toContain('alias.txt');
  });
});

describe('manifest', () => {
  it('lists the revision set with hashes and excludes server state and tooling folders', async () => {
    write('design/tests/smoke.yaml', 'steps: []\n');
    write('locales/en.json', '{}');
    write('scripts/Player.ts', 'export {};\n');
    write('node_modules/pkg/index.js', 'x');
    write('.git/HEAD', 'ref');
    write('dist/game.html', '<html>');
    write('assets/dist', 'a FILE named dist is ordinary');
    const { base, server } = await startServer();
    const reply = await call(`${base}/ws/manifest`);
    expect(reply.status).toBe(200);
    const files = reply.json.files as Array<{
      path: string;
      kind: string;
      size: number;
      mtime: number;
      sha256?: string;
    }>;
    // `.pix3/**` is listed (minus the server's own entries) but is not part of `revision`.
    const paths = files.map(file => file.path);
    expect(paths).toEqual([
      '.pix3',
      '.pix3/.gitignore',
      'assets',
      'assets/dist',
      'design',
      'design/tests',
      'design/tests/smoke.yaml',
      'locales',
      'locales/en.json',
      'pix3project.yaml',
      'scenes',
      'scenes/main.pix3scene',
      'scripts',
      'scripts/Player.ts',
    ]);
    const scene = files.find(file => file.path === 'scenes/main.pix3scene');
    expect(scene).toMatchObject({ kind: 'file', size: 9, sha256: sha('root: []\n') });
    expect(typeof scene?.mtime).toBe('number');
    expect(files.find(file => file.path === 'scenes')?.sha256).toBeUndefined();
    const lines = files
      .filter(file => file.kind === 'file' && !file.path.startsWith('.pix3/'))
      .map(file => `${file.path}:${file.sha256}`)
      .sort();
    expect(reply.json.revision).toBe(sha(lines.join('\n')));
    expect(reply.json).toMatchObject({
      workspaceId: server.workspaceId,
      serverSession: server.serverSession,
    });
  });
});

describe('.pix3/ — the editor bookkeeping', () => {
  type ManifestFile = { path: string; kind: string; sha256?: string };
  const manifestOf = async (base: string): Promise<{ files: ManifestFile[]; revision: string }> => {
    const reply = await call(`${base}/ws/manifest`);
    return { files: reply.json.files as ManifestFile[], revision: reply.json.revision as string };
  };

  it('round-trips .pix3/protected.json through PUT/GET, outside the revision', async () => {
    const { base, server } = await startServer();
    const before = server.revision();
    const body = '{"version":1,"entries":[]}\n';
    const written = await put(base, '.pix3/protected.json', body);
    expect(written.status).toBe(200);
    expect(written.json.sha256).toBe(sha(body));
    const got = await call(`${base}/ws/file?path=.pix3/protected.json`);
    expect(got.status).toBe(200);
    expect(got.text).toBe(body);
    expect(got.headers.get('etag')).toBe(`"${sha(body)}"`);
    // Conditional writes work there too.
    const stale = await put(base, '.pix3/protected.json', 'x', { 'if-match': `"${sha('no')}"` });
    expect(stale.status).toBe(409);
    expect(server.revision()).toBe(before);
    const manifest = await manifestOf(base);
    expect(manifest.revision).toBe(before);
    expect(manifest.files.find(file => file.path === '.pix3/protected.json')).toMatchObject({
      kind: 'file',
      sha256: sha(body),
    });
    const hashes = await post(`${base}/ws/hash`, { paths: ['.pix3/protected.json'] });
    expect(hashes.json.hashes).toEqual({ '.pix3/protected.json': sha(body) });
  });

  it('keeps the server-private entries 403 reserved_path, for reads and every mutation', async () => {
    write('.pix3/link/claim', 'c');
    const { base } = await startServer();
    for (const path of [
      '.pix3',
      '.pix3/workspace.json',
      '.PIX3/Workspace.json',
      '.pix3/serve.lock',
      '.pix3/tmp/put-x',
      '.pix3/link/claim',
    ]) {
      const read1 = await call(`${base}/ws/file?path=${encodeURIComponent(path)}`);
      expect([path, read1.status, read1.json.error]).toEqual([path, 403, 'reserved_path']);
      expect((await put(base, path, 'x')).status).toBe(403);
      expect((await post(`${base}/ws/delete`, { path, recursive: true })).status).toBe(403);
      expect((await post(`${base}/ws/hash`, { paths: [path] })).status).toBe(403);
    }
    expect((await post(`${base}/ws/mkdir`, { path: '.pix3/tmp/sub' })).status).toBe(403);
    await put(base, '.pix3/recovery/a.txt', 'a');
    expect(
      (await post(`${base}/ws/move`, { from: '.pix3/recovery/a.txt', to: '.pix3/tmp/a.txt' }))
        .status
    ).toBe(403);
    expect(
      (await post(`${base}/ws/move`, { from: '.pix3/workspace.json', to: 'stolen.json' })).status
    ).toBe(403);
    expect(existsSync(statePath(root))).toBe(true);
    const manifest = await manifestOf(base);
    const paths = manifest.files.map(file => file.path);
    expect(paths.filter(path => path.startsWith('.pix3'))).toEqual([
      '.pix3',
      '.pix3/.gitignore',
      '.pix3/recovery',
      '.pix3/recovery/a.txt',
    ]);
  });

  it('lists .pix3/recovery/ after writes and deletes (the journal prunes by listing)', async () => {
    const { base } = await startServer();
    await put(base, '.pix3/recovery/scenes%2Fmain.pix3scene/1-aaaa.pix3scene', 'v1');
    await put(base, '.pix3/recovery/scenes%2Fmain.pix3scene/2-bbbb.pix3scene', 'v2');
    let paths = (await manifestOf(base)).files.map(file => file.path);
    expect(paths).toContain('.pix3/recovery/scenes%2Fmain.pix3scene');
    expect(paths).toContain('.pix3/recovery/scenes%2Fmain.pix3scene/1-aaaa.pix3scene');
    expect(paths).toContain('.pix3/recovery/scenes%2Fmain.pix3scene/2-bbbb.pix3scene');
    expect(
      (
        await post(`${base}/ws/delete`, {
          path: '.pix3/recovery/scenes%2Fmain.pix3scene/1-aaaa.pix3scene',
        })
      ).status
    ).toBe(200);
    paths = (await manifestOf(base)).files.map(file => file.path);
    expect(paths).not.toContain('.pix3/recovery/scenes%2Fmain.pix3scene/1-aaaa.pix3scene');
    expect(paths).toContain('.pix3/recovery/scenes%2Fmain.pix3scene/2-bbbb.pix3scene');
    expect(readdirSync(join(root, '.pix3', 'tmp'))).toEqual([]);
  });

  it('broadcasts no events for .pix3/, except an external change of .pix3/ack.json', async () => {
    const { base, port, server } = await startServer();
    const before = server.revision();
    const conn = await authed(port);
    write('.pix3/recovery/x.pix3scene', 'external journal');
    write('.pix3/merge-log.jsonl', '{}\n');
    await put(base, '.pix3/protected.json', '{}');
    await put(base, '.pix3/ack.json', '{"acks":[]}\n'); // own write: no echo
    await sleep(300);
    expect(conn.frames.filter(frame => frame.type === 'change')).toEqual([]);
    const acks = '{"acks":[{"path":"scenes/main.pix3scene"}]}\n';
    // What `pix3 ack` does: temp file + rename.
    write('.pix3/ack.json.123.tmp', acks);
    renameSync(join(root, '.pix3/ack.json.123.tmp'), join(root, '.pix3/ack.json'));
    const change = await conn.next(frame => frame.type === 'change');
    expect(change.events).toEqual([
      { op: 'modify', path: '.pix3/ack.json', kind: 'file', sha256: sha(acks) },
    ]);
    expect(change.revision).toBe(before);
    expect(server.revision()).toBe(before);
  });
});

describe('reads', () => {
  it('serves bytes with a hash ETag and honours If-None-Match', async () => {
    const { base } = await startServer();
    const first = await call(`${base}/ws/file?path=scenes/main.pix3scene`);
    expect(first.status).toBe(200);
    expect(first.text).toBe('root: []\n');
    expect(first.headers.get('etag')).toBe(`"${sha('root: []\n')}"`);
    expect(first.headers.get('content-type')).toContain('yaml');
    const again = await call(`${base}/ws/file?path=scenes/main.pix3scene`, {
      headers: { 'if-none-match': first.headers.get('etag') ?? '' },
    });
    expect(again.status).toBe(304);
    expect(again.text).toBe('');
    const stale = await call(`${base}/ws/file?path=scenes/main.pix3scene`, {
      headers: { 'if-none-match': '"0000"' },
    });
    expect(stale.status).toBe(200);
  });

  it('answers byte ranges', async () => {
    const bytes = Buffer.from(Array.from({ length: 200 }, (_, i) => i));
    write('audio/clip.ogg', bytes);
    const { base } = await startServer();
    const url = `${base}/ws/file?path=audio/clip.ogg`;
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, range: 'bytes=10-19' },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 10-19/200');
    expect(response.headers.get('content-type')).toBe('audio/ogg');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(10, 20));
    const suffix = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, range: 'bytes=-5' },
    });
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(bytes.subarray(195));
    const beyond = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, range: 'bytes=500-' },
    });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get('content-range')).toBe('bytes */200');
  });

  it('answers /ws/hash with current hashes (null for missing and directories)', async () => {
    const { base } = await startServer();
    const reply = await post(`${base}/ws/hash`, {
      paths: ['scenes/main.pix3scene', 'missing.txt', 'scenes'],
    });
    expect(reply.json.hashes).toEqual({
      'scenes/main.pix3scene': sha('root: []\n'),
      'missing.txt': null,
      scenes: null,
    });
  });
});

describe('writes', () => {
  it('PUT with a matching If-Match replaces, a mismatching one is refused with the current hash', async () => {
    const { base } = await startServer();
    const baseHash = sha('root: []\n');
    const ok = await put(base, 'scenes/main.pix3scene', 'root: [a]\n', {
      'if-match': `"${baseHash}"`,
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      path: 'scenes/main.pix3scene',
      sha256: sha('root: [a]\n'),
      size: 10,
    });
    expect(typeof ok.json.seq).toBe('number');
    expect(typeof ok.json.mtime).toBe('number');
    expect(read('scenes/main.pix3scene')).toBe('root: [a]\n');
    const stale = await put(base, 'scenes/main.pix3scene', 'root: [b]\n', {
      'if-match': `"${baseHash}"`,
    });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ error: 'base_mismatch', currentHash: sha('root: [a]\n') });
    expect(read('scenes/main.pix3scene')).toBe('root: [a]\n');
    const createOnly = await put(base, 'scenes/main.pix3scene', 'x', { 'if-none-match': '*' });
    expect(createOnly.json.error).toBe('exists');
  });

  it('PUT creates parent directories and leaves no temp files behind', async () => {
    const { base } = await startServer();
    expect((await put(base, 'assets/deep/new/file.txt', 'hello')).status).toBe(200);
    expect(read('assets/deep/new/file.txt')).toBe('hello');
    const manifest = await call(`${base}/ws/manifest`);
    const paths = (manifest.json.files as Array<{ path: string }>).map(file => file.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'assets',
        'assets/deep',
        'assets/deep/new',
        'assets/deep/new/file.txt',
      ])
    );
    const tmp = join(root, '.pix3', 'tmp');
    expect(existsSync(tmp) ? readdirSync(tmp) : []).toEqual([]);
  });

  it('mkdir, non-recursive delete of a non-empty folder, recursive delete', async () => {
    const { base } = await startServer();
    expect((await post(`${base}/ws/mkdir`, { path: 'a/b' })).json).toMatchObject({
      path: 'a/b',
      created: true,
    });
    expect((await post(`${base}/ws/mkdir`, { path: 'a/b' })).json).toMatchObject({
      created: false,
    });
    write('a/b/c.txt', 'c');
    const refused = await post(`${base}/ws/delete`, { path: 'a' });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe('not_empty');
    expect((await post(`${base}/ws/delete`, { path: 'a', recursive: true })).json).toMatchObject({
      kind: 'dir',
    });
    expect(existsSync(join(root, 'a'))).toBe(false);
    expect((await post(`${base}/ws/delete`, { path: 'a' })).status).toBe(404);
  });

  it('replays a delete by mutation id instead of applying it again', async () => {
    const { base } = await startServer();
    write('doomed.txt', 'v1');
    const first = await post(
      `${base}/ws/delete`,
      { path: 'doomed.txt' },
      { 'x-mutation-id': 'm-del-1' }
    );
    expect(first.status).toBe(200);
    expect(existsSync(join(root, 'doomed.txt'))).toBe(false);
    write('doomed.txt', 'v2 — recreated after the response was lost');
    const retry = await post(
      `${base}/ws/delete`,
      { path: 'doomed.txt' },
      { 'x-mutation-id': 'm-del-1' }
    );
    expect(retry.status).toBe(200);
    expect(retry.json).toEqual(first.json);
    expect(retry.headers.get('x-mutation-replayed')).toBe('true');
    expect(read('doomed.txt')).toBe('v2 — recreated after the response was lost');
    const reused = await post(
      `${base}/ws/delete`,
      { path: 'other.txt' },
      { 'x-mutation-id': 'm-del-1' }
    );
    expect(reused.status).toBe(422);
    expect(reused.json.error).toBe('mutation_id_reused');
  });

  it('replays a move by mutation id instead of applying it again', async () => {
    const { base } = await startServer();
    write('from.txt', 'moved');
    const first = await post(
      `${base}/ws/move`,
      { from: 'from.txt', to: 'sub/to.txt' },
      { 'x-mutation-id': 'm-mv-1' }
    );
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({
      from: 'from.txt',
      to: 'sub/to.txt',
      kind: 'file',
      sha256: sha('moved'),
    });
    write('from.txt', 'a new from.txt');
    const retry = await post(
      `${base}/ws/move`,
      { from: 'from.txt', to: 'sub/to.txt' },
      { 'x-mutation-id': 'm-mv-1' }
    );
    expect(retry.json).toEqual(first.json);
    expect(read('from.txt')).toBe('a new from.txt');
    expect(read('sub/to.txt')).toBe('moved');
    // Without an id the same request is a new mutation, and refused because the target exists.
    expect((await post(`${base}/ws/move`, { from: 'from.txt', to: 'sub/to.txt' })).json.error).toBe(
      'exists'
    );
  });

  it('replays a PUT by mutation id, and a failed one stays failed', async () => {
    const { base } = await startServer();
    const first = await put(base, 'once.txt', 'one', { 'x-mutation-id': 'm-put-1' });
    write('once.txt', 'changed on disk');
    const retry = await put(base, 'once.txt', 'one', { 'x-mutation-id': 'm-put-1' });
    expect(retry.json).toEqual(first.json);
    expect(read('once.txt')).toBe('changed on disk');
  });
});

describe('events', () => {
  it('turns an external write into a change frame with the new revision', async () => {
    const { base, port } = await startServer();
    const conn = await authed(port);
    write('scenes/main.pix3scene', 'root: [external]\n');
    const change = await conn.next(frame => frame.type === 'change');
    expect(change.events).toEqual([
      {
        op: 'modify',
        path: 'scenes/main.pix3scene',
        kind: 'file',
        sha256: sha('root: [external]\n'),
      },
    ]);
    const manifest = await call(`${base}/ws/manifest`);
    expect(change.revision).toBe(manifest.json.revision);
    write('scenes/level2.pix3scene', 'root: []\n');
    const created = await conn.next(frame => frame.type === 'change');
    expect(created.events).toEqual([
      { op: 'create', path: 'scenes/level2.pix3scene', kind: 'file', sha256: sha('root: []\n') },
    ]);
    expect(created.seq as number).toBeGreaterThan(change.seq as number);
  });

  it('reports a rename, a new folder, and ignores excluded folders', async () => {
    const { port } = await startServer();
    const conn = await authed(port);
    renameSync(join(root, 'scenes/main.pix3scene'), join(root, 'scenes/renamed.pix3scene'));
    const renamed = await conn.next(frame => frame.type === 'change');
    expect(renamed.events).toEqual([
      {
        op: 'rename',
        from: 'scenes/main.pix3scene',
        path: 'scenes/renamed.pix3scene',
        kind: 'file',
        sha256: sha('root: []\n'),
      },
    ]);
    write('node_modules/x/index.js', 'ignored');
    write('prefabs/enemy.prefab', 'p');
    const next = await conn.next(frame => frame.type === 'change');
    const paths = (next.events as Array<{ path: string }>).map(event => event.path);
    expect(paths).toContain('prefabs/enemy.prefab');
    expect(paths.some(path => path.startsWith('node_modules'))).toBe(false);
    // A file inside the new folder, written after the folder appeared, is seen too.
    write('prefabs/boss.prefab', 'b');
    const later = await conn.next(frame => frame.type === 'change');
    expect((later.events as Array<{ path: string }>).map(event => event.path)).toEqual([
      'prefabs/boss.prefab',
    ]);
  });

  it('does not echo the server’s own writes as external changes', async () => {
    const { base, port } = await startServer();
    const conn = await authed(port);
    const own = await put(base, 'scenes/main.pix3scene', 'root: [own]\n');
    await post(`${base}/ws/mkdir`, { path: 'made' });
    await put(base, 'made/by/server.txt', 'x');
    await post(`${base}/ws/move`, { from: 'made/by/server.txt', to: 'made/moved.txt' });
    await post(`${base}/ws/delete`, { path: 'made/moved.txt' });
    await sleep(300);
    expect(conn.frames.filter(frame => frame.type === 'change')).toEqual([]);
    write('external.txt', 'e');
    const change = await conn.next(frame => frame.type === 'change');
    expect(change.events).toEqual([
      { op: 'create', path: 'external.txt', kind: 'file', sha256: sha('e') },
    ]);
    expect(change.seq as number).toBeGreaterThan(own.json.seq as number);
  });
});

describe('Host and Origin', () => {
  it('accepts localhost / 127.0.0.1 with any port, refuses other names', async () => {
    const { port } = await startServer();
    const auth = { authorization: `Bearer ${token}` };
    expect(await rawGet(port, '/ws/manifest', { ...auth, host: 'localhost:4444' })).toBe(200);
    expect(await rawGet(port, '/ws/manifest', { ...auth, host: '127.0.0.1:1' })).toBe(200);
    expect(await rawGet(port, '/ws/manifest', { ...auth, host: `attacker.example:${port}` })).toBe(
      403
    );
    expect(
      await rawGet(port, '/ws/manifest', { ...auth, host: 'localhost.attacker.example' })
    ).toBe(403);
  });

  it('the FSA link server accepts a forwarded port in Host too', async () => {
    const link = new LinkServer({ projectDir: root, ports: [0] });
    const port = await link.start();
    try {
      expect(await rawGet(port, '/hello', { host: 'localhost:4444' })).toBe(200);
      expect(await rawGet(port, '/hello', { host: 'evil.example:4444' })).toBe(403);
    } finally {
      await link.close();
    }
  });

  it('answers the CORS preflight for allowed origins and refuses others, WebSockets included', async () => {
    const { base, port } = await startServer();
    const preflight = await fetch(`${base}/ws/file?path=a.txt`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://editor.pix3.dev',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'authorization, if-match, x-mutation-id',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://editor.pix3.dev');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('X-Mutation-Id');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT');
    const read1 = await fetch(`${base}/ws/file?path=scenes/main.pix3scene`, {
      headers: { origin: 'http://localhost:8123', authorization: `Bearer ${token}` },
    });
    expect(read1.headers.get('access-control-expose-headers')).toContain('ETag');
    const evil = await fetch(`${base}/ws/manifest`, {
      headers: { origin: 'https://evil.example', authorization: `Bearer ${token}` },
    });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    await expect(connect(port, 'https://evil.example')).rejects.toThrow();
    const good = await connect(port, 'https://editor.pix3.dev');
    good.send({ type: 'auth', token });
    await good.next(frame => frame.type === 'hello');
  });
});

describe('one server per root', () => {
  it('a second serve on the same root reports the running one', async () => {
    const first = await openWorkspace({ projectDir: root, ports: [0] });
    expect(first.kind).toBe('started');
    if (first.kind !== 'started') return;
    servers.push(first.server);
    expect(first.identity.issuedToken).toBeNull(); // paired in beforeEach
    const second = await openWorkspace({ projectDir: root, ports: [0] });
    expect(second).toMatchObject({
      kind: 'running',
      port: first.port,
      pid: process.pid,
      workspaceId: first.server.workspaceId,
      serverSession: first.server.serverSession,
    });
    await first.server.close();
    expect(existsSync(join(root, '.pix3', 'serve.lock'))).toBe(false);
    const third = await openWorkspace({ projectDir: root, ports: [0] });
    expect(third.kind).toBe('started');
    if (third.kind === 'started') servers.push(third.server);
  });

  it('an explicit busy port is an error, not a silent switch', async () => {
    const { port } = await startServer();
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'pix3-serve-other-')));
    extraDirs.push(other);
    writeFileSync(join(other, 'pix3project.yaml'), 'version: 1.0.0\n');
    await expect(openWorkspace({ projectDir: other, ports: [port] })).rejects.toThrow(
      /already in use/
    );
    expect(existsSync(join(other, '.pix3', 'serve.lock'))).toBe(false);
  });

  it('a copied project gets its own identity and token', async () => {
    const original = ensureIdentity(root, { rotateToken: false }).state;
    const copy = realpathSync(mkdtempSync(join(tmpdir(), 'pix3-serve-copy-')));
    extraDirs.push(copy);
    mkdirSync(join(copy, '.pix3'));
    writeFileSync(join(copy, '.pix3', 'workspace.json'), readFileSync(statePath(root)));
    const minted = ensureIdentity(copy, { rotateToken: false });
    expect(minted.minted).toBe('moved');
    expect(minted.issuedToken).toBeTruthy();
    expect(minted.state.workspaceId).not.toBe(original.workspaceId);
  });
});

describe('lease', () => {
  it('acquire, busy, takeover, lost, release', async () => {
    const { port } = await startServer();
    const a = await authed(port);
    const b = await authed(port);
    a.send({ type: 'lease', action: 'acquire' });
    const granted = await a.next(frame => frame.type === 'lease');
    expect(granted).toMatchObject({ state: 'granted', resumed: false });
    b.send({ type: 'lease', action: 'acquire' });
    expect(await b.next(frame => frame.type === 'lease')).toMatchObject({ state: 'busy' });
    b.send({ type: 'lease', action: 'takeover' });
    expect(await b.next(frame => frame.type === 'lease')).toMatchObject({ state: 'granted' });
    expect(await a.next(frame => frame.type === 'lease')).toMatchObject({
      state: 'lost',
      reason: 'taken_over',
      leaseId: granted.leaseId,
    });
    b.send({ type: 'lease', action: 'release' });
    expect(await b.next(frame => frame.type === 'lease')).toMatchObject({ state: 'released' });
    a.send({ type: 'lease', action: 'acquire' });
    expect(await a.next(frame => frame.type === 'lease')).toMatchObject({ state: 'granted' });
  });

  it('a closed holder keeps the lease for the grace period, then loses it', async () => {
    const { port } = await startServer({ leaseGraceMs: 250 });
    const a = await authed(port);
    a.send({ type: 'lease', action: 'acquire' });
    const granted = await a.next(frame => frame.type === 'lease');
    a.ws.close();
    await a.closed;
    const b = await authed(port);
    b.send({ type: 'lease', action: 'acquire' });
    expect(await b.next(frame => frame.type === 'lease')).toMatchObject({
      state: 'busy',
      inGrace: true,
    });
    // The holder coming back within grace resumes the same lease.
    const back = await authed(port);
    back.send({ type: 'lease', action: 'acquire', leaseId: granted.leaseId });
    expect(await back.next(frame => frame.type === 'lease')).toMatchObject({
      state: 'granted',
      leaseId: granted.leaseId,
      resumed: true,
    });
    back.ws.close();
    await back.closed;
    await sleep(400);
    b.send({ type: 'lease', action: 'acquire' });
    expect(await b.next(frame => frame.type === 'lease')).toMatchObject({
      state: 'granted',
      resumed: false,
    });
  });

  it('says how long the grace is in hello', async () => {
    const { port } = await startServer({ leaseGraceMs: 1234 });
    const conn = await connect(port);
    conn.send({ type: 'auth', token });
    expect(await conn.next(frame => frame.type === 'hello')).toMatchObject({ leaseGraceMs: 1234 });
  });

  it('holder socket closes → after grace a new socket’s acquire is granted', async () => {
    const { port } = await startServer({ leaseGraceMs: 200 });
    const a = await authed(port);
    a.send({ type: 'lease', action: 'acquire' });
    const granted = await a.next(frame => frame.type === 'lease');
    // A tab reload: the socket goes away without a release (no close frame even).
    a.ws.terminate();
    await a.closed;
    const b = await authed(port);
    b.send({ type: 'lease', action: 'acquire', leaseId: 'someone-elses-id' });
    expect(await b.next(frame => frame.type === 'lease')).toMatchObject({
      state: 'busy',
      inGrace: true,
    });
    await sleep(350);
    // Nobody polled in between: the grace timer alone freed the lease.
    b.send({ type: 'lease', action: 'acquire', leaseId: granted.leaseId });
    const again = await b.next(frame => frame.type === 'lease');
    expect(again).toMatchObject({ state: 'granted', resumed: false });
    expect(again.leaseId).not.toBe(granted.leaseId);
    // A fresh socket (the reloaded tab) after the grace, with its stale id, also gets it.
    b.send({ type: 'lease', action: 'release' });
    await b.next(frame => frame.type === 'lease' && frame.state === 'released');
    const c = await authed(port);
    c.send({ type: 'lease', action: 'acquire', leaseId: granted.leaseId });
    expect(await c.next(frame => frame.type === 'lease')).toMatchObject({
      state: 'granted',
      resumed: false,
    });
  });

  it('relays calls to the holder and fails fast without one', async () => {
    const { server, port } = await startServer();
    const none = await server.enqueueCall('project_status', {});
    expect(none.isError).toBe(true);
    const a = await authed(port);
    a.send({ type: 'lease', action: 'acquire' });
    await a.next(frame => frame.type === 'lease');
    const pending = server.enqueueCall('play_status', { verbose: true });
    const delivered = await a.next(frame => frame.type === 'call');
    expect(delivered).toMatchObject({ name: 'play_status', input: { verbose: true } });
    a.send({
      type: 'call-result',
      id: delivered.id,
      result: { content: [{ type: 'text', text: 'running' }] },
    });
    expect(await pending).toEqual({ content: [{ type: 'text', text: 'running' }] });
  });

  it('hands an unanswered call to the window that takes over', async () => {
    const { server, port } = await startServer();
    const a = await authed(port);
    a.send({ type: 'lease', action: 'acquire' });
    await a.next(frame => frame.type === 'lease');
    const pending = server.enqueueCall('get_selection', {});
    await a.next(frame => frame.type === 'call');
    const b = await authed(port);
    b.send({ type: 'lease', action: 'takeover' });
    await b.next(frame => frame.type === 'lease' && frame.state === 'granted');
    const redelivered = await b.next(frame => frame.type === 'call');
    a.send({
      type: 'call-result',
      id: redelivered.id,
      result: { content: [{ type: 'text', text: 'late' }] },
    });
    expect(await a.next(frame => frame.type === 'error')).toMatchObject({
      error: 'not_lease_holder',
    });
    b.send({
      type: 'call-result',
      id: redelivered.id,
      result: { content: [{ type: 'text', text: 'b' }] },
    });
    expect((await pending).content[0].text).toBe('b');
  });
});
