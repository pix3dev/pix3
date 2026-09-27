// @vitest-environment node
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resultText } from './call-relay.ts';
import { LinkServer, type LinkServerOptions } from './link-server.ts';
import { describeUnlinked, projectStatus } from './mcp.ts';
import { LINK_PROTOCOL } from './protocol.ts';

/**
 * "One folder" (plan phase 0): the challenge file admits a window whose directory handle is THIS
 * folder and nobody else — not a copy, checkout or worktree carrying the same `projectId` — and at
 * most one window at a time holds the lease.
 *
 * A "window" here is what the editor does with its File System Access handle: after `POST /claim`
 * it reads `<its own folder>/<file>` and sends back what it found.
 */

const PROJECT_ID = 'test-project-0001';

let root: string;
let projectDir: string;
const servers: LinkServer[] = [];

const makeProject = (dir: string): void => {
  writeFileSync(
    join(dir, 'pix3project.yaml'),
    `version: 1.0.0\nmetadata:\n  projectName: T\n  projectId: ${PROJECT_ID}\n`
  );
};

const startServer = async (overrides: Partial<LinkServerOptions> = {}): Promise<string> => {
  const server = new LinkServer({ projectDir, ports: [0], ...overrides });
  servers.push(server);
  const port = await server.start();
  return `http://127.0.0.1:${port}`;
};

interface Reply {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

const call = async (
  url: string,
  init: { method?: string; body?: unknown; origin?: string; signal?: AbortSignal } = {}
): Promise<Reply> => {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.origin) headers.origin = init.origin;
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    headers: res.headers,
  };
};

/** A window whose FSA handle points at `windowDir`: claim, look for the file, confirm. */
const windowClaim = async (
  base: string,
  windowDir: string,
  route: 'confirm' | 'takeover' = 'confirm'
): Promise<Reply> => {
  const claim = await call(`${base}/claim`, { method: 'POST' });
  expect(claim.status).toBe(200);
  const file = String(claim.body.file);
  expect(Object.keys(claim.body)).toEqual(['file']);
  const path = join(windowDir, ...file.split('/'));
  const nonce = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
  return call(`${base}/claim/${route}`, { method: 'POST', body: { nonce } });
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pix3-link-'));
  projectDir = join(root, 'my-game');
  mkdirSync(projectDir);
  makeProject(projectDir);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  rmSync(root, { recursive: true, force: true });
});

describe('GET /hello', () => {
  it('announces the project id, session, protocol and self-declared agent', async () => {
    const base = await startServer({ agent: () => 'Claude Code' });
    const hello = await call(`${base}/hello`);
    expect(hello.status).toBe(200);
    expect(hello.body).toMatchObject({
      projectId: PROJECT_ID,
      protocol: LINK_PROTOCOL,
      agent: { name: 'Claude Code', verified: false },
      pid: process.pid,
    });
    expect(typeof hello.body.sessionId).toBe('string');
    expect(typeof hello.body.cliVersion).toBe('string');
  });

  it('reports a null projectId outside a project', async () => {
    rmSync(join(projectDir, 'pix3project.yaml'));
    const base = await startServer();
    expect((await call(`${base}/hello`)).body.projectId).toBeNull();
  });
});

describe('one folder: the challenge', () => {
  it('admits a window whose handle is the same folder, and deletes the challenge file', async () => {
    const base = await startServer();
    const reply = await windowClaim(base, projectDir);
    expect(reply.status).toBe(200);
    expect(typeof reply.body.leaseId).toBe('string');
    expect(readdirSync(join(projectDir, '.pix3', 'link'))).toEqual([]);
  });

  it('refuses a window whose handle is a COPY of the project (same projectId)', async () => {
    const copyDir = join(root, 'my-game-copy');
    cpSync(projectDir, copyDir, { recursive: true });
    const server = new LinkServer({ projectDir, ports: [0] });
    servers.push(server);
    const base = `http://127.0.0.1:${await server.start()}`;

    // The copy passes the projectId filter — that is exactly why the challenge exists.
    expect((await call(`${base}/hello`)).body.projectId).toBe(PROJECT_ID);
    const reply = await windowClaim(base, copyDir);
    expect(reply.status).toBe(403);
    expect(reply.body.error).toBe('bad_nonce');
    expect(server.isLeased()).toBe(false);
    // And the agent is told what is going on.
    expect(describeUnlinked(server.status(), projectDir)).toMatch(
      /copy, another checkout or a worktree/
    );
  });

  it('does not accept a nonce twice', async () => {
    const base = await startServer();
    const claim = await call(`${base}/claim`, { method: 'POST' });
    const nonce = readFileSync(join(projectDir, String(claim.body.file)), 'utf8').trim();
    expect((await call(`${base}/claim/confirm`, { method: 'POST', body: { nonce } })).status).toBe(
      200
    );
    expect((await call(`${base}/claim/takeover`, { method: 'POST', body: { nonce } })).status).toBe(
      403
    );
  });

  it('deletes an unconfirmed challenge file after the claim TTL', async () => {
    const base = await startServer({ claimTtlMs: 80 });
    const claim = await call(`${base}/claim`, { method: 'POST' });
    const path = join(projectDir, String(claim.body.file));
    expect(existsSync(path)).toBe(true);
    await sleep(200);
    expect(existsSync(path)).toBe(false);
  });
});

