import {
  LlmError,
  type LlmListModelsContext,
  type LlmModel,
  type ReasoningEffort,
} from './LlmTypes';

/**
 * Live model catalog from a Pix3AgentBridge lane (`GET {base}/models`).
 *
 * Every bridge lane serves the same payload — the Claude Agent SDK one from a static subscription
 * table, the Antigravity one from a live `agy models` call — so the fetching, validation and
 * fallback logic is shared rather than duplicated per provider class.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface FetchBridgeModelsOptions {
  /** Shown when the bridge cannot be reached at all. */
  readonly laneLabel: string;
  /**
   * Carry the reasoning-effort list over from the provider's static catalog when the bridge's
   * payload omits it. Older bridges predate the field, and dropping it would silently remove the
   * reasoning picker from a model that supports one.
   */
  readonly staticEffortsFor?: (modelId: string) => readonly ReasoningEffort[] | undefined;
}

export const fetchBridgeModels = async (
  baseUrl: string,
  ctx: LlmListModelsContext,
  options: FetchBridgeModelsOptions
): Promise<LlmModel[]> => {
  const fetchImpl = ctx.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = baseUrl.replace(/\/$/, '');

  let response: Response;
  try {
    response = await fetchImpl(`${base}/models`, {
      headers: ctx.apiKey ? { 'x-api-key': ctx.apiKey } : undefined,
      signal: ctx.signal,
    });
  } catch (error) {
    throw new LlmError(
      'network',
      `Could not reach the local bridge for ${options.laneLabel}. Is pix3-agent-bridge running?`,
      undefined,
      { cause: error }
    );
  }
  if (!response.ok) {
    // The bridge answers 503 with a specific, actionable reason for a CLI lane (not installed, not
    // signed in), so its message is worth far more to the user than the status code alone.
    const detail = await response
      .json()
      .then(body =>
        isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string'
          ? body.error.message
          : ''
      )
      .catch(() => '');
    throw new LlmError(
      'http',
      detail || `${options.laneLabel} bridge error (HTTP ${response.status}).`,
      response.status
    );
  }

  const payload: unknown = await response.json();
  const rawModels = isRecord(payload) && Array.isArray(payload.models) ? payload.models : [];
  const models = rawModels
    .filter(
      (model): model is LlmModel =>
        isRecord(model) &&
        typeof model.id === 'string' &&
        typeof model.label === 'string' &&
        isRecord(model.capabilities)
    )
    .map(model =>
      model.capabilities.reasoningEfforts
        ? model
        : {
            ...model,
            capabilities: {
              ...model.capabilities,
              reasoningEfforts: options.staticEffortsFor?.(model.id),
            },
          }
    );
  if (models.length === 0) {
    throw new LlmError('unknown', `The bridge returned no models for ${options.laneLabel}.`);
  }
  return models;
};
