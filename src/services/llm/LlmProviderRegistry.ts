import { injectable } from '@/fw/di';
import { GeminiLlmProvider } from './GeminiLlmProvider';
import type { LlmProvider } from './LlmTypes';

/**
 * Registry of available LLM providers for the in-editor agent.
 *
 * Only **Gemini** ships as a built-in: it sends CORS headers, so the editor calls it directly with
 * the user's own key — the zero-setup path for a basic user. Every other provider (OpenAI, Anthropic,
 * OpenCode Zen, custom OpenAI-compatible endpoints, and the Claude Code MAX lane) is served through a
 * locally-running **Pix3AgentBridge** and registered DYNAMICALLY from the bridge's discovery — see
 * {@link import('./BridgeConnectionService').BridgeConnectionService}. When the bridge is down the
 * dynamic set is empty, so those providers simply don't exist and the UI shows a setup call to action.
 *
 * The default provider is the first registered one (Gemini).
 */
@injectable()
export class LlmProviderRegistry {
  private readonly providers = new Map<string, LlmProvider>();
  private readonly staticOrder: string[] = [];
  /** Ids of the current dynamic (bridge-backed) set, in discovery order. */
  private bridgeOrder: string[] = [];

  constructor() {
    this.registerStatic(new GeminiLlmProvider());
  }

  /** Register a persistent provider (currently only Gemini). */
  register(provider: LlmProvider): void {
    this.registerStatic(provider);
  }

  /**
   * Replace the dynamic bridge-backed provider set with the given providers (in discovery order).
   * Previously-registered bridge providers are dropped; static providers are untouched. Called by
   * {@link BridgeConnectionService} after each discovery probe.
   */
  setBridgeProviders(providers: readonly LlmProvider[]): void {
    for (const id of this.bridgeOrder) {
      if (!this.staticOrder.includes(id)) {
        this.providers.delete(id);
      }
    }
    this.bridgeOrder = [];
    for (const provider of providers) {
      // A bridge entry must never shadow a static provider (e.g. a custom provider named "gemini").
      if (this.staticOrder.includes(provider.id)) {
        continue;
      }
      this.providers.set(provider.id, provider);
      this.bridgeOrder.push(provider.id);
    }
  }

  get(providerId: string): LlmProvider | undefined {
    return this.providers.get(providerId);
  }

  list(): LlmProvider[] {
    return [...this.staticOrder, ...this.bridgeOrder]
      .map(id => this.providers.get(id))
      .filter((provider): provider is LlmProvider => Boolean(provider));
  }

  getDefault(): LlmProvider | undefined {
    return this.staticOrder.length > 0 ? this.providers.get(this.staticOrder[0]) : undefined;
  }

  private registerStatic(provider: LlmProvider): void {
    if (!this.staticOrder.includes(provider.id)) {
      this.staticOrder.push(provider.id);
    }
    this.providers.set(provider.id, provider);
  }
}
