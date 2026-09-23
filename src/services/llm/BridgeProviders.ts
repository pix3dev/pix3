import { OpenAICompatLlmProvider } from './OpenAICompatLlmProvider';
import { AnthropicLlmProvider } from './AnthropicLlmProvider';
import { OpenCodeZenLlmProvider } from './OpenCodeZenLlmProvider';
import { CerebrasLlmProvider } from './CerebrasLlmProvider';
import { ClaudeBridgeLlmProvider } from './ClaudeBridgeLlmProvider';
import { fetchBridgeModels } from './BridgeModels';
import type {
  LlmListModelsContext,
  LlmModel,
  LlmProvider,
  LlmRequestContext,
  ReasoningEffort,
} from './LlmTypes';

/**
 * Bridge-backed LLM providers. Instead of the browser talking to OpenAI / Anthropic / OpenCode Zen
 * directly (blocked by CORS) or through a hosted cloud proxy, the metered providers are served by a
 * locally-running **Pix3AgentBridge** (`tools/pix3-agent-bridge`). The bridge holds the real API keys
 * on the user's machine; the editor authenticates to it with a single pairing token and never sees a
 * provider key.
 *
 * These classes reuse the existing wire mappings unchanged — only the base URL (pointed at the
 * bridge's per-provider proxy path) and the secret id (the shared pairing token) are overridden. The
 * provider set is built dynamically from the bridge's `GET /v1/providers` discovery by
 * {@link import('./BridgeConnectionService').BridgeConnectionService}, so a provider only exists in
 * the editor when the bridge is running and has that provider enabled — otherwise it is simply absent
 * (and the model picker shows a "set up the bridge" call to action).
 *
 * Google Gemini is deliberately NOT here: it sends CORS headers, so the editor calls it directly with
 * the user's own key (the no-bridge path for a basic user).
 */

/** Single SecretStorage id for the bridge pairing token, shared by every bridge-backed provider. */
export const BRIDGE_TOKEN_SECRET_ID = 'ai-provider:pix3-bridge:token';

/** Default local bridge origin (overridable via the `bridgeUrl` agent preference). */
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8484';

/**
 * What the bridge is serving for an entry: an upstream auth family it injects a key for
 * (`openai` / `anthropic`, mirroring the bridge's `ProviderKind`), or one of its intrinsic local
 * lanes — the Claude Agent SDK (`agent-sdk`) or an installed CLI agent it drives as a subprocess
 * (`agent-cli`, today the Antigravity CLI).
 */
export type BridgeProviderKind = 'openai' | 'anthropic' | 'agent-sdk' | 'agent-cli';

/** One thing the bridge found wrong (or worth warning about) with a local CLI-agent lane. */
export interface BridgeAgentDiagnostic {
  readonly reason: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly detail?: string;
}

/** Health of a local CLI-agent lane, as the bridge reports it in `agents[]`. */
export interface BridgeAgentStatus {
  readonly available: boolean;
  readonly version?: string;
  readonly auth: 'ok' | 'missing' | 'unknown';
  readonly mcp: 'registered' | 'missing';
  /** 'disabled' means the lane answers, but cannot run editor tools — see the bridge's `agy setup`. */
  readonly tools: 'enabled' | 'disabled';
  /** Native Codex image tool, when the bridge has probed that CLI capability. */
  readonly imageGeneration?: boolean;
  readonly diagnostics?: readonly BridgeAgentDiagnostic[];
}

/** One entry from the bridge's discovery response. */
export interface BridgeProviderEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: BridgeProviderKind;
  /** Present only for `agent-cli` entries. */
  readonly status?: BridgeAgentStatus;
}

const normalizeBase = (url: string): string => url.replace(/\/$/, '');

/** OpenAI-compatible provider proxied through the bridge (OpenAI, gateways, custom endpoints). */
class BridgeOpenAIProvider extends OpenAICompatLlmProvider {
  override readonly id: string;
  override readonly label: string;
  override readonly apiKeySecretId = BRIDGE_TOKEN_SECRET_ID;
  override readonly requiresBaseUrl = false;
  override readonly defaultBaseUrl: string;
  protected override readonly missingKeyMessage =
    'Pix3AgentBridge pairing token is not set — paste it in Settings → AI Agent.';

