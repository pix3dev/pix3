import { OpenAICompatLlmProvider } from './OpenAICompatLlmProvider';
import { AnthropicLlmProvider } from './AnthropicLlmProvider';
import { OpenCodeZenLlmProvider } from './OpenCodeZenLlmProvider';
import { CerebrasLlmProvider } from './CerebrasLlmProvider';
import { ClaudeBridgeLlmProvider } from './ClaudeBridgeLlmProvider';
import type { LlmProvider } from './LlmTypes';

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

/** Upstream auth family the bridge injects for a provider (mirrors the bridge's `ProviderKind`). */
export type BridgeProviderKind = 'openai' | 'anthropic' | 'agent-sdk';

/** One entry from the bridge's discovery response. */
export interface BridgeProviderEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: BridgeProviderKind;
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
