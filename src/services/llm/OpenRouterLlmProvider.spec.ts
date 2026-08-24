import { describe, expect, it, vi } from 'vitest';
import { OpenRouterLlmProvider, mapOpenRouterModel } from './OpenRouterLlmProvider';
import { LlmError } from './LlmTypes';

const BASE = 'https://openrouter.ai/api/v1';

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/** One entry of OpenRouter's `GET /models` payload, in the shape the live API returns. */
const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'vendor/model',
  name: 'Vendor: Model',
  context_length: 1_048_576,
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  pricing: { prompt: '0.000002', completion: '0.00001' },
  top_provider: { context_length: 1_048_576, max_completion_tokens: 128_000 },
  supported_parameters: ['max_tokens', 'reasoning_effort', 'tool_choice', 'tools'],
  reasoning: { supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'] },
  ...overrides,
});

describe('mapOpenRouterModel', () => {
  it('reads capabilities, context, per-1M pricing and reasoning levels from one catalog entry', () => {
    const model = mapOpenRouterModel(entry());
    expect(model).not.toBeNull();
    expect(model?.id).toBe('vendor/model');
    expect(model?.label).toBe('Vendor: Model');
    expect(model?.capabilities.supportsImages).toBe(true);
    expect(model?.capabilities.contextWindow).toBe(1_048_576);
    // Advertised output is capped, never the model's six-figure ceiling.
    expect(model?.capabilities.maxOutputTokens).toBe(32_768);
    // Per-token strings become USD per 1M tokens.
    expect(model?.pricing).toEqual({ inputPer1M: 2, outputPer1M: 10 });
    // Cheapest → deepest, and the extended levels survive (this model really takes them).
    expect(model?.capabilities.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(model?.description).toBe('1024K ctx · vision · reasoning');
  });

  it('drops models the agent cannot drive: no tool calling, and the async :batch variants', () => {
    expect(
      mapOpenRouterModel(entry({ supported_parameters: ['max_tokens', 'temperature'] }))
    ).toBeNull();
    expect(mapOpenRouterModel(entry({ id: 'vendor/model:batch' }))).toBeNull();
    expect(mapOpenRouterModel({ name: 'no id' })).toBeNull();
  });

  it('marks $0/$0 models free and omits the reasoning knob when the model has none', () => {
    const model = mapOpenRouterModel(
      entry({
        id: 'vendor/model:free',
        pricing: { prompt: '0', completion: '0' },
        architecture: { input_modalities: ['text'] },
        supported_parameters: ['max_tokens', 'tools'],
        reasoning: null,
      })
    );
    expect(model?.pricing).toEqual({ inputPer1M: 0, outputPer1M: 0 });
    expect(model?.capabilities.reasoningEfforts).toBeUndefined();
    expect(model?.description).toBe('Free · 1024K ctx');
  });

  it('ignores OpenRouter levels we have no name for (minimal / none)', () => {
    const model = mapOpenRouterModel(
      entry({ reasoning: { supported_efforts: ['high', 'medium', 'low', 'minimal', 'none'] } })
    );
    expect(model?.capabilities.reasoningEfforts).toEqual(['low', 'medium', 'high']);
  });
});

describe('OpenRouterLlmProvider', () => {
  const provider = new OpenRouterLlmProvider();

  it('is called directly (OpenRouter sends CORS headers) with a fixed host and required key', () => {
    expect(provider.id).toBe('openrouter');
    expect(provider.label).toBe('OpenRouter');
    expect(provider.requiresBaseUrl).toBe(false);
    expect(provider.defaultBaseUrl).toBe(BASE);
    expect(provider.apiKeySecretId).toBe('ai-provider:openrouter:api-key');
    // The static fallback leads with a free model.
    expect(provider.models[0].pricing).toEqual({ inputPer1M: 0, outputPer1M: 0 });
  });

  it('rejects a missing key before hitting the network', async () => {
    const fetchImpl = vi.fn();
    await expect(
      provider.chat(
        { messages: [{ role: 'user', content: 'hi' }] },
        { apiKey: '', modelId: 'vendor/model', fetchImpl: fetchImpl as unknown as typeof fetch }
      )
    ).rejects.toMatchObject({ kind: 'missing-key' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the attribution headers and passes an extended reasoning level through unclamped', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      })
    );

    const result = await provider.chat(
      { messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'xhigh' },
      {
        apiKey: 'k',
        modelId: 'anthropic/claude-sonnet-5',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }
    );

    expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/chat/completions`);
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Title']).toBe('Pix3 Editor');
    expect(headers.Authorization).toBe('Bearer k');
    // The base class clamps xhigh → high for the OpenAI triad; OpenRouter forwards it as chosen.
    expect(JSON.parse(String(init.body)).reasoning_effort).toBe('xhigh');
  });

  it('lists the live catalog keylessly, filters it, and sorts free models first', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        data: [
          entry({ id: 'vendor/paid', name: 'Vendor: Paid' }),
          entry({ id: 'vendor/paid:batch', name: 'Vendor: Paid (batch)' }),
          entry({ id: 'vendor/chat-only', supported_parameters: ['max_tokens'] }),
          entry({
            id: 'vendor/free',
            name: 'Vendor: Free',
            pricing: { prompt: '0', completion: '0' },
          }),
        ],
      })
    );

    const models = await provider.listModels({ fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(models.map(m => m.id)).toEqual(['vendor/free', 'vendor/paid']);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/models`);
    // The catalog is public — no key is sent, and none is needed.
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('reports an unusable catalog rather than returning an empty picker', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ data: [entry({ supported_parameters: ['max_tokens'] })] })
    );
    await expect(
      provider.listModels({ fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toBeInstanceOf(LlmError);
  });
});
