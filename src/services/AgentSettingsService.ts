import { inject, injectable } from '@/fw/di';
import { SecretStorageService } from '@/services/SecretStorageService';
import { LlmProviderRegistry } from '@/services/llm/LlmProviderRegistry';
import type { LlmProvider } from '@/services/llm/LlmTypes';

export interface AgentPreferences {
  selectedProviderId: string;
  /** Selected model id per provider id. */
  modelByProvider: Record<string, string>;
  /** Base URL override for the OpenAI-compatible provider (OpenAI / Ollama / LM Studio). */
  customBaseUrl: string;
  /**
   * Optional override for the vision-helper provider (used by `analyze_image` when the main model
   * can't see images). Empty = auto-resolve to the first provider with a key + a vision model.
   */
  visionProviderId: string;
  /** Vision-helper model id (paired with {@link visionProviderId}). Empty = first vision model. */
  visionModelId: string;
  /**
   * Provider of the **advisor** model — a deliberately stronger model the agent may consult via
   * `ask_advisor` when stuck or facing a design decision. Empty = the advisor feature is off
   * (never auto-picked: "stronger than the main model" is a judgment only the user can make).
   */
  advisorProviderId: string;
  /** Advisor model id (paired with {@link advisorProviderId}). Empty = the provider's selected model. */
  advisorModelId: string;
  /** Max LLM ⇄ tool-call round trips per agent turn (safety cap on the agentic loop). */
  maxToolIterations: number;
  /**
   * When on, the Agent panel exposes the raw wire-format conversation log, the resolved system
   * prompt, and per-response timing / tokens-per-second, and {@link AgentChatService} logs each
   * request and response to the browser devtools console.
   */
  debugMode: boolean;
}

const STORAGE_KEY = 'pix3.agentSettings:v1';
// 25 proved too tight for build-scale tasks: cheap models spend ~15 iterations exploring and then
// hit the cap right after play_start, before reading errors (see .plans/agent-eval-results.md).
const DEFAULT_MAX_TOOL_ITERATIONS = 40;

/**
 * Non-secret preferences for the in-editor LLM agent (selected provider/model, custom base URL, loop
 * limit). Persisted in localStorage — this is app configuration, not scene state, so it deliberately
 * does NOT flow through appState / the undo history. API keys are NOT stored here; they live
 * encrypted in {@link SecretStorageService} and are only referenced by each provider's secret id.
 *
 * Mirrors {@link import('./AiImageSettingsService').AiImageSettingsService}.
 */
@injectable()
export class AgentSettingsService {
  @inject(LlmProviderRegistry)
  private readonly registry!: LlmProviderRegistry;

  @inject(SecretStorageService)
  private readonly secrets!: SecretStorageService;

  private prefs: AgentPreferences | null = null;
  private readonly listeners = new Set<(prefs: AgentPreferences) => void>();

  getPreferences(): AgentPreferences {
    return { ...this.ensureLoaded() };
  }

  updatePreferences(patch: Partial<AgentPreferences>): void {
    const next: AgentPreferences = { ...this.ensureLoaded(), ...patch };
    if (patch.modelByProvider) {
      next.modelByProvider = { ...this.ensureLoaded().modelByProvider, ...patch.modelByProvider };
    }
    this.prefs = next;
    this.persist(next);
    this.notify();
  }

  /** Resolve the currently-selected provider (falls back to the default provider). */
  getSelectedProvider(): LlmProvider | undefined {
    const prefs = this.ensureLoaded();
    return this.registry.get(prefs.selectedProviderId) ?? this.registry.getDefault();
  }

  /** Resolve the selected model id for a provider (falls back to its first model). */
  getSelectedModelId(providerId: string): string | undefined {
    const prefs = this.ensureLoaded();
    const provider = this.registry.get(providerId);
    if (!provider) {
      return undefined;
    }
    const stored = prefs.modelByProvider[providerId];
    if (stored) {
      // Providers that accept arbitrary ids (OpenAI-compatible / local) or fetch a live catalog
      // (their real model set is wider than the static fallback list) pass any stored id through.
      // For static fixed-list providers, a stored id no longer in the list (e.g. a deprecated
      // Gemini model) falls back to the first model so a stale selection can't keep sending a
      // dead id.
      if (
        provider.requiresBaseUrl ||
        typeof provider.listModels === 'function' ||
        provider.models.some(model => model.id === stored)
      ) {
        return stored;
      }
    }
    return provider.models[0]?.id;
  }

