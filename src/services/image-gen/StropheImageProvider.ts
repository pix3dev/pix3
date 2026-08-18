import { StropheApiClient } from '@/services/strophe/StropheApiClient';
import { STROPHE_KEY_HELP_URL, STROPHE_SECRET_ID } from '@/services/strophe/StropheAccountService';
import {
  StropheError,
  type StropheFamilyDetail,
  type StropheGenerationRequest,
  type StropheParameter,
} from '@/services/strophe/StropheTypes';
import { base64ToBlob, blobToBase64 } from './image-ops';
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

/**
 * Aspect ratios our shared UI offers. Each family declares its own (wider) set; we intersect against
 * the live schema at request time, so a ratio a family does not support is simply not sent.
 */
const ASPECTS: readonly AspectRatio[] = ['Auto', '1:1', '3:4', '4:3', '16:9', '9:16'];

/**
 * Curated slice of Strophe's image catalog (66 families overall, 30 of them image).
 *
 * Hand-picked rather than generated from `GET /families` because our `ImageGenProvider.models` is a
 * synchronous list the settings picker renders immediately, while the catalog is an async fetch. The
 * cost of that trade-off is drift: prices/ratios below are a snapshot (verified 2026-08-11), so the
 * generate path never trusts them — it re-reads the family schema and validates every parameter
 * against it. Credit prices live in `price` because they are what a user actually chooses on.
 */
const MODELS: readonly ProviderModel[] = [
  {
    id: 'flux',
    label: 'FLUX.1 (schnell)',
    price: '1 cr',
    description: 'Cheapest draft lane, ~7 s. No reference images.',
    capabilities: {
      supportsReferenceImages: false,
      maxReferenceImages: 0,
      aspectRatios: ASPECTS,
      imageSizes: [],
      qualities: [],
      maxCount: 4,
      supportsTransparency: false,
      requiresProxy: false,
    },
  },
  {
    id: 'gpt-image-2',
    label: 'GPT Image 2',
    price: '4 cr',
    description: '6 credits when editing. Quality tiers, up to 4 reference images.',
    capabilities: {
      supportsReferenceImages: true,
      maxReferenceImages: 4,
      aspectRatios: ASPECTS,
      imageSizes: [],
      qualities: ['low', 'medium', 'high'],
      maxCount: 4,
      supportsTransparency: false,
      requiresProxy: false,
    },
  },
  {
    id: 'flux-2-max',
    label: 'FLUX.2 Max',
    price: '11 cr',
    description: '1K/2K, up to 3 reference images.',
    capabilities: {
      supportsReferenceImages: true,
      maxReferenceImages: 3,
      aspectRatios: ASPECTS,
      imageSizes: ['1K', '2K'],
      qualities: [],
      maxCount: 4,
      supportsTransparency: false,
      requiresProxy: false,
    },
  },
  {
    id: 'seedream-v5',
    label: 'Seedream 5.0',
    price: '8 cr',
    description: '2K/3K, up to 10 reference images.',
    capabilities: {
      supportsReferenceImages: true,
      maxReferenceImages: 10,
      aspectRatios: ASPECTS,
      imageSizes: ['2K', '3K'],
      qualities: [],
      maxCount: 4,
      supportsTransparency: false,
      requiresProxy: false,
    },
  },
  {
    id: 'nano-banana-pro',
    label: 'Nano Banana Pro',
    price: '23 cr',
    description: '2k/4k, strongest prompt adherence, up to 10 references.',
    capabilities: {
      supportsReferenceImages: true,
      maxReferenceImages: 10,
      aspectRatios: ASPECTS,
      imageSizes: ['2k', '4k'],
      qualities: [],
      maxCount: 4,
      supportsTransparency: false,
      requiresProxy: false,
    },
  },
  {
    id: 'recraft-v4',
    label: 'Recraft v4.1',
    price: '8 cr',
    description: 'Clean vector-ish game art, ~15 s. No reference images.',
    capabilities: {
      supportsReferenceImages: false,
      maxReferenceImages: 0,
      aspectRatios: ASPECTS,
      imageSizes: [],
      qualities: [],
      maxCount: 4,
      supportsTransparency: false,
      requiresProxy: false,
    },
  },
];

