import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeZenLlmProvider } from './OpenCodeZenLlmProvider';
import { resetModelsDevCache } from './models-dev';

const BASE = '/zen-proxy/zen/v1';

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/** models.dev payload with two Zen models: one free, one paid+vision (claude). */
const MODELS_DEV_PAYLOAD = {
  opencode: {
    models: {
      'glm-5-free': {
        name: 'GLM-5 Free',
        tool_call: true,
        reasoning: true,
        attachment: false,
        limit: { context: 204800, output: 131072 },
        cost: { input: 0, output: 0 },
      },
      'claude-sonnet-5': {
        name: 'Claude Sonnet 5',
        tool_call: true,
        reasoning: true,
        attachment: true,
        limit: { context: 1000000, output: 128000 },
        cost: { input: 2, output: 10 },
      },
      'retired-model': {
        name: 'Retired Model',
        tool_call: true,
        attachment: false,
        limit: { context: 128000, output: 32768 },
        cost: { input: 1, output: 2 },
      },
    },
  },
};

describe('OpenCodeZenLlmProvider', () => {
  const provider = new OpenCodeZenLlmProvider();

  beforeEach(() => {
    resetModelsDevCache();
  });

  it('advertises the same-origin proxy host (Zen sends no CORS headers) and free models first', () => {
    expect(provider.id).toBe('opencode-zen');
    expect(provider.label).toBe('OpenCode Zen');
    expect(provider.requiresBaseUrl).toBe(false);
    expect(provider.defaultBaseUrl).toBe(BASE);
    // The static fallback leads with free models (pricing $0/$0).
    const first = provider.models[0];
    expect(first.pricing).toEqual({ inputPer1M: 0, outputPer1M: 0 });
  });

  it('posts non-Claude models to the Chat Completions surface with a Bearer key', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] })
    );

    const result = await provider.chat(
      { messages: [{ role: 'user', content: 'hello' }] },
      { apiKey: 'zen-1', modelId: 'glm-5.1', fetchImpl }
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/chat/completions`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer zen-1');
    expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('routes Claude models to the Anthropic Messages surface with Bearer auth (not x-api-key)', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        content: [{ type: 'text', text: 'hello from claude' }],
        stop_reason: 'end_turn',
      })
    );

    const result = await provider.chat(
      {
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'scene_tree', description: 'read', inputSchema: { type: 'object' } }],
      },
      { apiKey: 'zen-1', modelId: 'claude-sonnet-5', fetchImpl }
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/messages`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer zen-1');
    expect(headers['x-api-key']).toBeUndefined();

    // Anthropic wire shape: top-level system, input_schema tools.
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.system).toBe('You are helpful.');
    expect((body.tools as Array<Record<string, unknown>>)[0].input_schema).toEqual({
      type: 'object',
    });
    expect(result.content).toEqual([{ type: 'text', text: 'hello from claude' }]);
  });

  it('rejects a missing key on both surfaces', async () => {
    const fetchImpl = vi.fn();
    for (const modelId of ['glm-5.1', 'claude-sonnet-5']) {
      await expect(
        provider.chat(
          { messages: [{ role: 'user', content: 'x' }] },
          { apiKey: '', modelId, fetchImpl }
        )
      ).rejects.toMatchObject({ kind: 'missing-key' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists live models joined with models.dev metadata, free first, retired models dropped', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('models.dev')) {
        return okJson(MODELS_DEV_PAYLOAD);
      }
      // Zen's live /models: claude + glm are served, retired-model is not; one id models.dev lacks.
      return okJson({
        object: 'list',
        data: [{ id: 'claude-sonnet-5' }, { id: 'glm-5-free' }, { id: 'brand-new-model' }],
      });
    }) as unknown as typeof fetch;

    const models = await provider.listModels({ fetchImpl });

    expect(models.map(m => m.id)).toEqual(['glm-5-free', 'brand-new-model', 'claude-sonnet-5']);
    // models.dev metadata joined in: free pricing + capabilities.
    const glm = models[0];
    expect(glm.pricing).toEqual({ inputPer1M: 0, outputPer1M: 0 });
    expect(glm.description).toContain('Free');
    expect(glm.capabilities.supportsTools).toBe(true);
    // A live id missing from models.dev still appears, with safe defaults.
    expect(models[1].capabilities.supportsTools).toBe(true);
    // Retired (catalog-only) models are filtered out by the live list.
    expect(models.some(m => m.id === 'retired-model')).toBe(false);
  });

  it('falls back to the full models.dev catalog when the live listing fails', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('models.dev')) {
        return okJson(MODELS_DEV_PAYLOAD);
      }
      return new Response('gateway down', { status: 502 });
    }) as unknown as typeof fetch;

    const models = await provider.listModels({ fetchImpl });
    expect(models.map(m => m.id)).toEqual(['glm-5-free', 'claude-sonnet-5', 'retired-model']);
  });
});
