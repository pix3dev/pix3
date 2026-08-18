import { describe, expect, it, vi } from 'vitest';

import { ImageGenError } from './ImageGenTypes';
import { DEFAULT_SVG_SPRITE_SIZE, SvgLlmImageProvider } from './SvgLlmImageProvider';
import {
  AGENT_DEFAULT_MODEL_ID,
  type SvgSpriteGenerator,
  type SvgSpriteRequest,
  type SvgSpriteResult,
} from './SvgSpriteGenerator';

/**
 * The provider is a thin adapter — what is worth asserting is the seam: which lane a model id maps
 * to, that the size the caller asked for is the size the generator is asked for, and that the SVG
 * source survives the trip out (it is the artifact the edit loop runs on).
 */
interface GeneratorStub {
  readonly generator: SvgSpriteGenerator;
  readonly generate: ReturnType<typeof vi.fn>;
}

function createGenerator(overrides: Partial<Record<string, unknown>> = {}): GeneratorStub {
  const generate = vi.fn(
    async (request: SvgSpriteRequest): Promise<SvgSpriteResult> => ({
      svgSource: `<svg viewBox="0 0 ${request.width} ${request.height}"><rect /></svg>`,
      png: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      llmProviderId: 'anthropic-bridge',
      llmModelId: 'claude-sonnet-4-5',
    })
  );
  const generator = {
    generate,
    supportsReferences: vi.fn(() => true),
    isAvailable: vi.fn(async () => true),
    listModels: vi.fn(() => [
      {
        id: 'anthropic-bridge/claude-sonnet-4-5',
        label: 'Anthropic (bridge) · Claude Sonnet 4.5',
        description: 'strong at SVG',
        supportsImages: true,
      },
      {
        id: 'zen/deepseek-chat',
        label: 'OpenCode Zen · DeepSeek Chat',
        supportsImages: false,
      },
    ]),
    ...overrides,
  } as unknown as SvgSpriteGenerator;
  return { generator, generate };
}

const createProvider = (stub: GeneratorStub): SvgLlmImageProvider =>
  new SvgLlmImageProvider(() => stub.generator);

describe('SvgLlmImageProvider', () => {
  it('needs no API key of its own', () => {
    const provider = createProvider(createGenerator());
    expect(provider.requiresApiKey).toBe(false);
  });

  it('lists the virtual agent-default entry first, then the LLM catalog', () => {
    const provider = createProvider(createGenerator());
    const models = provider.models;
    expect(models[0].id).toBe(AGENT_DEFAULT_MODEL_ID);
    expect(models.map(model => model.id)).toContain('anthropic-bridge/claude-sonnet-4-5');
  });

  it('advertises exact sizing and transparency on every model', () => {
    const provider = createProvider(createGenerator());
    for (const model of provider.models) {
      expect(model.capabilities.supportsExactSize).toBe(true);
      expect(model.capabilities.supportsTransparency).toBe(true);
      // Exact W×H replaces the aspect/size-tier knobs entirely.
      expect(model.capabilities.aspectRatios).toEqual([]);
      expect(model.capabilities.imageSizes).toEqual([]);
    }
  });

  it('offers reference images only for a lane that can see them', () => {
    const provider = createProvider(createGenerator());
    const seeing = provider.getModel('anthropic-bridge/claude-sonnet-4-5');
    const blind = provider.getModel('zen/deepseek-chat');
    expect(seeing?.capabilities.supportsReferenceImages).toBe(true);
    expect(blind?.capabilities.supportsReferenceImages).toBe(false);
    expect(blind?.capabilities.maxReferenceImages).toBe(0);
  });

  it('resolves an empty or sentinel model id to the agent-default entry', () => {
    const provider = createProvider(createGenerator());
    expect(provider.getModel('')?.id).toBe(AGENT_DEFAULT_MODEL_ID);
    expect(provider.getModel(AGENT_DEFAULT_MODEL_ID)?.id).toBe(AGENT_DEFAULT_MODEL_ID);
  });

  it('accepts a composite id the catalog has not listed yet', () => {
    const stub = createGenerator({ listModels: vi.fn(() => []) });
    const provider = createProvider(stub);
    expect(provider.getModel('openai/gpt-5')?.id).toBe('openai/gpt-5');
  });

  it('rejects a non-composite id that is not the sentinel', () => {
    const provider = createProvider(createGenerator());
    expect(provider.getModel('nonsense')).toBeUndefined();
  });

  it('passes the requested size straight through and returns the source with the PNG', async () => {
    const stub = createGenerator();
    const provider = createProvider(stub);
    const result = await provider.generate(
      { prompt: 'a coin', width: 96, height: 32 },
      { apiKey: '', modelId: AGENT_DEFAULT_MODEL_ID }
    );
    expect(stub.generate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'a coin', width: 96, height: 32 })
    );
    expect(result.images[0].mimeType).toBe('image/png');
    expect(result.images[0].svgSource).toContain('viewBox="0 0 96 32"');
  });

  it('clamps absurd sizes and squares up when only a width is given', async () => {
    const stub = createGenerator();
    const provider = createProvider(stub);
    await provider.generate(
      { prompt: 'a coin', width: 64 },
      { apiKey: '', modelId: AGENT_DEFAULT_MODEL_ID }
    );
    expect(stub.generate).toHaveBeenCalledWith(expect.objectContaining({ width: 64, height: 64 }));

    await provider.generate(
      { prompt: 'a coin', width: 99999, height: 1 },
      { apiKey: '', modelId: AGENT_DEFAULT_MODEL_ID }
    );
    expect(stub.generate).toHaveBeenLastCalledWith(
      expect.objectContaining({ width: 2048, height: 8 })
    );
  });

  it('falls back to the default sprite size when no size is requested', async () => {
    const stub = createGenerator();
    const provider = createProvider(stub);
    await provider.generate({ prompt: 'a coin' }, { apiKey: '', modelId: '' });
    expect(stub.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        width: DEFAULT_SVG_SPRITE_SIZE,
        height: DEFAULT_SVG_SPRITE_SIZE,
      })
    );
  });

  it('forwards an svgSource so the generator can run an edit instead of a re-roll', async () => {
    const stub = createGenerator();
    const provider = createProvider(stub);
    await provider.generate(
      { prompt: 'thicker outline', width: 64, height: 64, svgSource: '<svg />' },
      { apiKey: '', modelId: AGENT_DEFAULT_MODEL_ID }
    );
    expect(stub.generate).toHaveBeenCalledWith(expect.objectContaining({ svgSource: '<svg />' }));
  });

  it('rejects an empty prompt before reaching the model', async () => {
    const stub = createGenerator();
    const provider = createProvider(stub);
    await expect(
      provider.generate({ prompt: '   ' }, { apiKey: '', modelId: AGENT_DEFAULT_MODEL_ID })
    ).rejects.toBeInstanceOf(ImageGenError);
    expect(stub.generate).not.toHaveBeenCalled();
  });
});