/**
 * Strophe image generation. Strophe is a metered aggregator: one key, credits, many upstream models
 * exposed as "families".
 *
 * Three things about their contract shape this adapter:
 *
 * - **No proxy.** They send `Access-Control-Allow-Origin: *` on the API *and* on artifact delivery
 *   URLs, so unlike OpenAI/Tripo everything here is a direct browser call.
 * - **One artifact per generation.** There is no `count`/`n`, so a request for N images fans out into
 *   N independent generations (each charged separately) and the results are collected in order.
 * - **No transparency flag and no output-format control.** Every model here advertises
 *   `supportsTransparency: false`, which routes a transparent cutout through our local (free)
 *   background removal instead of Strophe's paid `bria-bg-remove` family. Output MIME is whatever the
 *   family returns — often JPEG. Both gaps are filed in
 *   `.plans/strophe-integration-feedback.md`.
 *
 * There is also no `seed`, so results are not reproducible and nothing seed-shaped is recorded in
 * asset provenance for this provider.
 */
export class StropheImageProvider implements ImageGenProvider {
  readonly id = 'strophe';
  readonly label = 'Strophe';
  readonly apiKeySecretId = STROPHE_SECRET_ID;
  readonly apiKeyHelpUrl = STROPHE_KEY_HELP_URL;
  readonly models = MODELS;

  /** Family schemas, cached per provider instance — the registry keeps one instance for the session. */
  private readonly familyCache = new Map<string, StropheFamilyDetail>();

  getModel(modelId: string): ProviderModel | undefined {
    return this.models.find(model => model.id === modelId);
  }

  async generate(params: GenerateImageParams, ctx: RequestContext): Promise<ImageGenResult> {
    if (!ctx.apiKey) {
      throw new ImageGenError('missing-key', 'No Strophe API key configured.');
    }
    const model = this.getModel(ctx.modelId);
    if (!model) {
      throw new ImageGenError('unknown', `Unknown Strophe image model "${ctx.modelId}".`);
    }

    const client = new StropheApiClient({
      auth: { getToken: () => ctx.apiKey },
      baseUrl: ctx.baseUrl,
      fetchImpl: ctx.fetchImpl,
    });

    try {
      const family = await this.resolveFamily(client, ctx.modelId);
      if (family.available === false) {
        throw new ImageGenError(
          'http',
          `Strophe model "${family.name}" is unavailable${family.lockReason ? `: ${family.lockReason}` : '.'}`
        );
      }

      // References must be uploaded first: the JSON request body is capped at 256 KiB, far below any
      // real image, so inline base64 is not an option here (only `POST /files` takes it).
      const imageIds = await this.uploadReferences(client, params, model, family);

      const request: StropheGenerationRequest = {
        familyId: ctx.modelId,
        prompt: params.prompt,
        parameters: buildParameters(family, params),
        ...(imageIds.length > 0 ? { imageIds } : {}),
      };

      const count = Math.min(Math.max(params.count ?? 1, 1), model.capabilities.maxCount);
      const etaSeconds = family.generationTime;

      // One generation per image: independent idempotency keys, so a network retry of any single
      // request replays that one instead of duplicating the batch.
      const generations = await Promise.all(
        Array.from({ length: count }, () =>
          client.runGeneration(request, { signal: params.signal, etaSeconds })
        )
      );

      const images: GeneratedImage[] = [];
      for (const generation of generations) {
        if (!generation.result) {
          continue;
        }
        const blob = await client.downloadResult(generation.result, params.signal);
        images.push({
          mimeType: generation.result.mimeType || blob.type || 'image/png',
          data: await blobToBase64(blob),
        });
      }

      if (images.length === 0) {
        throw new ImageGenError('empty', 'Strophe returned no image. Try rephrasing the prompt.');
      }

      return {
        images,
        raw: generations.map(generation => ({
          generationId: generation.generationId,
          modelId: generation.modelId,
          creditsCharged: generation.creditsCharged,
        })),
      };
    } catch (error) {
      throw toImageGenError(error);
    }
  }

  /** Family schema, cached. Drives parameter validation so we never send a field they reject. */
  private async resolveFamily(
    client: StropheApiClient,
    familyId: string
  ): Promise<StropheFamilyDetail> {
    const cached = this.familyCache.get(familyId);
    if (cached) {
      return cached;
    }
    const detail = await client.getFamily(familyId);
    this.familyCache.set(familyId, detail);
    return detail;
  }

