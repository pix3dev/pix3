/**
 * Provider-agnostic contracts for the in-editor LLM agent. New providers (Gemini, Anthropic,
 * OpenAI-compatible) implement {@link LlmProvider} and register in `LlmProviderRegistry`.
 *
 * The shape mirrors the image-gen provider layer (`src/services/image-gen/ImageGenTypes.ts`): a
 * registry of typed providers, per-model capabilities, keys referenced by `apiKeySecretId`, and a
 * {@link LlmError} carrying a machine-readable `kind`. The three wire formats (Gemini
 * functionCall/functionResponse, Anthropic tool_use/tool_result, OpenAI tool_calls/role:"tool") are
 * deliberately different, so we do NOT abstract over them beyond this common message/content model —
 * each provider maps this model to and from its own wire format.
 */

/** JSON Schema for a tool's input. Kept as a loose record — providers forward it verbatim. */
export type JsonSchema = Record<string, unknown>;

/** A text span in a message. */
export interface LlmTextBlock {
  readonly type: 'text';
  readonly text: string;
}

/** An inline image (base64-encoded WITHOUT the `data:` URI prefix) supplied to a multimodal model. */
export interface LlmImageBlock {
  readonly type: 'image';
  readonly mimeType: string;
  readonly data: string;
}

/** A tool invocation emitted by the assistant. `input` is the parsed (object) arguments. */
export interface LlmToolUseBlock {
  readonly type: 'tool-use';
  /** Stable id used to pair this call with its {@link LlmToolResultBlock}. */
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  /**
   * Opaque provider signature that must be echoed back verbatim when the assistant turn is replayed
   * (Gemini's `thoughtSignature` on `functionCall` parts). Ignored by providers that don't use it.
   */
  readonly signature?: string;
}

/**
 * The result of executing a tool, sent back to the model. `toolUseId` pairs it with the originating
 * {@link LlmToolUseBlock} (Anthropic/OpenAI match by id). `toolName` is carried for providers that
 * match by function name instead (Gemini) — providers fall back to resolving the name from the
 * matching tool-use block when it is absent.
 */
export interface LlmToolResultBlock {
  readonly type: 'tool-result';
  readonly toolUseId: string;
  readonly toolName?: string;
  readonly content: string;
  readonly isError?: boolean;
}

export type LlmContentBlock = LlmTextBlock | LlmImageBlock | LlmToolUseBlock | LlmToolResultBlock;

export type LlmRole = 'user' | 'assistant';

/** A single conversation turn. `content` may be a bare string (treated as one text block). */
export interface LlmMessage {
  readonly role: LlmRole;
  readonly content: string | readonly LlmContentBlock[];
}

/** A tool the model may call, described with a JSON Schema for its input. */
export interface LlmToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

/** Why the model stopped. `blocked` covers safety refusals; `unknown` is the catch-all. */
export type LlmStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'blocked' | 'unknown';

/**
 * Reasoning-depth level, ordered cheapest → deepest. A provider-agnostic name for the "how hard
 * should the model think" knob: Anthropic maps it to `output_config.effort` (adaptive thinking),
 * OpenAI-compatible models to `reasoning_effort`. Only levels a model actually accepts are offered
 * (see {@link LlmModelCapabilities.reasoningEfforts}); `high` matches most providers' default.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** All reasoning levels, cheapest → deepest. Providers advertise the subset each model accepts. */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** Token accounting, when the provider reports it. */
export interface LlmUsage {
  /**
   * Total prompt tokens for this request, **cache-inclusive** — the full context the model read
   * (system + tools + history), whether or not parts of it were served from cache. Providers whose
   * native counter splits cached tokens out (Anthropic) sum them back in so this stays comparable
   * across providers and matches the pre-caching meaning of "context size".
   */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /**
   * Subset of {@link inputTokens} served from cache instead of re-processed (billed cheaply). Maps
   * to Anthropic `cache_read_input_tokens`, OpenAI `prompt_tokens_details.cached_tokens`, Gemini
   * `cachedContentTokenCount`. Undefined when the provider doesn't report it.
   */
  readonly cacheReadTokens?: number;
  /**
   * Prompt tokens written to the cache on this request (billed at a premium; read back cheaply on
   * later requests within the cache TTL). Anthropic-only (`cache_creation_input_tokens`).
   */
  readonly cacheCreationTokens?: number;
}

