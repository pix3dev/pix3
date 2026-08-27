import { OpenAICompatLlmProvider } from './OpenAICompatLlmProvider';
import {
  LlmError,
  REASONING_EFFORTS,
  isAbortError,
  isRecord,
  type LlmListModelsContext,
  type LlmModel,
  type LlmModelPricing,
  type ReasoningEffort,
} from './LlmTypes';
import { sortCatalogModels } from './models-dev';

/**
 * Fixed hosted endpoint. Unlike the other gateways here (OpenCode Zen, Cerebras), OpenRouter sends
 * `Access-Control-Allow-Origin: *` on both its catalog and its inference routes, so the editor calls
 * it **directly with the user's own key** — no `/…-proxy` route to stand up, the same zero-setup
 * shape as Gemini. Override it (e.g. a self-hosted pass-through) with `VITE_OPENROUTER_BASE_URL`.
 */
const OPENROUTER_BASE_URL =
  (import.meta.env.VITE_OPENROUTER_BASE_URL as string | undefined) ??
  'https://openrouter.ai/api/v1';

/** Output-token cap we advertise: the model's real limit, never a runaway six-figure budget. */
const MAX_ADVERTISED_OUTPUT_TOKENS = 32_768;
const DEFAULT_OUTPUT_TOKENS = 8192;

/** OpenRouter prices per **token** as decimal strings; our hint is USD per 1M tokens. */
const perMillion = (value: unknown): number | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed * 1_000_000 : undefined;
};

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const OPENAI_TRIAD: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

/**
 * Which reasoning levels a model accepts. OpenRouter reports them per model
 * (`reasoning.supported_efforts`) in the same vocabulary we use, plus `minimal`/`none`, so the
 * intersection with {@link REASONING_EFFORTS} is what the picker offers — including `xhigh`/`max`
 * on the models (Claude, GPT-5.x) that really take them.
 */
const readReasoningEfforts = (entry: Record<string, unknown>): readonly ReasoningEffort[] => {
  const reasoning = isRecord(entry.reasoning) ? entry.reasoning : null;
  const supported =
    reasoning && Array.isArray(reasoning.supported_efforts) ? reasoning.supported_efforts : null;
  if (supported) {
    const efforts = REASONING_EFFORTS.filter(effort => supported.includes(effort));
    if (efforts.length > 0) return efforts;
  }
  // No per-model list, but the model still exposes the OpenAI `reasoning_effort` knob.
  const params = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
  return params.includes('reasoning_effort') || params.includes('reasoning') ? OPENAI_TRIAD : [];
};

/** Map one entry of OpenRouter's `GET /models` payload to an {@link LlmModel}; null when unusable. */
export const mapOpenRouterModel = (entry: unknown): LlmModel | null => {
  if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id) {
    return null;
  }
  const params = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
  // The agent drives this provider through tool calls, so a model without them is dead weight in a
  // 400-entry picker. `:batch` variants go to the asynchronous batch API — not an interactive turn.
  if (!params.includes('tools') || entry.id.endsWith(':batch')) {
    return null;
  }

  const architecture = isRecord(entry.architecture) ? entry.architecture : {};
  const modalities = Array.isArray(architecture.input_modalities)
    ? architecture.input_modalities
    : [];
  const topProvider = isRecord(entry.top_provider) ? entry.top_provider : {};
  const pricingRaw = isRecord(entry.pricing) ? entry.pricing : {};

  const context = asNumber(entry.context_length) ?? asNumber(topProvider.context_length);
  const maxOutput = asNumber(topProvider.max_completion_tokens);
  const supportsImages = modalities.includes('image');
  const reasoningEfforts = readReasoningEfforts(entry);

  const inputPer1M = perMillion(pricingRaw.prompt);
  const outputPer1M = perMillion(pricingRaw.completion);
  const pricing: LlmModelPricing | undefined =
    inputPer1M !== undefined && outputPer1M !== undefined ? { inputPer1M, outputPer1M } : undefined;
  const free = pricing?.inputPer1M === 0 && pricing.outputPer1M === 0;

  const descriptionParts: string[] = [];
  if (free) descriptionParts.push('Free');
  if (context) descriptionParts.push(`${Math.round(context / 1024)}K ctx`);
  if (supportsImages) descriptionParts.push('vision');
  if (reasoningEfforts.length > 0) descriptionParts.push('reasoning');

  return {
    id: entry.id,
    label: typeof entry.name === 'string' && entry.name.trim() ? entry.name : entry.id,
    description: descriptionParts.join(' · ') || undefined,
    capabilities: {
      supportsTools: true,
      supportsImages,
      supportsSystemPrompt: true,
      maxOutputTokens: Math.min(maxOutput ?? DEFAULT_OUTPUT_TOKENS, MAX_ADVERTISED_OUTPUT_TOKENS),
      contextWindow: context,
      ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
    },
    pricing,
  };
};

