import { OpenAICompatLlmProvider } from './OpenAICompatLlmProvider';
import { fetchModelsDevCatalog, sortCatalogModels } from './models-dev';
import { LlmError, type LlmListModelsContext, type LlmModel } from './LlmTypes';

const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';

/**
 * Cerebras Inference provider. Cerebras exposes an OpenAI-compatible Chat Completions API
 * (`POST /v1/chat/completions`, `Authorization: Bearer`) at a fixed host, so we reuse the
 * {@link OpenAICompatLlmProvider} wire mapping and only override the host, identity, model list, and
 * the key policy (Cerebras always requires a key, and the base URL is fixed rather than user-typed).
 *
 * @see https://inference-docs.cerebras.ai
 */
export class CerebrasLlmProvider extends OpenAICompatLlmProvider {
  override readonly id = 'cerebras';
  override readonly label = 'Cerebras';
  override readonly apiKeySecretId = 'ai-provider:cerebras:api-key';
  override readonly apiKeyHelpUrl = 'https://cloud.cerebras.ai/';
  // Fixed hosted endpoint — unlike the generic OpenAI-compatible lane, the user does not type a base URL.
  override readonly requiresBaseUrl = false;
  override readonly defaultBaseUrl = CEREBRAS_BASE_URL;

  override readonly models: readonly LlmModel[] = [
    {
      id: 'gpt-oss-120b',
      label: 'GPT-OSS 120B',
      description: 'Production tier — 65K context, strong tool use.',
      capabilities: {
        supportsTools: true,
        supportsImages: false,
        supportsSystemPrompt: true,
        maxOutputTokens: 8192,
      },
    },
    {
      id: 'zai-glm-4.7',
      label: 'GLM 4.7 (Z.ai)',
      description: 'Preview — 8K context.',
      capabilities: {
        supportsTools: true,
        supportsImages: false,
        supportsSystemPrompt: true,
        maxOutputTokens: 8192,
      },
    },
    {
      id: 'gemma-4-31b',
      label: 'Gemma 4 31B',
      description: 'Preview — 65K context.',
      capabilities: {
        supportsTools: true,
        supportsImages: false,
        supportsSystemPrompt: true,
        maxOutputTokens: 8192,
      },
    },
  ];

  // Cerebras is a hosted, always-keyed endpoint — reject an empty key regardless of base URL.
  protected override requiresApiKey(): boolean {
    return true;
  }

  protected override readonly missingKeyMessage = 'No Cerebras API key configured.';

  /**
   * Live catalog: `GET /v1/models` is authoritative for what the key can use but returns bare ids
   * (and needs the key — it 403s anonymously), so each live id is enriched with capabilities and
   * pricing from models.dev. Without a key (or if the live call fails) the models.dev catalog
   * stands alone.
   */
  override async listModels(ctx: LlmListModelsContext): Promise<LlmModel[]> {
    const catalog = await fetchModelsDevCatalog('cerebras', ctx.fetchImpl).catch(() => null);
    if (ctx.apiKey) {
      try {
        const live = await super.listModels(ctx);
        return sortCatalogModels(live.map(model => catalog?.get(model.id) ?? model));
      } catch {
        // Fall through to the models.dev catalog.
      }
    }
    if (catalog && catalog.size > 0) {
      return sortCatalogModels([...catalog.values()]);
    }
    throw new LlmError('unknown', 'Could not fetch the Cerebras model list.');
  }
}
