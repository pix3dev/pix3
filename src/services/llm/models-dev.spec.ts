import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchModelsDevCatalog,
  mapModelsDevModel,
  resetModelsDevCache,
  sortCatalogModels,
} from './models-dev';
import type { LlmModel } from './LlmTypes';

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('models-dev', () => {
  beforeEach(() => {
    resetModelsDevCache();
  });

  it('maps a models.dev entry to an LlmModel (capabilities, clamped output, free pricing)', () => {
    const model = mapModelsDevModel('glm-5-free', {
      name: 'GLM-5 Free',
      tool_call: true,
      reasoning: true,
      attachment: false,
      limit: { context: 204800, output: 131072 },
      cost: { input: 0, output: 0 },
    });

    expect(model).toMatchObject({
      id: 'glm-5-free',
      label: 'GLM-5 Free',
      pricing: { inputPer1M: 0, outputPer1M: 0 },
      capabilities: {
        supportsTools: true,
        supportsImages: false,
        supportsSystemPrompt: true,
        // The 131K output limit is clamped to a sane request budget.
        maxOutputTokens: 32768,
        // The reasoning flag becomes the OpenAI-style low/medium/high effort triad.
        reasoningEfforts: ['low', 'medium', 'high'],
      },
    });
    expect(model?.description).toBe('Free · 200K ctx · reasoning');
  });

  it('returns null for malformed entries and defaults missing fields', () => {
    expect(mapModelsDevModel('x', null)).toBeNull();
    const bare = mapModelsDevModel('bare-model', {});
    expect(bare).toMatchObject({
      id: 'bare-model',
      label: 'bare-model',
      capabilities: { supportsTools: false, supportsImages: false, maxOutputTokens: 8192 },
    });
    expect(bare?.pricing).toBeUndefined();
    // No reasoning flag → no effort control offered.
    expect(bare?.capabilities.reasoningEfforts).toBeUndefined();
  });

  it('fetches one provider catalog and shares a single api.json download across calls', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        opencode: { models: { m1: { name: 'M1', tool_call: true } } },
        cerebras: { models: { c1: { name: 'C1', tool_call: true } } },
      })
    ) as unknown as typeof fetch;

    const [zen, cerebras] = await Promise.all([
      fetchModelsDevCatalog('opencode', fetchImpl),
      fetchModelsDevCatalog('cerebras', fetchImpl),
    ]);

    expect(zen.get('m1')?.label).toBe('M1');
    expect(cerebras.get('c1')?.label).toBe('C1');
    // Concurrent catalog reads share one in-flight download; a repeat hits the TTL cache.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await fetchModelsDevCatalog('opencode', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws for an unknown provider key', async () => {
    const fetchImpl = vi.fn(async () => okJson({})) as unknown as typeof fetch;
    await expect(fetchModelsDevCatalog('nope', fetchImpl)).rejects.toMatchObject({
      kind: 'unknown',
    });
  });

  it('sorts free models first, then alphabetically by label', () => {
    const model = (id: string, label: string, free: boolean): LlmModel => ({
      id,
      label,
      capabilities: {
        supportsTools: true,
        supportsImages: false,
        supportsSystemPrompt: true,
        maxOutputTokens: 8192,
      },
      pricing: free ? { inputPer1M: 0, outputPer1M: 0 } : { inputPer1M: 1, outputPer1M: 2 },
    });

    const sorted = sortCatalogModels([
      model('b', 'Bravo', false),
      model('z', 'Zulu Free', true),
      model('a', 'Alpha', false),
      model('c', 'Charlie Free', true),
    ]);
    expect(sorted.map(m => m.id)).toEqual(['c', 'z', 'a', 'b']);
  });
});