/**
 * OpenRouter provider. One key (https://openrouter.ai/keys) fronts every major lab plus a rotating
 * set of **free** models on an OpenAI-compatible Chat Completions surface, so this reuses the
 * {@link OpenAICompatLlmProvider} wire mapping and overrides only the identity, host, headers and
 * catalog.
 *
 * Two things set it apart from the other gateways in this folder:
 *
 * - **It is browser-callable.** Its CORS headers are permissive, so it is registered *statically*
 *   beside Gemini and needs neither the Pix3AgentBridge nor a dev-server proxy route.
 * - **Its catalog is self-describing.** `GET /models` is public (no key) and already carries
 *   capabilities, context, per-token pricing and per-model reasoning levels, so unlike Zen/Cerebras
 *   there is nothing to join against models.dev — the static list below is only an offline fallback.
 *
 * @see https://openrouter.ai/docs/api-reference/overview
 */
export class OpenRouterLlmProvider extends OpenAICompatLlmProvider {
  override readonly id: string = 'openrouter';
  override readonly label: string = 'OpenRouter';
  override readonly apiKeySecretId: string = 'ai-provider:openrouter:api-key';
  override readonly apiKeyHelpUrl = 'https://openrouter.ai/keys';
  // Fixed hosted gateway — unlike the generic OpenAI-compatible lane, the user does not type a base URL.
  override readonly requiresBaseUrl = false;
  override readonly defaultBaseUrl = OPENROUTER_BASE_URL;

  override readonly models: readonly LlmModel[] = [
    {
      id: 'z-ai/glm-5.2:free',
      label: 'Z.ai: GLM 5.2 (free)',
      description: 'Free · 250K ctx · reasoning',
      capabilities: {
        supportsTools: true,
        supportsImages: false,
        supportsSystemPrompt: true,
        maxOutputTokens: MAX_ADVERTISED_OUTPUT_TOKENS,
        contextWindow: 256_000,
        reasoningEfforts: ['high', 'xhigh'],
      },
      pricing: { inputPer1M: 0, outputPer1M: 0 },
    },
    {
      id: 'google/gemini-3.7-flash',
      label: 'Google: Gemini 3.7 Flash',
      description: '1024K ctx · vision · reasoning',
      capabilities: {
        supportsTools: true,
        supportsImages: true,
        supportsSystemPrompt: true,
        maxOutputTokens: MAX_ADVERTISED_OUTPUT_TOKENS,
        contextWindow: 1_048_576,
        reasoningEfforts: OPENAI_TRIAD,
      },
      pricing: { inputPer1M: 0.375, outputPer1M: 1.875 },
    },
    {
      id: 'anthropic/claude-sonnet-5',
      label: 'Anthropic: Claude Sonnet 5',
      description: '977K ctx · vision · reasoning',
      capabilities: {
        supportsTools: true,
        supportsImages: true,
        supportsSystemPrompt: true,
        maxOutputTokens: MAX_ADVERTISED_OUTPUT_TOKENS,
        contextWindow: 1_000_000,
        reasoningEfforts: REASONING_EFFORTS,
      },
      pricing: { inputPer1M: 2, outputPer1M: 10 },
    },
    {
      id: 'openai/gpt-5.6-terra',
      label: 'OpenAI: GPT-5.6 Terra',
      description: '1025K ctx · vision · reasoning',
      capabilities: {
        supportsTools: true,
        supportsImages: true,
        supportsSystemPrompt: true,
        maxOutputTokens: MAX_ADVERTISED_OUTPUT_TOKENS,
        contextWindow: 1_050_000,
        reasoningEfforts: REASONING_EFFORTS,
      },
      pricing: { inputPer1M: 2, outputPer1M: 12 },
    },
    {
      id: 'deepseek/deepseek-v4-flash',
      label: 'DeepSeek: DeepSeek V4 Flash',
      description: '1024K ctx · reasoning',
      capabilities: {
        supportsTools: true,
        supportsImages: false,
        supportsSystemPrompt: true,
        maxOutputTokens: MAX_ADVERTISED_OUTPUT_TOKENS,
        contextWindow: 1_048_576,
        reasoningEfforts: ['high', 'xhigh'],
      },
      pricing: { inputPer1M: 0.056, outputPer1M: 0.112 },
    },
  ];

