import { ProviderError } from '@txt2sfx/agent';
import { describe, expect, it, vi } from 'vitest';

import type { LlmLane } from '@/services/llm/LlmLaneResolver';
import {
  LlmError,
  type ChatParams,
  type LlmProvider,
  type LlmRequestContext,
  type LlmResult,
} from '@/services/llm/LlmTypes';

import {
  SOUNDLINE_MAX_TOKENS,
  createSoundlineLlmProvider,
  isRetryableLlmFailure,
  toLlmMessages,
} from './SoundlineLlmAdapter';

const textResult = (text: string): LlmResult => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
});

type ChatFn = (params: ChatParams, ctx: LlmRequestContext) => Promise<LlmResult>;

/** A lane over a stub provider, with the model's output ceiling configurable. */
function createLane(chat: ChatFn, maxOutputTokens = 8192): LlmLane {
  const provider = {
    id: 'stub',
    label: 'Stub',
    models: [],
    apiKeySecretId: 'stub-key',
    getModel: () => undefined,
    chat,
  } as unknown as LlmProvider;
  return {
    provider,
    modelId: 'stub-model',
    baseUrl: 'https://example.test',
    model: {
      id: 'stub-model',
      label: 'Stub Model',
      capabilities: {
        supportsTools: false,
        supportsImages: false,
        supportsSystemPrompt: true,
        maxOutputTokens,
      },
    },
  };
}

describe('toLlmMessages', () => {
  it('passes the turns through and leaves the system prompt out of them', () => {
    expect(
      toLlmMessages({
        system: 'the contract',
        messages: [
          { role: 'user', content: 'a coin' },
          { role: 'assistant', content: 'sound "coin" 200ms pickup' },
        ],
      })
    ).toEqual([
      { role: 'user', content: 'a coin' },
      { role: 'assistant', content: 'sound "coin" 200ms pickup' },
    ]);
  });
});

describe('createSoundlineLlmProvider', () => {
  it('reports the lane it speaks for, so the bench transcript names the right model', () => {
    const provider = createSoundlineLlmProvider({
      apiKey: 'k',
      lane: createLane(async () => textResult('')),
    });
    expect(provider.name).toBe('stub');
    expect(provider.model).toBe('stub-model');
  });

  it('forwards system, messages, token cap, abort signal, key and base URL', async () => {
    const chat = vi.fn<ChatFn>(async () => textResult('sound "pop" 40ms pop'));
    const lane = createLane(chat);
    const controller = new AbortController();
    const provider = createSoundlineLlmProvider({ apiKey: 'sk-test', lane });

    const reply = await provider.complete({
      system: 'the contract',
      messages: [{ role: 'user', content: 'a pop' }],
      signal: controller.signal,
    });

    expect(reply).toBe('sound "pop" 40ms pop');
    const call = chat.mock.calls[0];
    expect(call).toBeDefined();
    const [params, ctx] = call!;
    expect(params.system).toBe('the contract');
    expect(params.messages).toEqual([{ role: 'user', content: 'a pop' }]);
    expect(params.maxTokens).toBe(SOUNDLINE_MAX_TOKENS);
    expect(params.signal).toBe(controller.signal);
    expect(ctx).toEqual({
      apiKey: 'sk-test',
      modelId: 'stub-model',
      baseUrl: 'https://example.test',
    });
  });

  it("clamps the reply budget to the model's own ceiling", async () => {
    const chat = vi.fn<ChatFn>(async () => textResult('ok'));
    const provider = createSoundlineLlmProvider({ apiKey: 'k', lane: createLane(chat, 512) });
    await provider.complete({ messages: [{ role: 'user', content: 'x' }], maxTokens: 99_999 });
    expect(chat.mock.calls[0]?.[0].maxTokens).toBe(512);
  });

  it('joins text blocks and drops anything that is not prose', async () => {
    const chat = async (): Promise<LlmResult> => ({
      content: [
        { type: 'text', text: 'here you go' },
        { type: 'tool-use', id: 't1', name: 'noop', input: {} },
        { type: 'text', text: 'sound "pop" 40ms pop' },
      ],
      stopReason: 'end_turn',
    });
    const provider = createSoundlineLlmProvider({ apiKey: 'k', lane: createLane(chat) });
    expect(await provider.complete({ messages: [{ role: 'user', content: 'x' }] })).toBe(
      'here you go\nsound "pop" 40ms pop'
    );
  });

  it('maps a rate limit to a retryable ProviderError', async () => {
    const provider = createSoundlineLlmProvider({
      apiKey: 'k',
      lane: createLane(async () => {
        throw new LlmError('http', 'slow down', 429);
      }),
    });
    await expect(provider.complete({ messages: [] })).rejects.toMatchObject({
      name: 'ProviderError',
      provider: 'stub',
      status: 429,
      retryable: true,
    });
  });

  it('maps a bad request to a NON-retryable ProviderError, server text intact', async () => {
    const provider = createSoundlineLlmProvider({
      apiKey: 'k',
      lane: createLane(async () => {
        throw new LlmError('http', 'temperature: unexpected field', 400);
      }),
    });
    const error = await provider.complete({ messages: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryable).toBe(false);
    expect((error as ProviderError).message).toContain('temperature: unexpected field');
  });

  it('re-throws an abort untouched — a cancelled run is not a provider failure', async () => {
    const aborted = new LlmError('aborted', 'cancelled');
    const provider = createSoundlineLlmProvider({
      apiKey: 'k',
      lane: createLane(async () => {
        throw aborted;
      }),
    });
    await expect(provider.complete({ messages: [] })).rejects.toBe(aborted);
  });

  it('wraps a non-LlmError throw as retryable rather than swallowing it', async () => {
    const provider = createSoundlineLlmProvider({
      apiKey: 'k',
      lane: createLane(async () => {
        throw new TypeError('fetch exploded');
      }),
    });
    await expect(provider.complete({ messages: [] })).rejects.toMatchObject({
      name: 'ProviderError',
      retryable: true,
    });
  });
});

describe('isRetryableLlmFailure', () => {
  it('retries 429 and 5xx and nothing else with a status', () => {
    expect(isRetryableLlmFailure(new LlmError('http', 'x', 429))).toBe(true);
    expect(isRetryableLlmFailure(new LlmError('http', 'x', 503))).toBe(true);
    expect(isRetryableLlmFailure(new LlmError('http', 'x', 400))).toBe(false);
    expect(isRetryableLlmFailure(new LlmError('http', 'x', 401))).toBe(false);
  });

  it('falls back to the error kind when there is no status', () => {
    expect(isRetryableLlmFailure(new LlmError('network', 'x'))).toBe(true);
    expect(isRetryableLlmFailure(new LlmError('unknown', 'x'))).toBe(true);
    expect(isRetryableLlmFailure(new LlmError('missing-key', 'x'))).toBe(false);
    expect(isRetryableLlmFailure(new LlmError('blocked', 'x'))).toBe(false);
    expect(isRetryableLlmFailure(new LlmError('empty', 'x'))).toBe(false);
  });
});
