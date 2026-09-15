/**
 * The bridge's `tool_use` plumbing, driven without a Claude Code CLI through the session's
 * `startQuery` seam and a real in-memory MCP client.
 *
 * What it guards is the failure the batching work in `.plans/agent-one-shot-generation.md` §4.2
 * predicted from reading this code: the SDK invokes MCP tools ONE AT A TIME, so when a model emits
 * several `tool_use` blocks in one assistant message, only the first ever reaches the bridge before
 * pix3 needs its HTTP answer. Waiting for every block to be parked therefore deadlocked the turn
 * until the 20-minute timeout, and results for the blocks that had not been invoked yet were
 * dropped outright.
 *
 * Run: npm test   (node --test)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { BridgeSession } from './sessions.ts';
import type { BridgeResponse } from './sessions.ts';
import type { WireMessagesRequest } from './wire.ts';

const REQUEST: WireMessagesRequest = {
  model: 'claude-sonnet-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'read both files' }],
  tools: [
    {
      name: 'read_file',
      description: 'Read one file.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ],
} as unknown as WireMessagesRequest;

/** An assistant message carrying `count` independent `read_file` calls — what batching looks like. */
const assistantWithCalls = (count: number) => ({
  type: 'assistant' as const,
  parent_tool_use_id: null,
  message: {
    role: 'assistant',
    content: Array.from({ length: count }, (_, index) => ({
      type: 'tool_use',
      id: `toolu_${index}`,
      name: 'mcp__pix3__read_file',
      input: { path: `file${index}.json` },
    })),
  },
});

interface Harness {
  readonly session: BridgeSession;
  /** Push one SDK message into the session's pump. */
  readonly emit: (message: unknown) => void;
  /** Invoke a bridge tool the way the SDK's MCP client would. Never resolves until pix3 answers. */
  readonly callTool: (path: string) => Promise<unknown>;
  /** End the fake SDK stream and close the session, so `node --test` can exit. */
  readonly dispose: () => void;
}

const makeHarness = async (): Promise<Harness> => {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  let mcp: McpServer | undefined;

  const stream = {
    async *[Symbol.asyncIterator]() {
      while (!ended) {
        if (queue.length > 0) {
          yield queue.shift() as never;
          continue;
        }
        await new Promise<void>(resolve => {
          wake = resolve;
        });
      }
    },
    close() {
      ended = true;
      wake?.();
      wake = null;
    },
    interrupt: async () => {},
  };

  const session = new BridgeSession(
    REQUEST,
    () => {},
    (options: unknown) => {
      const servers = (
        options as { options: { mcpServers: Record<string, { instance: McpServer }> } }
      ).options.mcpServers;
      mcp = servers.pix3.instance;
      return stream as never;
    }
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp!.server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);

  return {
    session,
    emit: message => {
      queue.push(message);
      const waiter = wake;
      wake = null;
      waiter?.();
    },
    callTool: path => client.callTool({ name: 'read_file', arguments: { path } }),
    dispose: () => {
      session.close('test over');
      stream.close();
    },
  };
};

/** Give the pump and the MCP round trip a few turns of the event loop to settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve));
};

describe('several tool_use blocks in one assistant message', () => {
  it('answers pix3 once ONE call is parked, instead of waiting for all of them', async () => {
    const harness = await makeHarness();

    let response: BridgeResponse | null = null;
    const pending = harness.session
      .handleRequest(REQUEST, new AbortController().signal)
      .then(value => (response = value));

    harness.emit(assistantWithCalls(3));
    // Exactly what the SDK does: invoke the first tool and wait for its result before the next.
    void harness.callTool('file0.json');
    await settle();

    assert.ok(response, 'the HTTP request is still hanging — this is the 20-minute deadlock');
    await pending;
    const content = (response as unknown as BridgeResponse).body as { content: unknown[] };
    assert.equal(
      content.content.length,
      3,
      'all three blocks must reach pix3, not just the parked one'
    );
    harness.dispose();
  });

  it('holds a result whose call the SDK has not invoked yet, and hands it over when it is', async () => {
    const harness = await makeHarness();

    const first = harness.session.handleRequest(REQUEST, new AbortController().signal);
    harness.emit(assistantWithCalls(2));
    const call0 = harness.callTool('file0.json');
    await settle();
    await first;

    // pix3 runs BOTH tools and posts both results — the second call has not been invoked yet.
    const next = {
      ...REQUEST,
      messages: [
        ...REQUEST.messages,
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_0', content: 'A' },
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'B' },
          ],
        },
      ],
    } as unknown as WireMessagesRequest;
    harness.session.handleRequest(next, new AbortController().signal).catch(() => {
      // Never answered: this request only exists to deliver the two tool_results.
    });
    await settle();

    const result0 = (await call0) as { content: Array<{ text: string }> };
    assert.equal(result0.content[0].text, 'A');

    // Now the SDK gets round to the second block. Its answer was posted long ago; it must be there.
    const call1 = harness.callTool('file1.json');
    await settle();
    const result1 = (await call1) as { content: Array<{ text: string }> };
    assert.equal(
      result1.content[0].text,
      'B',
      'the second result was dropped — the call can never resolve'
    );
    harness.dispose();
  });
});

describe('output-token accounting', () => {
  /**
   * The SDK under-reports its own output for tool calls — measured, `output_tokens: 2` for an
   * assistant message whose only block was `read_file {"path":"a.json"}`, and 473 tokens across a
   * 51-hop turn. pix3's panel rendered that as "0 tok/s · 2↓" beside a 112K prompt, which reads as
   * "we sent everything and got nothing". The bridge knows what it returns, so it counts.
   */
  it('reports at least the tokens of the content it is actually returning', async () => {
    const harness = await makeHarness();

    let response: BridgeResponse | null = null;
    const pending = harness.session
      .handleRequest(REQUEST, new AbortController().signal)
      .then(value => (response = value));

    harness.emit({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_0',
            name: 'mcp__pix3__read_file',
            input: { path: 'scripts/a-fairly-long-path-that-is-clearly-more-than-two-tokens.ts' },
          },
        ],
        // What the SDK actually says for that message.
        usage: { input_tokens: 762, output_tokens: 2, cache_read_input_tokens: 0 },
      },
    });
    void harness.callTool('scripts/a-fairly-long-path-that-is-clearly-more-than-two-tokens.ts');
    await settle();
    await pending;

    const body = (response as unknown as BridgeResponse).body as {
      usage: { output_tokens: number; input_tokens: number };
    };
    assert.ok(
      body.usage.output_tokens > 10,
      `output_tokens was ${body.usage.output_tokens} — the SDK's under-count went straight through`
    );
    // Everything the SDK gets right is passed through untouched.
    assert.equal(body.usage.input_tokens, 762);
    harness.dispose();
  });
});
