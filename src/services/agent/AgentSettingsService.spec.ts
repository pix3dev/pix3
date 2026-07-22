import { beforeEach, describe, expect, it } from 'vitest';
import { AgentSettingsService } from '@/services/agent/AgentSettingsService';
import { LlmProviderRegistry } from '@/services/llm/LlmProviderRegistry';
import type { LlmProvider } from '@/services/llm/LlmTypes';

/**
 * Bridge-backed provider stubs mirroring what BridgeConnectionService registers at runtime. Only
 * Gemini is a real static provider; the rest are registered dynamically, so the tests inject a
 * representative set to exercise id resolution (base URL, live-catalog passthrough, key delegation).
 */
const bridgeStubs = (): LlmProvider[] => [
  {
    id: 'anthropic',
    label: 'Anthropic',
    models: [],
    apiKeySecretId: 'ai-provider:pix3-bridge:token',
    getModel: () => undefined,
    chat: async () => ({ content: [], stopReason: 'end_turn' as const }),
  },
  {
    id: 'openai-compat',
    label: 'OpenAI',
    models: [],
    apiKeySecretId: 'ai-provider:pix3-bridge:token',
    requiresBaseUrl: false,
    defaultBaseUrl: 'http://127.0.0.1:8484/providers/openai-compat',
    getModel: () => undefined,
    listModels: async () => [],
    chat: async () => ({ content: [], stopReason: 'end_turn' as const }),
  },
  {
    id: 'opencode-zen',
    label: 'OpenCode Zen',
    models: [],
    apiKeySecretId: 'ai-provider:pix3-bridge:token',
    getModel: () => undefined,
    listModels: async () => [],
    chat: async () => ({ content: [], stopReason: 'end_turn' as const }),
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    models: [],
    apiKeySecretId: 'ai-provider:pix3-bridge:token',
    getModel: () => undefined,
    listModels: async () => [],
    chat: async () => ({ content: [], stopReason: 'end_turn' as const }),
  },
];

/** In-memory stand-in for SecretStorageService (no IndexedDB in happy-dom). */
class FakeSecretStorage {
  readonly store = new Map<string, string>();
  async setSecret(id: string, value: string): Promise<void> {
    this.store.set(id, value);
  }
  async getSecret(id: string): Promise<string | null> {
    return this.store.get(id) ?? null;
  }
  async hasSecret(id: string): Promise<boolean> {
    return this.store.has(id);
  }
  async deleteSecret(id: string): Promise<void> {
    this.store.delete(id);
  }
}

/** Build a service with fakes injected in place of the DI-resolved dependencies. */
const buildService = (secrets = new FakeSecretStorage()): AgentSettingsService => {
  const service = new AgentSettingsService();
  const registry = new LlmProviderRegistry();
  registry.setBridgeProviders(bridgeStubs());
  Object.defineProperty(service, 'registry', { value: registry, configurable: true });
  Object.defineProperty(service, 'secrets', { value: secrets, configurable: true });
  return service;
};

