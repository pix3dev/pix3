/**
 * Unit tests for the Antigravity lane that need no `agy` on the machine.
 *
 * The stream fixtures are verbatim captures from a live `agy 1.2.5` — including the parts that are
 * easy to get wrong from the docs alone: the input event is `user` (not `type`), `result.usage` is a
 * running total rather than a prompt size, and MCP calls come back denied unless the CLI was started
 * with the permission opt-in.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { parseModelCatalog, toAgyModel } from './agy.ts';
import { AgySession, parseAgyEvent, type AgyProcessHandle } from './agy-session.ts';
import { ConversationStore, conversationKey } from './agy-conversations.ts';
import { ToolRelay } from './tool-relay.ts';
import type { WireMessagesRequest } from './wire.ts';

// A verbatim `agy models` capture, banner line and all.
const MODELS_STDOUT = [
  'Fetching available models...',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
  'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
  'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
  '',
].join('\n');

describe('agy model catalog', () => {
  it('ignores the banner and collapses effort variants into one model', () => {
    const entries = parseModelCatalog(MODELS_STDOUT);
    const ids = entries.map(entry => entry.id);
    assert.deepEqual(ids, [
      'gemini-3.8-flash',
      'gemini-3.1-pro',
      'claude-sonnet-4-6',
      'gpt-oss-120b-medium',
    ]);
    assert.deepEqual(
      entries.find(entry => entry.id === 'gemini-3.8-flash')?.efforts,
      ['low', 'medium', 'high']
    );
    // Only the levels that actually exist: 3.1 Pro ships low and high, no medium.
    assert.deepEqual(entries.find(entry => entry.id === 'gemini-3.1-pro')?.efforts, ['low', 'high']);
  });

  it('keeps a single-variant id whose name merely ends in an effort word', () => {
    // `gpt-oss-120b-medium` is one model, not a family: `--model gpt-oss-120b` is rejected by the CLI.
    const entry = parseModelCatalog(MODELS_STDOUT).find(item => item.id === 'gpt-oss-120b-medium');
    assert.ok(entry);
    assert.deepEqual(entry.efforts, []);
    assert.equal(entry.label, 'GPT-OSS 120B (Medium)');
  });

  it('never claims image support and gates tools on the caller', () => {
    const [flash] = parseModelCatalog(MODELS_STDOUT);
    assert.equal(toAgyModel(flash, true).capabilities.supportsTools, true);
    const without = toAgyModel(flash, false);
    assert.equal(without.capabilities.supportsTools, false);
    assert.equal(without.capabilities.supportsImages, false);
    assert.deepEqual(without.capabilities.reasoningEfforts, ['low', 'medium', 'high']);
  });
});

describe('agy stream parser', () => {
  it('reads the event kinds agy actually emits and rejects noise', () => {
    assert.equal(parseAgyEvent('not json'), null);
    assert.equal(parseAgyEvent('{"nope":1}'), null);
    assert.equal(parseAgyEvent('{"event":"init","conversation_id":"abc"}')?.event, 'init');
  });
});

// -- a fake agy process -------------------------------------------------------

class FakeAgy implements AgyProcessHandle {
  readonly pid = 4242;
  readonly turns: string[] = [];
  killed = false;
  private stdout: ((chunk: string) => void) | null = null;
  private exit: ((code: number | null, signal: string | null) => void) | null = null;

  write(line: string): void {
    this.turns.push(line.trim());
  }
  endInput(): void {}
  kill(force: boolean): void {
    this.killed = true;
    void force;
  }
  onStdout(listener: (chunk: string) => void): void {
    this.stdout = listener;
  }
  onStderr(): void {}
  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.exit = listener;
  }

  /** Feed the session one or more NDJSON lines, exactly as agy would. */
  emit(...events: Array<Record<string, unknown>>): void {
    for (const event of events) this.stdout?.(`${JSON.stringify(event)}\n`);
  }
  die(code: number): void {
    this.exit?.(code, null);
  }
}

const step = (extra: Record<string, unknown>): Record<string, unknown> => ({
  event: 'step_update',
  step_update: { conversation_id: 'conv-1', ...extra },
});

