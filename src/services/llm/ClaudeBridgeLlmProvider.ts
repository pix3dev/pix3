import { AnthropicLlmProvider } from './AnthropicLlmProvider';
import {
  LlmError,
  type LlmListModelsContext,
  type LlmModel,
  type LlmRequestContext,
} from './LlmTypes';

/**
 * Default endpoint of the local bridge (`tools/claude-bridge`). The bridge binds to 127.0.0.1 and
 * serves the Anthropic Messages wire shape, so this provider is a thin identity/auth override on
 * top of {@link AnthropicLlmProvider} — the same pattern as OpenCode Zen's Claude lane. Override
 * the host with `VITE_CLAUDE_BRIDGE_URL` when running the bridge on a non-default port.
 */
const CLAUDE_BRIDGE_BASE_URL =
  (import.meta.env.VITE_CLAUDE_BRIDGE_URL as string | undefined) ?? 'http://127.0.0.1:8484/v1';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Personal/dev provider: routes the agent through a locally running `pix3-claude-bridge`, which
 * serves each request from a Claude Agent SDK (Claude Code) session authenticated with the user's
 * own Claude subscription. No Anthropic credentials ever enter the browser — the "API key" here is
 * the bridge's pairing token (printed by the bridge on startup), which only authorizes talking to
 * that local process.
 *
 * Requests are the standard Messages shape this class' base already emits; responses come back as
 * standard Messages responses (the bridge does the harness inversion server-side). Pricing is $0 —
 * usage draws from the subscription's limits, not a metered key.
 */
export class ClaudeBridgeLlmProvider extends AnthropicLlmProvider {
  override readonly id = 'claude-bridge';
  override readonly label = 'Claude Code (local bridge)';
  override readonly apiKeySecretId = 'ai-provider:claude-bridge:api-key';
  /** The bridge's health page explains where the pairing token comes from. */
  override readonly apiKeyHelpUrl = `${CLAUDE_BRIDGE_BASE_URL.replace(/\/v1\/?$/, '')}/health`;
  // Fixed local endpoint: not user-typed (the shared customBaseUrl pref belongs to openai-compat).
  readonly requiresBaseUrl = false;
  override readonly defaultBaseUrl = CLAUDE_BRIDGE_BASE_URL;

  protected override readonly missingKeyMessage =
    'No bridge pairing token configured. Start pix3-claude-bridge and paste the token it prints.';

  override readonly models: readonly LlmModel[] = [
    {
      id: 'claude-fable-5',
      label: 'Claude Fable 5 (MAX)',
      description: 'Most capable — via Claude Code subscription.',
      capabilities: {
        supportsTools: true,
        supportsImages: true,
        supportsSystemPrompt: true,
        maxOutputTokens: 32000,
        contextWindow: 1_000_000,
      },
      pricing: { inputPer1M: 0, outputPer1M: 0 },
    },
    {
      id: 'claude-opus-4-8',
      label: 'Claude Opus 4.8 (MAX)',
      description: 'Highly capable — via Claude Code subscription.',
      capabilities: {
        supportsTools: true,
        supportsImages: true,
        supportsSystemPrompt: true,
        maxOutputTokens: 32000,
        contextWindow: 1_000_000,
      },
      pricing: { inputPer1M: 0, outputPer1M: 0 },
    },
    {
      id: 'claude-sonnet-5',
      label: 'Claude Sonnet 5 (MAX)',
      description: 'Balanced speed and quality — via Claude Code subscription.',
      capabilities: {
        supportsTools: true,
        supportsImages: true,
        supportsSystemPrompt: true,
        maxOutputTokens: 32000,
        contextWindow: 1_000_000,
      },
      pricing: { inputPer1M: 0, outputPer1M: 0 },
    },
    {
      id: 'claude-haiku-4-5',
      label: 'Claude Haiku 4.5 (MAX)',
      description: 'Fastest — via Claude Code subscription.',
      capabilities: {
        supportsTools: true,
        supportsImages: true,
        supportsSystemPrompt: true,
        maxOutputTokens: 16000,
        contextWindow: 200_000,
      },
      pricing: { inputPer1M: 0, outputPer1M: 0 },
    },
  ];

  /**
   * The bridge is same-machine plain HTTP: no Anthropic version/browser-access headers needed, just
   * the pairing token (kept on `x-api-key` so the base class' request path works unchanged).
   */
  protected override buildHeaders(ctx: LlmRequestContext): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': ctx.apiKey,
    };
  }

  /** Live catalog from the bridge (`GET {base}/models`) — reflects what the subscription serves. */
  async listModels(ctx: LlmListModelsContext): Promise<LlmModel[]> {
    const fetchImpl = ctx.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const baseUrl = (ctx.baseUrl ?? this.defaultBaseUrl).replace(/\/$/, '');

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/models`, {
        headers: ctx.apiKey ? { 'x-api-key': ctx.apiKey } : undefined,
        signal: ctx.signal,
      });
    } catch (error) {
      throw new LlmError(
        'network',
        'Could not reach the local Claude bridge. Is pix3-claude-bridge running?',
        undefined,
        { cause: error }
      );
    }
    if (!response.ok) {
      throw new LlmError('http', `Claude bridge error (HTTP ${response.status}).`, response.status);
    }

    const payload: unknown = await response.json();
    const rawModels = isRecord(payload) && Array.isArray(payload.models) ? payload.models : [];
    const models = rawModels.filter(
      (model): model is LlmModel =>
        isRecord(model) &&
        typeof model.id === 'string' &&
        typeof model.label === 'string' &&
        isRecord(model.capabilities)
    );
    if (models.length === 0) {
      throw new LlmError('unknown', 'The Claude bridge returned no models.');
    }
    return models;
  }
}
