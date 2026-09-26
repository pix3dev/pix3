// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { ensureIdentity } from './serve/state-file.ts';
import { WorkspaceServer } from './serve/workspace-server.ts';

/**
 * `pix3 mcp --workspace` end to end: the real CLI spawned over stdio (an in-process MCP client),
 * a real `pix3 serve` on an OS-assigned port, and a fake editor "window" — a WebSocket client with
 * the pairing token that holds the lease and answers `call` frames — standing in for the browser.
 */

const CLI_ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));

let root: string;
let token: string;
const servers: WorkspaceServer[] = [];
const sockets: WebSocket[] = [];
const clients: Client[] = [];

const sha = (data: string): string => createHash('sha256').update(data).digest('hex');

const write = (rel: string, data: string): void => {
  const file = join(root, ...rel.split('/'));
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, data);
};

const startServer = async (): Promise<WorkspaceServer> => {
  const server = new WorkspaceServer({ root, ports: [0], debounceMs: 30, leaseGraceMs: 300 });
  servers.push(server);
  await server.start();
  return server;
};

type Frame = Record<string, unknown>;
type CallHandler = (name: string, input: Frame, frame: Frame) => Promise<Frame> | Frame;

/** A fake editor window: holds the lease and answers calls through `handler`. */
const openWindow = async (server: WorkspaceServer, handler: CallHandler): Promise<Frame[]> => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/events`);
  sockets.push(ws);
  const calls: Frame[] = [];
  let granted: () => void = () => undefined;
  const leased = new Promise<void>(resolve => {
    granted = resolve;
  });
  ws.on('message', data => {
    const frame = JSON.parse(String(data)) as Frame;
    if (frame.type === 'hello') ws.send(JSON.stringify({ type: 'lease', action: 'acquire' }));
    if (frame.type === 'lease' && frame.state === 'granted') granted();
    if (frame.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    if (frame.type === 'call') {
      // The schema fetch runs in the background of any call; tests look at the rest.
      if (frame.name !== 'tools_manifest') calls.push(frame);
      void Promise.resolve(handler(String(frame.name), (frame.input ?? {}) as Frame, frame)).then(
        result => ws.send(JSON.stringify({ type: 'call-result', id: frame.id, result }))
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'auth', token }));
  await leased;
  return calls;
};

const textResult = (value: unknown): Frame => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
});

const startMcp = async (projectDir: string = root): Promise<Client> => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_ENTRY, 'mcp', '--workspace', '--project', projectDir],
    env: { ...process.env, PIX3_AGENT: 'spec-agent' } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'spec-client', version: '0.0.0' });
  clients.push(client);
  await client.connect(transport);
  return client;
};

interface ToolReply {
  readonly isError: boolean;
  readonly body: Record<string, unknown>;
  readonly content: Array<Record<string, unknown>>;
}

const callTool = async (client: Client, name: string, args: Frame = {}): Promise<ToolReply> => {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<Record<string, unknown>>;
  const first = content.find(block => block.type === 'text');
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(String(first?.text ?? '{}')) as Record<string, unknown>;
  } catch {
    body = { text: first?.text };
  }
  return { isError: result.isError === true, body, content };
};

/** A window whose barrier reports exactly the disk versions of `loaded` paths. */
const barrierWindow =
  (loaded: () => Record<string, string>, onTool: CallHandler): CallHandler =>
  (name, input, frame) => {
    if (name === 'sync_barrier') return textResult({ loaded: loaded(), errors: [], holdId: 'h1' });
    if (name === 'sync_release') return textResult({ released: true });
    return onTool(name, input, frame);
  };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pix3-mcp-ws-')));
  write(
    'pix3project.yaml',
    'version: 1.0.0\nmetadata:\n  projectName: MCP Test\n  projectId: p-mcp\n'
  );
  write('scenes/main.pix3scene', 'root: []\n');
  token = ensureIdentity(root, { rotateToken: false }).issuedToken ?? '';
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close().catch(() => undefined)));
  for (const ws of sockets.splice(0)) ws.terminate();
  await Promise.all(servers.splice(0).map(server => server.close()));
  rmSync(root, { recursive: true, force: true });
});

describe('pix3 mcp --workspace', () => {
  it('lists exactly the v1 tools, with `expect` on the barrier tools', async () => {
    await startServer();
    const client = await startMcp();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(
      [
        'project_status',
        'play_start',
        'play_stop',
        'play_restart',
        'play_status',
        'game_run',
        'game_input',
        'game_observe',
        'read_errors',
        'read_logs',
        'viewport_screenshot',
        'generate_asset',
        'generate_sfx',
        'get_selection',
      ].sort()
    );
    for (const name of ['play_start', 'play_restart', 'game_run']) {
      const tool = tools.find(t => t.name === name);
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain('expect');
    }
    expect(tools.some(t => /set_property|create_node|fs_write/.test(t.name))).toBe(false);
  }, 20_000);

  it('uses the schemas the window advertises once one is connected', async () => {
    const server = await startServer();
    await openWindow(server, name =>
      name === 'tools_manifest'
        ? textResult({
            tools: [
              {
                name: 'get_selection',
                description: 'FROM THE WINDOW',
                inputSchema: { type: 'object', properties: { verbose: { type: 'boolean' } } },
              },
              { name: 'fs_write', description: 'not allowed', inputSchema: { type: 'object' } },
            ],
          })
        : textResult({})
    );
    const client = await startMcp();
    const { tools } = await client.listTools();
    expect(tools.find(t => t.name === 'get_selection')?.description).toBe('FROM THE WINDOW');
    expect(tools.some(t => t.name === 'fs_write')).toBe(false);
  }, 20_000);

  it('project_status says what to open without a window, and forwards with one', async () => {
    const server = await startServer();
    const client = await startMcp();
    const alone = await callTool(client, 'project_status');
    expect(alone.isError).toBe(false);
    expect(alone.body).toMatchObject({ connected: false, editor: null });
    expect(String(alone.body.message)).toContain(root);

    await openWindow(server, name =>
      name === 'project_status'
        ? textResult({ scenes: [{ path: 'scenes/main.pix3scene' }] })
        : textResult({})
    );
    const linked = await callTool(client, 'project_status');
    expect(linked.body).toMatchObject({
      connected: true,
      editor: { scenes: [{ path: 'scenes/main.pix3scene' }] },
    });
  }, 20_000);

  it('no_editor for a run with no window holding the lease', async () => {
    await startServer();
    const client = await startMcp();
    const reply = await callTool(client, 'play_status');
    expect(reply.isError).toBe(true);
    expect(reply.body.error).toBe('no_editor');
  }, 20_000);

  it('game_run with matching expect: verified, matchesAgent and matchesDisk, the agent named', async () => {
    const server = await startServer();
    const scene = 'root: [agent]\n';
    write('scenes/main.pix3scene', scene);
    const calls = await openWindow(
      server,
      barrierWindow(
        () => ({ 'scenes/main.pix3scene': sha(scene) }),
        name => (name === 'game_run' ? textResult({ verdict: 'PASS frame 12' }) : textResult({}))
      )
    );
    const client = await startMcp();
    const reply = await callTool(client, 'game_run', {
      until: [{ kind: 'frames', n: 10 }],
      expect: { 'scenes/main.pix3scene': sha(scene) },
    });
    expect(reply.isError).toBe(false);
    expect(reply.body).toMatchObject({
      revision: { 'scenes/main.pix3scene': sha(scene) },
      matchesAgent: true,
      matchesDisk: true,
      changedDuringRun: [],
      editorChangedSinceAgentWrite: [],
      result: { verdict: 'PASS frame 12' },
    });
    expect(calls.map(c => c.name)).toEqual(['sync_barrier', 'game_run', 'sync_release']);
    // `expect` is the MCP process's business; the editor tool gets the rest.
    expect(calls[1].input).toEqual({ until: [{ kind: 'frames', n: 10 }] });
    expect(calls[0].agent).toMatchObject({ name: 'spec-client', verified: false });
  }, 20_000);

  it('without expect: agentExpectations none', async () => {
    const server = await startServer();
    await openWindow(
      server,
      barrierWindow(
        () => ({ 'scenes/main.pix3scene': sha('root: []\n') }),
        () => textResult({ ok: true })
      )
    );
    const client = await startMcp();
    const reply = await callTool(client, 'play_start');
    expect(reply.body).toMatchObject({
      agentExpectations: 'none',
      matchesAgent: null,
      matchesDisk: true,
    });
  }, 20_000);

  it('mismatching expect → disk_differs_from_agent, with the recovery copy only when it exists', async () => {
    const server = await startServer();
    const calls = await openWindow(server, () => textResult({}));
    const agentMain = 'root: [agent-main]\n';
    write('scenes/main.pix3scene', 'root: [human]\n');
    write('scenes/level.pix3scene', 'root: [human]\n');
    write(
      `.pix3/recovery/${encodeURIComponent('scenes/main.pix3scene')}/2026-09-26T10-00-00-000Z-${sha(agentMain).slice(0, 8)}.pix3scene`,
      agentMain
    );
    const client = await startMcp();
    const reply = await callTool(client, 'game_run', {
      until: [{ kind: 'frames', n: 1 }],
      expect: {
        'scenes/main.pix3scene': sha(agentMain),
        'scenes/level.pix3scene': sha('root: [agent-level]\n'),
      },
    });
    expect(reply.isError).toBe(true);
    expect(reply.body.error).toBe('disk_differs_from_agent');
    const differing = reply.body.differing as Array<Record<string, unknown>>;
    const main = differing.find(d => d.path === 'scenes/main.pix3scene');
    const level = differing.find(d => d.path === 'scenes/level.pix3scene');
    expect(main?.recovery).toMatch(/^\.pix3\/recovery\//);
    expect(String(main?.hint)).toContain(String(main?.recovery));
    expect(level?.recovery).toBeNull();
    expect(String(level?.hint)).toMatch(/no copy exists/);
    // Nothing reached the editor: the check happens before any sync.
    expect(calls).toEqual([]);
  }, 20_000);

  it('a file changed during the run is listed in changedDuringRun', async () => {
    const server = await startServer();
    const scene = 'root: []\n';
    await openWindow(
      server,
      barrierWindow(
        () => ({ 'scenes/main.pix3scene': sha(scene) }),
        name => {
          if (name === 'game_run') {
            // The agent (or anyone) writes while the game runs.
            write('scenes/main.pix3scene', 'root: [during]\n');
            write('scripts/new.ts', 'export {};\n');
          }
          return textResult({ verdict: 'PASS' });
        }
      )
    );
    const client = await startMcp();
    const reply = await callTool(client, 'game_run', { until: [{ kind: 'frames', n: 1 }] });
    expect(reply.isError).toBe(false);
    expect(reply.body.matchesDisk).toBe(false);
    expect(reply.body.changedDuringRun).toEqual(
      expect.arrayContaining(['scenes/main.pix3scene', 'scripts/new.ts'])
    );
  }, 20_000);

  it('sync_timeout when the editor keeps reporting another version than the disk', async () => {
    const server = await startServer();
    let barriers = 0;
    const calls = await openWindow(server, name => {
      if (name === 'sync_barrier') {
        barriers += 1;
        return textResult({
          loaded: { 'scenes/main.pix3scene': sha('root: [stale]\n') },
          errors: [],
          holdId: `h${barriers}`,
        });
      }
      return textResult({ released: true });
    });
    const client = await startMcp();
    const reply = await callTool(client, 'play_restart');
    expect(reply.isError).toBe(true);
    expect(reply.body.error).toBe('sync_timeout');
    expect(reply.body.differing).toEqual([
      expect.objectContaining({
        path: 'scenes/main.pix3scene',
        loadedHash: sha('root: [stale]\n'),
        diskHash: sha('root: []\n'),
      }),
    ]);
    expect(barriers).toBeGreaterThan(1);
    expect(calls.some(c => c.name === 'play_restart')).toBe(false);
    expect(calls.at(-1)?.name).toBe('sync_release');
    // Every hold a retry took was given back.
    expect(calls.filter(c => c.name === 'sync_release')).toHaveLength(barriers);
  }, 20_000);

  it('load_failed and pending_external from the editor’s barrier errors', async () => {
    const server = await startServer();
    let mode: 'compile' | 'pending' = 'compile';
    await openWindow(server, name => {
      if (name !== 'sync_barrier') return textResult({});
      return mode === 'compile'
        ? textResult({
            loaded: { 'scenes/main.pix3scene': sha('root: []\n') },
            errors: [{ file: 'scripts/a.ts', line: 3, message: 'Expected ";"', kind: 'compile' }],
          })
        : textResult({
            loaded: { 'scenes/main.pix3scene': sha('root: []\n') },
            errors: [{ file: 'scenes/b.pix3scene', message: 'not readable', kind: 'pending' }],
          });
    });
    const client = await startMcp();
    const failed = await callTool(client, 'play_start');
    expect(failed.body).toMatchObject({
      error: 'load_failed',
      errors: [{ file: 'scripts/a.ts', line: 3, kind: 'compile' }],
    });
    mode = 'pending';
    const pending = await callTool(client, 'play_start');
    expect(pending.body.error).toBe('pending_external');
  }, 20_000);

  it('observing tools pass images through and report the revision + stale', async () => {
    const server = await startServer();
    await openWindow(server, name =>
      name === 'viewport_screenshot'
        ? {
            content: [
              { type: 'text', text: '{"ok":true,"view":"game"}' },
              { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
            ],
            // The running game started from a version of main the disk no longer holds.
            _meta: {
              pix3: { playRevision: { 'scenes/main.pix3scene': sha('old') }, stale: false },
            },
          }
        : textResult({})
    );
    const client = await startMcp();
    const reply = await callTool(client, 'viewport_screenshot');
    expect(reply.body).toMatchObject({
      revision: { 'scenes/main.pix3scene': sha('old') },
      stale: true,
      result: { ok: true, view: 'game' },
    });
    expect(reply.content.find(block => block.type === 'image')).toMatchObject({
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png',
    });
  }, 20_000);

  it('passes permission_denied from the editor through unchanged', async () => {
    const server = await startServer();
    await openWindow(server, () => ({
      content: [{ type: 'text', text: '{"error":"permission_denied","message":"denied"}' }],
      isError: true,
    }));
    const client = await startMcp();
    const reply = await callTool(client, 'generate_asset', { prompt: 'a coin', name: 'coin' });
    expect(reply).toMatchObject({ isError: true, body: { error: 'permission_denied' } });
  }, 20_000);

  it('no_workspace_server when no pix3 serve runs, and recovers once one does', async () => {
    const client = await startMcp();
    const down = await callTool(client, 'project_status');
    expect(down.isError).toBe(true);
    expect(down.body.error).toBe('no_workspace_server');
    expect(String(down.body.message)).toContain('Run `pix3 serve` in');

    await startServer();
    const up = await callTool(client, 'project_status');
    expect(up.isError).toBe(false);
    expect(up.body.connected).toBe(false);
  }, 20_000);
});
