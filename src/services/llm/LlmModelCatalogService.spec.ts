import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmModelCatalogService } from './LlmModelCatalogService';
import { LlmProviderRegistry } from './LlmProviderRegistry';
import type { LlmModel, LlmProvider } from './LlmTypes';

const model = (id: string): LlmModel => ({
  id,
  label: id,
  capabilities: {
    supportsTools: true,
    supportsImages: false,
    supportsSystemPrompt: true,
    maxOutputTokens: 8192,
  },
});

interface Overrides {
  listModels?: (ctx: unknown) => Promise<LlmModel[]>;
}

/** Register a fake provider (static list [s1]; optional live catalog) and build the service. */
const buildService = (
  overrides: Overrides = {}
): { service: LlmModelCatalogService; registry: LlmProviderRegistry } => {
  const registry = new LlmProviderRegistry();
  const fake: LlmProvider = {
    id: 'fake',
    label: 'Fake',
    models: [model('s1')],
    apiKeySecretId: 'ai-provider:fake:api-key',
    getModel: () => undefined,
    chat: async () => ({ content: [], stopReason: 'end_turn' as const }),
    ...(overrides.listModels ? { listModels: overrides.listModels } : {}),
  };
  registry.register(fake);

  const service = new LlmModelCatalogService();
  Object.defineProperty(service, 'registry', { value: registry, configurable: true });
  Object.defineProperty(service, 'settings', {
    value: { getApiKey: async () => 'key-1', getBaseUrl: () => undefined },
    configurable: true,
  });
  return { service, registry };
};

describe('LlmModelCatalogService', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns the static list for providers without a live catalog (no refresh attempted)', () => {
    const { service } = buildService();
    expect(service.getModels('fake').map(m => m.id)).toEqual(['s1']);
    expect(service.supportsRefresh('fake')).toBe(false);
  });

  it('refresh() fetches, caches and notifies; getModels then serves the live catalog', async () => {
    const listModels = vi.fn(async () => [model('live-1'), model('live-2')]);
    const { service } = buildService({ listModels });
    const listener = vi.fn();
    service.subscribe(listener);

    const models = await service.refresh('fake');

    expect(models.map(m => m.id)).toEqual(['live-1', 'live-2']);
    expect(listener).toHaveBeenCalled();
    expect(service.getModels('fake').map(m => m.id)).toEqual(['live-1', 'live-2']);
    // The provider received the stored key.
    expect(listModels).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'key-1' }));
    expect(service.supportsRefresh('fake')).toBe(true);
    expect(service.getFetchedAt('fake')).toBeTypeOf('number');
  });

  it('persists the catalog to localStorage and reloads it in a fresh instance', async () => {
    const listModels = vi.fn(async () => [model('live-1')]);
    const first = buildService({ listModels });
    await first.service.refresh('fake');

    // A fresh instance (fresh cache) still needs no refetch to serve the fetched catalog.
    const second = buildService({ listModels });
    expect(second.service.getModels('fake').map(m => m.id)).toEqual(['live-1']);
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it('keeps the cached/static list when a refresh fails', async () => {
    const listModels = vi.fn(async () => {
      throw new Error('offline');
    });
    const { service } = buildService({ listModels });

    await expect(service.refresh('fake')).rejects.toThrow('offline');
    expect(service.getModels('fake').map(m => m.id)).toEqual(['s1']);
  });

  it('getModels triggers a lazy background refresh for stale live catalogs', async () => {
    let resolveListing: (models: LlmModel[]) => void = () => {};
    const listModels = vi.fn(() => new Promise<LlmModel[]>(resolve => (resolveListing = resolve)));
    const { service } = buildService({ listModels });

    // First read: static fallback served synchronously, refresh kicked off in the background
    // (the provider call lands on a later microtask — it resolves the key first).
    expect(service.getModels('fake').map(m => m.id)).toEqual(['s1']);
    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));

    resolveListing([model('live-1')]);
    await vi.waitFor(() => {
      expect(service.getModels('fake').map(m => m.id)).toEqual(['live-1']);
    });
    // The fresh cache suppresses further refreshes.
    service.getModels('fake');
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent refreshes into one provider call', async () => {
    const listModels = vi.fn(async () => [model('live-1')]);
    const { service } = buildService({ listModels });

    await Promise.all([service.refresh('fake'), service.refresh('fake')]);
    expect(listModels).toHaveBeenCalledTimes(1);
  });
});
