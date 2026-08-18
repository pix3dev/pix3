import { inject, injectable } from '@/fw/di';
import { GeminiImageProvider } from './GeminiImageProvider';
import { OpenAIImageProvider } from './OpenAIImageProvider';
import { StropheImageProvider } from './StropheImageProvider';
import { SvgLlmImageProvider } from './SvgLlmImageProvider';
import { SvgSpriteGenerator } from './SvgSpriteGenerator';
import type { ImageGenProvider } from './ImageGenTypes';

/**
 * Registry of available AI image-generation providers. Ships with Gemini ("Nano Banana"), OpenAI
 * (GPT Image), Strophe (metered aggregator — one key, credits, many upstream models) and SVG
 * (Agent LLM), which authors vector sprites with the agent's own chat model and bakes them locally.
 * Additional providers register here once implemented. The default provider is the first registered
 * one.
 */
@injectable()
export class ImageGenProviderRegistry {
  /**
   * The SVG provider's engine. Injected here rather than constructed inside the provider because
   * `@inject` is a prototype accessor: the provider gets it as a closure, so nothing is resolved
   * while this constructor runs and the LLM stack is not pulled in until a vector sprite is asked for.
   */
  @inject(SvgSpriteGenerator)
  private readonly svgGenerator!: SvgSpriteGenerator;

  private readonly providers = new Map<string, ImageGenProvider>();
  private readonly order: string[] = [];

  constructor() {
    this.register(new GeminiImageProvider());
    this.register(new OpenAIImageProvider());
    this.register(new StropheImageProvider());
    this.register(new SvgLlmImageProvider(() => this.svgGenerator));
  }

  register(provider: ImageGenProvider): void {
    if (!this.providers.has(provider.id)) {
      this.order.push(provider.id);
    }
    this.providers.set(provider.id, provider);
  }

  get(providerId: string): ImageGenProvider | undefined {
    return this.providers.get(providerId);
  }

  list(): ImageGenProvider[] {
    return this.order.map(id => this.providers.get(id)!).filter(Boolean);
  }

  getDefault(): ImageGenProvider | undefined {
    return this.order.length > 0 ? this.providers.get(this.order[0]) : undefined;
  }
}
