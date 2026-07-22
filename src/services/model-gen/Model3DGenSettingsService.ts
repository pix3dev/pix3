import { injectable } from '@/fw/di';
import { REASONING_EFFORTS, type ReasoningEffort } from '@/services/llm/LlmTypes';
import type { ModelGenMode } from '@/services/model-gen/model-gen-types';

/**
 * Non-secret preferences for Model Lab. Two model slots (codegen + vision) with empty ids meaning
 * "auto-resolve" (like the Agent tab), a per-model reasoning-effort map, loop/quality knobs, and the
 * default save folder. Persisted in localStorage — app configuration, not scene state, so it does
 * NOT flow through appState / the undo history. API keys are NOT stored here; they are referenced by
 * each provider's secret id via {@link import('@/services/agent/AgentSettingsService').AgentSettingsService}.
 *
 * Mirrors {@link import('@/services/agent/AgentSettingsService').AgentSettingsService} in shape.
 */
export interface ModelLabPreferences {
  /** Codegen provider id (spec + factory code). Empty = the agent's selected provider. */
  codegenProviderId: string;
  /** Codegen model id (paired with {@link codegenProviderId}). Empty = the provider's selected model. */
  codegenModelId: string;
  /** Vision provider id (image assessment). Empty = auto-resolve like the agent vision helper. */
  visionProviderId: string;
  /** Vision model id (paired with {@link visionProviderId}). Empty = first vision-capable model. */
  visionModelId: string;
  /**
   * Chosen reasoning-effort level per model, keyed by {@link reasoningEffortKey} (`provider::model`).
   * Absent entries mean "use the model's default effort".
   */
  reasoningEffortByModel: Record<string, ReasoningEffort>;
  /** Vision score threshold for the (Phase 3) review loop. */
  scoreThreshold: number;
  /** Cap on codegen/refine iterations per pass. */
  maxIterationsPerPass: number;
  /** Default generation depth. */
  mode: ModelGenMode;
  /** Project-relative folder GLBs are saved into by default. */
  saveFolder: string;
}

const STORAGE_KEY = 'pix3.modelLabSettings:v1';

/** Compose the {@link ModelLabPreferences.reasoningEffortByModel} key for a provider + model pair. */
const reasoningEffortKey = (providerId: string, modelId: string): string =>
  `${providerId}::${modelId}`;

const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);

const isMode = (value: unknown): value is ModelGenMode => value === 'fast' || value === 'quality';

/** Keep only well-formed `provider::model → level` entries when loading persisted prefs. */
const sanitizeReasoningEffortMap = (raw: unknown): Record<string, ReasoningEffort> => {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const out: Record<string, ReasoningEffort> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isReasoningEffort(value)) {
      out[key] = value;
    }
  }
  return out;
};

const DEFAULT_SCORE_THRESHOLD = 0.7;
const DEFAULT_MAX_ITERATIONS_PER_PASS = 3;
const DEFAULT_SAVE_FOLDER = 'models';

@injectable()
export class Model3DGenSettingsService {
  private prefs: ModelLabPreferences | null = null;
  private readonly listeners = new Set<(prefs: ModelLabPreferences) => void>();

  getPreferences(): ModelLabPreferences {
    return { ...this.ensureLoaded() };
  }

  updatePreferences(patch: Partial<ModelLabPreferences>): void {
    const next: ModelLabPreferences = { ...this.ensureLoaded(), ...patch };
    if (patch.reasoningEffortByModel) {
      next.reasoningEffortByModel = {
        ...this.ensureLoaded().reasoningEffortByModel,
        ...patch.reasoningEffortByModel,
      };
    }
    this.prefs = next;
    this.persist(next);
    this.notify();
  }

  /** The chosen reasoning level for a model, or undefined to use the model's default effort. */
  getReasoningEffort(providerId: string, modelId: string): ReasoningEffort | undefined {
    if (!modelId) {
      return undefined;
    }
    return this.ensureLoaded().reasoningEffortByModel[reasoningEffortKey(providerId, modelId)];
  }

  /**
   * Set (or, with `undefined`, clear back to default) the reasoning level for one model. Clearing
   * deletes the key rather than storing a sentinel, so {@link getReasoningEffort} reports "default".
   */
  setReasoningEffort(
    providerId: string,
    modelId: string,
    effort: ReasoningEffort | undefined
  ): void {
    if (!modelId) {
      return;
    }
    const key = reasoningEffortKey(providerId, modelId);
    const map = { ...this.ensureLoaded().reasoningEffortByModel };
    if (effort) {
      map[key] = effort;
    } else {
      delete map[key];
    }
    this.prefs = { ...this.ensureLoaded(), reasoningEffortByModel: map };
    this.persist(this.prefs);
    this.notify();
  }

  subscribe(listener: (prefs: ModelLabPreferences) => void): () => void {
    this.listeners.add(listener);
    listener(this.getPreferences());
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
    this.prefs = null;
  }

  // -- internals -------------------------------------------------------------

  private ensureLoaded(): ModelLabPreferences {
    if (!this.prefs) {
      this.prefs = this.load();
    }
    return this.prefs;
  }

  private defaults(): ModelLabPreferences {
    return {
      codegenProviderId: '',
      codegenModelId: '',
      visionProviderId: '',
      visionModelId: '',
      reasoningEffortByModel: {},
      scoreThreshold: DEFAULT_SCORE_THRESHOLD,
      maxIterationsPerPass: DEFAULT_MAX_ITERATIONS_PER_PASS,
      mode: 'quality',
      saveFolder: DEFAULT_SAVE_FOLDER,
    };
  }

  private load(): ModelLabPreferences {
    const defaults = this.defaults();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return defaults;
      }
      const parsed = JSON.parse(raw) as Partial<ModelLabPreferences> | null;
      if (!parsed || typeof parsed !== 'object') {
        return defaults;
      }
      return {
        codegenProviderId:
          typeof parsed.codegenProviderId === 'string'
            ? parsed.codegenProviderId
            : defaults.codegenProviderId,
        codegenModelId:
          typeof parsed.codegenModelId === 'string'
            ? parsed.codegenModelId
            : defaults.codegenModelId,
        visionProviderId:
          typeof parsed.visionProviderId === 'string'
            ? parsed.visionProviderId
            : defaults.visionProviderId,
        visionModelId:
          typeof parsed.visionModelId === 'string' ? parsed.visionModelId : defaults.visionModelId,
        reasoningEffortByModel: sanitizeReasoningEffortMap(parsed.reasoningEffortByModel),
        scoreThreshold:
          typeof parsed.scoreThreshold === 'number' &&
          Number.isFinite(parsed.scoreThreshold) &&
          parsed.scoreThreshold >= 0 &&
          parsed.scoreThreshold <= 1
            ? parsed.scoreThreshold
            : defaults.scoreThreshold,
        maxIterationsPerPass:
          typeof parsed.maxIterationsPerPass === 'number' &&
          Number.isFinite(parsed.maxIterationsPerPass) &&
          parsed.maxIterationsPerPass > 0
            ? Math.min(Math.round(parsed.maxIterationsPerPass), 20)
            : defaults.maxIterationsPerPass,
        mode: isMode(parsed.mode) ? parsed.mode : defaults.mode,
        saveFolder:
          typeof parsed.saveFolder === 'string' && parsed.saveFolder.trim()
            ? parsed.saveFolder
            : defaults.saveFolder,
      };
    } catch {
      return defaults;
    }
  }

  private persist(prefs: ModelLabPreferences): void {
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
