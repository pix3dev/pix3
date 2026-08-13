/**
 * End-to-end HTTP tests for `POST /v1/sessions/reset` (auth + contract) and the session counts added
 * to the discovery response.
 *
 * The bridge is spawned as a real child process on a throwaway port with HOME pointed at a temp
 * directory, so it mints its own config/pairing token and never touches `~/.pix3/agent-bridge.json`
 * or a bridge the developer already has running on 8484. No Claude login is needed: none of these
 * requests starts an Agent-SDK session.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const ENTRY = path.join(import.meta.dirname, 'index.ts');
const STALL_TIMEOUT_MS = 90_000;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('bridge HTTP surface', () => {
  let child: ChildProcessByStdio<null, Readable, Readable>;
  let base = '';
  let token = '';
  let output = '';

  before(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pix3-bridge-test-'));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [ENTRY, '--port', String(port)], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PIX3_BRIDGE_STALL_TIMEOUT_MS: String(STALL_TIMEOUT_MS),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const probe = await fetch(`${base}/`);
        if (probe.ok) break;
      } catch {
        /* not listening yet */
      }
      await sleep(100);
    }
    const config = JSON.parse(
      fs.readFileSync(path.join(home, '.pix3', 'agent-bridge.json'), 'utf8')
    ) as { token: string };
    token = config.token;
    assert.ok(token, `bridge did not start; output:\n${output}`);
  });

  after(() => {
    child?.kill('SIGTERM');
  });

  it('rejects a reset with no pairing token', async () => {
    const res = await fetch(`${base}/v1/sessions/reset`, { method: 'POST' });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /pairing token/i);
  });

  it('rejects a reset with a wrong pairing token', async () => {
    const res = await fetch(`${base}/v1/sessions/reset`, {
      method: 'POST',
      headers: { 'x-pix3-bridge-token': 'not-the-token' },
    });
    assert.equal(res.status, 401);
  });

  it('returns closed/remaining for an empty body when nothing is wedged', async () => {
    const res = await fetch(`${base}/v1/sessions/reset`, {
      method: 'POST',
      headers: { 'x-pix3-bridge-token': token },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.closed, 0);
    assert.equal(body.remaining, 0);
    assert.equal(body.scope, 'stalled');
  });

  it('accepts all/sessionKey and stays idempotent', async () => {
    for (const payload of [{ all: true }, { sessionKey: 'nope' }, {}]) {
      const res = await fetch(`${base}/v1/sessions/reset`, {
        method: 'POST',
        headers: { 'x-api-key': token, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 200, `payload ${JSON.stringify(payload)}`);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.closed, 0);
      assert.equal(body.remaining, 0);
    }
  });

  it('rejects a malformed reset body with 400, not 500', async () => {
    const res = await fetch(`${base}/v1/sessions/reset`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{oops',
    });
    assert.equal(res.status, 400);
  });

  it('reports session counts and the watchdog threshold in discovery', async () => {
    const res = await fetch(`${base}/v1/providers`, {
      headers: { 'x-pix3-bridge-token': token },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      providers: Array<{ id: string }>;
      sessions: { total: number; busy: number; stalled: number; stallTimeoutMs: number };
    };
    assert.ok(body.providers.some(provider => provider.id === 'claude-bridge'));
    assert.deepEqual(body.sessions, {
      total: 0,
      busy: 0,
      stalled: 0,
      stallTimeoutMs: STALL_TIMEOUT_MS,
    });
  });

  it('keeps the unauthenticated health response unchanged', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.name, 'pix3-agent-bridge');
  });
});
