import { inject, injectable } from '@/fw/di';
import { AgentSettingsService } from '@/services/agent/AgentSettingsService';
import { LlmModelCatalogService } from '@/services/llm/LlmModelCatalogService';
import { LlmProviderRegistry } from '@/services/llm/LlmProviderRegistry';
import type { LlmContentBlock, LlmMessage, LlmModel, LlmProvider } from '@/services/llm/LlmTypes';
import { ImageGenError, type ReferenceImage } from '@/services/image-gen/ImageGenTypes';
import {
  MAX_SVG_SOURCE_LENGTH,
  extractSvgSource,
  prepareSvgForRaster,
  rasterizeSvg,
} from '@/services/image-gen/svg-render';

/**
 * Sentinel model id meaning "whatever the agent chat is using right now". It carries no slash, which
 * is what separates it from a pinned {@link formatSvgModelId} pick — and it deliberately re-resolves
 * on every call, so switching the agent's model in the chat switches this too.
 */
export const AGENT_DEFAULT_MODEL_ID = 'agent-default';

/** Image-gen `modelId` for one LLM provider+model pair (image-gen model ids are a single string). */
export const formatSvgModelId = (providerId: string, modelId: string): string =>
  `${providerId}/${modelId}`;

/** Split a composite `"<llmProviderId>/<llmModelId>"` id. Null for the sentinel or malformed input. */
export const parseSvgModelId = (
  composite: string
): { providerId: string; modelId: string } | null => {
  const slash = composite.indexOf('/');
  if (slash <= 0 || slash === composite.length - 1) {
    return null;
  }
  // Split on the FIRST slash only: gateway model ids carry their own (`anthropic/claude-sonnet-4.5`).
  return { providerId: composite.slice(0, slash), modelId: composite.slice(slash + 1) };
};

/** What the generator was asked to draw. */
export interface SvgSpriteRequest {
  readonly prompt: string;
  readonly width: number;
  readonly height: number;
  /** The current source when this is an edit ("make the outline thicker"), not a fresh sprite. */
  readonly svgSource?: string;
  /** Style references; only sent to a model that can actually see images. */
  readonly references?: readonly ReferenceImage[];
  /** `AGENT_DEFAULT_MODEL_ID` or a composite `"<llmProviderId>/<llmModelId>"`. */
  readonly modelId?: string;
  readonly signal?: AbortSignal;
}

/** A baked sprite plus the source it was baked from. */
export interface SvgSpriteResult {
  /** Sanitised, viewBox-normalised source — exactly the text that was rasterised. */
  readonly svgSource: string;
  readonly png: Blob;
  /** Which LLM actually answered, for provenance in history / the panel. */
  readonly llmProviderId: string;
  readonly llmModelId: string;
}

/**
 * A resolved LLM lane: provider + model + endpoint. Deliberately key-free so it can be resolved
 * synchronously (the model picker needs it); the credential is read separately, at call time.
 */
export interface SvgLlmTarget {
  readonly provider: LlmProvider;
  readonly modelId: string;
  readonly baseUrl?: string;
  readonly model?: LlmModel;
}

const MAX_OUTPUT_TOKENS = 8192;
/** One retry: models that fluff the format once nearly always get it right when shown the failure. */
const MAX_ATTEMPTS = 2;

const STYLE_RULES = [
  'Flat vector game art: clean closed shapes, a limited palette (3-6 colours), readable at small sizes.',
  'Transparent background — do NOT emit a full-bleed background rect unless the user asked for one.',
  'Fill the frame: the subject should span most of the viewBox with a small margin, centred.',
  'Prefer <path>/<rect>/<circle>/<polygon> with explicit fills over strokes-only line art.',
].join('\n- ');

const CONTRACT_RULES = [
  'Reply with ONE ```svg fenced code block containing exactly one <svg> root element. No prose outside it.',
  'The root must carry xmlns="http://www.w3.org/2000/svg" and viewBox="0 0 W H" for the requested W and H.',
  'Never emit <script>, <foreignObject>, on* event attributes, external href/xlink:href, or CSS url() to a remote resource — they are stripped and the art breaks.',
  'Text is rendered without webfonts: use generic families only (sans-serif, serif, monospace), and prefer shapes over text.',
  'No embedded raster data (no <image> with a data: URI) — this must stay vector.',
].join('\n- ');

