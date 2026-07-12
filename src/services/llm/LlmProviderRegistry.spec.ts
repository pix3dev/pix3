import { describe, expect, it } from 'vitest';
import { LlmProviderRegistry } from './LlmProviderRegistry';
import type { LlmProvider } from './LlmTypes';

describe('LlmProviderRegistry', () => {
  it('ships gemini, anthropic and openai-compat with gemini as the default', () => {
    const registry = new LlmProviderRegistry();
    expect(registry.list().map(p => p.id)).toEqual(['gemini', 'anthropic', 'openai-compat']);
    expect(registry.getDefault()?.id).toBe('gemini');
    expect(registry.get('anthropic')?.label).toContain('Claude');
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
  });
});