/**
 * Opt-in prompt-caching hint. Providers with server-side automatic caching (OpenAI, Gemini) ignore
 * it and still report cache reads via {@link LlmUsage}; Anthropic uses it to place `cache_control`
 * breakpoints so the request-stable prefix is reused from cache across calls.
 */
export interface LlmCacheHint {
  /**
   * Number of leading characters of {@link ChatParams.system} that are request-stable (rules,
   * project instructions, tool list) and safe to cache as a prefix. The rest (live scene context)
   * stays uncached. Omit to cache the whole system prompt. A cache hit requires this head to be
   * byte-identical between requests, so the caller must keep every volatile line after it.
   */
  readonly systemStableChars?: number;
  /**
   * Also cache the conversation prefix — a breakpoint on the last message, so a multi-step agentic
   * loop re-reads its history from cache each iteration instead of re-billing it.
   */
  readonly conversation?: boolean;
}

/**
 * Incremental streaming event. The streaming interface is laid in from the start so callers can wire
 * a UI to `onDelta`; providers in this phase may return the full response and never emit deltas.
 */
export type LlmStreamDelta =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool-use-start'; readonly id: string; readonly name: string }
  | { readonly type: 'tool-use-input'; readonly id: string; readonly partialJson: string };

export interface ChatParams {
  readonly messages: readonly LlmMessage[];
  /** Tool definitions the model may call (JSON Schema inputs). */
  readonly tools?: readonly LlmToolDefinition[];
  /** System prompt / instructions. */
  readonly system?: string;
  /** Opt into explicit prompt caching. Ignored by providers without a `cache_control` mechanism. */
  readonly cache?: LlmCacheHint;
  /** Cap on generated tokens. Providers clamp to their model's ceiling. */
  readonly maxTokens?: number;
  /**
   * Reasoning-depth level for models that expose one. The caller only sets it for a model whose
   * {@link LlmModelCapabilities.reasoningEfforts} lists the chosen level, so providers may emit it
   * verbatim (Anthropic → `output_config.effort`, OpenAI-compatible → `reasoning_effort`) without
   * re-checking capability. Omit to use the model's default effort.
   */
  readonly reasoningEffort?: ReasoningEffort;
  /** Cancellation. Forwarded to `fetch`; an abort surfaces as an `aborted` {@link LlmError}. */
  readonly signal?: AbortSignal;
  /** Optional streaming sink. May be ignored by providers that return the full response. */
  readonly onDelta?: (delta: LlmStreamDelta) => void;
}

export interface LlmResult {
  /** The assistant's reply as content blocks (text + any tool-use calls). */
  readonly content: LlmContentBlock[];
  readonly stopReason: LlmStopReason;
  readonly usage?: LlmUsage;
  /** Raw provider payload, retained for debugging. */
  readonly raw?: unknown;
}

export interface LlmModelCapabilities {
  readonly supportsTools: boolean;
  readonly supportsImages: boolean;
  readonly supportsSystemPrompt: boolean;
  /** Default cap on generated tokens for this model. */
  readonly maxOutputTokens: number;
  /**
   * Total context-window size in tokens (prompt + generation). Optional — providers that can't
   * report it (local/OpenAI-compatible endpoints) omit it. The chat UI uses it to show how full
   * the context is; when absent, the fill indicator degrades to a bare token count.
   */
  readonly contextWindow?: number;
  /**
   * Reasoning-depth levels this model accepts, cheapest → deepest, or omitted/empty for models with
   * no reasoning control. Presence is the capability flag: the chat UI shows a reasoning-level picker
   * only when this is non-empty, and offers exactly these levels. (Anthropic Opus/Sonnet expose the
   * full `low…max` range; gateway/OpenAI-style models expose `low/medium/high`.)
   */
  readonly reasoningEfforts?: readonly ReasoningEffort[];
}

