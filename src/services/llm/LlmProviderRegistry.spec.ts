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
  it('ships the browser-callable providers as built-ins, with gemini as the default', () => {
    const registry = new LlmProviderRegistry();
    expect(registry.list().map(p => p.id)).toEqual(['gemini', 'openrouter']);
    expect(registry.listStatic().map(p => p.id)).toEqual(['gemini', 'openrouter']);
    expect(registry.getDefault()?.id).toBe('gemini');
    expect(registry.get('gemini')?.label).toContain('Gemini');
    expect(registry.get('openrouter')?.label).toBe('OpenRouter');
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
      'openrouter',
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
    expect(registry.list().map(p => p.id)).toEqual(['gemini', 'openrouter', 'openai', 'cerebras']);

    registry.setBridgeProviders([makeProvider('openai')]);
    expect(registry.list().map(p => p.id)).toEqual(['gemini', 'openrouter', 'openai']);
    expect(registry.get('cerebras')).toBeUndefined();

    // Bridge unreachable → empty set → only the built-ins remain.
    registry.setBridgeProviders([]);
    expect(registry.list().map(p => p.id)).toEqual(['gemini', 'openrouter']);
  });

  it('prefers a bridge lane over the static default, and falls back to it when the bridge is down', () => {
    const registry = new LlmProviderRegistry();
    // Nothing from the bridge yet: Gemini is all there is.
    expect(registry.getPreferred()?.id).toBe('gemini');

    registry.setBridgeProviders([makeProvider('openai'), makeProvider('claude-bridge')]);
    expect(registry.getPreferred()?.id).toBe('openai');

    registry.setBridgeProviders([]);
    expect(registry.getPreferred()?.id).toBe('gemini');
  });

  it('skips hidden bridge providers when picking the preferred one', () => {
    const registry = new LlmProviderRegistry();
    registry.setBridgeProviders([
      { ...makeProvider('retired'), hidden: true },
      makeProvider('openai'),
    ]);
    expect(registry.getPreferred()?.id).toBe('openai');
  });

  it('never drops a static provider when swapping bridge sets', () => {
    const registry = new LlmProviderRegistry();
    registry.setBridgeProviders([
      makeProvider('gemini', 'shadow'),
      makeProvider('openrouter', 'shadow'),
      makeProvider('openai'),
    ]);
    // A bridge entry colliding with a static id must not evict the built-in from the static set.
    registry.setBridgeProviders([]);
    expect(registry.get('gemini')?.label).toContain('Gemini');
    expect(registry.get('openrouter')?.label).toBe('OpenRouter');
    expect(registry.list().map(p => p.id)).toEqual(['gemini', 'openrouter']);
  });
});
