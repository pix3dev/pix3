import { OpenAICompatLlmProvider } from './OpenAICompatLlmProvider';
import { AnthropicLlmProvider } from './AnthropicLlmProvider';
import { fetchModelsDevCatalog, sortCatalogModels } from './models-dev';
import {
  LlmError,
  type ChatParams,
  type LlmListModelsContext,
  type LlmModel,
  type LlmRequestContext,
  type LlmResult,
  type ReasoningEffort,
} from './LlmTypes';

/** Zen serves reasoning models on the OpenAI `reasoning_effort` surface (low/medium/high triad). */
const ZEN_REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

/**
 * Default endpoint. OpenCode Zen sends **no CORS headers at all** (its reference integrations are
 * server-side / VS Code extensions, where CORS doesn't apply), so a browser cannot call
 * `opencode.ai` directly. Requests therefore go through a **same-origin proxy** by default: the
 * Vite dev server rewrites `/zen-proxy` → `https://opencode.ai` (see `vite.config.ts`), mirroring
 * `/openai-proxy`. For a production static build, host an equivalent proxy and point
 * `VITE_OPENCODE_ZEN_PROXY_URL` at it. The user's key still travels from the browser as a Bearer
 * token — the proxy is a dumb pass-through.
 */
const OPENCODE_ZEN_BASE_URL =
  (import.meta.env.VITE_OPENCODE_ZEN_PROXY_URL as string | undefined) ?? '/zen-proxy/zen/v1';

/** Zen serves Claude models on its native Anthropic surface; everything else is OpenAI-compatible. */
const isClaudeModel = (modelId: string): boolean => modelId.startsWith('claude-');

/**
 * Zen's Anthropic lane: the standard Messages wire mapping (`POST {base}/messages`) with Zen's
 * host and auth. Zen authenticates every route with a Bearer key, unlike native Anthropic's
 * `x-api-key` (+ browser-access opt-in) headers.
 */
class ZenMessagesLane extends AnthropicLlmProvider {
  override readonly id = 'opencode-zen';
  override readonly label = 'OpenCode Zen';
  override readonly apiKeySecretId = 'ai-provider:opencode-zen:api-key';
  override readonly defaultBaseUrl = OPENCODE_ZEN_BASE_URL;
  override readonly models: readonly LlmModel[] = [];
  protected override readonly missingKeyMessage = 'No OpenCode Zen API key configured.';