describe('one folder: the lease', () => {
  it('answers a second window on the same folder with 409 busy', async () => {
    const base = await startServer();
    expect((await windowClaim(base, projectDir)).status).toBe(200);
    const second = await windowClaim(base, projectDir);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('busy');
  });

  it('lets a window take over explicitly; the old window hears it on its poll', async () => {
    const base = await startServer({ pollTimeoutMs: 5_000 });
    const first = await windowClaim(base, projectDir);
    const oldLease = String(first.body.leaseId);
    // The old window is mid-poll when the takeover lands.
    const oldPoll = call(`${base}/calls?lease=${oldLease}`);
    await sleep(50);

    const takeover = await windowClaim(base, projectDir, 'takeover');
    expect(takeover.status).toBe(200);
    expect(takeover.body.leaseId).not.toBe(oldLease);

    const lost = await oldPoll;
    expect(lost.status).toBe(409);
    expect(lost.body).toMatchObject({ error: 'lease_lost', reason: 'taken_over' });
    const next = await call(`${base}/calls?lease=${oldLease}`);
    expect(next.body).toMatchObject({ error: 'lease_lost', reason: 'taken_over' });
  });

  it('expires a lease nobody polls, freeing the session for another window', async () => {
    const base = await startServer({ leaseTtlMs: 120 });
    const first = await windowClaim(base, projectDir);
    await sleep(250);
    const second = await windowClaim(base, projectDir);
    expect(second.status).toBe(200);
    const stale = await call(`${base}/calls?lease=${String(first.body.leaseId)}`);
    expect(stale.status).toBe(409);
    expect(stale.body.reason).toBe('expired');
  });

  it('keeps the lease alive while a long-poll is in flight, and answers empty on timeout', async () => {
    const server = new LinkServer({ projectDir, ports: [0], leaseTtlMs: 100, pollTimeoutMs: 300 });
    servers.push(server);
    const base = `http://127.0.0.1:${await server.start()}`;
    const lease = String((await windowClaim(base, projectDir)).body.leaseId);
    const poll = call(`${base}/calls?lease=${lease}`);
    await sleep(200); // past the lease TTL, but the poll holds it
    expect(server.isLeased()).toBe(true);
    expect((await poll).body).toEqual({ calls: [] });
  });

  it('relays a tool call to the leased window and back', async () => {
    const server = new LinkServer({ projectDir, ports: [0], pollTimeoutMs: 5_000 });
    servers.push(server);
    const base = `http://127.0.0.1:${await server.start()}`;
    const lease = String((await windowClaim(base, projectDir)).body.leaseId);

    const poll = call(`${base}/calls?lease=${lease}`);
    await sleep(30);
    const pending = projectStatus(server);
    const delivered = await poll;
    const calls = delivered.body.calls as Array<{ id: string; name: string }>;
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('project_status');

    const answer = await call(`${base}/calls/${calls[0].id}`, {
      method: 'POST',
      body: { lease, result: { content: [{ type: 'text', text: 'scene main open' }] } },
    });
    expect(answer.body).toEqual({ ok: true });
    expect(await pending).toEqual({ content: [{ type: 'text', text: 'scene main open' }] });
  });

  it('re-delivers calls the old window never answered to the window that takes over', async () => {
    const server = new LinkServer({ projectDir, ports: [0], pollTimeoutMs: 5_000 });
    servers.push(server);
    const base = `http://127.0.0.1:${await server.start()}`;
    const oldLease = String((await windowClaim(base, projectDir)).body.leaseId);
    const pending = server.callEditor('project_status', {});
    const first = await call(`${base}/calls?lease=${oldLease}`);
    expect((first.body.calls as unknown[]).length).toBe(1);

    const lease = String((await windowClaim(base, projectDir, 'takeover')).body.leaseId);
    const again = await call(`${base}/calls?lease=${lease}`);
    const [redelivered] = again.body.calls as Array<{ id: string }>;
    await call(`${base}/calls/${redelivered.id}`, {
      method: 'POST',
      body: { lease, result: { content: [{ type: 'text', text: 'ok' }] } },
    });
    expect(resultText(await pending)).toBe('ok');
  });

  it('tells the agent to open the folder when no window holds the lease', async () => {
    const server = new LinkServer({ projectDir, ports: [0] });
    servers.push(server);
    await server.start();
    const result = await projectStatus(server);
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain(projectDir);
    expect(resultText(result)).toMatch(/not open on this project/);
  });
});