/**
 * The system prompt that pins the output contract. Split out so the wording is unit-testable: this
 * is the part that decides whether an answer parses at all.
 */
export const buildSvgSystemPrompt = (): string =>
  'You are a game sprite artist who draws in SVG. You produce production-ready 2D game art as ' +
  'hand-written SVG markup that will be rasterised to a PNG with transparency.\n\n' +
  `Output contract:\n- ${CONTRACT_RULES}\n\nStyle:\n- ${STYLE_RULES}`;

/** True when the request carries a source to modify rather than a brief to draw from scratch. */
export const isSvgEditRequest = (request: Pick<SvgSpriteRequest, 'svgSource'>): boolean =>
  Boolean(request.svgSource && request.svgSource.trim());

/**
 * The user turn. In edit mode the current source leads and the prompt becomes a change request —
 * that is the whole point of keeping the source: a tweak is a diff on known markup, not a re-roll
 * that also changes the six things the user liked.
 */
export const buildSvgUserPrompt = (request: SvgSpriteRequest): string => {
  const size = `Target raster size: ${request.width}×${request.height} px (use viewBox="0 0 ${request.width} ${request.height}").`;
  if (isSvgEditRequest(request)) {
    return [
      'Here is the current SVG source of an existing sprite:',
      '```svg',
      request.svgSource?.trim() ?? '',
      '```',
      '',
      `Change requested: ${request.prompt}`,
      '',
      size,
      'Edit the source above rather than redrawing it: keep every element the request does not ' +
        'touch (same palette, same composition, same ids) so the sprite stays recognisable. Reply ' +
        'with the complete updated SVG in one ```svg block.',
    ].join('\n');
  }
  return [`Draw this sprite: ${request.prompt}`, '', size].join('\n');
};

/** The follow-up turn after an unusable reply, quoting the failure back at the model. */
export const buildSvgRetryPrompt = (reason: string): string =>
  `That reply could not be used: ${reason}\n\n` +
  'Reply again with ONLY one ```svg fenced block containing a single complete <svg>…</svg> ' +
  'element. No explanation, no partial markup.';

/** Style references become image blocks — worth sending only to a model that can see them. */
const toImageBlocks = (references: readonly ReferenceImage[]): LlmContentBlock[] =>
  references.map(reference => ({
    type: 'image' as const,
    mimeType: reference.mimeType,
    data: reference.data,
  }));

/**
 * Authors sprites by asking the **agent's own LLM** for SVG and baking the result locally.
 *
 * This is where every decision that makes `svg-llm` different from a raster provider lives, and the
 * provider ({@link import('./SvgLlmImageProvider').SvgLlmImageProvider}) stays a thin adapter over
 * it. There is no key and no model catalog of its own: the lane is the one the agent chat resolves
 * to (`AgentSettingsService.getSelectedProvider()`, which prefers a paired bridge), so a user who
 * configured Claude through the bridge gets Claude here without configuring anything twice.
 */
@injectable()
export class SvgSpriteGenerator {
  @inject(AgentSettingsService)
  private readonly agentSettings!: AgentSettingsService;

  @inject(LlmProviderRegistry)
  private readonly llmRegistry!: LlmProviderRegistry;

  @inject(LlmModelCatalogService)
  private readonly catalog!: LlmModelCatalogService;