const makeRequest = (overrides: Partial<WireMessagesRequest> = {}): WireMessagesRequest =>
  ({
    model: 'gemini-3.8-flash',
    system: 'You are the pix3 agent.',
    messages: [{ role: 'user', content: 'hello' }],
    output_config: { effort: 'low' },
    ...overrides,
  }) as WireMessagesRequest;

const startSession = (
  request: WireMessagesRequest = makeRequest(),
  options: { allowTools?: boolean; conversationId?: string } = {}
): { session: AgySession; fake: FakeAgy; args: string[] } => {
  const fake = new FakeAgy();
  let args: string[] = [];
  const session = new AgySession(request, () => {}, {
    binary: 'agy',
    allowTools: options.allowTools ?? false,
    mcpUrl: 'http://127.0.0.1:1/agents/agy/mcp',
    mcpToken: 'mcp-token',
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    spawner: (_file, spawnArgs) => {
      args = [...spawnArgs];
      return fake;
    },
  });
  return { session, fake, args: args as string[] };
};

describe('AgySession', () => {
  it('spawns with the flags the CLI actually requires', async () => {
    const { session, fake } = startSession();
    const promise = session.handleRequest(makeRequest(), new AbortController().signal);
    // Spawning happens on the first turn, so read the args from the fake's own turn write.
    assert.equal(fake.turns.length, 1);
    const sent = JSON.parse(fake.turns[0]) as { event: string; message: { content: string } };
    assert.equal(sent.event, 'user', 'agy rejects a stream message without an "event" field');
    assert.match(sent.message.content, /operating-instructions/);
    assert.match(sent.message.content, /hello$/);

    fake.emit(
      { event: 'init', conversation_id: 'conv-1', init: { model: 'gemini-3.8-flash' } },
      step({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'hi' }),
      step({
        step_index: 1,
        state: 'DONE',
        step_type: 'agent_response',
        usage: { input_tokens: 14000, output_tokens: 7, thinking_tokens: 0, cache_read_tokens: 0 },
      }),
      { event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'hi' } }
    );

    const response = await promise;
    const body = response.body as {
      content: Array<{ type: string; text?: string }>;
      stop_reason: string;
      usage: Record<string, number>;
    };
    assert.equal(body.stop_reason, 'end_turn');
    assert.deepEqual(body.content, [{ type: 'text', text: 'hi' }]);
    assert.equal(body.usage.input_tokens, 14000);
    assert.equal(body.usage.output_tokens, 7);
    assert.equal(session.getConversationId(), 'conv-1');
  });

  it('reports the prompt size, not the running total agy puts in `result`', async () => {
    const { session, fake } = startSession();
    const promise = session.handleRequest(makeRequest(), new AbortController().signal);
    fake.emit(
      { event: 'init', conversation_id: 'conv-1' },
      step({
        step_index: 1,
        state: 'DONE',
        step_type: 'agent_response',
        usage: { input_tokens: 14007, output_tokens: 83, cache_read_tokens: 0 },
      }),
      step({
        step_index: 3,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: 'done',
        usage: { input_tokens: 14216, output_tokens: 39, thinking_tokens: 4, cache_read_tokens: 8120 },
      }),
      // agy's own total here is 28223 — the SUM of the two steps. Using it would draw a context bar
      // that doubles every hop.
      {
        event: 'result',
        result: { status: 'SUCCESS', response: 'done', usage: { input_tokens: 28223, output_tokens: 122 } },
      }
    );
    const body = (await promise).body as { usage: Record<string, number> };
    assert.equal(body.usage.input_tokens, 14216 - 8120);
    assert.equal(body.usage.cache_read_input_tokens, 8120);
    assert.equal(body.usage.output_tokens, 83 + 39 + 4);
  });

  it('narrates agy\'s own tool steps once, and never its pix3 relay calls', async () => {
    const { session, fake } = startSession();
    const promise = session.handleRequest(makeRequest(), new AbortController().signal);
    fake.emit(
      { event: 'init', conversation_id: 'conv-1' },
      step({
        step_index: 2,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'view_file',
        tool_info: { name: 'view_file', parameters: { AbsolutePath: 'C:/tmp/a.json' } },
      }),
      // The DONE half of the same step must not produce a second marker.
      step({
        step_index: 2,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'view_file',
        tool_info: { name: 'view_file', parameters: { AbsolutePath: 'C:/tmp/a.json' } },
      }),
      step({
        step_index: 4,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'call_mcp_tool',
        tool_info: { name: 'call_mcp_tool', parameters: { ServerName: 'pix3', ToolName: 'list_nodes' } },
      }),
      step({ step_index: 5, state: 'DONE', step_type: 'agent_response', text_delta: 'ok' }),
      { event: 'result', result: { status: 'SUCCESS', response: 'ok' } }
    );
    const body = (await promise).body as { content: Array<{ text: string }> };
    const markers = body.content.filter(block => block.text.startsWith('[agy]'));
    assert.equal(markers.length, 1);
    assert.match(markers[0].text, /view_file\(AbsolutePath=C:\/tmp\/a\.json\)/);
  });

  it('answers with tool_use as soon as a relay call parks, then feeds the result back', async () => {
    const request = makeRequest({
      tools: [{ name: 'list_nodes', description: 'List nodes', input_schema: { type: 'object' } }],
    });
    const { session, fake } = startSession(request, { allowTools: true });
    const first = session.handleRequest(request, new AbortController().signal);
    fake.emit({ event: 'init', conversation_id: 'conv-1' });

    // agy calls the tool through the shim → the bridge parks it → the HTTP turn must flush.
    const toolPromise = session.callTool('list_nodes', { depth: 1 });
    const body = (await first).body as {
      content: Array<Record<string, unknown>>;
      stop_reason: string;
    };
    assert.equal(body.stop_reason, 'tool_use');
    const call = body.content.find(block => block.type === 'tool_use');
    assert.ok(call, 'the response must carry the minted tool_use block');
    const toolUseId = String(call.id);
    assert.match(toolUseId, /^toolu_/);
    assert.equal(call.name, 'list_nodes');

    const second = session.handleRequest(
      {
        ...request,
        messages: [
          ...request.messages,
          { role: 'assistant', content: [call] },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Root, Player' }],
          },
        ],
      } as WireMessagesRequest,
      new AbortController().signal
    );
    const toolResult = await toolPromise;
    assert.equal(toolResult.content[0].text, 'Root, Player');
    // No new turn was pushed at agy: the tool answer IS the input that unblocks it.
    assert.equal(fake.turns.length, 1);

    fake.emit(
      step({ step_index: 6, state: 'DONE', step_type: 'agent_response', text_delta: 'two nodes' }),
      { event: 'result', result: { status: 'SUCCESS', response: 'two nodes' } }
    );
    const finalBody = (await second).body as { stop_reason: string };
    assert.equal(finalBody.stop_reason, 'end_turn');
  });

  it('turns a denied MCP call into an actionable error rather than a silent empty answer', async () => {
    const { session, fake } = startSession(makeRequest(), { allowTools: true });
    const promise = session.handleRequest(makeRequest(), new AbortController().signal);
    fake.emit(
      { event: 'init', conversation_id: 'conv-1' },
      {
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: '',
          denied_actions: [{ action: 'mcp', display_name: 'CallMcpTool' }],
        },
      }
    );
    await assert.rejects(promise, /dangerously-skip-permissions/);
  });

  it('maps a quota failure to 429 and an auth failure to 401', async () => {
    for (const [message, status] of [
      ['RESOURCE_EXHAUSTED: Individual quota reached', 429],
      ['UNAUTHENTICATED: please log in', 401],
    ] as const) {
      const { session, fake } = startSession();
      const promise = session.handleRequest(makeRequest(), new AbortController().signal);
      fake.emit({ event: 'init', conversation_id: 'c' }, { event: 'result', result: { status: 'ERROR', error: message } });
      await assert.rejects(promise, (error: { status?: number }) => error.status === status);
    }
  });

  it('survives an event kind it has never seen', async () => {
    const { session, fake } = startSession();
    const promise = session.handleRequest(makeRequest(), new AbortController().signal);
    fake.emit(
      { event: 'brand_new_event', payload: { whatever: true } },
      step({ step_index: 1, state: 'DONE', step_type: 'some_future_step' }),
      { event: 'result', result: { status: 'SUCCESS', response: 'still fine' } }
    );
    const body = (await promise).body as { content: Array<{ text: string }> };
    assert.equal(body.content[0].text, 'still fine');
  });

  it('reports a process that dies mid-turn instead of hanging until the timeout', async () => {
    const { session, fake } = startSession();
    const promise = session.handleRequest(makeRequest(), new AbortController().signal);
    fake.die(1);
    await assert.rejects(promise, /exited unexpectedly/);
  });

  it('refuses to be mistaken for another chat of the same length', async () => {
    // The live failure this pins: two chats, both two messages long, same model. The router matched
    // on length alone and handed chat B's follow-up to chat A's session, which answered from ITS
    // history ("BRIDGE-OK" came back as the answer to "what was the code word?").
    const chatA = makeRequest({ messages: [{ role: 'user', content: 'Reply with: BRIDGE-OK' }] });
    const { session, fake } = startSession(chatA);
    const promise = session.handleRequest(chatA, new AbortController().signal);
    fake.emit(
      { event: 'init', conversation_id: 'conv-a' },
      step({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'BRIDGE-OK' }),
      { event: 'result', result: { status: 'SUCCESS', response: 'BRIDGE-OK' } }
    );
    await promise;
    assert.equal(session.transcriptLen, 2);

    const followUpToA = makeRequest({
      messages: [
        { role: 'user', content: 'Reply with: BRIDGE-OK' },
        { role: 'assistant', content: 'BRIDGE-OK' },
        { role: 'user', content: 'and again?' },
      ],
    });
    assert.equal(session.matchesChat(followUpToA), true);

    const followUpToB = makeRequest({
      messages: [
        { role: 'user', content: 'Remember the code word MARMOT. Just say ok.' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'What was the code word?' },
      ],
    });
    assert.equal(session.matchesChat(followUpToB), false);
    session.close('test');
  });

  it('skips the system preamble when it is resuming an existing conversation', () => {
    const { session, fake } = startSession(makeRequest(), { conversationId: 'conv-old' });
    assert.equal(session.resumesInsteadOfReplay, true);
    // The turn is abandoned on purpose — only the first stdin write is under test.
    session.handleRequest(makeRequest(), new AbortController().signal).catch(() => {});
    const sent = JSON.parse(fake.turns[0]) as { message: { content: string } };
    assert.equal(sent.message.content, 'hello');
    session.close('test');
  });
});