  /** Upload the reference images this family can actually accept, preserving caller order. */
  private async uploadReferences(
    client: StropheApiClient,
    params: GenerateImageParams,
    model: ProviderModel,
    family: StropheFamilyDetail
  ): Promise<string[]> {
    const declaredMax = family.maxInputs?.images ?? model.capabilities.maxReferenceImages;
    const max = Math.min(declaredMax, model.capabilities.maxReferenceImages);
    if (max <= 0) {
      return [];
    }
    const references = (params.references ?? []).slice(0, max);
    if (references.length === 0) {
      return [];
    }
    const uploaded = await Promise.all(
      references.map(reference =>
        client.uploadFile({ blob: base64ToBlob(reference.data, reference.mimeType) }, params.signal)
      )
    );
    return uploaded.map(file => file.fileId);
  }
}

// -- pure, unit-testable helpers ---------------------------------------------

/**
 * Build the `parameters` object for a request from our generic params, keeping only fields the family
 * actually declares and only values its enum allows.
 *
 * This matters because Strophe validates strictly — an unknown key fails the whole request with
 * `invalid_parameters` — and because families spell the same concept differently (`resolution` is
 * `1K/2K` on FLUX.2, `2K/3K` on Seedream, `2k/4k` on Nano Banana). Matching is therefore
 * case-insensitive against the declared values, and the family's own spelling is what gets sent.
 * Anything unmatched is omitted so the family default applies.
 */
export function buildParameters(
  family: StropheFamilyDetail,
  params: GenerateImageParams
): Record<string, unknown> {
  const declared = new Map<string, StropheParameter>(
    (family.parameters ?? []).map(parameter => [parameter.name, parameter])
  );
  const out: Record<string, unknown> = {};

  // 'Auto' means "let the model decide" in our contract — send nothing.
  if (params.aspectRatio && params.aspectRatio !== 'Auto') {
    const value = matchEnumValue(declared.get('aspectRatio'), params.aspectRatio);
    if (value) {
      out.aspectRatio = value;
    }
  }
  if (params.imageSize) {
    const value = matchEnumValue(declared.get('resolution'), params.imageSize);
    if (value) {
      out.resolution = value;
    }
  }
  if (params.quality) {
    const value = matchEnumValue(declared.get('quality'), params.quality);
    if (value) {
      out.quality = value;
    }
  }
  return out;
}

/** The family's own spelling of `requested`, matched case-insensitively, or null when unsupported. */
export function matchEnumValue(
  parameter: StropheParameter | undefined,
  requested: string
): string | null {
  if (!parameter || !parameter.values || parameter.values.length === 0) {
    return null;
  }
  const wanted = requested.trim().toLowerCase();
  return parameter.values.find(value => value.toLowerCase() === wanted) ?? null;
}

/**
 * Map a Strophe failure onto our provider-agnostic error kinds.
 *
 * `billing` is deliberately distinct from `http`: out-of-credits is fixed by topping up, not by
 * retrying, and the UI says so. Their `content_policy` failure class becomes `blocked`, which is the
 * same bucket a Gemini safety refusal lands in.
 */
export function toImageGenError(error: unknown): ImageGenError {
  if (error instanceof ImageGenError) {
    return error;
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ImageGenError('aborted', 'Image generation was cancelled.');
  }
  if (error instanceof StropheError) {
    if (error.code === 'aborted') {
      return new ImageGenError('aborted', 'Image generation was cancelled.');
    }
    if (error.isAuthProblem) {
      return new ImageGenError('missing-key', error.message, error.options.status, {
        cause: error,
      });
    }
    if (error.isBillingBlock) {
      return new ImageGenError('billing', error.message, error.options.status, { cause: error });
    }
    if (error.code === 'network') {
      return new ImageGenError('network', error.message, undefined, { cause: error });
    }
    if (error.code === 'generation_failed') {
      const failureCode = error.options.details?.failureCode;
      if (failureCode === 'content_policy') {
        return new ImageGenError('blocked', error.message, undefined, { cause: error });
      }
      return new ImageGenError('http', error.message, error.options.status, { cause: error });
    }
    return new ImageGenError('http', error.message, error.options.status, { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ImageGenError('unknown', message, undefined, { cause: error });
}
