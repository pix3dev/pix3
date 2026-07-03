import { injectable } from '@/fw/di';
import { GeminiImageProvider } from './GeminiImageProvider';
import type { ImageGenProvider } from './ImageGenTypes';

/**
 * Registry of available AI image-generation providers. Ships with Gemini ("Nano Banana"); other
 * providers (OpenAI GPT Image, etc.) register here once implemented. The default provider is the
 * first registered one.
 */
@injectable()
export class ImageGenProviderRegistry {
  private readonly providers = new Map<string, ImageGenProvider>();
  private readonly order: string[] = [];

  constructor() {
    this.register(new GeminiImageProvider());
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
