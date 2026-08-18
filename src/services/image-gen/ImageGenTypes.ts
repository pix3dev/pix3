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
  /**
   * The vector source this raster was baked from, when the provider authored one (`svg-llm`). Kept
   * as a first-class artifact: it makes edits deterministic ("thicken the outline" is a source edit,
   * not a re-roll) and lets the same asset be re-baked at another size without another model call.
   */
  readonly svgSource?: string;
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
  /**
   * Exact output size in pixels. Only honoured by providers whose selected model advertises
   * {@link ImageModelCapabilities.supportsExactSize} — a raster model returns whatever its aspect
   * ratio / size tier produces, so asking it for 96×32 would be a promise we cannot keep.
   */
  readonly width?: number;
  readonly height?: number;
  /**
   * The current vector source of the asset being edited. Providers that author SVG (`svg-llm`) treat
   * its presence as "edit this source" instead of "author a new sprite", which turns a tweak into a
   * deterministic source edit rather than a fresh roll.
   */
  readonly svgSource?: string;
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
  /**
   * True when the model honours {@link GenerateImageParams.width}/`height` exactly. Vector-authoring
   * providers can (the raster is baked locally at whatever size was asked for); raster models cannot,
   * so the UI shows W×H inputs only for the former and the aspect-ratio/size tier pickers otherwise.
   */
  readonly supportsExactSize: boolean;
  /** True when direct browser calls are blocked by CORS and a same-origin proxy is required. */
  readonly requiresProxy: boolean;
}

export interface ProviderModel {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /**
   * Short price tag rendered next to the label in every model picker (e.g. `'$0.039/img'`,
   * `'8 cr'`). A display string rather than a number because providers meter differently — dollars
   * per output image for direct APIs, credits for aggregators — and because it is a hand-maintained
   * snapshot, not something the API reports. Omit it when the price is not a single figure (e.g.
   * OpenAI, where it depends on the quality tier).
   */
  readonly price?: string;
  readonly capabilities: ImageModelCapabilities;
}

/**
 * Option text for a model picker. Shared by the Generate panel and the settings dialog so both
 * spell the price the same way; a `<option>` renders plain text only, hence the interpunct instead
 * of separate markup.
 */
export const modelPickerLabel = (model: ProviderModel): string =>
  model.price ? `${model.label} · ${model.price}` : model.label;

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
  /**
   * Whether this provider needs an API key of its own. Defaults to `true`. A provider that borrows
   * another stack's credentials (`svg-llm` runs on the agent's LLM) sets it to `false`: callers skip
   * the key check and the UI drops the key prompt — it would ask for a key nothing ever reads.
   */
  readonly requiresApiKey?: boolean;
  getModel(modelId: string): ProviderModel | undefined;
  generate(params: GenerateImageParams, ctx: RequestContext): Promise<ImageGenResult>;
  /**
   * Whether the provider can generate right now, for providers with {@link requiresApiKey} `false`
   * (where "is a key stored?" is the wrong question). Optional; absent means "always available".
   */
  isAvailable?(): Promise<boolean>;
}

export type ImageGenErrorKind =
  | 'missing-key'
  /**
   * The account is out of credits, or the request exceeded a spend limit. Distinct from `http`
   * because the fix is "top up / raise the cap", not "retry" — providers that meter in credits
   * (Strophe) report it as its own machine-readable code.
   */
  | 'billing'
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
