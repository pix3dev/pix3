import { describe, expect, it } from 'vitest';
import { LlmProviderRegistry } from './LlmProviderRegistry';
import type { LlmProvider } from './LlmTypes';

const makeProvider = (id: string, label = id): LlmProvider => ({
  id,
  label,
  models: [],
  apiKeySecretId: `s:${id}`,
  getModel: () => undefined,
  chat: async () => ({ content: [], stopReason: 'end_turn' as const }),
});

describe('LlmProviderRegistry', () => {
  it('ships only gemini as a built-in, with gemini as the default', () => {
    const registry = new LlmProviderRegistry();
    expect(registry.list().map(p => p.id)).toEqual(['gemini']);
    expect(registry.getDefault()?.id).toBe('gemini');
    expect(registry.get('gemini')?.label).toContain('Gemini');
    expect(registry.get('nope')).toBeUndefined();
  });

  it('adds bridge providers after the static ones, in discovery order', () => {
    const registry = new LlmProviderRegistry();
    registry.setBridgeProviders([
      makeProvider('openai', 'OpenAI'),
      makeProvider('anthropic', 'Anthropic'),
      makeProvider('claude-bridge', 'Claude Code (MAX)'),
    ]);
    expect(registry.list().map(p => p.id)).toEqual([
      'gemini',
      'openai',
      'anthropic',
      'claude-bridge',
    ]);
    // Default stays Gemini even with bridge providers present.
    expect(registry.getDefault()?.id).toBe('gemini');
    expect(registry.get('anthropic')?.label).toBe('Anthropic');
  });

  it('replaces the previous bridge set on each call (bridge going down clears them)', () => {
    const registry = new LlmProviderRegistry();
    registry.setBridgeProviders([makeProvider('openai'), makeProvider('cerebras')]);
    expect(registry.list().map(p => p.id)).toEqual(['gemini', 'openai', 'cerebras']);

    registry.setBridgeProviders([makeProvider('openai')]);
    expect(registry.list().map(p => p.id)).toEqual(['gemini', 'openai']);
    expect(registry.get('cerebras')).toBeUndefined();

    // Bridge unreachable → empty set → only Gemini remains.
    registry.setBridgeProviders([]);
    expect(registry.list().map(p => p.id)).toEqual(['gemini']);
  });

  it('never drops the static gemini provider when swapping bridge sets', () => {
    const registry = new LlmProviderRegistry();
    registry.setBridgeProviders([makeProvider('gemini', 'shadow'), makeProvider('openai')]);
    // A bridge entry colliding with a static id must not evict gemini from the static set.
    registry.setBridgeProviders([]);
    expect(registry.get('gemini')?.label).toContain('Gemini');
    expect(registry.list().map(p => p.id)).toEqual(['gemini']);
  });
});
