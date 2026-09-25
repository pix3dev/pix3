import { AnthropicLlmProvider, CLAUDE_REASONING_EFFORTS } from './AnthropicLlmProvider';
import { fetchBridgeModels } from './BridgeModels';
import { type LlmListModelsContext, type LlmModel, type LlmRequestContext } from './LlmTypes';

/**
 * Default endpoint of the local bridge (`tools/pix3-agent-bridge`). The bridge binds to 127.0.0.1 and
 * serves the Anthropic Messages wire shape, so this provider is a thin identity/auth override on
 * top of {@link AnthropicLlmProvider} — the same pattern as OpenCode Zen's Claude lane. Override
 * the host with `VITE_CLAUDE_BRIDGE_URL` when running the bridge on a non-default port.
 */
const CLAUDE_BRIDGE_BASE_URL =
  (import.meta.env.VITE_CLAUDE_BRIDGE_URL as string | undefined) ?? 'http://127.0.0.1:8484/v1';

/**
 * Personal/dev provider: routes the agent through a locally running `pix3-agent-bridge`, which
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
  override readonly id: string = 'claude-bridge';
  override readonly label: string = 'Claude Code (local bridge)';
  override readonly apiKeySecretId: string = 'ai-provider:claude-bridge:api-key';
  /** The bridge's health page explains where the pairing token comes from. */
  override readonly apiKeyHelpUrl = `${CLAUDE_BRIDGE_BASE_URL.replace(/\/v1\/?$/, '')}/health`;
  // Fixed local endpoint: not user-typed (the shared customBaseUrl pref belongs to openai-compat).
  readonly requiresBaseUrl = false;
  override readonly defaultBaseUrl = CLAUDE_BRIDGE_BASE_URL;

  protected override readonly missingKeyMessage =
    'No bridge pairing token configured. Start pix3-agent-bridge and paste the token it prints.';

  /**
   * Every model in this lane costs the same ($0 — it draws on the subscription's limits), so the
   * only thing left to weigh is capability. Opus runs the agent loop and answers vision questions;
   * Fable, the most capable of the lane, is held back for the advisor, whose entire job is to be a
   * second and stronger opinion than whatever is driving the turn.
   */
  readonly defaultModelIds = {
    main: 'claude-opus-5-5',
    advisor: 'claude-fable-5-1',
    vision: 'claude-opus-5-5',
  } as const;

  override readonly models: readonly LlmModel[] = [
    {
      id: 'claude-fable-5-1',
      label: 'Claude Fable 5.1 (MAX)',
      description: 'Most capable — via Claude Code subscription.',
      capabilities: {
        supportsTools: true,
        supportsImages: true,
        supportsSystemPrompt: true,
        maxOutputTokens: 32000,
        contextWindow: 1_000_000,
        reasoningEfforts: CLAUDE_REASONING_EFFORTS,
      },
      pricing: { inputPer1M: 0, outputPer1M: 0 },
    },
    {
      id: 'claude-opus-5-5',
      label: 'Claude Opus 5.5 (MAX)',
      description: 'Highly capable — via Claude Code subscription.',
      capabilities: {
        supportsTools: true,
        supportsImages: true,
        supportsSystemPrompt: true,
        maxOutputTokens: 32000,
        contextWindow: 1_000_000,
        reasoningEfforts: CLAUDE_REASONING_EFFORTS,
      },
      pricing: { inputPer1M: 0, outputPer1M: 0 },
    },
    {
      id: 'claude-opus-5',
      label: 'Claude Opus 5 (MAX)',
      description: 'Previous Opus — via Claude Code subscription.',
      capabilities: {
        supportsTools: true,
        supportsImages: true,
        supportsSystemPrompt: true,
        maxOutputTokens: 32000,
        contextWindow: 1_000_000,
        reasoningEfforts: CLAUDE_REASONING_EFFORTS,
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
        reasoningEfforts: CLAUDE_REASONING_EFFORTS,
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
    return fetchBridgeModels(ctx.baseUrl ?? this.defaultBaseUrl, ctx, {
      laneLabel: 'Claude Code',
      staticEffortsFor: id => this.getModel(id)?.capabilities.reasoningEfforts,
    });
  }
}
