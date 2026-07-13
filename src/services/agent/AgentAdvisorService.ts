import { inject, injectable } from '@/fw/di';
import { AgentSettingsService } from '@/services/AgentSettingsService';
import { LlmProviderRegistry } from '@/services/llm/LlmProviderRegistry';
import { LlmModelCatalogService } from '@/services/llm/LlmModelCatalogService';
import type { LlmProvider } from '@/services/llm/LlmTypes';

/** A resolved advisor: a (user-chosen, deliberately stronger) provider + model + its API key. */
export interface Advisor {
  readonly provider: LlmProvider;
  readonly modelId: string;
  readonly apiKey: string;
}

/** JSON-safe description of the resolved advisor (for status / debug surfaces). */
export interface AdvisorInfo {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly modelId: string;
  readonly modelLabel: string | null;
}

const MAX_ADVISOR_TOKENS = 2048;

const ADVISOR_SYSTEM_PROMPT =
  'You are a senior game-development advisor. Another AI agent working inside the Pix3 editor ' +
  '(a browser-based editor for HTML5 games mixing 2D and 3D, with Script components attached to ' +
  'scene nodes) is consulting you about a problem it could not solve alone. Be concrete and ' +
  'actionable: name the most likely cause when diagnosable, propose the smallest fix or a short ' +
  'numbered plan, and include code only when it directly answers the question. You see ONLY what ' +
  'the agent passed you — if essential information is missing, start with a single line stating ' +
  'exactly what to check or provide, then give your best answer anyway. Answer in the language ' +
  'of the question.';

/**
 * Resolves and calls the **advisor** — a deliberately stronger LLM the main (usually cheap) agent
 * model can consult via the `ask_advisor` tool when it is stuck or facing a non-obvious design
 * decision. Stateless: one question + caller-provided context in, one answer out; the advisor never
 * sees the conversation, the scene, or any tools.
 *
 * Unlike the vision helper there is NO auto-resolution: "stronger than the main model" is a
 * judgment call, so the feature is off until the user (or the eval harness) explicitly picks an
 * advisor provider/model in agent settings.
 */
@injectable()
export class AgentAdvisorService {
  @inject(AgentSettingsService)
  private readonly settings!: AgentSettingsService;

  @inject(LlmProviderRegistry)
  private readonly registry!: LlmProviderRegistry;

  @inject(LlmModelCatalogService)
  private readonly catalog!: LlmModelCatalogService;

  /** Resolve the configured advisor, or null when unset / its provider has no API key. */
  async resolveAdvisor(): Promise<Advisor | null> {
    const prefs = this.settings.getPreferences();
    if (!prefs.advisorProviderId) {
      return null;
    }
    const provider = this.registry.get(prefs.advisorProviderId);
    if (!provider) {
      return null;
    }
    const modelId = prefs.advisorModelId || this.settings.getSelectedModelId(provider.id);
    const apiKey = (await this.settings.getApiKey(provider.id)) ?? '';
    if (!modelId || !apiKey) {
      return null;
    }
    return { provider, modelId, apiKey };
  }

  /** JSON-safe description of the resolved advisor (or null when none is configured/usable). */
  async describeAdvisor(): Promise<AdvisorInfo | null> {
    const advisor = await this.resolveAdvisor();
    if (!advisor) {
      return null;
    }
    const model = this.catalog.getModel(advisor.provider.id, advisor.modelId);
    return {
      providerId: advisor.provider.id,
      providerLabel: advisor.provider.label,
      modelId: advisor.modelId,
      modelLabel: model?.label ?? null,
    };
  }

  /**
   * Ask the advisor one question. `context` is everything the advisor gets besides the question —
   * the caller (tool handler) is responsible for including the goal, exact errors, and code.
   */
  async consult(question: string, context: string, signal?: AbortSignal): Promise<string> {
    const advisor = await this.resolveAdvisor();
    if (!advisor) {
      throw new Error(
        'No advisor model is configured (or its provider has no API key). The user can set one in ' +
          'the agent settings; until then, proceed with your own best judgment.'
      );
    }
    const body = context.trim()
      ? `${question.trim()}\n\n--- Context provided by the consulting agent ---\n${context.trim()}`
      : question.trim();
    const baseUrl = this.settings.getBaseUrl(advisor.provider.id);
    const result = await advisor.provider.chat(
      {
        messages: [{ role: 'user', content: [{ type: 'text', text: body }] }],
        system: ADVISOR_SYSTEM_PROMPT,
        maxTokens: MAX_ADVISOR_TOKENS,
        signal,
      },
      { apiKey: advisor.apiKey, modelId: advisor.modelId, baseUrl }
    );
    const text = result.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();
    return text || '(the advisor returned no text)';
  }
}
