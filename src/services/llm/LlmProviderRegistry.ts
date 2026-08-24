import { injectable } from '@/fw/di';
import { GeminiLlmProvider } from './GeminiLlmProvider';
import { OpenRouterLlmProvider } from './OpenRouterLlmProvider';
import type { LlmProvider } from './LlmTypes';

/**
 * Registry of available LLM providers for the in-editor agent.
 *
 * Two providers ship as built-ins, both because they send CORS headers and can therefore be called
 * straight from the browser with the user's own key — the zero-setup path for a basic user:
 * **Gemini** (the default) and **OpenRouter** (one key, every major lab plus a rotating set of free
 * models). Every other provider (OpenAI, Anthropic, OpenCode Zen, custom OpenAI-compatible
 * endpoints, and the Claude Code MAX lane) is served through a locally-running **Pix3AgentBridge**
 * and registered DYNAMICALLY from the bridge's discovery — see
 * {@link import('./BridgeConnectionService').BridgeConnectionService}. When the bridge is down the
 * dynamic set is empty, so those providers simply don't exist and the UI shows a setup call to action.
 *
 * The default provider is the first registered one (Gemini); {@link LlmProviderRegistry.getPreferred}
 * is what an unpinned selection resolves through, and it puts the bridge ahead of that default.
 */
@injectable()
export class LlmProviderRegistry {
  private readonly providers = new Map<string, LlmProvider>();
  private readonly staticOrder: string[] = [];
  /** Ids of the current dynamic (bridge-backed) set, in discovery order. */
  private bridgeOrder: string[] = [];

  constructor() {
    this.registerStatic(new GeminiLlmProvider());
    this.registerStatic(new OpenRouterLlmProvider());
  }

  /** Register a persistent provider (Gemini and OpenRouter ship this way). */
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

  /**
   * The built-in providers only — the ones this browser calls directly with a key it stores itself
   * (Gemini, OpenRouter), excluding whatever the bridge currently advertises. UI that answers "does
   * this browser hold a usable key at all?" iterates these.
   */
  listStatic(): LlmProvider[] {
    return this.staticOrder
      .map(id => this.providers.get(id))
      .filter((provider): provider is LlmProvider => Boolean(provider));
  }

  getDefault(): LlmProvider | undefined {
    return this.staticOrder.length > 0 ? this.providers.get(this.staticOrder[0]) : undefined;
  }

  /**
   * Which provider to use when the user has not pinned one: **a bridge lane first**, the static
   * default (Gemini) only as a fallback.
   *
   * Running the bridge is a deliberate act — the user installed it, paired it and put keys in it —
   * so an unpinned session answering from Gemini instead is never what was meant, and it is the
   * kind of wrong that hides: both lanes just work, and the bill/quota lands somewhere else. Within
   * the bridge the discovery order decides, which puts the providers the user explicitly configured
   * (`provider add <id> --key …`) ahead of the always-advertised Claude Code lane.
   */
  getPreferred(): LlmProvider | undefined {
    for (const id of this.bridgeOrder) {
      const provider = this.providers.get(id);
      if (provider && !provider.hidden) {
        return provider;
      }
    }
    return this.getDefault();
  }

  private registerStatic(provider: LlmProvider): void {
    if (!this.staticOrder.includes(provider.id)) {
      this.staticOrder.push(provider.id);
    }
    this.providers.set(provider.id, provider);
  }
}
