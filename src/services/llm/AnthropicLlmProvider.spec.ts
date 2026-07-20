import { describe, expect, it, vi } from 'vitest';
import { AnthropicLlmProvider } from './AnthropicLlmProvider';
import { LlmError, type LlmMessage } from './LlmTypes';

const BASE = 'https://anthropic.test/v1';

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const errJson = (status: number, message: string): Response =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const bodyOf = (fetchImpl: ReturnType<typeof vi.fn>): Record<string, unknown> =>
  JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>;

describe('AnthropicLlmProvider', () => {
  const provider = new AnthropicLlmProvider();

  it('posts to /messages with the browser-access header and maps system + tools', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' })
    );

    const result = await provider.chat(
      {
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
          { name: 'get_selection', description: 'Selection', inputSchema: { type: 'object' } },
        ],
      },
      { apiKey: 'sk-ant', modelId: 'claude-opus-4-8', baseUrl: BASE, fetchImpl }
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/messages`);
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');

    const body = bodyOf(fetchImpl);
    expect(body).toMatchObject({ model: 'claude-opus-4-8', system: 'You are helpful.' });
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ name: 'get_selection', input_schema: { type: 'object' } });

    expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(result.stopReason).toBe('end_turn');
  });

  it('forwards a reasoning effort as output_config.effort', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' })
    );
    await provider.chat(
      { messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'xhigh' },
      { apiKey: 'sk-ant', modelId: 'claude-opus-4-8', baseUrl: BASE, fetchImpl }
    );
    expect(bodyOf(fetchImpl).output_config).toEqual({ effort: 'xhigh' });
  });

  it('omits output_config when no reasoning effort is set', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' })
    );
    await provider.chat(
      { messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'sk-ant', modelId: 'claude-opus-4-8', baseUrl: BASE, fetchImpl }
    );
    expect(bodyOf(fetchImpl).output_config).toBeUndefined();
  });

  it('places cache_control breakpoints when a cache hint is supplied', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' })
    );

    await provider.chat(
      {
        system: 'STABLE-HEAD|volatile-tail',
        cache: { systemStableChars: 'STABLE-HEAD'.length, conversation: true },
        messages: [
          { role: 'user', content: 'a' },
          { role: 'user', content: [{ type: 'text', text: 'b' }] },
        ],
        tools: [
          { name: 'first', description: 'd1', inputSchema: { type: 'object' } },
          { name: 'last', description: 'd2', inputSchema: { type: 'object' } },
        ],
      },
      { apiKey: 'sk', modelId: 'claude-opus-4-8', baseUrl: BASE, fetchImpl }
    );

    const body = bodyOf(fetchImpl);
    // System split into a cached head + uncached tail; the two concatenate back to the original.
    const system = body.system as Array<Record<string, unknown>>;
    expect(system).toEqual([
      { type: 'text', text: 'STABLE-HEAD', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '|volatile-tail' },
    ]);
    // Only the LAST tool carries the breakpoint (it caches the whole preceding tool list).
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual({ type: 'ephemeral' });
    // Conversation caching marks the last block of the last message.
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[0].content[0].cache_control).toBeUndefined();
    expect(messages[1].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('reports cache read/creation tokens and folds them into the total input count', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 120,
          output_tokens: 14,
          cache_read_input_tokens: 6000,
          cache_creation_input_tokens: 400,
        },
      })
    );

    const result = await provider.chat(
      { messages: [{ role: 'user', content: 'x' }] },
      { apiKey: 'sk', modelId: 'claude-opus-4-8', baseUrl: BASE, fetchImpl }
    );

    // inputTokens is cache-inclusive: 120 fresh + 6000 read + 400 written.
    expect(result.usage).toEqual({
      inputTokens: 6520,
      outputTokens: 14,
      cacheReadTokens: 6000,
      cacheCreationTokens: 400,
    });
  });

  it('sends the plain system string and uncached tools without a cache hint', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' })
    );

    await provider.chat(
      {
        system: 'plain',
        messages: [{ role: 'user', content: 'x' }],
        tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
      },
      { apiKey: 'sk', modelId: 'claude-opus-4-8', baseUrl: BASE, fetchImpl }
    );

    const body = bodyOf(fetchImpl);
    expect(body.system).toBe('plain');
    expect((body.tools as Array<Record<string, unknown>>)[0].cache_control).toBeUndefined();
  });

  it('round-trips tool_use / tool_result blocks by id', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'set_property', input: { nodeId: 'n1' } },
        ],
        stop_reason: 'tool_use',
      })
    );

    const messages: LlmMessage[] = [
      { role: 'user', content: 'move it' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-use', id: 'toolu_1', name: 'set_property', input: { nodeId: 'n1' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool-result', toolUseId: 'toolu_1', content: 'ok', isError: false }],
      },
    ];

    const result = await provider.chat(
      { messages },
      { apiKey: 'sk', modelId: 'claude-opus-4-8', baseUrl: BASE, fetchImpl }
    );

    const body = bodyOf(fetchImpl);
    const sent = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(sent[1].content[0]).toMatchObject({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'set_property',
    });
    expect(sent[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: 'ok',
    });

    // Parsed response tool call:
    expect(result.stopReason).toBe('tool_use');
    expect(result.content).toEqual([
      { type: 'tool-use', id: 'toolu_1', name: 'set_property', input: { nodeId: 'n1' } },
    ]);
  });

  it('serialises an error tool-result with is_error', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ content: [{ type: 'text', text: 'noted' }], stop_reason: 'end_turn' })
    );

    await provider.chat(
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool-result', toolUseId: 't1', content: 'boom', isError: true }],
          },
        ],
      },
      { apiKey: 'sk', modelId: 'claude-opus-4-8', baseUrl: BASE, fetchImpl }
    );

    const body = bodyOf(fetchImpl);
    const sent = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(sent[0].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 't1',
      is_error: true,
    });
  });

  it('maps a refusal stop_reason to a blocked LlmError', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ content: [], stop_reason: 'refusal', stop_details: { explanation: 'nope' } })
    );
    const error = await provider
      .chat(
        { messages: [{ role: 'user', content: 'x' }] },
        {
          apiKey: 'sk',
          modelId: 'claude-opus-4-8',
          baseUrl: BASE,
          fetchImpl,
        }
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind: 'blocked' });
  });

  it('rejects a missing key without hitting the network', async () => {
    const fetchImpl = vi.fn();
    await expect(
      provider.chat(
        { messages: [{ role: 'user', content: 'x' }] },
        {
          apiKey: '',
          modelId: 'claude-opus-4-8',
          fetchImpl,
        }
      )
    ).rejects.toMatchObject({ kind: 'missing-key' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps a 401 to an http LlmError carrying the status', async () => {
    const fetchImpl = vi.fn(async () => errJson(401, 'bad key'));
    const error = await provider
      .chat(
        { messages: [{ role: 'user', content: 'x' }] },
        {
          apiKey: 'bad',
          modelId: 'claude-opus-4-8',
          baseUrl: BASE,
          fetchImpl,
        }
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'http', status: 401 });
  });
});