/** Indicative USD price per 1M tokens (shown as a hint in the model picker; may drift). */
export interface LlmModelPricing {
  readonly inputPer1M: number;
  readonly outputPer1M: number;
}

export interface LlmModel {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly capabilities: LlmModelCapabilities;
  /** Optional pricing hint. Omitted for providers with user-configurable/local models. */
  readonly pricing?: LlmModelPricing;
}

/** Format a pricing hint like "$0.30 / $2.50 per 1M" for display in a model picker. */
export const formatPricingHint = (pricing: LlmModelPricing | undefined): string => {
  if (!pricing) {
    return '';
  }
  if (pricing.inputPer1M === 0 && pricing.outputPer1M === 0) {
    return 'Free';
  }
  const fmt = (n: number): string => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
  return `${fmt(pricing.inputPer1M)} / ${fmt(pricing.outputPer1M)} per 1M`;
};

/** Per-request context supplied by the caller (key + selected model + optional overrides). */
export interface LlmRequestContext {
  readonly apiKey: string;
  readonly modelId: string;
  /** Injected fetch (e.g. for tests); defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Override host (e.g. a local Ollama / LM Studio endpoint for the OpenAI-compatible provider). */
  readonly baseUrl?: string;
}

/**
 * Context for {@link LlmProvider.listModels}. No model is selected yet, and the key is optional —
 * public catalogs (models.dev, OpenCode Zen) and keyless local endpoints list without one.
 */
export interface LlmListModelsContext {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

export interface LlmProvider {
  readonly id: string;
  readonly label: string;
  /**
   * Static model catalog: the fallback (and capability hints) when no live catalog has been
   * fetched. Consumers should read models through `LlmModelCatalogService`, which overlays the
   * result of {@link listModels} on top of this list.
   */
  readonly models: readonly LlmModel[];
  /** SecretStorageService id under which this provider's API key is stored. */
  readonly apiKeySecretId: string;
  /** Where a user obtains an API key (shown in settings). */
  readonly apiKeyHelpUrl?: string;
  /** True when the provider needs a user-supplied base URL (OpenAI-compatible / local endpoints). */
  readonly requiresBaseUrl?: boolean;
  /**
   * When true, the provider is registered (so stored selections and its catalog still resolve) but
   * hidden from the picker / settings UI — used to retire a provider without deleting its code.
   */
  readonly hidden?: boolean;
  /** Default host used when no `baseUrl` override is supplied. */
  readonly defaultBaseUrl?: string;
  getModel(modelId: string): LlmModel | undefined;
  chat(params: ChatParams, ctx: LlmRequestContext): Promise<LlmResult>;
  /**
   * Fetch the provider's live model catalog (hosted catalogs churn — new/free models appear and
   * disappear weekly). Optional: fixed-list providers omit it. Throws {@link LlmError} on failure;
   * `LlmModelCatalogService` caches successful results and falls back to {@link models} otherwise.
   */
  listModels?(ctx: LlmListModelsContext): Promise<LlmModel[]>;
}

export type LlmErrorKind =
  | 'missing-key'
  | 'network'
  | 'http'
  | 'blocked'
  | 'aborted'
  | 'empty'
  | 'unknown';

/** User-facing LLM error carrying a machine-readable kind (mirrors `ImageGenError`). */
export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly status?: number,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'LlmError';
  }
}

// ---------------------------------------------------------------------------
// Shared helpers (used by every provider)
// ---------------------------------------------------------------------------

export const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' : false;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Normalise a message's `content` to an array of blocks (a bare string becomes one text block). */
export const toBlocks = (
  content: string | readonly LlmContentBlock[]
): readonly LlmContentBlock[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : content;

/**
 * Build a lookup from tool-use id → tool name across the whole conversation. Providers that match
 * tool results by name (Gemini) use this to resolve a {@link LlmToolResultBlock} that omits
 * `toolName`.
 */
export const collectToolNames = (messages: readonly LlmMessage[]): Map<string, string> => {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const block of toBlocks(message.content)) {
      if (block.type === 'tool-use') {
        names.set(block.id, block.name);
      }
    }
  }
  return names;
};