describe('ToolRelay', () => {
  it('fails an invented tool immediately instead of blocking the turn', async () => {
    const relay = new ToolRelay();
    relay.setTools([{ name: 'real', description: 'd', input_schema: { type: 'object' } }]);
    const result = await relay.call('imaginary', {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No editor tool named "imaginary"/);
  });

  it('hands each result to its own parked call', async () => {
    const relay = new ToolRelay();
    relay.setTools([{ name: 'a', description: 'd', input_schema: { type: 'object' } }]);
    const first = relay.call('a', { n: 1 });
    const second = relay.call('a', { n: 2 });
    const blocks = relay.takeUnflushedBlocks();
    assert.equal(blocks.length, 2);
    assert.equal(relay.hasUnflushed(), false, 'a flushed block must not be sent twice');
    relay.resolveResults([
      { toolUseId: String(blocks[1].id), content: 'second', isError: false },
      { toolUseId: String(blocks[0].id), content: 'first', isError: false },
    ]);
    assert.equal((await first).content[0].text, 'first');
    assert.equal((await second).content[0].text, 'second');
  });
});

describe('the MCP shim agy spawns', () => {
  /**
   * The shim is a generated file, so it is never typechecked — this drives the real script against a
   * stub relay. The protocol details below are all from a live capture: agy sends a non-standard
   * `server/discover` BEFORE `initialize`, and a shim that rejects unknown requests never gets to
   * `initialize` at all.
   */
  it('answers discover/initialize/list/call and forwards the session id it inherited', async () => {
    const { installShim, agyShimPath } = await import('./mcp-shim.ts');
    installShim();

    const seen: Array<{ session: string; token: string; method: string }> = [];
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => (body += String(chunk)));
      req.on('end', () => {
        const { method, params } = JSON.parse(body) as {
          method: string;
          params: Record<string, unknown>;
        };
        seen.push({
          session: decodeURIComponent((req.url ?? '').split('/').pop() ?? ''),
          token: String(req.headers['x-pix3-mcp-token'] ?? ''),
          method,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            method === 'tools/list'
              ? { tools: [{ name: 'list_nodes', description: 'd', inputSchema: { type: 'object' } }] }
              : { content: [{ type: 'text', text: `called ${String(params.name)}` }] }
          )
        );
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { spawn } = await import('node:child_process');
    const shim = spawn(process.execPath, [agyShimPath()], {
      env: {
        ...process.env,
        PIX3_BRIDGE_SESSION: 'sess-42',
        PIX3_BRIDGE_MCP_URL: `http://127.0.0.1:${port}/agents/agy/mcp`,
        PIX3_BRIDGE_MCP_TOKEN: 'relay-token',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const replies: Array<Record<string, unknown>> = [];
    let buffered = '';
    shim.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) replies.push(JSON.parse(line) as Record<string, unknown>);
        newline = buffered.indexOf('\n');
      }
    });

    for (const message of [
      { jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_nodes', arguments: {} } },
    ]) {
      shim.stdin.write(`${JSON.stringify(message)}\n`);
    }
    for (let attempt = 0; attempt < 100 && replies.length < 4; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    shim.stdin.end();
    shim.kill();
    await new Promise<void>(resolve => server.close(() => resolve()));

    assert.equal(replies.length, 4, `shim answered ${replies.length} of 4`);
    // An unknown method must get a result, not an error, or agy never reaches `initialize`.
    assert.ok(replies[0].result, 'server/discover must be answered, not rejected');
    assert.equal(
      (replies[1].result as { protocolVersion: string }).protocolVersion,
      '2025-11-25',
      'the shim echoes the version agy offered'
    );
    const tools = (replies[2].result as { tools: Array<{ name: string }> }).tools;
    assert.deepEqual(tools.map(tool => tool.name), ['list_nodes']);
    assert.match(
      ((replies[3].result as { content: Array<{ text: string }> }).content[0].text),
      /called list_nodes/
    );
    // Every hop carried the session identity and the relay-only token, never the pairing token.
    assert.deepEqual(
      seen.map(entry => entry.method),
      ['tools/list', 'tools/call']
    );
    assert.ok(seen.every(entry => entry.session === 'sess-42' && entry.token === 'relay-token'));
  });

  it('finishes a call that is still in flight when stdin closes', async () => {
    // Found live: the shim exited the moment stdin ended, so a tool call the editor was still
    // running came back to agy as nothing at all.
    const { installShim, agyShimPath } = await import('./mcp-shim.ts');
    installShim();
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      req.resume();
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: 'slow but delivered' }] }));
      }, 300);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const { spawn } = await import('node:child_process');
    const shim = spawn(process.execPath, [agyShimPath()], {
      env: {
        ...process.env,
        PIX3_BRIDGE_SESSION: 's',
        PIX3_BRIDGE_MCP_URL: `http://127.0.0.1:${port}/agents/agy/mcp`,
        PIX3_BRIDGE_MCP_TOKEN: 't',
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    shim.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    shim.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } })}\n`
    );
    shim.stdin.end(); // agy tearing the transport down mid-call
    await new Promise<void>(resolve => shim.on('exit', () => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.match(out, /slow but delivered/);
  });
});

describe('ConversationStore', () => {
  it('keys a chat on its opening exchange, so two "hi" chats do not collide', () => {
    const a = conversationKey([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'about physics' },
    ]);
    const b = conversationKey([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'about shaders' },
    ]);
    assert.notEqual(a, b);
  });

  it('round-trips through disk and drops entries older than the retention window', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix3-agy-store-'));
    const file = path.join(dir, 'agy-sessions.json');
    const now = Date.UTC(2026, 0, 1);
    const store = new ConversationStore(file, () => now);
    store.remember('fresh', { conversationId: 'c1', model: 'm', transcriptLen: 3, updatedAt: now });
    store.remember('stale', {
      conversationId: 'c2',
      model: 'm',
      transcriptLen: 1,
      updatedAt: now - 40 * 24 * 60 * 60 * 1000,
    });

    const reopened = new ConversationStore(file, () => now);
    assert.equal(reopened.get('fresh')?.conversationId, 'c1');
    assert.equal(reopened.get('stale'), undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
