import { inject, injectable } from '@/fw/di';
import { AgentSettingsService } from '@/services/agent/AgentSettingsService';
import { LlmModelCatalogService } from '@/services/llm/LlmModelCatalogService';
import { LlmProviderRegistry } from '@/services/llm/LlmProviderRegistry';
import { formatLlmModelId, parseLlmModelId } from '@/services/llm/llm-model-id';
import type { LlmModel, LlmProvider } from '@/services/llm/LlmTypes';

/**
 * A resolved LLM lane: provider + model + endpoint. Deliberately key-free so it can be resolved
 * synchronously (a model picker needs it); the credential is read separately, at call time.
 */
export interface LlmLane {
  readonly provider: LlmProvider;
  readonly modelId: string;
  readonly baseUrl?: string;
  readonly model?: LlmModel;
}

/** One entry of a borrower's model picker: a composite id plus what to draw next to it. */
export interface LlmLaneOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly supportsImages: boolean;
}

/**
 * Resolves "which LLM answers" for features that **borrow the agent chat's model** instead of owning
 * a provider and a key of their own — the `svg-llm` image provider and the SFX generator today.
 *
 * The rule in one sentence: a composite id pins a provider+model, and anything else (the
 * `AGENT_DEFAULT_MODEL_ID` sentinel, a malformed id, or a pinned lane whose provider is no longer
 * registered) falls back to the agent's current selection. The fallback is the load-bearing half — a
 * stored pick for a bridge lane that is currently down must degrade to a working model rather than
 * fail the call, which is why this never throws and answers `null` only when the agent itself has no
 * lane at all.
 */
@injectable()
export class LlmLaneResolver {
  @inject(AgentSettingsService)
  private readonly agentSettings!: AgentSettingsService;

  @inject(LlmProviderRegistry)
  private readonly llmRegistry!: LlmProviderRegistry;

  @inject(LlmModelCatalogService)
  private readonly catalog!: LlmModelCatalogService;

  /** The lane a given composite/sentinel `modelId` resolves to, or null when none is configured. */
  resolve(modelId?: string): LlmLane | null {
    const composite = modelId ? parseLlmModelId(modelId) : null;
    if (composite) {
      const provider = this.llmRegistry.get(composite.providerId);
      if (provider) {
        return this.describe(provider, composite.modelId);
      }
    }
    const provider = this.agentSettings.getSelectedProvider();
    if (!provider) {
      return null;
    }
    const selectedModelId = this.agentSettings.getSelectedModelId(provider.id) ?? '';
    if (!selectedModelId) {
      return null;
    }
    return this.describe(provider, selectedModelId);
  }

  /**
   * Whether a lane is usable right now — a lane plus a credential for it. This is the "no key needed,
   * but is one reachable?" check every borrower gates its UI on, so a missing key reads as "configure
   * a provider in Agent settings" rather than as a nag for a key nothing here would store.
   */
  async isAvailable(modelId?: string): Promise<boolean> {
    const lane = this.resolve(modelId);
    if (!lane) {
      return false;
    }
    try {
      return Boolean(await this.agentSettings.getApiKey(lane.provider.id));
    } catch {
      return false;
    }
  }

  /** The credential for a lane (API key or bridge token). Empty string when there is none. */
  async getApiKey(lane: LlmLane): Promise<string> {
    try {
      return (await this.agentSettings.getApiKey(lane.provider.id)) ?? '';
    } catch {
      return '';
    }
  }

  /** Models a borrower's picker should offer: the agent's current provider, as composite ids. */
  listOptions(): LlmLaneOption[] {
    const provider = this.agentSettings.getSelectedProvider();
    if (!provider) {
      return [];
    }
    return this.catalog.getModels(provider.id).map(model => ({
      id: formatLlmModelId(provider.id, model.id),
      label: `${provider.label} · ${model.label}`,
      description: model.description,
      supportsImages: model.capabilities.supportsImages,
    }));
  }

  // -- internals -------------------------------------------------------------

  private describe(provider: LlmProvider, modelId: string): LlmLane {
    return {
      provider,
      modelId,
      baseUrl: this.agentSettings.getBaseUrl(provider.id),
      model: this.catalog.getModel(provider.id, modelId) ?? provider.getModel(modelId),
    };
  }
}
