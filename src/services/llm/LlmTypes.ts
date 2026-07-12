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

/** Token accounting, when the provider reports it. */
export interface LlmUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
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
  /** Cap on generated tokens. Providers clamp to their model's ceiling. */
  readonly maxTokens?: number;
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
}

export interface LlmModel {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly capabilities: LlmModelCapabilities;
}

/** Per-request context supplied by the caller (key + selected model + optional overrides). */
export interface LlmRequestContext {
  readonly apiKey: string;
  readonly modelId: string;
  /** Injected fetch (e.g. for tests); defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Override host (e.g. a local Ollama / LM Studio endpoint for the OpenAI-compatible provider). */
  readonly baseUrl?: string;
}

export interface LlmProvider {
  readonly id: string;
  readonly label: string;
  readonly models: readonly LlmModel[];
  /** SecretStorageService id under which this provider's API key is stored. */
  readonly apiKeySecretId: string;
  /** Where a user obtains an API key (shown in settings). */
  readonly apiKeyHelpUrl?: string;
  /** True when the provider needs a user-supplied base URL (OpenAI-compatible / local endpoints). */
  readonly requiresBaseUrl?: boolean;
  /** Default host used when no `baseUrl` override is supplied. */
  readonly defaultBaseUrl?: string;
  getModel(modelId: string): LlmModel | undefined;
  chat(params: ChatParams, ctx: LlmRequestContext): Promise<LlmResult>;
}

export type LlmErrorKind = 'missing-key' | 'network' | 'http' | 'blocked' | 'aborted' | 'unknown';

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
