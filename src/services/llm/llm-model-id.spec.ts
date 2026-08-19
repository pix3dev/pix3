import { describe, expect, it } from 'vitest';

import { AGENT_DEFAULT_MODEL_ID, formatLlmModelId, parseLlmModelId } from './llm-model-id';

/**
 * The encoding every "borrow the agent's model" feature shares. Its one interesting case is the
 * gateway model id that carries its own slash — get that wrong and a pinned lane resolves to a
 * provider that does not exist, which the resolver then silently papers over with the agent default.
 */
describe('composite LLM model ids', () => {
  it('round-trips a provider/model pair', () => {
    const composite = formatLlmModelId('anthropic-bridge', 'claude-sonnet-4-5');
    expect(composite).toBe('anthropic-bridge/claude-sonnet-4-5');
    expect(parseLlmModelId(composite)).toEqual({
      providerId: 'anthropic-bridge',
      modelId: 'claude-sonnet-4-5',
    });
  });

  it('splits on the FIRST slash so gateway model ids keep their own', () => {
    expect(parseLlmModelId('zen/anthropic/claude-sonnet-4.5')).toEqual({
      providerId: 'zen',
      modelId: 'anthropic/claude-sonnet-4.5',
    });
  });

  it('treats the agent-default sentinel and malformed ids as "not a pinned lane"', () => {
    expect(parseLlmModelId(AGENT_DEFAULT_MODEL_ID)).toBeNull();
    expect(parseLlmModelId('')).toBeNull();
    expect(parseLlmModelId('/leading')).toBeNull();
    expect(parseLlmModelId('trailing/')).toBeNull();
  });

  it('keeps the sentinel free of a slash so it can never collide with a composite', () => {
    expect(AGENT_DEFAULT_MODEL_ID).not.toContain('/');
  });
});
