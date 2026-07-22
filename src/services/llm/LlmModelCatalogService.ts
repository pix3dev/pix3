import { inject, injectable } from '@/fw/di';
import { AgentSettingsService } from '@/services/agent/AgentSettingsService';
import { LlmProviderRegistry } from './LlmProviderRegistry';
import { isRecord, type LlmModel } from './LlmTypes';

interface CatalogEntry {
  readonly fetchedAt: number;
  readonly models: LlmModel[];
}

const STORAGE_KEY = 'pix3.llmModelCatalog:v1';
/** Hosted catalogs churn weekly, not hourly — refresh at most twice a day (plus the manual button). */
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

/**
 * Cached live model catalogs for the LLM providers. Providers that implement `listModels` (Zen,
 * Cerebras, OpenAI-compatible) get their catalog fetched lazily, persisted in localStorage, and
 * re-fetched in the background once it goes stale — hosted gateways rotate models (especially free
 * ones) often enough that a checked-in list is permanently out of date. UI model pickers and the
 * chat loop read models through this service; fixed-list providers simply pass their static
 * `models` through.
 *
 * Like {@link AgentSettingsService}, this is app configuration — it deliberately does NOT flow
 * through appState / the undo history.
 */
@injectable()
export class LlmModelCatalogService {
  @inject(LlmProviderRegistry)
  private readonly registry!: LlmProviderRegistry;

  @inject(AgentSettingsService)
  private readonly settings!: AgentSettingsService;

  private cache: Record<string, CatalogEntry> | null = null;
  private readonly inflight = new Map<string, Promise<readonly LlmModel[]>>();
  private readonly listeners = new Set<() => void>();

  /**
   * Models for a provider: the last fetched live catalog when present, else the provider's static
   * list. Kicks off a background refresh (fire-and-forget) when the provider supports live listing
   * and the cache is missing or stale — subscribers re-render when it lands.
   */
  getModels(providerId: string): readonly LlmModel[] {
    const provider = this.registry.get(providerId);
    if (!provider) {
      return [];
    }
    const entry = this.ensureLoaded()[providerId];
    if (provider.listModels && (!entry || Date.now() - entry.fetchedAt > STALE_AFTER_MS)) {
      void this.refresh(providerId).catch(() => {
        // Background refresh is best-effort; the static/cached list keeps working.
      });
    }
    return entry && entry.models.length > 0 ? entry.models : provider.models;
  }

  getModel(providerId: string, modelId: string): LlmModel | undefined {
    return this.getModels(providerId).find(model => model.id === modelId);
  }

  /** True when the provider can fetch a live catalog (drives the refresh button in settings). */
  supportsRefresh(providerId: string): boolean {
    return typeof this.registry.get(providerId)?.listModels === 'function';
  }

  /** When this provider's catalog was last fetched (undefined = never). */
  getFetchedAt(providerId: string): number | undefined {
    return this.ensureLoaded()[providerId]?.fetchedAt;
  }

  /**
   * Fetch the provider's live catalog now (concurrent calls share one request). Rejects with the
   * provider's `LlmError` on failure — the cached/static list stays in place.
   */
  async refresh(providerId: string): Promise<readonly LlmModel[]> {
    const provider = this.registry.get(providerId);
    if (!provider) {
      return [];
    }
    if (!provider.listModels) {
      return provider.models;
    }
    const running = this.inflight.get(providerId);
    if (running) {
      return running;
    }
    const task = (async (): Promise<readonly LlmModel[]> => {
      const apiKey = (await this.settings.getApiKey(providerId)) ?? undefined;
      const baseUrl = this.settings.getBaseUrl(providerId);
      const models = await provider.listModels!({ apiKey, baseUrl });
      const cache = this.ensureLoaded();
      cache[providerId] = { fetchedAt: Date.now(), models: [...models] };
      this.persist();
      this.notify();
      return models;
    })();
    this.inflight.set(providerId, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(providerId);
    }
  }

  /** Notifies whenever any provider's catalog updates (listeners re-read via getModels). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
    this.inflight.clear();
    this.cache = null;
  }

  // -- internals -------------------------------------------------------------

  private ensureLoaded(): Record<string, CatalogEntry> {
    if (!this.cache) {
      this.cache = this.load();
    }
    return this.cache;
  }

  private load(): Record<string, CatalogEntry> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return {};
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) {
        return {};
      }
      const cache: Record<string, CatalogEntry> = {};
      for (const [providerId, entry] of Object.entries(parsed)) {
        if (!isRecord(entry) || typeof entry.fetchedAt !== 'number' || !Array.isArray(entry.models))
          continue;
        const models = entry.models.filter(
          (model): model is LlmModel =>
            isRecord(model) &&
            typeof model.id === 'string' &&
            typeof model.label === 'string' &&
            isRecord(model.capabilities)
        );
        if (models.length > 0) {
          cache[providerId] = { fetchedAt: entry.fetchedAt, models };
        }
      }
      return cache;
    } catch {
      return {};
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.cache ?? {}));
    } catch {
      // ignore persistence errors (private mode / quota)
    }
  }

  private notify(): void {
    this.listeners.forEach(listener => listener());
  }
}
