import { injectable } from '@/fw/di';
import { GeminiLlmProvider } from './GeminiLlmProvider';
import { AnthropicLlmProvider } from './AnthropicLlmProvider';
import { OpenAICompatLlmProvider } from './OpenAICompatLlmProvider';
import { CerebrasLlmProvider } from './CerebrasLlmProvider';
import { OpenCodeZenLlmProvider } from './OpenCodeZenLlmProvider';
import type { LlmProvider } from './LlmTypes';

/**
 * Registry of available LLM providers for the in-editor agent. Ships with Gemini, Anthropic, Cerebras,
 * OpenCode Zen, and an OpenAI-compatible provider (covering hosted OpenAI plus local Ollama / LM Studio
 * endpoints). Mirrors `ImageGenProviderRegistry`: the default provider is the first registered one.
 */
@injectable()
export class LlmProviderRegistry {
  private readonly providers = new Map<string, LlmProvider>();
  private readonly order: string[] = [];

  constructor() {
    this.register(new GeminiLlmProvider());
    this.register(new AnthropicLlmProvider());
    this.register(new CerebrasLlmProvider());
    this.register(new OpenCodeZenLlmProvider());
    this.register(new OpenAICompatLlmProvider());
  }

  register(provider: LlmProvider): void {
    if (!this.providers.has(provider.id)) {
      this.order.push(provider.id);
    }
    this.providers.set(provider.id, provider);
  }

  get(providerId: string): LlmProvider | undefined {
    return this.providers.get(providerId);
  }

  list(): LlmProvider[] {
    return this.order.map(id => this.providers.get(id)!).filter(Boolean);
  }

  getDefault(): LlmProvider | undefined {
    return this.order.length > 0 ? this.providers.get(this.order[0]) : undefined;
  }
}
