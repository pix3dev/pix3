/**
 * Provider-agnostic contracts for AI image generation. New providers (OpenAI GPT Image, etc.)
 * implement {@link ImageGenProvider} and register in `ImageGenProviderRegistry`.
 */

/** 'Auto' lets the model choose (no aspectRatio sent); others map to Gemini imageConfig.aspectRatio. */
export type AspectRatio = 'Auto' | '1:1' | '3:4' | '4:3' | '16:9' | '9:16';

/**
 * Requested output background. Providers that advertise
 * {@link ImageModelCapabilities.supportsTransparency} can honour `'transparent'` and return a PNG
 * with a real alpha channel (no local background-removal pass needed). `'auto'` lets the model
 * decide; `'opaque'` forces a filled background.
 */
export type Background = 'auto' | 'transparent' | 'opaque';

/** A reference/input image, base64-encoded WITHOUT the `data:` URI prefix. */
export interface ReferenceImage {
  readonly mimeType: string;
  readonly data: string;
}

/** A generated output image, base64-encoded WITHOUT the `data:` URI prefix. */
export interface GeneratedImage {
  readonly mimeType: string;
  readonly data: string;
}

export interface GenerateImageParams {
  readonly prompt: string;
  /** Absent/empty => text-to-image. Present => image+reference (edit) generation. */
  readonly references?: readonly ReferenceImage[];
  readonly aspectRatio?: AspectRatio;
  /** Provider-specific size hint (e.g. '1K' | '2K' | '4K' for Gemini). */
  readonly imageSize?: string;
  /** Provider-specific quality tier (e.g. 'low' | 'medium' | 'high' for OpenAI GPT Image). */
  readonly quality?: string;
  /**
   * Desired output background. Only honoured by providers whose selected model advertises
   * {@link ImageModelCapabilities.supportsTransparency}; ignored otherwise.
   */
  readonly background?: Background;
  readonly outputMimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Number of images to request. Providers may clamp to their `maxCount`. */
  readonly count?: number;
  readonly signal?: AbortSignal;
}

export interface ImageGenResult {
  readonly images: GeneratedImage[];
  /** Raw provider payload, retained for debugging. */
  readonly raw?: unknown;
}

export interface ImageModelCapabilities {
  readonly supportsReferenceImages: boolean;
  readonly maxReferenceImages: number;
  readonly aspectRatios: readonly AspectRatio[];
  readonly imageSizes: readonly string[];
  /**
   * Provider-specific quality tiers (e.g. `['low', 'medium', 'high']`). Empty/omitted means the
   * model exposes no quality knob and the UI hides the control.
   */
  readonly qualities?: readonly string[];
  readonly maxCount: number;
  /** True when the model can emit a transparent alpha channel directly (skips local bg-removal). */
  readonly supportsTransparency: boolean;
  /** True when direct browser calls are blocked by CORS and a same-origin proxy is required. */
  readonly requiresProxy: boolean;
}

export interface ProviderModel {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly capabilities: ImageModelCapabilities;
}

/** Per-request context supplied by the caller (key + selected model + optional proxy hooks). */
export interface RequestContext {
  readonly apiKey: string;
  readonly modelId: string;
  /** Injected fetch (e.g. a proxying fetch); defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Override host, e.g. a same-origin proxy route for providers that need one. */
  readonly baseUrl?: string;
}

export interface ImageGenProvider {
  readonly id: string;
  readonly label: string;
  readonly models: readonly ProviderModel[];
  /** SecretStorageService id under which this provider's API key is stored. */
  readonly apiKeySecretId: string;
  /** Where a user obtains an API key (shown in settings). */
  readonly apiKeyHelpUrl?: string;
  getModel(modelId: string): ProviderModel | undefined;
  generate(params: GenerateImageParams, ctx: RequestContext): Promise<ImageGenResult>;
}

export type ImageGenErrorKind =
  | 'missing-key'
  | 'network'
  | 'http'
  | 'blocked'
  | 'empty'
  | 'aborted'
  | 'unknown';

/** User-facing image generation error carrying a machine-readable kind. */
export class ImageGenError extends Error {
  constructor(
    readonly kind: ImageGenErrorKind,
    message: string,
    readonly status?: number,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'ImageGenError';
  }
}