  /**
   * The lane a given image-gen `modelId` resolves to. A composite id pins a provider+model; the
   * sentinel (or anything that no longer resolves) falls back to the agent's current selection, so a
   * stored pick for a bridge lane that is currently down degrades instead of failing.
   */
  resolveTarget(modelId?: string): SvgLlmTarget | null {
    const composite = modelId ? parseSvgModelId(modelId) : null;
    if (composite) {
      const provider = this.llmRegistry.get(composite.providerId);
      if (provider) {
        return this.describeTarget(provider, composite.modelId);
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
    return this.describeTarget(provider, selectedModelId);
  }

  /** Whether an LLM lane is usable right now (drives the "no key needed, but is one reachable?" check). */
  async isAvailable(): Promise<boolean> {
    const target = this.resolveTarget();
    if (!target) {
      return false;
    }
    try {
      return Boolean(await this.agentSettings.getApiKey(target.provider.id));
    } catch {
      return false;
    }
  }

  /** Models offered in the image-gen picker: the agent's current lane, as composite ids. */
  listModels(): Array<{
    id: string;
    label: string;
    description?: string;
    supportsImages: boolean;
  }> {
    const provider = this.agentSettings.getSelectedProvider();
    if (!provider) {
      return [];
    }
    return this.catalog.getModels(provider.id).map(model => ({
      id: formatSvgModelId(provider.id, model.id),
      label: `${provider.label} · ${model.label}`,
      description: model.description,
      supportsImages: model.capabilities.supportsImages,
    }));
  }

  /** Whether the lane behind `modelId` can see reference images. */
  supportsReferences(modelId?: string): boolean {
    return Boolean(this.resolveTarget(modelId)?.model?.capabilities.supportsImages);
  }

  /**
   * Ask the LLM for an SVG, sanitise it, and bake it to a PNG at exactly the requested size.
   * Throws an {@link ImageGenError} so callers handle it exactly like a raster provider failure.
   */
  async generate(request: SvgSpriteRequest): Promise<SvgSpriteResult> {
    const target = this.resolveTarget(request.modelId);
    if (!target) {
      throw new ImageGenError(
        'missing-key',
        'No LLM is configured for the agent. Pick a provider and model in Settings → AI Agent ' +
          '(or start the Pix3AgentBridge) — the SVG provider draws with the agent’s model.'
      );
    }
    const apiKey = (await this.agentSettings.getApiKey(target.provider.id)) ?? '';
    if (!apiKey) {
      throw new ImageGenError(
        'missing-key',
        `No API key or bridge token is configured for "${target.provider.label}". Set one in ` +
          'Settings → AI Agent.'
      );
    }

    const canSeeImages = Boolean(target.model?.capabilities.supportsImages);
    const references = canSeeImages ? (request.references ?? []) : [];
    const userContent: LlmContentBlock[] = [
      { type: 'text', text: buildSvgUserPrompt(request) },
      ...toImageBlocks(references),
    ];
    if (references.length > 0) {
      userContent.push({
        type: 'text',
        text: 'Match the palette, stroke weight and shading style of the reference image(s) above.',
      });
    }

    const messages: LlmMessage[] = [{ role: 'user', content: userContent }];
    const maxTokens = Math.min(
      target.model?.capabilities.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
      MAX_OUTPUT_TOKENS
    );

    let lastFailure = 'the reply contained no <svg> element';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const reply = await this.chat(target, apiKey, messages, maxTokens, request.signal);
      const extracted = extractSvgSource(reply);
      if (extracted && extracted.length <= MAX_SVG_SOURCE_LENGTH) {
        const svgSource = prepareSvgForRaster(extracted, {
          width: request.width,
          height: request.height,
        });
        const png = await rasterizeSvg(svgSource, {
          width: request.width,
          height: request.height,
        });
        return {
          svgSource,
          png,
          llmProviderId: target.provider.id,
          llmModelId: target.modelId,
        };
      }
      lastFailure = extracted
        ? `the SVG was ${extracted.length} characters, over the ${MAX_SVG_SOURCE_LENGTH} limit`
        : 'the reply contained no complete <svg>…</svg> element';
      messages.push({ role: 'assistant', content: reply || '(empty reply)' });
      messages.push({ role: 'user', content: buildSvgRetryPrompt(lastFailure) });
    }

    throw new ImageGenError(
      'empty',
      `${target.provider.label} did not return a usable SVG (${lastFailure}). Try rephrasing the ` +
        'prompt, or pick a stronger model.'
    );
  }

  /** Re-bake a kept source at a new size — no model call, no cost, no drift. */
  async rebake(svgSource: string, width: number, height: number): Promise<Blob> {
    return rasterizeSvg(svgSource, { width, height });
  }

  // -- internals -------------------------------------------------------------

  private describeTarget(provider: LlmProvider, modelId: string): SvgLlmTarget {
    return {
      provider,
      modelId,
      baseUrl: this.agentSettings.getBaseUrl(provider.id),
      model: this.catalog.getModel(provider.id, modelId) ?? provider.getModel(modelId),
    };
  }

  private async chat(
    target: SvgLlmTarget,
    apiKey: string,
    messages: readonly LlmMessage[],
    maxTokens: number,
    signal?: AbortSignal
  ): Promise<string> {
    const result = await target.provider.chat(
      {
        messages,
        system: buildSvgSystemPrompt(),
        maxTokens,
        signal,
      },
      { apiKey, modelId: target.modelId, baseUrl: target.baseUrl }
    );
    return result.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();
  }
}
