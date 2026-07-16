import { describe, expect, it, vi } from 'vitest';
import { ClaudeBridgeLlmProvider } from './ClaudeBridgeLlmProvider';
import { LlmError } from './LlmTypes';

const BASE = 'http://127.0.0.1:8484/v1';

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('ClaudeBridgeLlmProvider', () => {
  const provider = new ClaudeBridgeLlmProvider();

  it('is a fixed local endpoint with zero pricing and the bridge secret id', () => {
    expect(provider.id).toBe('claude-bridge');
    expect(provider.requiresBaseUrl).toBe(false);
    expect(provider.defaultBaseUrl).toBe(BASE);
    expect(provider.apiKeySecretId).toBe('ai-provider:claude-bridge:api-key');
    expect(provider.models.length).toBeGreaterThan(0);
    for (const model of provider.models) {
      expect(model.pricing).toEqual({ inputPer1M: 0, outputPer1M: 0 });
    }
  });

  it('posts the Messages wire shape with only the pairing token header', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_selection', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 2 },
      })
    );

    const result = await provider.chat(
      {
        system: 'You are pix3.',
        messages: [{ role: 'user', content: 'select something' }],
        tools: [
          { name: 'get_selection', description: 'Selection', inputSchema: { type: 'object' } },
        ],
      },
      { apiKey: 'pairing-token', modelId: 'claude-opus-4-8', baseUrl: BASE, fetchImpl }
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/messages`);
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('pairing-token');
    // Same-machine bridge: the Anthropic browser-access opt-in must not be sent.
    expect(headers['anthropic-dangerous-direct-browser-access']).toBeUndefined();
    expect(headers['anthropic-version']).toBeUndefined();

    expect(result.stopReason).toBe('tool_use');
    expect(result.content).toEqual([
      { type: 'tool-use', id: 'toolu_1', name: 'get_selection', input: {} },
    ]);
  });

  it('rejects with missing-key before hitting the network', async () => {
    const fetchImpl = vi.fn();
    await expect(
      provider.chat(
        { messages: [{ role: 'user', content: 'hi' }] },
        { apiKey: '', modelId: 'claude-opus-4-8', baseUrl: BASE, fetchImpl }
      )
    ).rejects.toMatchObject({ kind: 'missing-key' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists models from the bridge and filters malformed entries', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        models: [
          {
            id: 'claude-fable-5',
            label: 'Claude Fable 5 (MAX)',
            capabilities: {
              supportsTools: true,
              supportsImages: true,
              supportsSystemPrompt: true,
              maxOutputTokens: 32000,
            },
            pricing: { inputPer1M: 0, outputPer1M: 0 },
          },
          { id: 'broken' },
        ],
      })
    );

    const models = await provider.listModels({ apiKey: 'pairing-token', baseUrl: BASE, fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/models`);
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('pairing-token');
    expect(models.map(model => model.id)).toEqual(['claude-fable-5']);
  });

  it('maps an unreachable bridge to a network LlmError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(provider.listModels({ baseUrl: BASE, fetchImpl })).rejects.toSatisfy(
      error => error instanceof LlmError && error.kind === 'network'
    );
  });
});
