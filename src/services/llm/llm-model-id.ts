/**
 * Composite `"<llmProviderId>/<llmModelId>"` ids, and the sentinel that means "whatever the agent
 * chat is using right now".
 *
 * This encoding exists because features that *borrow* the agent's LLM (the `svg-llm` image provider,
 * the SFX generator) are configured through pickers that only have room for one string. Splitting
 * the pair back out is fiddly in exactly one way — gateway model ids carry their own slash
 * (`anthropic/claude-sonnet-4.5`) — so it lives here once rather than being re-derived per feature.
 *
 * Neutral on purpose: it names no feature, so a second borrower does not have to import the first
 * one's module to parse an id.
 */

/**
 * Sentinel model id meaning "whatever the agent chat is using right now". It carries no slash, which
 * is what separates it from a pinned {@link formatLlmModelId} pick — and it deliberately re-resolves
 * on every call, so switching the agent's model in the chat switches the borrower's too.
 */
export const AGENT_DEFAULT_MODEL_ID = 'agent-default';

/** One string naming an LLM provider+model pair, for a picker whose value is a single id. */
export const formatLlmModelId = (providerId: string, modelId: string): string =>
  `${providerId}/${modelId}`;

/** Split a composite `"<llmProviderId>/<llmModelId>"` id. Null for the sentinel or malformed input. */
export const parseLlmModelId = (
  composite: string
): { providerId: string; modelId: string } | null => {
  const slash = composite.indexOf('/');
  if (slash <= 0 || slash === composite.length - 1) {
    return null;
  }
  // Split on the FIRST slash only: gateway model ids carry their own (`anthropic/claude-sonnet-4.5`).
  return { providerId: composite.slice(0, slash), modelId: composite.slice(slash + 1) };
};
