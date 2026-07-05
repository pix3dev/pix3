import { inject, injectable } from '@/fw/di';
import { SecretStorageService } from '@/services/SecretStorageService';
import { ImageGenProviderRegistry } from '@/services/image-gen/ImageGenProviderRegistry';
import type { AspectRatio, ImageGenProvider } from '@/services/image-gen/ImageGenTypes';
import type { BgRemovalEngine, BgRemovalQuality } from '@/services/bg-removal/types';

export interface AiImagePreferences {
  selectedProviderId: string;
  /** Selected model id per provider id. */
  modelByProvider: Record<string, string>;
  defaultAspectRatio: AspectRatio;
  defaultImageSize: string;
  /** Provider-specific quality tier (e.g. OpenAI 'low' | 'medium' | 'high'); '' = provider default. */
  defaultQuality: string;
  /** Request a transparent alpha channel from providers that support it (e.g. OpenAI GPT Image). */
  transparentBackground: boolean;
  /** Local background-removal engine + BiRefNet quality tier. */
  bgRemovalEngine: BgRemovalEngine;
  bgRemovalQuality: BgRemovalQuality;
  /** Fill enclosed transparent holes in the cutout (recovers wrongly-removed object interiors). */
  bgFillHoles: boolean;
}

const STORAGE_KEY = 'pix3.aiImageSettings:v1';

const ASPECT_RATIOS: readonly AspectRatio[] = ['Auto', '1:1', '3:4', '4:3', '16:9', '9:16'];

const isAspectRatio = (value: unknown): value is AspectRatio =>
  typeof value === 'string' && (ASPECT_RATIOS as readonly string[]).includes(value);

/**
 * Non-secret preferences for AI image generation (selected provider/model, default size/aspect).
 * Persisted in localStorage — this is app configuration, not scene state, so it deliberately does
 * NOT flow through appState / the undo history. API keys are NOT stored here; they live encrypted
 * in {@link SecretStorageService} and are only referenced by provider secret id.
 */
@injectable()
export class AiImageSettingsService {
  @inject(ImageGenProviderRegistry)
  private readonly registry!: ImageGenProviderRegistry;

  @inject(SecretStorageService)
  private readonly secrets!: SecretStorageService;

  private prefs: AiImagePreferences | null = null;
  private readonly listeners = new Set<(prefs: AiImagePreferences) => void>();

  getPreferences(): AiImagePreferences {
    return { ...this.ensureLoaded() };
  }

  updatePreferences(patch: Partial<AiImagePreferences>): void {
    const next: AiImagePreferences = { ...this.ensureLoaded(), ...patch };
    if (patch.modelByProvider) {
      next.modelByProvider = { ...this.ensureLoaded().modelByProvider, ...patch.modelByProvider };
    }
    this.prefs = next;
    this.persist(next);
    this.notify();
  }

  /** Resolve the currently-selected provider (falls back to the default provider). */
  getSelectedProvider(): ImageGenProvider | undefined {
    const prefs = this.ensureLoaded();
    return this.registry.get(prefs.selectedProviderId) ?? this.registry.getDefault();
  }

  /** Resolve the selected model id for a provider (falls back to its first model). */
  getSelectedModelId(providerId: string): string | undefined {
    const prefs = this.ensureLoaded();
    const provider = this.registry.get(providerId);
    if (!provider) {
      return undefined;
    }
    const stored = prefs.modelByProvider[providerId];
    if (stored && provider.getModel(stored)) {
      return stored;
    }
    return provider.models[0]?.id;
  }

  subscribe(listener: (prefs: AiImagePreferences) => void): () => void {
    this.listeners.add(listener);
    listener(this.getPreferences());
    return () => this.listeners.delete(listener);
  }

  // -- API keys (delegated to encrypted secret storage) ----------------------

  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    const provider = this.registry.get(providerId);
    if (!provider) {
      throw new Error(`Unknown image provider: ${providerId}`);
    }
    await this.secrets.setSecret(provider.apiKeySecretId, apiKey);
    this.notify();
  }

  async clearApiKey(providerId: string): Promise<void> {
    const provider = this.registry.get(providerId);
    if (!provider) {
      return;
    }
    await this.secrets.deleteSecret(provider.apiKeySecretId);
    this.notify();
  }

  async hasApiKey(providerId: string): Promise<boolean> {
    const provider = this.registry.get(providerId);
    if (!provider) {
      return false;
    }
    return this.secrets.hasSecret(provider.apiKeySecretId);
  }

  async getApiKey(providerId: string): Promise<string | null> {
    const provider = this.registry.get(providerId);
    if (!provider) {
      return null;
    }
    return this.secrets.getSecret(provider.apiKeySecretId);
  }

  dispose(): void {
    this.listeners.clear();
    this.prefs = null;
  }

  // -- internals -------------------------------------------------------------

  private ensureLoaded(): AiImagePreferences {
    if (!this.prefs) {
      this.prefs = this.load();
    }
    return this.prefs;
  }

  private defaults(): AiImagePreferences {
    const defaultProvider = this.registry.getDefault();
    return {
      selectedProviderId: defaultProvider?.id ?? '',
      modelByProvider: {},
      defaultAspectRatio: 'Auto',
      defaultImageSize: '1K',
      defaultQuality: '',
      transparentBackground: false,
      bgRemovalEngine: 'imgly',
      bgRemovalQuality: 'balanced',
      bgFillHoles: true,
    };
  }

  private load(): AiImagePreferences {
    const defaults = this.defaults();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return defaults;
      }
      const parsed = JSON.parse(raw) as Partial<AiImagePreferences> | null;
      if (!parsed || typeof parsed !== 'object') {
        return defaults;
      }
      return {
        selectedProviderId:
          typeof parsed.selectedProviderId === 'string' &&
          this.registry.get(parsed.selectedProviderId)
            ? parsed.selectedProviderId
            : defaults.selectedProviderId,
        modelByProvider:
          parsed.modelByProvider && typeof parsed.modelByProvider === 'object'
            ? { ...(parsed.modelByProvider as Record<string, string>) }
            : {},
        defaultAspectRatio: isAspectRatio(parsed.defaultAspectRatio)
          ? parsed.defaultAspectRatio
          : defaults.defaultAspectRatio,
        defaultImageSize:
          typeof parsed.defaultImageSize === 'string'
            ? parsed.defaultImageSize
            : defaults.defaultImageSize,
        defaultQuality:
          typeof parsed.defaultQuality === 'string'
            ? parsed.defaultQuality
            : defaults.defaultQuality,
        transparentBackground:
          typeof parsed.transparentBackground === 'boolean'
            ? parsed.transparentBackground
            : defaults.transparentBackground,
        bgRemovalEngine:
          parsed.bgRemovalEngine === 'imgly' || parsed.bgRemovalEngine === 'birefnet'
            ? parsed.bgRemovalEngine
            : defaults.bgRemovalEngine,
        bgRemovalQuality:
          parsed.bgRemovalQuality === 'balanced' || parsed.bgRemovalQuality === 'max'
            ? parsed.bgRemovalQuality
            : defaults.bgRemovalQuality,
        bgFillHoles:
          typeof parsed.bgFillHoles === 'boolean' ? parsed.bgFillHoles : defaults.bgFillHoles,
      };
    } catch {
      return defaults;
    }
  }

  private persist(prefs: AiImagePreferences): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // ignore persistence errors (private mode / quota)
    }
  }

  private notify(): void {
    const snapshot = this.getPreferences();
    this.listeners.forEach(listener => listener(snapshot));
  }
}