  // OpenRouter is a hosted, always-keyed gateway — reject an empty key regardless of base URL.
  protected override requiresApiKey(): boolean {
    return true;
  }

  protected override readonly missingKeyMessage = 'No OpenRouter API key configured.';

  protected override readonly networkErrorMessage =
    'Network error contacting OpenRouter. Check your connection and API key — and that no ' +
    'extension or firewall is blocking openrouter.ai.';

  /**
   * Attribution headers OpenRouter uses to credit and rank the calling app (both optional, neither
   * affects billing). `HTTP-Referer` is spelled that way deliberately: a browser refuses to let a
   * page set the real `Referer` header.
   */
  protected override extraHeaders(): Record<string, string> {
    const origin =
      typeof globalThis.location === 'object' ? globalThis.location?.origin : undefined;
    return {
      ...(origin ? { 'HTTP-Referer': origin } : {}),
      'X-Title': 'Pix3 Editor',
    };
  }

  /**
   * OpenRouter forwards the whole `low…max` range to the models that advertise it, and the picker
   * only offers a model's own {@link LlmModel.capabilities} levels — so, unlike the OpenAI triad the
   * base class clamps to, the chosen level goes through untouched.
   */
  protected override mapReasoningEffort(effort: ReasoningEffort): string {
    return effort;
  }

  /**
   * Live catalog from OpenRouter's own `GET /models`: public, keyless, and rich enough on its own
   * (capabilities, context, per-token pricing, per-model reasoning levels) that no models.dev join
   * is needed. Non-tool and `:batch` models are dropped by {@link mapOpenRouterModel}; free models
   * sort first.
   */
  override async listModels(ctx: LlmListModelsContext): Promise<LlmModel[]> {
    const baseUrl = (ctx.baseUrl ?? this.defaultBaseUrl).replace(/\/$/, '');
    const fetchImpl = ctx.fetchImpl ?? globalThis.fetch.bind(globalThis);

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/models`, {
        method: 'GET',
        headers: this.extraHeaders(),
        signal: ctx.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new LlmError('aborted', 'The request was cancelled.');
      }
      throw new LlmError(
        'network',
        'Network error fetching the OpenRouter model list.',
        undefined,
        {
          cause: error,
        }
      );
    }

    if (!response.ok) {
      throw new LlmError(
        'http',
        `OpenRouter returned HTTP ${response.status} for its model list.`,
        response.status
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new LlmError('unknown', 'Malformed OpenRouter model list.', undefined, {
        cause: error,
      });
    }

    const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
    const models = data
      .map(mapOpenRouterModel)
      .filter((model): model is LlmModel => model !== null);
    if (models.length === 0) {
      throw new LlmError('unknown', 'OpenRouter returned no usable (tool-calling) models.');
    }
    return sortCatalogModels(models);
  }
}
