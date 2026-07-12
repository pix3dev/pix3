import { beforeEach, describe, expect, it } from 'vitest';
import { AgentSettingsService } from './AgentSettingsService';
import { LlmProviderRegistry } from './llm/LlmProviderRegistry';

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
  Object.defineProperty(service, 'registry', {
    value: new LlmProviderRegistry(),
    configurable: true,
  });
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
    expect(prefs.maxToolIterations).toBe(25);
    expect(prefs.customBaseUrl).toBe('');
    expect(prefs.modelByProvider).toEqual({});
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
    expect(service.getSelectedModelId('gemini')).toBe('gemini-2.5-flash');
    // Custom / local model id must pass through even when not in the provider list.
    service.updatePreferences({ modelByProvider: { 'openai-compat': 'my-local-model' } });
    expect(service.getSelectedModelId('openai-compat')).toBe('my-local-model');
    expect(service.getSelectedModelId('nope')).toBeUndefined();
  });

  it('returns the custom base URL only for the provider that requires one', () => {
    const service = buildService();
    service.updatePreferences({ customBaseUrl: 'http://localhost:1234/v1' });
    expect(service.getBaseUrl('openai-compat')).toBe('http://localhost:1234/v1');
    // Gemini has no default base URL and ignores the custom one.
    expect(service.getBaseUrl('gemini')).toBeUndefined();
  });

  it('sanitises out-of-range or invalid maxToolIterations on load', () => {
    const read = (value: unknown): number => {
      localStorage.setItem('pix3.agentSettings:v1', JSON.stringify({ maxToolIterations: value }));
      return buildService().getPreferences().maxToolIterations;
    };
    expect(read(500)).toBe(100); // clamped to the ceiling
    expect(read(-3)).toBe(25); // non-positive → default
    expect(read(0)).toBe(25); // zero → default
    expect(read('lots')).toBe(25); // non-number → default
  });

  it('delegates API keys to secret storage keyed by the provider secret id', async () => {
    const secrets = new FakeSecretStorage();
    const service = buildService(secrets);
    await service.setApiKey('anthropic', 'sk-ant-123');
    expect(secrets.store.get('ai-provider:anthropic:api-key')).toBe('sk-ant-123');
    expect(await service.hasApiKey('anthropic')).toBe(true);
    expect(await service.getApiKey('anthropic')).toBe('sk-ant-123');
    await service.clearApiKey('anthropic');
    expect(await service.hasApiKey('anthropic')).toBe(false);
  });
});