describe('AgentSettingsService', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to the first provider and a sane loop cap', () => {
    const prefs = buildService().getPreferences();
    expect(prefs.selectedProviderId).toBe('gemini');
    expect(prefs.maxToolIterations).toBe(40);
    expect(prefs.customBaseUrl).toBe('');
    expect(prefs.modelByProvider).toEqual({});
    expect(prefs.debugMode).toBe(false);
  });

  it('defaults the soul to Brobot with empty custom fields', () => {
    const prefs = buildService().getPreferences();
    expect(prefs.soulId).toBe('brobot');
    expect(prefs.customSoulName).toBe('');
    expect(prefs.customSoulPrompt).toBe('');
  });

  it('round-trips the soul fields through localStorage', () => {
    const service = buildService();
    service.updatePreferences({
      soulId: 'custom',
      customSoulName: 'Kevin',
      customSoulPrompt: 'You are Kevin, a duck.',
    });
    const reloaded = buildService().getPreferences();
    expect(reloaded.soulId).toBe('custom');
    expect(reloaded.customSoulName).toBe('Kevin');
    expect(reloaded.customSoulPrompt).toBe('You are Kevin, a duck.');
  });

  it('loads older prefs without a soulId as Brobot (backfilled default)', () => {
    localStorage.setItem(
      'pix3.agentSettings:v1',
      JSON.stringify({ selectedProviderId: 'anthropic' })
    );
    const prefs = buildService().getPreferences();
    expect(prefs.soulId).toBe('brobot');
    expect(prefs.customSoulName).toBe('');
    expect(prefs.customSoulPrompt).toBe('');
  });

  it('persists the debug-mode flag', () => {
    const service = buildService();
    service.updatePreferences({ debugMode: true });
    expect(buildService().getPreferences().debugMode).toBe(true);
  });

  it('persists preferences to localStorage and reloads them in a fresh instance', () => {
    const service = buildService();
    service.updatePreferences({
      selectedProviderId: 'anthropic',
      modelByProvider: { anthropic: 'claude-sonnet-5' },
      customBaseUrl: 'http://localhost:11434/v1',
      maxToolIterations: 10,
    });

    const reloaded = buildService().getPreferences();
    expect(reloaded.selectedProviderId).toBe('anthropic');
    expect(reloaded.modelByProvider.anthropic).toBe('claude-sonnet-5');
    expect(reloaded.customBaseUrl).toBe('http://localhost:11434/v1');
    expect(reloaded.maxToolIterations).toBe(10);
  });

  it('merges modelByProvider instead of overwriting the whole map', () => {
    const service = buildService();
    service.updatePreferences({ modelByProvider: { gemini: 'gemini-2.5-pro' } });
    service.updatePreferences({ modelByProvider: { anthropic: 'claude-opus-4-8' } });
    const prefs = service.getPreferences();
    expect(prefs.modelByProvider).toEqual({
      gemini: 'gemini-2.5-pro',
      anthropic: 'claude-opus-4-8',
    });
  });

  it('resolves the selected model id (default first model, custom passthrough)', () => {
    const service = buildService();
    expect(service.getSelectedModelId('gemini')).toBe('gemini-flash-latest');
    // Custom / local model id must pass through even when not in the provider list.
    service.updatePreferences({ modelByProvider: { 'openai-compat': 'my-local-model' } });
    expect(service.getSelectedModelId('openai-compat')).toBe('my-local-model');
    expect(service.getSelectedModelId('nope')).toBeUndefined();
  });

  it('falls back to the first model when a fixed-list provider has a stale/deprecated stored id', () => {
    const service = buildService();
    // A previously-stored Gemini id that is no longer in the provider list (deprecated model).
    service.updatePreferences({ modelByProvider: { gemini: 'gemini-2.5-flash' } });
    expect(service.getSelectedModelId('gemini')).toBe('gemini-flash-latest');
    // A still-valid stored id is preserved.
    service.updatePreferences({ modelByProvider: { gemini: 'gemini-pro-latest' } });
    expect(service.getSelectedModelId('gemini')).toBe('gemini-pro-latest');
  });

  it('passes stored ids through for providers with a live catalog (wider than the static list)', () => {
    const service = buildService();
    // A model picked from a live-fetched Zen catalog is not in the static fallback list — it must
    // survive (the live catalog rotates; the static list is only a bootstrap).
    service.updatePreferences({ modelByProvider: { 'opencode-zen': 'glm-5-free' } });
    expect(service.getSelectedModelId('opencode-zen')).toBe('glm-5-free');
    service.updatePreferences({ modelByProvider: { cerebras: 'qwen-3-235b' } });
    expect(service.getSelectedModelId('cerebras')).toBe('qwen-3-235b');
  });

  it('stores, clears, and reloads a per-model reasoning effort', () => {
    const service = buildService();
    expect(service.getReasoningEffort('anthropic', 'claude-opus-4-8')).toBeUndefined();

    service.setReasoningEffort('anthropic', 'claude-opus-4-8', 'xhigh');
    service.setReasoningEffort('anthropic', 'claude-sonnet-5', 'low');
    expect(service.getReasoningEffort('anthropic', 'claude-opus-4-8')).toBe('xhigh');

    // Survives a reload, keyed per model.
    const reloaded = buildService();
    expect(reloaded.getReasoningEffort('anthropic', 'claude-opus-4-8')).toBe('xhigh');
    expect(reloaded.getReasoningEffort('anthropic', 'claude-sonnet-5')).toBe('low');

    // Clearing (undefined) drops the entry back to "default".
    reloaded.setReasoningEffort('anthropic', 'claude-opus-4-8', undefined);
    expect(reloaded.getReasoningEffort('anthropic', 'claude-opus-4-8')).toBeUndefined();
    expect(buildService().getReasoningEffort('anthropic', 'claude-opus-4-8')).toBeUndefined();
  });

  it('drops malformed reasoning-effort entries on load', () => {
    localStorage.setItem(
      'pix3.agentSettings:v1',
      JSON.stringify({ reasoningEffortByModel: { 'a::b': 'high', 'c::d': 'bogus', 'e::f': 3 } })
    );
    const service = buildService();
    expect(service.getReasoningEffort('a', 'b')).toBe('high');
    expect(service.getReasoningEffort('c', 'd')).toBeUndefined();
    expect(service.getReasoningEffort('e', 'f')).toBeUndefined();
  });

  it('resolves a base URL from the provider default (bridge path) and none for direct Gemini', () => {
    const service = buildService();
    // Bridge-backed providers carry their default base URL (the bridge proxy path); no user override.
    expect(service.getBaseUrl('openai-compat')).toBe(
      'http://127.0.0.1:8484/providers/openai-compat'
    );
    // Gemini has no base URL — it is called directly.
    expect(service.getBaseUrl('gemini')).toBeUndefined();
  });

  it('sanitises out-of-range or invalid maxToolIterations on load', () => {
    const read = (value: unknown): number => {
      localStorage.setItem('pix3.agentSettings:v1', JSON.stringify({ maxToolIterations: value }));
      return buildService().getPreferences().maxToolIterations;
    };
    expect(read(500)).toBe(100); // clamped to the ceiling
    expect(read(-3)).toBe(40); // non-positive → default
    expect(read(0)).toBe(40); // zero → default
    expect(read('lots')).toBe(40); // non-number → default
  });

  it('delegates API keys to secret storage keyed by the provider secret id', async () => {
    const secrets = new FakeSecretStorage();
    const service = buildService(secrets);
    // Gemini keeps its own per-provider key (the direct, no-bridge path).
    await service.setApiKey('gemini', 'gm-123');
    expect(secrets.store.get('ai-provider:gemini:api-key')).toBe('gm-123');
    expect(await service.hasApiKey('gemini')).toBe(true);
    expect(await service.getApiKey('gemini')).toBe('gm-123');
    await service.clearApiKey('gemini');
    expect(await service.hasApiKey('gemini')).toBe(false);

    // Bridge-backed providers all resolve to the single shared pairing-token secret.
    await service.setApiKey('anthropic', 'bridge-token');
    expect(secrets.store.get('ai-provider:pix3-bridge:token')).toBe('bridge-token');
    expect(await service.getApiKey('opencode-zen')).toBe('bridge-token');
  });
});
