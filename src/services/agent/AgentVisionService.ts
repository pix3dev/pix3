import { inject, injectable } from '@/fw/di';
import { AgentSettingsService } from '@/services/AgentSettingsService';
import { LlmProviderRegistry } from '@/services/llm/LlmProviderRegistry';
import { LlmModelCatalogService } from '@/services/llm/LlmModelCatalogService';
import type { LlmImageBlock, LlmProvider } from '@/services/llm/LlmTypes';

/** A resolved vision helper: a vision-capable provider + model + its API key. */
export interface VisionHelper {
  readonly provider: LlmProvider;
  readonly modelId: string;
  readonly apiKey: string;
}

/** JSON-safe description of the resolved helper (for status / debug surfaces). */
export interface VisionHelperInfo {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly modelId: string;
  readonly modelLabel: string | null;
  /** True when it was chosen automatically (no explicit user setting). */
  readonly auto: boolean;
}

const DEFAULT_QUESTION = 'Describe this image in detail.';
const MAX_VISION_TOKENS = 1024;

const VISION_SYSTEM_PROMPT =
  'You are a vision assistant helping a coding agent that cannot see images. Answer the question ' +
  'about the image concretely and concisely. When asked for style tokens, reply with a compact ' +
  'comma-separated list (palette hex, rendering style, line/shading, lighting, camera angle, mood) ' +
  'that can be pasted directly into an image-generation prompt.';

/**
 * Resolves and calls a **vision helper** — a vision-capable LLM used to describe or analyze images
 * on behalf of a text-only main model (e.g. DeepSeek). This keeps a cheap coding model usable for a
 * game-prototyping session: it can still "see" a design reference, a generated sprite, or the
 * viewport by delegating to a side model, without the user switching their main model.
 *
 * Resolution order: an explicit setting (`visionProviderId`/`visionModelId`), else the first
 * registered provider that has a configured API key AND a vision-capable model. When the main model
 * already supports images, auto-resolution simply lands on it (no extra config or cost).
 */
@injectable()
export class AgentVisionService {
  @inject(AgentSettingsService)
  private readonly settings!: AgentSettingsService;

  @inject(LlmProviderRegistry)
  private readonly registry!: LlmProviderRegistry;

  @inject(LlmModelCatalogService)
  private readonly catalog!: LlmModelCatalogService;

  /** Resolve the vision helper to use, or null when none is available (no vision key configured). */
  async resolveHelper(): Promise<VisionHelper | null> {
    const prefs = this.settings.getPreferences();

    // 1) Explicit setting wins when it is usable.
    if (prefs.visionProviderId) {
      const provider = this.registry.get(prefs.visionProviderId);
      if (provider) {
        const modelId = prefs.visionModelId || this.firstVisionModelId(provider.id);
        const apiKey = (await this.settings.getApiKey(provider.id)) ?? '';
        if (modelId && apiKey) {
          return { provider, modelId, apiKey };
        }
      }
    }

    // 2) Auto: first registered provider with a key and a vision-capable model.
    for (const provider of this.registry.list()) {
      const modelId = this.firstVisionModelId(provider.id);
      if (!modelId) {
        continue;
      }
      const apiKey = (await this.settings.getApiKey(provider.id)) ?? '';
      if (apiKey) {
        return { provider, modelId, apiKey };
      }
    }
    return null;
  }

  /** JSON-safe description of the resolved helper (or null when none is available). */
  async describeHelper(): Promise<VisionHelperInfo | null> {
    const helper = await this.resolveHelper();
    if (!helper) {
      return null;
    }
    const model = this.catalog.getModel(helper.provider.id, helper.modelId);
    return {
      providerId: helper.provider.id,
      providerLabel: helper.provider.label,
      modelId: helper.modelId,
      modelLabel: model?.label ?? null,
      auto: !this.settings.getPreferences().visionProviderId,
    };
  }

  /** Send an image + question to the vision helper and return its text answer. */
  async analyze(image: LlmImageBlock, question: string, signal?: AbortSignal): Promise<string> {
    const helper = await this.resolveHelper();
    if (!helper) {
      throw new Error(
        'No vision-capable model with a configured API key is available. Configure a vision helper ' +
          'in agent settings, or select a main model that supports images.'
      );
    }
    const prompt = question.trim() || DEFAULT_QUESTION;
    const baseUrl = this.settings.getBaseUrl(helper.provider.id);
    const result = await helper.provider.chat(
      {
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, image] }],
        system: VISION_SYSTEM_PROMPT,
        maxTokens: MAX_VISION_TOKENS,
        signal,
      },
      { apiKey: helper.apiKey, modelId: helper.modelId, baseUrl }
    );
    const text = result.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();
    return text || '(the vision model returned no text)';
  }

  /**
   * Best vision-capable model id for a provider: the currently-selected model when it already
   * supports images (no extra cost/config), else the first vision-capable model in the catalog.
   */
  private firstVisionModelId(providerId: string): string | undefined {
    const models = this.catalog.getModels(providerId);
    const selectedId = this.settings.getSelectedModelId(providerId);
    const selected = models.find(model => model.id === selectedId);
    if (selected?.capabilities.supportsImages) {
      return selected.id;
    }
    return models.find(model => model.capabilities.supportsImages)?.id;
  }
}