describe('Origin and Host rules', () => {
  it('answers the editor origins with CORS headers', async () => {
    const base = await startServer();
    for (const origin of [
      'https://editor.pix3.dev',
      'http://localhost:8123',
      'http://127.0.0.1:8123',
    ]) {
      const hello = await call(`${base}/hello`, { origin });
      expect(hello.status).toBe(200);
      expect(hello.headers.get('access-control-allow-origin')).toBe(origin);
    }
  });

  it('refuses any other origin with 403 and no CORS headers — and no side effects', async () => {
    const base = await startServer();
    // Any http://localhost:<port> is a dev editor (Vite / a VS Code forward pick the port), so
    // only non-loopback hosts, https-on-localhost lookalikes and the opaque 'null' are refused.
    for (const origin of [
      'https://evil.example',
      'http://localhost.evil.example',
      'https://localhost:5173',
      'null',
    ]) {
      const hello = await call(`${base}/hello`, { origin });
      expect(hello.status).toBe(403);
      expect(hello.headers.get('access-control-allow-origin')).toBeNull();
    }
    const claim = await call(`${base}/claim`, { method: 'POST', origin: 'https://evil.example' });
    expect(claim.status).toBe(403);
    expect(existsSync(join(projectDir, '.pix3', 'link'))).toBe(false);
  });

  it('serves requests with no Origin (local processes) without CORS headers', async () => {
    const base = await startServer();
    const hello = await call(`${base}/hello`);
    expect(hello.status).toBe(200);
    expect(hello.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers the JSON POST preflight for allowed origins only', async () => {
    const base = await startServer();
    const preflight = (origin: string) =>
      fetch(`${base}/claim/confirm`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
    const ok = await preflight('https://editor.pix3.dev');
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://editor.pix3.dev');
    expect(ok.headers.get('access-control-allow-methods')).toContain('POST');
    expect(ok.headers.get('access-control-allow-headers')).toContain('content-type');
    const refused = await preflight('https://evil.example');
    expect(refused.status).toBe(403);
    expect(refused.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses a non-loopback Host header (DNS rebinding)', async () => {
    const server = new LinkServer({ projectDir, ports: [0] });
    servers.push(server);
    const port = await server.start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/hello', headers: { host: `attacker.example:${port}` } },
        res => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});

describe('listening', () => {
  it('takes the first free port of its range and fails clearly when all are taken', async () => {
    const base = 20_000 + Math.floor(Math.random() * 20_000);
    const ports = [base, base + 1];
    const a = new LinkServer({ projectDir, ports });
    const b = new LinkServer({ projectDir, ports });
    const c = new LinkServer({ projectDir, ports });
    servers.push(a, b, c);
    expect(await a.start()).toBe(base);
    expect(await b.start()).toBe(base + 1);
    await expect(c.start()).rejects.toThrow(/No free port/);
  });

  it('is not reachable on a non-loopback interface', async () => {
    const external = Object.values(networkInterfaces())
      .flat()
      .find(entry => entry && entry.family === 'IPv4' && !entry.internal);
    const server = new LinkServer({ projectDir, ports: [0] });
    servers.push(server);
    const port = await server.start();
    if (!external) return; // no external interface in this sandbox — nothing to probe
    await expect(fetch(`http://${external.address}:${port}/hello`)).rejects.toThrow();
  });
});
