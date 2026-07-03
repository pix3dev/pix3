import {
  ImageGenError,
  type AspectRatio,
  type GenerateImageParams,
  type GeneratedImage,
  type ImageGenProvider,
  type ImageGenResult,
  type ProviderModel,
  type RequestContext,
} from './ImageGenTypes';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const ASPECTS: readonly AspectRatio[] = ['Auto', '1:1', '3:4', '4:3', '16:9', '9:16'];

// Prepended before reference images so the model treats them as visual guidance rather than as
// captions to render into the output. Mirrors the proven Magic Studio integration.
const REFERENCE_PREAMBLE =
  'The following attached images are visual references for this generation. ' +
  'Use them only as visual guidance for subject, composition, lighting, colour and style. ' +
  'Do not render any filenames, labels, captions or other text onto the generated image unless the prompt explicitly asks for text.';

/**
 * Google Gemini ("Nano Banana") image generation via the `generateContent` endpoint
 * (`POST /v1beta/models/{model}:generateContent`, header `x-goog-api-key`). Text-to-image and
 * reference-to-image share the endpoint; references are inline base64 image parts. Output size and
 * aspect are requested through `generationConfig.imageConfig`. The API returns base64 image bytes
 * inline (no hosted URL) and allows browser CORS for key-auth, so it is callable directly from the
 * browser. This matches the working Asset Lab "Magic Studio" client.
 *
 * @see https://ai.google.dev/gemini-api/docs/image-generation
 */
export class GeminiImageProvider implements ImageGenProvider {
  readonly id = 'gemini';
  readonly label = 'Google Gemini (Nano Banana)';
  readonly apiKeySecretId = 'ai-provider:gemini:api-key';
  readonly apiKeyHelpUrl = 'https://aistudio.google.com/apikey';

  readonly models: readonly ProviderModel[] = [
    {
      id: 'gemini-2.5-flash-image',
      label: 'Nano Banana (2.5 Flash)',
      description: 'Fast, reliable default.',
      capabilities: {
        supportsReferenceImages: true,
        maxReferenceImages: 6,
        aspectRatios: ASPECTS,
        imageSizes: ['1K', '2K'],
        maxCount: 1,
        requiresProxy: false,
      },
    },
    {
      id: 'gemini-3.1-flash-image-preview',
      label: 'Nano Banana 2 (Flash) — 3.1',
      description: 'Newest, sharper. 512–4K.',
      capabilities: {
        supportsReferenceImages: true,
        maxReferenceImages: 6,
        aspectRatios: ASPECTS,
        imageSizes: ['512', '1K', '2K', '4K'],
        maxCount: 1,
        requiresProxy: false,
      },
    },
    {
      id: 'gemini-3-pro-image-preview',
      label: 'Nano Banana Pro — 3 Pro',
      description: 'Higher fidelity, slower.',
      capabilities: {
        supportsReferenceImages: true,
        maxReferenceImages: 6,
        aspectRatios: ASPECTS,
        imageSizes: ['1K', '2K', '4K'],
        maxCount: 1,
        requiresProxy: false,
      },
    },
  ];

  getModel(modelId: string): ProviderModel | undefined {
    return this.models.find(model => model.id === modelId);
  }

  async generate(params: GenerateImageParams, ctx: RequestContext): Promise<ImageGenResult> {
    if (!ctx.apiKey) {
      throw new ImageGenError('missing-key', 'No Gemini API key configured.');
    }
    const model = this.getModel(ctx.modelId);
    if (!model) {
      throw new ImageGenError('unknown', `Unknown Gemini model "${ctx.modelId}".`);
    }

    const fetchImpl = ctx.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const baseUrl = (ctx.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

    // Build the request parts: reference preamble + labelled inline images, then the prompt.
    const parts: GeminiPart[] = [];
    const references = params.references ?? [];
    if (references.length > 0) {
      parts.push({ text: REFERENCE_PREAMBLE });
      references.forEach((reference, index) => {
        parts.push({ text: `Reference image ${index + 1}:` });
        parts.push({ inline_data: { mime_type: reference.mimeType, data: reference.data } });
      });
    }
    const aspectHint =
      params.aspectRatio && params.aspectRatio !== 'Auto'
        ? `\n\nReturn a single image with a ${params.aspectRatio} aspect ratio.`
        : '';
    parts.push({ text: `${params.prompt}${aspectHint}` });

    const imageConfig: GeminiImageConfig = {};
    if (params.aspectRatio && params.aspectRatio !== 'Auto') {
      imageConfig.aspectRatio = params.aspectRatio;
    }
    if (params.imageSize && model.capabilities.imageSizes.includes(params.imageSize)) {
      imageConfig.imageSize = params.imageSize;
    }

    const body = {
      contents: [{ parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig },
    };

    const url = `${baseUrl}/models/${ctx.modelId}:generateContent`;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.apiKey },
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new ImageGenError('aborted', 'Image generation was cancelled.');
      }
      throw new ImageGenError(
        'network',
        'Network error contacting the Gemini API. Check your connection.',
        undefined,
        { cause: error }
      );
    }

