import { describe, expect, it, vi } from 'vitest';
import { GeminiLlmProvider } from './GeminiLlmProvider';
import { LlmError, type LlmMessage } from './LlmTypes';

const BASE = 'https://gen.test/v1beta';

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

describe('GeminiLlmProvider', () => {
  const provider = new GeminiLlmProvider();

  it('maps system + messages + tools into a generateContent request', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }] })
    );

    const result = await provider.chat(
      {
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            name: 'scene_tree',
            description: 'Read the scene.',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
      { apiKey: 'k', modelId: 'gemini-2.5-flash', baseUrl: BASE, fetchImpl }
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/models/gemini-2.5-flash:generateContent`);
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('k');

    const body = bodyOf(fetchImpl);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'You are helpful.' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
    const tools = body.tools as Array<{ functionDeclarations: unknown[] }>;
    expect(tools[0].functionDeclarations[0]).toMatchObject({ name: 'scene_tree' });

    expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(result.stopReason).toBe('end_turn');
  });

  it('parses a functionCall part into a tool-use block with tool_use stop reason', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'set_property', args: { nodeId: 'n1' } } }],
            },
            finishReason: 'STOP',
          },
        ],
      })
    );

    const result = await provider.chat(
      { messages: [{ role: 'user', content: 'move it' }] },
      { apiKey: 'k', modelId: 'gemini-2.5-flash', baseUrl: BASE, fetchImpl }
    );

    expect(result.stopReason).toBe('tool_use');
    expect(result.content).toEqual([
      { type: 'tool-use', id: 'gemini-tool-0', name: 'set_property', input: { nodeId: 'n1' } },
    ]);
  });

  it('serialises a tool-result as a functionResponse, resolving the name from the tool-use block', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] })
    );

    const messages: LlmMessage[] = [
      { role: 'user', content: 'inspect n1' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-use', id: 'gemini-tool-0', name: 'node_inspect', input: { nodeId: 'n1' } },
        ],
      },
      {
        role: 'user',
        // toolName omitted on purpose — provider must resolve it via the tool-use block.
        content: [{ type: 'tool-result', toolUseId: 'gemini-tool-0', content: '{"type":"Box"}' }],
      },
    ];

    await provider.chat(
      { messages },
      { apiKey: 'k', modelId: 'gemini-2.5-flash', baseUrl: BASE, fetchImpl }
    );

    const body = bodyOf(fetchImpl);
    const contents = body.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    // assistant turn → role 'model' with functionCall
    expect(contents[1].role).toBe('model');
    expect(contents[1].parts[0]).toHaveProperty('functionCall');
    // tool-result turn → functionResponse with the resolved function name
    const fnResponse = contents[2].parts[0].functionResponse as { name: string; response: unknown };
    expect(fnResponse.name).toBe('node_inspect');
    expect(fnResponse.response).toEqual({ result: '{"type":"Box"}' });
  });

  it('rejects a missing key without hitting the network', async () => {
    const fetchImpl = vi.fn();
    await expect(
      provider.chat(
        { messages: [{ role: 'user', content: 'x' }] },
        {
          apiKey: '',
          modelId: 'gemini-2.5-flash',
          fetchImpl,
        }
      )
    ).rejects.toMatchObject({ kind: 'missing-key' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps a 429 to an http LlmError carrying the status', async () => {
    const fetchImpl = vi.fn(async () => errJson(429, 'rate limit'));
    const error = await provider
      .chat(
        { messages: [{ role: 'user', content: 'x' }] },
        {
          apiKey: 'k',
          modelId: 'gemini-2.5-flash',
          baseUrl: BASE,
          fetchImpl,
        }
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind: 'http', status: 429 });
  });
});
