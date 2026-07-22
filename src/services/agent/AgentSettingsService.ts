import { inject, injectable } from '@/fw/di';
import { SecretStorageService } from '@/services/core/SecretStorageService';
import { DEFAULT_SOUL_ID } from '@/services/agent/AgentSouls';
import { LlmProviderRegistry } from '@/services/llm/LlmProviderRegistry';
import { REASONING_EFFORTS, type LlmProvider, type ReasoningEffort } from '@/services/llm/LlmTypes';

export interface AgentPreferences {
  selectedProviderId: string;
  /** Selected model id per provider id. */
  modelByProvider: Record<string, string>;
  /**
   * Chosen reasoning-effort level per model, keyed by {@link reasoningEffortKey} (`provider::model`).
   * Absent entries mean "use the model's default effort" — nothing is sent to the provider.
   */
  reasoningEffortByModel: Record<string, ReasoningEffort>;
  /** Base URL override for the OpenAI-compatible provider (OpenAI / Ollama / LM Studio). */
  customBaseUrl: string;
  /**
   * Origin of the local Pix3AgentBridge that serves the metered providers (OpenAI / Anthropic /
   * OpenCode Zen / custom). Empty falls back to the default `http://127.0.0.1:8484`. Only changed
   * when the user runs the bridge on a non-default port.
   */
  bridgeUrl: string;
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
  /**
   * The agent's "soul": a personality preset id (see {@link import('./AgentSouls').SOUL_PRESETS}) or
   * `'custom'` for the user-authored soul. Shapes HOW the agent talks (name + tone), never what it
   * does. Missing/invalid on load falls back to {@link import('./AgentSouls').DEFAULT_SOUL_ID}.
   */
  soulId: string;
  /** Display name for the custom soul (used only when `soulId === 'custom'`). */
  customSoulName: string;
  /** Personality prompt for the custom soul (used only when `soulId === 'custom'`). */
  customSoulPrompt: string;
}

const STORAGE_KEY = 'pix3.agentSettings:v1';

/** Compose the {@link AgentPreferences.reasoningEffortByModel} key for a provider + model pair. */
const reasoningEffortKey = (providerId: string, modelId: string): string =>
  `${providerId}::${modelId}`;

const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);

/** Keep only well-formed `provider::model → level` entries when loading persisted prefs. */
const sanitizeReasoningEffortMap = (raw: unknown): Record<string, ReasoningEffort> => {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const out: Record<string, ReasoningEffort> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isReasoningEffort(value)) {
      out[key] = value;
    }
  }
  return out;
};
// 25 proved too tight for build-scale tasks: cheap models spend ~15 iterations exploring and then
// hit the cap right after play_start, before reading errors (see .plans/agent-eval-results.md).
const DEFAULT_MAX_TOOL_ITERATIONS = 40;

/**
 * Non-secret preferences for the in-editor LLM agent (selected provider/model, custom base URL, loop
 * limit). Persisted in localStorage — this is app configuration, not scene state, so it deliberately
 * does NOT flow through appState / the undo history. API keys are NOT stored here; they live
 * encrypted in {@link SecretStorageService} and are only referenced by each provider's secret id.
 *
 * Mirrors {@link import('@/services/image-gen/AiImageSettingsService').AiImageSettingsService}.
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
    if (patch.reasoningEffortByModel) {
      next.reasoningEffortByModel = {
        ...this.ensureLoaded().reasoningEffortByModel,
        ...patch.reasoningEffortByModel,
      };
    }
    this.prefs = next;
    this.persist(next);
    this.notify();
  }

  /** The chosen reasoning level for a model, or undefined to use the model's default effort. */
  getReasoningEffort(providerId: string, modelId: string): ReasoningEffort | undefined {
    if (!modelId) {
      return undefined;
    }
    return this.ensureLoaded().reasoningEffortByModel[reasoningEffortKey(providerId, modelId)];
  }

  /**
   * Set (or, with `undefined`, clear back to default) the reasoning level for one model. Clearing
   * deletes the key rather than storing a sentinel, so {@link getReasoningEffort} reports "default".
   */
  setReasoningEffort(
    providerId: string,
    modelId: string,
    effort: ReasoningEffort | undefined
  ): void {
    if (!modelId) {
      return;
    }
    const key = reasoningEffortKey(providerId, modelId);
    const map = { ...this.ensureLoaded().reasoningEffortByModel };
    if (effort) {
      map[key] = effort;
    } else {
      delete map[key];
    }
    this.prefs = { ...this.ensureLoaded(), reasoningEffortByModel: map };
    this.persist(this.prefs);
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
      reasoningEffortByModel: {},
      customBaseUrl: '',
      bridgeUrl: '',
      visionProviderId: '',
      visionModelId: '',
      advisorProviderId: '',
      advisorModelId: '',
      maxToolIterations: DEFAULT_MAX_TOOL_ITERATIONS,
      debugMode: false,
      soulId: DEFAULT_SOUL_ID,
      customSoulName: '',
      customSoulPrompt: '',
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
      // Provider ids are kept as-is (not validated against the registry): bridge-backed providers
      // register asynchronously after these prefs load, so validating here would reset a stored
      // bridge selection to the default before the bridge probe runs. getSelectedProvider() already
      // falls back to the default when an id doesn't resolve.
      return {
        selectedProviderId:
          typeof parsed.selectedProviderId === 'string' && parsed.selectedProviderId
            ? parsed.selectedProviderId
            : defaults.selectedProviderId,
        modelByProvider:
          parsed.modelByProvider && typeof parsed.modelByProvider === 'object'
            ? { ...(parsed.modelByProvider as Record<string, string>) }
            : {},
        reasoningEffortByModel: sanitizeReasoningEffortMap(parsed.reasoningEffortByModel),
        customBaseUrl:
          typeof parsed.customBaseUrl === 'string' ? parsed.customBaseUrl : defaults.customBaseUrl,
        bridgeUrl: typeof parsed.bridgeUrl === 'string' ? parsed.bridgeUrl : defaults.bridgeUrl,
        visionProviderId:
          typeof parsed.visionProviderId === 'string'
            ? parsed.visionProviderId
            : defaults.visionProviderId,
        visionModelId:
          typeof parsed.visionModelId === 'string' ? parsed.visionModelId : defaults.visionModelId,
        advisorProviderId:
          typeof parsed.advisorProviderId === 'string'
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
        soulId: typeof parsed.soulId === 'string' && parsed.soulId ? parsed.soulId : defaults.soulId,
        customSoulName:
          typeof parsed.customSoulName === 'string'
            ? parsed.customSoulName
            : defaults.customSoulName,
        customSoulPrompt:
          typeof parsed.customSoulPrompt === 'string'
            ? parsed.customSoulPrompt
            : defaults.customSoulPrompt,
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
