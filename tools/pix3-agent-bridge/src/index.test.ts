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
  let mcpToken = '';
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
        // Detection for the Antigravity lane spawns a real `agy`, which a hermetic HTTP test must
        // not do — and would make these assertions depend on whatever is installed on the machine.
        PIX3_AGY_DISABLED: '1',
        PIX3_CODEX_DISABLED: '1',
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
    ) as { token: string; mcpToken: string };
    token = config.token;
    mcpToken = config.mcpToken;
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

  it('lists local CLI agents in their own array, never among the proxied providers', async () => {
    const res = await fetch(`${base}/v1/providers`, {
      headers: { 'x-pix3-bridge-token': token },
    });
    const body = (await res.json()) as {
      providers: Array<{ id: string }>;
      agents: Array<{ id: string; kind: string; available: boolean; tools: string }>;
    };
    // An older editor maps an unknown `kind` in `providers` to 'openai' and would build a broken
    // provider pointed at /providers/agy — which is exactly why this lane lives in `agents`.
    assert.equal(body.providers.some(provider => provider.id === 'agy'), false);
    const agy = body.agents.find(agent => agent.id === 'agy');
    assert.ok(agy, 'the agy lane must be advertised even when it is unavailable');
    assert.equal(agy.kind, 'agent-cli');
    assert.equal(agy.available, false);
    assert.equal(agy.tools, 'disabled');
    assert.equal(body.providers.some(provider => provider.id === 'codex'), false);
    const codex = body.agents.find(agent => agent.id === 'codex');
    assert.ok(codex, 'the Codex lane must be advertised even when it is unavailable');
    assert.equal(codex.kind, 'agent-cli');
    assert.equal(codex.available, false);
    assert.equal(codex.tools, 'disabled');
  });

  it('answers /agents/agy/v1/models with a reason, not a stack trace, when agy is absent', async () => {
    const res = await fetch(`${base}/agents/agy/v1/models`, {
      headers: { 'x-pix3-bridge-token': token },
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /disabled|not found|not available/i);
  });

  it('guards the MCP relay with its own token and refuses browsers outright', async () => {
    const url = `${base}/agents/agy/mcp/whatever`;
    const withoutToken = await fetch(url, { method: 'POST', body: '{"method":"tools/list"}' });
    assert.equal(withoutToken.status, 401);

    // The pairing token must NOT open the relay: they are separate secrets on purpose.
    const wrongToken = await fetch(url, {
      method: 'POST',
      headers: { 'x-pix3-mcp-token': token },
      body: '{"method":"tools/list"}',
    });
    assert.equal(wrongToken.status, 401);

    const fromBrowser = await fetch(url, {
      method: 'POST',
      headers: { 'x-pix3-mcp-token': mcpToken, origin: 'http://localhost:8123' },
      body: '{"method":"tools/list"}',
    });
    assert.equal(fromBrowser.status, 403);

    // Correct token, unknown session → a plain 404 the shim turns into a JSON-RPC error.
    const unknownSession = await fetch(url, {
      method: 'POST',
      headers: { 'x-pix3-mcp-token': mcpToken },
      body: '{"method":"tools/list"}',
    });
    assert.equal(unknownSession.status, 404);
  });

  it('keeps the unauthenticated health response unchanged', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.name, 'pix3-agent-bridge');
  });
});