  constructor(id: string, label: string, baseUrl: string) {
    super();
    this.id = id;
    this.label = label;
    this.defaultBaseUrl = baseUrl;
  }

  // The upstream key lives in the bridge; the "key" the editor sends is the pairing token, which the
  // bridge validates and replaces. Presence of the token is enforced by the connection probe, so an
  // empty base-URL key check would be redundant here.
  protected override requiresApiKey(): boolean {
    return false;
  }
}

/** Native Anthropic Messages provider proxied through the bridge. */
class BridgeAnthropicProvider extends AnthropicLlmProvider {
  override readonly id: string;
  override readonly label: string;
  override readonly apiKeySecretId = BRIDGE_TOKEN_SECRET_ID;
  readonly requiresBaseUrl = false;
  override readonly defaultBaseUrl: string;
  protected override readonly missingKeyMessage =
    'Pix3AgentBridge pairing token is not set — paste it in Settings → AI Agent.';

  constructor(id: string, label: string, baseUrl: string) {
    super();
    this.id = id;
    this.label = label;
    this.defaultBaseUrl = baseUrl;
  }
}

/** OpenCode Zen (keeps its OpenAI + Claude-via-Messages routing), proxied through the bridge. */
class BridgeZenProvider extends OpenCodeZenLlmProvider {
  override readonly apiKeySecretId: string = BRIDGE_TOKEN_SECRET_ID;
  override readonly defaultBaseUrl: string;

  constructor(baseUrl: string) {
    super();
    this.defaultBaseUrl = baseUrl;
  }
}

/** Cerebras, proxied through the bridge (visible whenever the user enables it in the bridge). */
class BridgeCerebrasProvider extends CerebrasLlmProvider {
  override readonly apiKeySecretId: string = BRIDGE_TOKEN_SECRET_ID;
  override readonly defaultBaseUrl: string;
  override readonly hidden: boolean = false;

  constructor(baseUrl: string) {
    super();
    this.defaultBaseUrl = baseUrl;
  }
}

/** Claude Code (MAX) Agent-SDK lane — the bridge's original purpose, served from a subscription. */
class BridgeClaudeCodeProvider extends ClaudeBridgeLlmProvider {
  override readonly label: string = 'Claude Code (MAX)';
  override readonly apiKeySecretId: string = BRIDGE_TOKEN_SECRET_ID;
  override readonly defaultBaseUrl: string;

  constructor(baseUrl: string) {
    super();
    this.defaultBaseUrl = baseUrl;
  }
}

/**
 * A local CLI agent the bridge drives as a subprocess — today the Antigravity CLI (`agy`), served
 * from the user's own Antigravity subscription at zero marginal cost.
 *
 * The wire is the Anthropic Messages shape (the bridge inverts agy's own NDJSON stream behind
 * `/agents/<id>/v1`), so this is an identity/auth override on {@link AnthropicLlmProvider} exactly
 * like the Claude Code lane. Two things differ and both come from what `agy` can actually do:
 *
 *   - **No vision.** agy's print mode takes text only; there is no flag for handing it an image.
 *   - **Tools are conditional.** agy auto-denies MCP calls unless the bridge was told, deliberately,
 *     to start it with `--dangerously-skip-permissions`. Until then the lane is a text-only
 *     provider — which is still worth having, because the `advisor` role is text by definition.
 *
 * The static catalog below is only a seed for the picker and for role nomination; the real list is
 * fetched live from the bridge, which asks `agy models`.
 */
class BridgeAgentCliProvider extends AnthropicLlmProvider {
  override readonly id: string;
  override readonly label: string;
  override readonly apiKeySecretId = BRIDGE_TOKEN_SECRET_ID;
  readonly requiresBaseUrl = false;
  override readonly defaultBaseUrl: string;
  protected override readonly missingKeyMessage =
    'Pix3AgentBridge pairing token is not set — paste it in Settings → AI Agent.';

  /**
   * Nominates only the advisor. A second opinion is the one role a text-only, subscription-funded
   * model fills perfectly; `main` needs tools and `vision` needs images, and this lane may have
   * neither.
   */
  readonly defaultModelIds: { readonly advisor: string };

