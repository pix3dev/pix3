import { LlmError, isAbortError, isRecord, type LlmModel, type ReasoningEffort } from './LlmTypes';

/** OpenAI-compatible reasoning levels — the set gateway (`reasoning_effort`) models accept. */
const OPENAI_REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

/**
 * Shared [models.dev](https://models.dev) catalog client. models.dev is the community model
 * database opencode itself uses: one public `api.json` (CORS `*`, no key) keyed by provider id,
 * with per-model capabilities (`tool_call`, `attachment`, `reasoning`), limits and USD costs —
 * free models are the ones priced 0/0. Hosted-gateway providers (OpenCode Zen, Cerebras) use it
 * to enrich their live `/models` id lists with capabilities and pricing.
 *
 * The raw payload is a few MB, so one download is shared module-wide: an in-flight promise dedups
 * concurrent refreshes and the parsed JSON is kept for a short TTL (providers refreshing seconds
 * apart reuse it; the long-term cache lives in `LlmModelCatalogService`).
 */

const MODELS_DEV_URL = 'https://models.dev/api.json';
const PAYLOAD_TTL_MS = 10 * 60 * 1000;

let cachedPayload: { readonly at: number; readonly payload: Record<string, unknown> } | null = null;
let inflight: Promise<Record<string, unknown>> | null = null;

/** Drop the module-level payload cache (test isolation). */
export const resetModelsDevCache = (): void => {
  cachedPayload = null;
  inflight = null;
};

const fetchPayload = async (fetchImpl: typeof fetch): Promise<Record<string, unknown>> => {
  if (cachedPayload && Date.now() - cachedPayload.at < PAYLOAD_TTL_MS) {
    return cachedPayload.payload;
  }
  if (inflight) {
    return inflight;
  }
  inflight = (async () => {
    let response: Response;
    try {
      response = await fetchImpl(MODELS_DEV_URL, { method: 'GET' });
    } catch (error) {
      if (isAbortError(error)) {
        throw new LlmError('aborted', 'The request was cancelled.');
      }
      throw new LlmError('network', 'Network error contacting models.dev.', undefined, {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new LlmError('http', `models.dev returned HTTP ${response.status}.`, response.status);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new LlmError('unknown', 'Malformed models.dev payload.', undefined, { cause: error });
    }
    if (!isRecord(payload)) {
      throw new LlmError('unknown', 'Malformed models.dev payload (not an object).');
    }
    cachedPayload = { at: Date.now(), payload };
    return payload;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
};

/** Output-token cap we advertise per model: its real limit, but never a runaway six-figure budget. */
const MAX_ADVERTISED_OUTPUT_TOKENS = 32_768;
const DEFAULT_OUTPUT_TOKENS = 8192;

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Map one models.dev model entry to our {@link LlmModel}. Returns null for malformed entries. */
export const mapModelsDevModel = (id: string, entry: unknown): LlmModel | null => {
  if (!isRecord(entry)) {
    return null;
  }
  const limit = isRecord(entry.limit) ? entry.limit : {};
  const cost = isRecord(entry.cost) ? entry.cost : {};
  const inputCost = asNumber(cost.input);
  const outputCost = asNumber(cost.output);
  const context = asNumber(limit.context);
  const output = asNumber(limit.output);
  const supportsImages = entry.attachment === true;
  const supportsReasoning = entry.reasoning === true;
  const free = inputCost === 0 && outputCost === 0;

  const descriptionParts: string[] = [];
  if (free) descriptionParts.push('Free');
  if (context) descriptionParts.push(`${Math.round(context / 1024)}K ctx`);
  if (supportsImages) descriptionParts.push('vision');
  if (supportsReasoning) descriptionParts.push('reasoning');

  return {
    id,
    label: typeof entry.name === 'string' && entry.name.trim() ? entry.name : id,
    description: descriptionParts.join(' · ') || undefined,
    capabilities: {
      supportsTools: entry.tool_call === true,
      supportsImages,
      supportsSystemPrompt: true,
      maxOutputTokens: Math.min(output ?? DEFAULT_OUTPUT_TOKENS, MAX_ADVERTISED_OUTPUT_TOKENS),
      contextWindow: context,
      // These gateway models speak the OpenAI `reasoning_effort` surface, which accepts the
      // low/medium/high triad (the extended xhigh/max levels are Anthropic-only).
      ...(supportsReasoning ? { reasoningEfforts: OPENAI_REASONING_EFFORTS } : {}),
    },
    pricing:
      inputCost !== undefined && outputCost !== undefined
        ? { inputPer1M: inputCost, outputPer1M: outputCost }
        : undefined,
  };
};

/**
 * Fetch one provider's model map from models.dev, keyed by model id. Throws {@link LlmError} when
 * the catalog is unreachable or the provider key is absent.
 */
export const fetchModelsDevCatalog = async (
  providerKey: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<Map<string, LlmModel>> => {
  const payload = await fetchPayload(fetchImpl);
  const provider = payload[providerKey];
  if (!isRecord(provider) || !isRecord(provider.models)) {
    throw new LlmError('unknown', `models.dev has no catalog for "${providerKey}".`);
  }
  const models = new Map<string, LlmModel>();
  for (const [id, entry] of Object.entries(provider.models)) {
    const model = mapModelsDevModel(id, entry);
    if (model) {
      models.set(id, model);
    }
  }
  return models;
};

/** Model-picker order for gateway catalogs: free models first, then alphabetical by label. */
export const sortCatalogModels = (models: readonly LlmModel[]): LlmModel[] => {
  const isFree = (model: LlmModel): boolean =>
    model.pricing?.inputPer1M === 0 && model.pricing?.outputPer1M === 0;
  return [...models].sort((a, b) => {
    const freeDelta = Number(isFree(b)) - Number(isFree(a));
    return freeDelta !== 0 ? freeDelta : a.label.localeCompare(b.label);
  });
};
