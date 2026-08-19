import { ProviderError, type CompletionRequest, type LLMProvider } from '@txt2sfx/agent';

import type { LlmLane } from '@/services/llm/LlmLaneResolver';
import { LlmError, type LlmMessage } from '@/services/llm/LlmTypes';

/**
 * The one piece of glue with any thickness: pix3's {@link import('@/services/llm/LlmTypes').LlmProvider}
 * presented as txt2sfx's `LLMProvider`.
 *
 * The two interfaces want the same thing (a conversation in, one assistant message out) and differ in
 * three details, each handled here rather than in the loop:
 *
 * - **The system prompt is a field, not a turn.** Both sides agree on that, so it passes straight
 *   through — flattening it into the messages would silently produce plausible-but-wrong output.
 * - **The reply is text, not blocks.** pix3 answers content blocks because its chat has tools;
 *   the soundline loop only ever wants the prose, so text blocks are joined and everything else
 *   (a stray tool-use block) is dropped.
 * - **Failures must arrive as `ProviderError` with an honest `retryable`.** The loop's own retry
 *   policy reads that flag, and a 400 that says the request shape is wrong will say it again
 *   forever. So the mapping is decided from the status code where pix3 reports one, and an abort is
 *   re-thrown untouched — a cancelled run is not a provider failure and must not be retried.
 */

/** How to reach one lane, for {@link createSoundlineLlmProvider}. */
export interface SoundlineProviderOptions {
  readonly lane: LlmLane;
  /** API key or bridge token for the lane's provider. */
  readonly apiKey: string;
  /** Cap on generated tokens; clamped against the model's own ceiling. */
  readonly maxTokens?: number;
}

/**
 * Default reply budget. A soundline document is a few hundred tokens, but the models that write the
 * best ones think out loud first, and a truncated reply loses the fenced block at the end — which the
 * extractor reads as "no soundline" and the loop spends a whole iteration on.
 */
export const SOUNDLINE_MAX_TOKENS = 4096;

/**
 * Whether a failed pix3 LLM call is worth another attempt.
 *
 * Decided from the status where there is one (429 and 5xx yes, other 4xx no) and from the error kind
 * otherwise: a network blip is transient, a missing key or a safety refusal is not. `unknown` is
 * treated as retryable because the alternative — declaring a transient failure permanent — costs the
 * user the run, while the opposite costs one extra request.
 */
export const isRetryableLlmFailure = (error: LlmError): boolean => {
  if (typeof error.status === 'number') {
    return error.status === 429 || error.status >= 500;
  }
  switch (error.kind) {
    case 'network':
    case 'unknown':
      return true;
    case 'missing-key':
    case 'blocked':
    case 'aborted':
    case 'empty':
    case 'http':
      return false;
  }
};

/** Join an {@link LlmResult}'s content down to the prose the soundline extractor reads. */
const textOf = (content: readonly { type: string }[]): string =>
  content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();

/** Map txt2sfx's system+messages shape onto pix3's. */
export const toLlmMessages = (request: CompletionRequest): LlmMessage[] =>
  request.messages.map(message => ({ role: message.role, content: message.content }));

/** Adapt one resolved pix3 lane into the provider the txt2sfx loop talks to. */
export function createSoundlineLlmProvider(options: SoundlineProviderOptions): LLMProvider {
  const { lane, apiKey } = options;
  const ceiling = lane.model?.capabilities.maxOutputTokens ?? SOUNDLINE_MAX_TOKENS;
  const maxTokens = Math.min(options.maxTokens ?? SOUNDLINE_MAX_TOKENS, ceiling);

  return {
    name: lane.provider.id,
    model: lane.modelId,
    async complete(request: CompletionRequest): Promise<string> {
      try {
        const result = await lane.provider.chat(
          {
            messages: toLlmMessages(request),
            ...(request.system === undefined ? {} : { system: request.system }),
            maxTokens: Math.min(request.maxTokens ?? maxTokens, ceiling),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          },
          { apiKey, modelId: lane.modelId, baseUrl: lane.baseUrl }
        );
        return textOf(result.content);
      } catch (error) {
        // A cancelled run is the user's decision, not a provider fault: surfacing it as a
        // ProviderError would let the loop's retry policy fight the abort.
        if (error instanceof LlmError && error.kind === 'aborted') {
          throw error;
        }
        if (error instanceof LlmError) {
          throw new ProviderError({
            provider: lane.provider.id,
            message: error.message,
            status: error.status,
            retryable: isRetryableLlmFailure(error),
            cause: error,
          });
        }
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error;
        }
        throw new ProviderError({
          provider: lane.provider.id,
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
          cause: error,
        });
      }
    },
  };
}