  protected override buildHeaders(ctx: LlmRequestContext): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ctx.apiKey}`,
    };
  }
}

/**
 * OpenCode Zen provider. Zen is a hosted gateway (one key from https://opencode.ai/auth, many
 * models — including a rotating set of **free** ones) whose primary surface is an OpenAI-compatible
 * Chat Completions API, so we reuse the {@link OpenAICompatLlmProvider} wire mapping. Claude models
 * are the exception: Zen serves them on a native Anthropic Messages surface, and routing them
 * through {@link ZenMessagesLane} keeps the higher-fidelity tool_use mapping (this mirrors the
 * reference VS Code extension's per-model routing).
 *
 * The static list below is only the fallback until {@link listModels} runs: the live catalog is
 * `GET {base}/models` (which ids are actually served right now — free models churn weekly) joined
 * with models.dev metadata (capabilities, context, pricing; free = $0/$0).
 */
export class OpenCodeZenLlmProvider extends OpenAICompatLlmProvider {
  override readonly id: string = 'opencode-zen';
  override readonly label: string = 'OpenCode Zen';
  // Widened to string (not the literal) so bridge-backed subclasses can override the secret id.
  override readonly apiKeySecretId: string = 'ai-provider:opencode-zen:api-key';
  override readonly apiKeyHelpUrl = 'https://opencode.ai/auth';
  // Fixed hosted gateway — unlike the generic OpenAI-compatible lane, the user does not type a base URL.
  override readonly requiresBaseUrl = false;
  override readonly defaultBaseUrl = OPENCODE_ZEN_BASE_URL;

  private readonly messagesLane = new ZenMessagesLane();

  override readonly models: readonly LlmModel[] = [
    {
      id: 'big-pickle',
      label: 'Big Pickle',
      description: 'Free · 195K ctx · reasoning',
      capabilities: {
        supportsTools: true,
        supportsImages: false,
        supportsSystemPrompt: true,
        maxOutputTokens: 32000,
        reasoningEfforts: ZEN_REASONING_EFFORTS,
      },
      pricing: { inputPer1M: 0, outputPer1M: 0 },
    },
    {
      id: 'deepseek-v4-flash-free',
      label: 'DeepSeek V4 Flash Free',
      description: 'Free · 195K ctx · reasoning',
      capabilities: {
        supportsTools: true,
        supportsImages: false,
        supportsSystemPrompt: true,
        maxOutputTokens: 32768,
        reasoningEfforts: ZEN_REASONING_EFFORTS,
      },
      pricing: { inputPer1M: 0, outputPer1M: 0 },
    },
    {
      id: 'mimo-v2.5-free',
      label: 'MiMo V2.5 Free',
      description: 'Free · 195K ctx · vision · reasoning',
      capabilities: {
        supportsTools: true,
        supportsImages: true,
        supportsSystemPrompt: true,
        maxOutputTokens: 32000,
        reasoningEfforts: ZEN_REASONING_EFFORTS,
      },
      pricing: { inputPer1M: 0, outputPer1M: 0 },
    },
    {
      id: 'nemotron-3-ultra-free',
      label: 'Nemotron 3 Ultra Free',
      description: 'Free · 977K ctx · reasoning',
      capabilities: {
        supportsTools: true,
        supportsImages: false,
        supportsSystemPrompt: true,
        maxOutputTokens: 32768,
        reasoningEfforts: ZEN_REASONING_EFFORTS,
      },
      pricing: { inputPer1M: 0, outputPer1M: 0 },
    },
    {
      id: 'hy3-free',
      label: 'Hy3 Free',
      description: 'Free · 186K ctx · reasoning',
      capabilities: {
        supportsTools: true,
        supportsImages: false,
        supportsSystemPrompt: true,
        maxOutputTokens: 32768,
        reasoningEfforts: ZEN_REASONING_EFFORTS,
      },
      pricing: { inputPer1M: 0, outputPer1M: 0 },
    },
    {
      id: 'minimax-m2.7',
      label: 'MiniMax-M2.7',
      description: '200K ctx · reasoning',
      capabilities: {
        supportsTools: true,
        supportsImages: false,
        supportsSystemPrompt: true,
        maxOutputTokens: 32768,
        reasoningEfforts: ZEN_REASONING_EFFORTS,
      },
      pricing: { inputPer1M: 0.3, outputPer1M: 1.2 },
    },
    {
      id: 'glm-5.1',
      label: 'GLM-5.1',
      description: '200K ctx · reasoning',
      capabilities: {
        supportsTools: true,
        supportsImages: false,
        supportsSystemPrompt: true,
        maxOutputTokens: 32768,
        reasoningEfforts: ZEN_REASONING_EFFORTS,
      },
      pricing: { inputPer1M: 1.4, outputPer1M: 4.4 },
    },
    {
      id: 'qwen3.6-plus',
      label: 'Qwen3.6 Plus',
      description: '256K ctx · vision · reasoning',
      capabilities: {
        supportsTools: true,
        supportsImages: true,
        supportsSystemPrompt: true,
        maxOutputTokens: 32768,
        reasoningEfforts: ZEN_REASONING_EFFORTS,
      },
      pricing: { inputPer1M: 0.5, outputPer1M: 3 },
    },
    {
      id: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      description: '977K ctx · vision · reasoning',
      capabilities: {
        supportsTools: true,
        supportsImages: true,
        supportsSystemPrompt: true,
        maxOutputTokens: 32768,
        reasoningEfforts: ZEN_REASONING_EFFORTS,
      },
      pricing: { inputPer1M: 2, outputPer1M: 10 },
    },
  ];

  // Zen is a hosted, always-keyed gateway — reject an empty key regardless of base URL.
  protected override requiresApiKey(): boolean {
    return true;
  }

  protected override readonly missingKeyMessage = 'No OpenCode Zen API key configured.';

  override async chat(params: ChatParams, ctx: LlmRequestContext): Promise<LlmResult> {
    if (isClaudeModel(ctx.modelId)) {
      if (!ctx.apiKey) {
        throw new LlmError('missing-key', this.missingKeyMessage);
      }
      return this.messagesLane.chat(params, {
        ...ctx,
        baseUrl: ctx.baseUrl ?? this.defaultBaseUrl,
      });
    }
    return super.chat(params, ctx);
  }

  /**
   * Live catalog: Zen's `GET {base}/models` is public (no key) and lists exactly what the gateway
   * serves right now, but only as bare ids; models.dev's `opencode` entry carries the metadata
   * (capabilities, context, cost) but includes retired models. The join — live ids, models.dev
   * metadata — yields a current catalog with free models identifiable ($0/$0) and sorted first.
   */
  override async listModels(ctx: LlmListModelsContext): Promise<LlmModel[]> {
    const [catalog, live] = await Promise.all([
      fetchModelsDevCatalog('opencode', ctx.fetchImpl).catch(() => null),
      super.listModels(ctx).catch(() => null),
    ]);
    if (live && live.length > 0) {
      return sortCatalogModels(live.map(model => catalog?.get(model.id) ?? model));
    }
    if (catalog && catalog.size > 0) {
      return sortCatalogModels([...catalog.values()]);
    }
    throw new LlmError('unknown', 'Could not fetch the OpenCode Zen model list.');
  }
}