  override readonly models: readonly LlmModel[];

  constructor(id: string, label: string, baseUrl: string, status: BridgeAgentStatus | undefined) {
    super();
    this.id = id;
    this.label = label;
    this.defaultBaseUrl = baseUrl;
    const supportsTools = status?.tools === 'enabled';
    this.defaultModelIds = { advisor: id === 'codex' ? 'gpt-5.6-sol' : 'gemini-3.1-pro' };
    const seed = (
      modelId: string,
      modelLabel: string,
      contextWindow: number,
      efforts?: readonly ReasoningEffort[]
    ): LlmModel => ({
      id: modelId,
      label: modelLabel,
      description:
        id === 'codex'
          ? 'Uses your Codex CLI sign-in and configured model.'
          : 'Antigravity CLI — runs on your Antigravity subscription, no metered key.',
      capabilities: {
        supportsTools,
        supportsImages: false,
        supportsSystemPrompt: true,
        maxOutputTokens: 32000,
        contextWindow,
        ...(efforts ? { reasoningEfforts: efforts } : {}),
      },
      pricing: { inputPer1M: 0, outputPer1M: 0 },
    });
    this.models =
      id === 'codex'
        ? [
            seed('gpt-5.6-sol', 'GPT-5.6 Sol (Codex)', 200_000, ['low', 'medium', 'high', 'xhigh']),
            seed('gpt-5.6-terra', 'GPT-5.6 Terra (Codex)', 200_000, [
              'low',
              'medium',
              'high',
              'xhigh',
            ]),
            seed('gpt-5.6-luna', 'GPT-5.6 Luna (Codex)', 200_000, [
              'low',
              'medium',
              'high',
              'xhigh',
            ]),
          ]
        : [
            seed('gemini-3.1-pro', 'Gemini 3.1 Pro (agy)', 1_000_000, ['low', 'high']),
            seed('gemini-3.8-flash', 'Gemini 3.8 Flash (agy)', 1_000_000, [
              'low',
              'medium',
              'high',
            ]),
            seed('claude-opus-4-6-thinking', 'Claude Opus 4.6 Thinking (agy)', 200_000),
            seed('claude-sonnet-4-6', 'Claude Sonnet 4.6 (agy)', 200_000),
          ];
  }

  /** Same reasoning as the Claude lane: a local plain-HTTP hop needs only the pairing token. */
  protected override buildHeaders(ctx: LlmRequestContext): Record<string, string> {
    return { 'Content-Type': 'application/json', 'x-api-key': ctx.apiKey };
  }

  async listModels(ctx: LlmListModelsContext): Promise<LlmModel[]> {
    return fetchBridgeModels(ctx.baseUrl ?? this.defaultBaseUrl, ctx, { laneLabel: this.label });
  }
}

/**
 * Build an editor provider for one bridge discovery entry. Known ids keep their specialized wire
 * behaviour (Zen's dual lanes, Cerebras' fixed model list); everything else with `kind: 'openai'`
 * uses the generic OpenAI-compatible mapping, which also covers user-defined custom endpoints.
 */
export const createBridgeProvider = (
  entry: BridgeProviderEntry,
  bridgeUrl: string
): LlmProvider => {
  const base = normalizeBase(bridgeUrl);
  if (entry.kind === 'agent-sdk') {
    return new BridgeClaudeCodeProvider(`${base}/v1`);
  }
  if (entry.kind === 'agent-cli') {
    return new BridgeAgentCliProvider(
      entry.id,
      entry.label,
      `${base}/agents/${entry.id}/v1`,
      entry.status
    );
  }
  const providerBase = `${base}/providers/${entry.id}`;
  if (entry.kind === 'anthropic') {
    return new BridgeAnthropicProvider(entry.id, entry.label, providerBase);
  }
  if (entry.id === 'opencode-zen') {
    return new BridgeZenProvider(providerBase);
  }
  if (entry.id === 'cerebras') {
    return new BridgeCerebrasProvider(providerBase);
  }
  return new BridgeOpenAIProvider(entry.id, entry.label, providerBase);
};
