import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatLlmProvider } from './OpenAICompatLlmProvider';
import { LlmError, type LlmMessage } from './LlmTypes';

const BASE = 'https://local.test/v1';

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

describe('OpenAICompatLlmProvider', () => {
  const provider = new OpenAICompatLlmProvider();

  it('maps system + user + tools to Chat Completions with a Bearer key', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] })
    );

    const result = await provider.chat(
      {
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'scene_tree', description: 'read', inputSchema: { type: 'object' } }],
      },
      { apiKey: 'sk-1', modelId: 'gpt-4.1', baseUrl: BASE, fetchImpl }
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/chat/completions`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-1');

    const body = bodyOf(fetchImpl);
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hello' },
    ]);
    const tools = body.tools as Array<{ type: string; function: Record<string, unknown> }>;
    expect(tools[0]).toMatchObject({ type: 'function', function: { name: 'scene_tree' } });

    expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(result.stopReason).toBe('end_turn');
  });

  it('surfaces cached prompt tokens from prompt_tokens_details', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 7000,
          completion_tokens: 12,
          prompt_tokens_details: { cached_tokens: 6144 },
        },
      })
    );

    const result = await provider.chat(
      { messages: [{ role: 'user', content: 'x' }] },
      { apiKey: 'sk', modelId: 'gpt-4.1', baseUrl: BASE, fetchImpl }
    );

    // prompt_tokens is already cache-inclusive here; cached_tokens is the subset served from cache.
    expect(result.usage).toEqual({
      inputTokens: 7000,
      outputTokens: 12,
      cacheReadTokens: 6144,
    });
  });

  it('flattens assistant tool_calls and a following tool-result into role:"tool" messages', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] })
    );

    const messages: LlmMessage[] = [
      { role: 'user', content: 'move it' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling' },
          { type: 'tool-use', id: 'call_1', name: 'set_property', input: { nodeId: 'n1' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool-result', toolUseId: 'call_1', content: 'ok' }],
      },
    ];

    await provider.chat(
      { messages },
      { apiKey: 'sk', modelId: 'gpt-4.1', baseUrl: BASE, fetchImpl }
    );

    const body = bodyOf(fetchImpl);
    const sent = body.messages as Array<Record<string, unknown>>;
    // assistant message carries content + tool_calls with stringified arguments
    const assistant = sent[1];
    expect(assistant.role).toBe('assistant');
    const toolCalls = assistant.tool_calls as Array<{
      id: string;
      function: { name: string; arguments: string };
    }>;
    expect(toolCalls[0]).toMatchObject({ id: 'call_1', function: { name: 'set_property' } });
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ nodeId: 'n1' });
    // tool-result flattened to a standalone role:"tool" message
    expect(sent[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'ok' });
  });

  it('parses tool_calls from the response into tool-use blocks (arguments JSON-decoded)', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_9',
                  type: 'function',
                  function: { name: 'find_nodes', arguments: '{"text":"box"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })
    );

    const result = await provider.chat(
      { messages: [{ role: 'user', content: 'find boxes' }] },
      { apiKey: 'sk', modelId: 'gpt-4.1', baseUrl: BASE, fetchImpl }
    );

    expect(result.stopReason).toBe('tool_use');
    expect(result.content).toEqual([
      { type: 'tool-use', id: 'call_9', name: 'find_nodes', input: { text: 'box' } },
    ]);
  });

  it('sends no Authorization header for a keyless local endpoint', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] })
    );

    await provider.chat(
      { messages: [{ role: 'user', content: 'x' }] },
      { apiKey: '', modelId: 'llama3.1', baseUrl: BASE, fetchImpl }
    );

    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('rejects a missing key only for the hosted OpenAI default host', async () => {
    const fetchImpl = vi.fn();
    await expect(
      provider.chat(
        { messages: [{ role: 'user', content: 'x' }] },
        {
          apiKey: '',
          modelId: 'gpt-4.1',
          // no baseUrl → hosted default
          fetchImpl,
        }
      )
    ).rejects.toMatchObject({ kind: 'missing-key' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists models from GET {base}/models, merging static capability hints for known ids', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ object: 'list', data: [{ id: 'qwen3:8b' }, { id: 'gpt-4.1' }] })
    );

    const models = await provider.listModels({ apiKey: 'sk-1', baseUrl: BASE, fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/models`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-1');
    expect(models.map(m => m.id)).toEqual(['gpt-4.1', 'qwen3:8b']);
    // A known id keeps its static capability hints; an unknown one gets safe defaults.
    expect(models[0].capabilities.supportsImages).toBe(true);
    expect(models[1].capabilities).toMatchObject({ supportsTools: true, supportsImages: false });
  });

  it('maps a 404 to an http LlmError carrying the status', async () => {
    const fetchImpl = vi.fn(async () => errJson(404, 'no model'));
    const error = await provider
      .chat(
        { messages: [{ role: 'user', content: 'x' }] },
        {
          apiKey: 'sk',
          modelId: 'gpt-4.1',
          baseUrl: BASE,
          fetchImpl,
        }
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind: 'http', status: 404 });
  });

  it('flags a 200 with no usable choice as a retryable "empty" error', async () => {
    // Free / rate-limited models occasionally return a 200 whose body has no choices[0].message.
    const fetchImpl = vi.fn(async () => okJson({ choices: [] }));
    const error = await provider
      .chat(
        { messages: [{ role: 'user', content: 'x' }] },
        { apiKey: 'sk', modelId: 'gpt-4.1', baseUrl: BASE, fetchImpl }
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind: 'empty' });
  });

  it('surfaces a provider error wrapped in a 200 body instead of a generic message', async () => {
    // Some gateways return {error:{message}} with HTTP 200 rather than an error status.
    const fetchImpl = vi.fn(async () => okJson({ error: { message: 'no capacity right now' } }));
    const error = await provider
      .chat(
        { messages: [{ role: 'user', content: 'x' }] },
        { apiKey: 'sk', modelId: 'gpt-4.1', baseUrl: BASE, fetchImpl }
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind: 'http', message: 'no capacity right now' });
  });
});
