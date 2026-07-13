import { describe, expect, it } from 'vitest';
import { LlmProviderRegistry } from './LlmProviderRegistry';
import type { LlmProvider } from './LlmTypes';

describe('LlmProviderRegistry', () => {
  it('ships gemini, anthropic, cerebras, opencode-zen and openai-compat with gemini as the default', () => {
    const registry = new LlmProviderRegistry();
    expect(registry.list().map(p => p.id)).toEqual([
      'gemini',
      'anthropic',
      'cerebras',
      'opencode-zen',
      'openai-compat',
    ]);
    expect(registry.getDefault()?.id).toBe('gemini');
    expect(registry.get('anthropic')?.label).toContain('Claude');
    expect(registry.get('cerebras')?.label).toBe('Cerebras');
    expect(registry.get('opencode-zen')?.label).toBe('OpenCode Zen');
    expect(registry.get('nope')).toBeUndefined();
  });

  it('registers a new provider and preserves order; re-registering replaces without duplicating', () => {
    const registry = new LlmProviderRegistry();
    const custom = {
      id: 'custom',
      label: 'Custom',
      models: [],
      apiKeySecretId: 's',
      getModel: () => undefined,
      chat: async () => ({ content: [], stopReason: 'end_turn' as const }),
    } satisfies LlmProvider;
    registry.register(custom);
    expect(registry.list().map(p => p.id)).toEqual([
      'gemini',
      'anthropic',
      'cerebras',
      'opencode-zen',
      'openai-compat',
      'custom',
    ]);

    const replacement = { ...custom, label: 'Replaced' } satisfies LlmProvider;
    registry.register(replacement);
    expect(registry.list().filter(p => p.id === 'custom')).toHaveLength(1);
    expect(registry.get('custom')?.label).toBe('Replaced');
  });

  it('exposes requiresBaseUrl / defaultBaseUrl only on the openai-compat provider', () => {
    const registry = new LlmProviderRegistry();
    expect(registry.get('openai-compat')?.requiresBaseUrl).toBe(true);
    expect(registry.get('openai-compat')?.defaultBaseUrl).toBeTruthy();
    expect(registry.get('gemini')?.requiresBaseUrl).toBeUndefined();
    // Cerebras is a fixed hosted endpoint: no user-typed base URL, but a default (proxy) host is set.
    expect(registry.get('cerebras')?.requiresBaseUrl).toBe(false);
    expect(registry.get('cerebras')?.defaultBaseUrl).toBe('/cerebras-proxy/v1');
  });
});