    let payload: unknown;
    try {
      payload = await this.readJson(response);
    } catch (error) {
      if (isAbortError(error)) {
        throw new ImageGenError('aborted', 'Image generation was cancelled.');
      }
      throw new ImageGenError(
        'network',
        'Network error while reading the Gemini response.',
        undefined,
        {
          cause: error,
        }
      );
    }

    if (!response.ok) {
      throw new ImageGenError(
        'http',
        extractErrorMessage(payload) ?? describeStatus(response.status),
        response.status
      );
    }

    const images = extractImages(payload);
    if (images.length === 0) {
      throw new ImageGenError('blocked', describeNoImage(payload));
    }

    return { images, raw: payload };
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { rawText: text };
    }
  }
}

interface GeminiInlineData {
  mime_type?: string;
  mimeType?: string;
  data?: string;
}
interface GeminiPart {
  text?: string;
  inline_data?: GeminiInlineData;
  inlineData?: GeminiInlineData;
}
interface GeminiImageConfig {
  aspectRatio?: string;
  imageSize?: string;
}

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' : false;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Collect base64 image parts from a generateContent response (candidates → content → parts). */
const extractImages = (payload: unknown): GeneratedImage[] => {
  const collected: GeneratedImage[] = [];
  const seen = new Set<string>();

  const push = (data: unknown, mime: unknown): void => {
    if (typeof data !== 'string' || data.length === 0 || seen.has(data)) {
      return;
    }
    seen.add(data);
    collected.push({
      mimeType: typeof mime === 'string' && mime ? mime : 'image/png',
      data,
    });
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isRecord(node)) {
      return;
    }
    const inline = (node.inline_data ?? node.inlineData) as GeminiInlineData | undefined;
    if (isRecord(inline) && typeof inline.data === 'string') {
      push(inline.data, inline.mime_type ?? inline.mimeType);
    }
    for (const value of Object.values(node)) {
      walk(value);
    }
  };

  walk(payload);
  return collected;
};

const extractErrorMessage = (payload: unknown): string | null => {
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string') {
    return payload.error.message;
  }
  return null;
};

const describeStatus = (status: number): string => {
  switch (status) {
    case 400:
      return 'Bad request to the Gemini API. Check your key and try again.';
    case 403:
      return 'Your API key was rejected. Re-check the key or its permissions.';
    case 429:
      return 'Rate limit reached (free tier). Wait a moment and try again.';
    default:
      return `Gemini API error (HTTP ${status}).`;
  }
};

/** Explain why a 2xx response carried no image (safety block / finish reason / text-only). */
const describeNoImage = (payload: unknown): string => {
  if (isRecord(payload)) {
    const feedback = payload.promptFeedback;
    if (isRecord(feedback) && typeof feedback.blockReason === 'string') {
      return `Request was blocked by safety filters (${feedback.blockReason}). Adjust the prompt.`;
    }
    const candidates = payload.candidates;
    if (Array.isArray(candidates) && isRecord(candidates[0])) {
      const candidate = candidates[0];
      if (typeof candidate.finishMessage === 'string' && candidate.finishMessage.trim()) {
        return candidate.finishMessage.trim();
      }
      const content = candidate.content;
      if (isRecord(content) && Array.isArray(content.parts)) {
        const textPart = content.parts.find(
          (part): part is { text: string } => isRecord(part) && typeof part.text === 'string'
        );
        if (textPart) {
          return `The model returned text instead of an image: ${textPart.text}`;
        }
      }
    }
  }
  return 'The model returned no image. Try rephrasing the prompt.';
};
