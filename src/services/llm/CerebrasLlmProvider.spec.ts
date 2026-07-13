import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CerebrasLlmProvider } from './CerebrasLlmProvider';
import { resetModelsDevCache } from './models-dev';

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const MODELS_DEV_PAYLOAD = {
  cerebras: {
    models: {
      'gpt-oss-120b': {
        name: 'GPT OSS 120B',
        tool_call: true,
        attachment: false,
        limit: { context: 131072, output: 40960 },
        cost: { input: 0.35, output: 0.75 },
      },
    },
  },
};

describe('CerebrasLlmProvider', () => {
  const provider = new CerebrasLlmProvider();

  beforeEach(() => {
    resetModelsDevCache();
  });

  it('advertises the fixed Cerebras host and a fixed (no base-URL) model list', () => {
    expect(provider.id).toBe('cerebras');
    expect(provider.requiresBaseUrl).toBe(false);
    expect(provider.defaultBaseUrl).toBe('https://api.cerebras.ai/v1');
    expect(provider.models.map(m => m.id)).toEqual(['gpt-oss-120b', 'zai-glm-4.7', 'gemma-4-31b']);
  });

  it('posts to the Cerebras host with a Bearer key when no base URL is supplied', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] })
    );

    const result = await provider.chat(
      { messages: [{ role: 'user', content: 'hello' }] },
      { apiKey: 'csk-1', modelId: 'gpt-oss-120b', fetchImpl }
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.cerebras.ai/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer csk-1');
    expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('rejects a missing key (always required, unlike the local OpenAI-compat lane)', async () => {
    const fetchImpl = vi.fn();
    await expect(
      provider.chat(
        { messages: [{ role: 'user', content: 'x' }] },
        { apiKey: '', modelId: 'gpt-oss-120b', fetchImpl }
      )
    ).rejects.toMatchObject({ kind: 'missing-key' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists live /v1/models (with the key) enriched from models.dev', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('models.dev')) {
        return okJson(MODELS_DEV_PAYLOAD);
      }
      // The live endpoint requires the Bearer key.
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (auth !== 'Bearer csk-1') {
        return new Response('{"detail":"Not authenticated"}', { status: 403 });
      }
      return okJson({ object: 'list', data: [{ id: 'gpt-oss-120b' }, { id: 'new-model' }] });
    }) as unknown as typeof fetch;

    const models = await provider.listModels({ apiKey: 'csk-1', fetchImpl });

    expect(models.map(m => m.id)).toEqual(['gpt-oss-120b', 'new-model']);
    // Enriched from models.dev (pricing), not the bare live id.
    expect(models[0].pricing).toEqual({ inputPer1M: 0.35, outputPer1M: 0.75 });
  });

  it('falls back to the models.dev catalog without a key (live /models 403s anonymously)', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('models.dev')) {
        return okJson(MODELS_DEV_PAYLOAD);
      }
      return new Response('{"detail":"Not authenticated"}', { status: 403 });
    }) as unknown as typeof fetch;

    const models = await provider.listModels({ fetchImpl });
    expect(models.map(m => m.id)).toEqual(['gpt-oss-120b']);
  });
});
