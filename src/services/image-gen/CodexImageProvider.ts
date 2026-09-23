import { BridgeConnectionService } from '@/services/llm/BridgeConnectionService';
import {
  ImageGenError,
  type GenerateImageParams,
  type ImageGenProvider,
  type ImageGenResult,
  type ProviderModel,
  type RequestContext,
} from '@/services/image-gen/ImageGenTypes';

const MODEL: ProviderModel = {
  id: 'default',
  label: 'Codex default',
  description: 'Uses the image generation tool in the locally signed-in Codex CLI.',
  capabilities: {
    supportsReferenceImages: true,
    maxReferenceImages: 3,
    aspectRatios: ['Auto', '1:1', '3:4', '4:3', '16:9', '9:16'],
    imageSizes: [],
    qualities: [],
    maxCount: 1,
    supportsTransparency: true,
    supportsExactSize: false,
    requiresProxy: false,
  },
};

/** Raster generation through Codex's ChatGPT sign-in, using the paired local Pix3 bridge. */
export class CodexImageProvider implements ImageGenProvider {
  readonly id = 'codex';
  readonly label = 'Codex (ChatGPT)';
  readonly apiKeySecretId = 'ai-provider:codex:unused';
  readonly requiresApiKey = false;
  readonly models = [MODEL];

  constructor(private readonly bridge: () => BridgeConnectionService) {}

  getModel(modelId: string): ProviderModel | undefined {
    return modelId === MODEL.id ? MODEL : undefined;
  }

  async isAvailable(): Promise<boolean> {
    const bridge = this.bridge();
    return Boolean(
      (await bridge.hasToken()) &&
        bridge
          .getEntries()
          .some(
            entry =>
              entry.id === 'codex' &&
              entry.kind === 'agent-cli' &&
              entry.status?.available &&
              entry.status.auth === 'ok' &&
              entry.status.imageGeneration === true
          )
    );
  }

  async generate(params: GenerateImageParams, ctx: RequestContext): Promise<ImageGenResult> {
    if (!params.prompt?.trim()) throw new ImageGenError('unknown', 'A prompt is required.');
    if (ctx.modelId !== MODEL.id) throw new ImageGenError('unknown', 'Unknown Codex image model.');
    const bridge = this.bridge();
    const token = await bridge.getToken();
    if (!token)
      throw new ImageGenError(
        'missing-key',
        'Pair the Pix3 Agent Bridge in Settings → Agent (LLM).'
      );

    let response: Response;
    try {
      response = await (ctx.fetchImpl ?? fetch)(
        `${bridge.getBridgeUrl().replace(/\/$/, '')}/agents/codex/v1/images`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-pix3-bridge-token': token },
          body: JSON.stringify({
            prompt: params.prompt.trim(),
            transparent: params.background === 'transparent',
            aspectRatio: params.aspectRatio ?? 'Auto',
            references: (params.references ?? []).slice(0, MODEL.capabilities.maxReferenceImages),
          }),
          signal: params.signal,
        }
      );
    } catch (error) {
      if (params.signal?.aborted) throw new ImageGenError('aborted', 'Image generation cancelled.');
      throw new ImageGenError('network', 'Could not reach Pix3 Agent Bridge.', undefined, {
        cause: error,
      });
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        typeof payload === 'object' &&
        payload !== null &&
        'error' in payload &&
        typeof payload.error === 'object' &&
        payload.error !== null &&
        'message' in payload.error &&
        typeof payload.error.message === 'string'
          ? payload.error.message
          : `Codex failed (${response.status}).`;
      throw new ImageGenError(
        response.status === 429 ? 'billing' : 'http',
        message,
        response.status
      );
    }
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('data' in payload) ||
      typeof payload.data !== 'string' ||
      !('mimeType' in payload) ||
      typeof payload.mimeType !== 'string'
    ) {
      throw new ImageGenError('empty', 'Codex returned no image.');
    }
    return {
      images: [{ data: payload.data, mimeType: payload.mimeType }],
      raw: {
        revisedPrompt: 'revisedPrompt' in payload ? payload.revisedPrompt : undefined,
      },
    };
  }
}
