import { blobToBase64 } from '@/services/image-gen/image-ops';
import {
  ImageGenError,
  type GenerateImageParams,
  type ImageGenProvider,
  type ImageGenResult,
  type ImageModelCapabilities,
  type ProviderModel,
  type RequestContext,
} from '@/services/image-gen/ImageGenTypes';
import {
  AGENT_DEFAULT_MODEL_ID,
  parseSvgModelId,
  type SvgSpriteGenerator,
} from '@/services/image-gen/SvgSpriteGenerator';
import { clampSpriteSize } from '@/services/image-gen/svg-render';

export const SVG_LLM_PROVIDER_ID = 'svg-llm';

/** Default sprite size when a caller asks for none — a square that suits icons and small props. */
export const DEFAULT_SVG_SPRITE_SIZE = 128;

/**
 * Nothing is stored under this id — the provider borrows the agent's LLM credentials. It exists only
 * because {@link ImageGenProvider} declares the field, and `requiresApiKey: false` is what actually
 * tells every caller not to ask for a key.
 */
const UNUSED_SECRET_ID = 'ai-provider:svg-llm:unused';

const capabilities = (supportsReferenceImages: boolean): ImageModelCapabilities => ({
  supportsReferenceImages,
  maxReferenceImages: supportsReferenceImages ? 3 : 0,
  // Exact W×H replaces both knobs: an aspect ratio is what you ask for when you cannot ask for pixels.
  aspectRatios: [],
  imageSizes: [],
  qualities: [],
  maxCount: 1,
  supportsTransparency: true,
  supportsExactSize: true,
  requiresProxy: false,
});

/**
 * Thin adapter that exposes {@link SvgSpriteGenerator} as a normal image-generation provider, so the
 * Generate panel, the Sprite Editor, generation history, `AssetGenService` and the agent's
 * `generate_asset` tool all reach vector sprites through the path they already know.
 *
 * Two things about it are unlike the raster providers:
 *
 * - **No key and no catalog of its own.** `requiresApiKey` is false and the model list is derived
 *   from the LLM stack, as composite `"<llmProviderId>/<llmModelId>"` ids plus a virtual
 *   "Agent default" entry that re-resolves per call. That entry is what most users will stay on: it
 *   follows whatever the agent chat is set to, including a bridge lane.
 * - **The model list is dynamic**, so `models` is a getter rather than a frozen array. A stored pick
 *   whose lane has since disappeared still resolves — {@link SvgSpriteGenerator.resolveTarget} falls
 *   back to the agent's current selection rather than failing the generation.
 */
export class SvgLlmImageProvider implements ImageGenProvider {
  readonly id = SVG_LLM_PROVIDER_ID;
  readonly label = 'SVG (Agent LLM)';
  readonly apiKeySecretId = UNUSED_SECRET_ID;
  readonly requiresApiKey = false;

  /**
   * The generator is handed in as an accessor, not an instance: the registry constructs this
   * provider in its own constructor, while the generator is resolved through DI on first use.
   */
  constructor(private readonly generator: () => SvgSpriteGenerator) {}

  get models(): readonly ProviderModel[] {
    const virtual: ProviderModel = {
      id: AGENT_DEFAULT_MODEL_ID,
      label: 'Agent default',
      description: 'Whatever model the Agent chat is set to right now (bridge lanes included).',
      capabilities: capabilities(this.generator().supportsReferences()),
    };
    const listed = this.generator().listModels();
    return [
      virtual,
      ...listed.map(model => ({
        id: model.id,
        label: model.label,
        description: model.description,
        capabilities: capabilities(model.supportsImages),
      })),
    ];
  }

  getModel(modelId: string): ProviderModel | undefined {
    if (!modelId || modelId === AGENT_DEFAULT_MODEL_ID) {
      return this.models[0];
    }
    const listed = this.models.find(model => model.id === modelId);
    if (listed) {
      return listed;
    }
    // A composite id the catalog has not listed (a live catalog that hasn't loaded yet, or an
    // explicit agent override) is still valid — the lane is resolved at call time, not from a list.
    const parsed = parseSvgModelId(modelId);
    if (!parsed) {
      return undefined;
    }
    return {
      id: modelId,
      label: modelId,
      capabilities: capabilities(this.generator().supportsReferences(modelId)),
    };
  }

  async isAvailable(): Promise<boolean> {
    return this.generator().isAvailable();
  }

  async generate(params: GenerateImageParams, ctx: RequestContext): Promise<ImageGenResult> {
    const prompt = params.prompt?.trim();
    if (!prompt) {
      throw new ImageGenError('unknown', 'A prompt is required.');
    }
    const width = clampSpriteSize(params.width ?? 0, DEFAULT_SVG_SPRITE_SIZE);
    const height = clampSpriteSize(params.height ?? 0, width);

    const result = await this.generator().generate({
      prompt,
      width,
      height,
      svgSource: params.svgSource,
      references: params.references,
      modelId: ctx.modelId,
      signal: params.signal,
    });

    return {
      images: [
        {
          mimeType: 'image/png',
          data: await blobToBase64(result.png),
          svgSource: result.svgSource,
        },
      ],
      raw: {
        llmProviderId: result.llmProviderId,
        llmModelId: result.llmModelId,
        width,
        height,
      },
    };
  }
}