  /**
   * Resolve the base URL to use for a provider: the user's `customBaseUrl` for providers that need
   * one (OpenAI-compatible), otherwise the provider's default (or `undefined` to let the provider
   * pick its own default).
   */
  getBaseUrl(providerId: string): string | undefined {
    const prefs = this.ensureLoaded();
    const provider = this.registry.get(providerId);
    if (provider?.requiresBaseUrl && prefs.customBaseUrl.trim()) {
      return prefs.customBaseUrl.trim();
    }
    return provider?.defaultBaseUrl;
  }

  subscribe(listener: (prefs: AgentPreferences) => void): () => void {
    this.listeners.add(listener);
    listener(this.getPreferences());
    return () => this.listeners.delete(listener);
  }

  // -- API keys (delegated to encrypted secret storage) ----------------------

  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    const provider = this.registry.get(providerId);
    if (!provider) {
      throw new Error(`Unknown LLM provider: ${providerId}`);
    }
    await this.secrets.setSecret(provider.apiKeySecretId, apiKey);
    this.notify();
  }

  async clearApiKey(providerId: string): Promise<void> {
    const provider = this.registry.get(providerId);
    if (!provider) {
      return;
    }
    await this.secrets.deleteSecret(provider.apiKeySecretId);
    this.notify();
  }

  async hasApiKey(providerId: string): Promise<boolean> {
    const provider = this.registry.get(providerId);
    if (!provider) {
      return false;
    }
    return this.secrets.hasSecret(provider.apiKeySecretId);
  }

  async getApiKey(providerId: string): Promise<string | null> {
    const provider = this.registry.get(providerId);
    if (!provider) {
      return null;
    }
    return this.secrets.getSecret(provider.apiKeySecretId);
  }

  dispose(): void {
    this.listeners.clear();
    this.prefs = null;
  }

  // -- internals -------------------------------------------------------------

  private ensureLoaded(): AgentPreferences {
    if (!this.prefs) {
      this.prefs = this.load();
    }
    return this.prefs;
  }

  private defaults(): AgentPreferences {
    const defaultProvider = this.registry.getDefault();
    return {
      selectedProviderId: defaultProvider?.id ?? '',
      modelByProvider: {},
      customBaseUrl: '',
      visionProviderId: '',
      visionModelId: '',
      advisorProviderId: '',
      advisorModelId: '',
      maxToolIterations: DEFAULT_MAX_TOOL_ITERATIONS,
      debugMode: false,
    };
  }

  private load(): AgentPreferences {
    const defaults = this.defaults();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return defaults;
      }
      const parsed = JSON.parse(raw) as Partial<AgentPreferences> | null;
      if (!parsed || typeof parsed !== 'object') {
        return defaults;
      }
      return {
        selectedProviderId:
          typeof parsed.selectedProviderId === 'string' &&
          this.registry.get(parsed.selectedProviderId)
            ? parsed.selectedProviderId
            : defaults.selectedProviderId,
        modelByProvider:
          parsed.modelByProvider && typeof parsed.modelByProvider === 'object'
            ? { ...(parsed.modelByProvider as Record<string, string>) }
            : {},
        customBaseUrl:
          typeof parsed.customBaseUrl === 'string' ? parsed.customBaseUrl : defaults.customBaseUrl,
        visionProviderId:
          typeof parsed.visionProviderId === 'string' && this.registry.get(parsed.visionProviderId)
            ? parsed.visionProviderId
            : defaults.visionProviderId,
        visionModelId:
          typeof parsed.visionModelId === 'string' ? parsed.visionModelId : defaults.visionModelId,
        advisorProviderId:
          typeof parsed.advisorProviderId === 'string' &&
          this.registry.get(parsed.advisorProviderId)
            ? parsed.advisorProviderId
            : defaults.advisorProviderId,
        advisorModelId:
          typeof parsed.advisorModelId === 'string'
            ? parsed.advisorModelId
            : defaults.advisorModelId,
        maxToolIterations:
          typeof parsed.maxToolIterations === 'number' &&
          Number.isFinite(parsed.maxToolIterations) &&
          parsed.maxToolIterations > 0
            ? Math.min(Math.round(parsed.maxToolIterations), 100)
            : defaults.maxToolIterations,
        debugMode: typeof parsed.debugMode === 'boolean' ? parsed.debugMode : defaults.debugMode,
      };
    } catch {
      return defaults;
    }
  }

  private persist(prefs: AgentPreferences): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // ignore persistence errors (private mode / quota)
    }
  }

  private notify(): void {
    const snapshot = this.getPreferences();
    this.listeners.forEach(listener => listener(snapshot));
  }
}
