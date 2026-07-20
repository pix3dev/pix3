import {
  LlmError,
  isAbortError,
  isRecord,
  toBlocks,
  type ChatParams,
  type LlmContentBlock,
  type LlmMessage,
  type LlmModel,
  type LlmProvider,
  type LlmRequestContext,
  type LlmResult,
  type LlmStopReason,
  type LlmUsage,
  type ReasoningEffort,
} from './LlmTypes';

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Reasoning levels the modern Claude models accept via `output_config.effort` (adaptive thinking).
 * Opus 4.8 / Sonnet 5 / Fable 5 cover the full range; older/smaller models (Haiku 4.5) don't take
 * the effort parameter at all and so advertise none.
 */
export const CLAUDE_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/**
 * Anthropic Claude chat via the Messages API (`POST /v1/messages`). Direct browser calls require the
 * `anthropic-dangerous-direct-browser-access: true` header (Anthropic blocks them otherwise); the
 * user's key travels as `x-api-key`. BYOK — the risk of exposing a key in the browser is accepted.
 *
 * Tool-use maps cleanly here: assistant tool calls are `tool_use` content blocks (`id`, `name`,
 * `input`) and results are `tool_result` blocks carrying the same `tool_use_id`. Our unified content
 * model is essentially Anthropic's, so this mapping is close to 1:1.
 *
 * @see https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
 */
export class AnthropicLlmProvider implements LlmProvider {
  // Widened (not literal) types so subclasses (e.g. OpenCode Zen's Claude lane) can override the
  // identity, host and auth scheme while reusing the Messages wire mapping.
  readonly id: string = 'anthropic';
  readonly label: string = 'Anthropic (Claude)';
  readonly apiKeySecretId: string = 'ai-provider:anthropic:api-key';
  readonly apiKeyHelpUrl: string = 'https://console.anthropic.com/settings/keys';
  readonly defaultBaseUrl: string = DEFAULT_BASE_URL;

  readonly models: readonly LlmModel[] = [
    {
      id: 'claude-opus-4-8',
      label: 'Claude Opus 4.8',
      description: 'Most capable — best for hard, multi-step edits.',
      capabilities: {
        supportsTools: true,
        supportsImages: true,
        supportsSystemPrompt: true,
        maxOutputTokens: 16000,
        contextWindow: 200_000,
        reasoningEfforts: CLAUDE_REASONING_EFFORTS,
      },
      pricing: { inputPer1M: 5, outputPer1M: 25 },
    },
    {
      id: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      description: 'Balanced speed and quality.',
      capabilities: {
        supportsTools: true,
        supportsImages: true,
        supportsSystemPrompt: true,
        maxOutputTokens: 16000,
        contextWindow: 200_000,
        reasoningEfforts: CLAUDE_REASONING_EFFORTS,
      },
      pricing: { inputPer1M: 3, outputPer1M: 15 },
    },
    {
      id: 'claude-haiku-4-5',
      label: 'Claude Haiku 4.5',
      description: 'Fastest, cheapest.',
      capabilities: {
        supportsTools: true,
        supportsImages: true,
        supportsSystemPrompt: true,
        maxOutputTokens: 8192,
        contextWindow: 200_000,
      },
      pricing: { inputPer1M: 1, outputPer1M: 5 },
    },
  ];

  getModel(modelId: string): LlmModel | undefined {
    return this.models.find(model => model.id === modelId);
  }

  /** User-facing message when an empty key is rejected. */
  protected readonly missingKeyMessage: string = 'No Anthropic API key configured.';

  /**
   * Request headers. Native Anthropic wants the key as `x-api-key` plus the browser-access opt-in;
   * gateways that proxy the Messages API (OpenCode Zen) override this with a plain Bearer header.
   */
  protected buildHeaders(ctx: LlmRequestContext): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': ctx.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }

  async chat(params: ChatParams, ctx: LlmRequestContext): Promise<LlmResult> {
    if (!ctx.apiKey) {
      throw new LlmError('missing-key', this.missingKeyMessage);
    }
    if (!ctx.modelId) {
      throw new LlmError('unknown', 'No Anthropic model selected.');
    }

    const fetchImpl = ctx.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const baseUrl = (ctx.baseUrl ?? this.defaultBaseUrl).replace(/\/$/, '');
    const body = this.buildBody(params, ctx.modelId);

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/messages`, {
        method: 'POST',
        headers: this.buildHeaders(ctx),
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new LlmError('aborted', 'The request was cancelled.');
      }
      throw new LlmError('network', 'Network error contacting the Anthropic API.', undefined, {
        cause: error,
      });
    }

    const payload = await readJson(response);

    if (!response.ok) {
      throw new LlmError(
        'http',
        extractErrorMessage(payload) ?? describeStatus(response.status),
        response.status
      );
    }

    return parseResponse(payload);
  }

  private buildBody(params: ChatParams, modelId: string): Record<string, unknown> {
    const model = this.getModel(modelId);
    const maxTokens = params.maxTokens ?? model?.capabilities.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
    const cache = params.cache;
    const body: Record<string, unknown> = {
      model: modelId,
      max_tokens: maxTokens,
      messages: toAnthropicMessages(params.messages, cache?.conversation ?? false),
    };
    if (params.system) {
      // Only split/mark the prompt when caching is requested — a one-off call keeps the plain
      // string (a cache write it never reads back would just cost the 1.25× write premium).
      body.system = cache
        ? buildSystemBlocks(params.system, cache.systemStableChars)
        : params.system;
    }
    if (params.tools && params.tools.length > 0) {
      const lastIndex = params.tools.length - 1;
      body.tools = params.tools.map((tool, index) => {
        const spec: Record<string, unknown> = {
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        };
        // A `cache_control` breakpoint on the LAST tool caches the whole (request-stable) tool
        // list as one prefix — the single biggest static chunk of an agent request.
        if (cache && index === lastIndex) {
          spec.cache_control = EPHEMERAL;
        }
        return spec;
      });
    }
    if (params.reasoningEffort) {
      // Adaptive-thinking depth control on modern Claude models. `high` is the API default, so we
      // still send it explicitly for a stable, self-documenting request. Emitting effort alone (no
      // `thinking` block) needs no thinking-block round-trip on the next tool turn — the model
      // decides when to think, and any thinking is summarised, not returned as replayable blocks.
      body.output_config = { effort: params.reasoningEffort };
    }
    return body;
  }
}

/** Anthropic's ephemeral (5-minute) cache marker; shared by reference — it is serialized, not mutated. */
const EPHEMERAL = { type: 'ephemeral' } as const;

const toAnthropicMessages = (
  messages: readonly LlmMessage[],
  cacheConversation: boolean
): Array<Record<string, unknown>> => {
  const mapped = messages.map(toAnthropicMessage);
  // Cache the conversation prefix: a breakpoint on the last block of the last message makes
  // Anthropic serve the longest matching message prefix from cache, so each agentic-loop iteration
  // re-reads the prior turns cheaply instead of re-billing the whole growing history.
  if (cacheConversation && mapped.length > 0) {
    const lastContent = mapped[mapped.length - 1].content;
    if (Array.isArray(lastContent) && lastContent.length > 0) {
      (lastContent[lastContent.length - 1] as Record<string, unknown>).cache_control = EPHEMERAL;
    }
  }
  return mapped;
};

/**
 * Build the Anthropic `system` field with a cache breakpoint. The prompt is split into a cached head
 * (the first `stableChars` characters — rules + project instructions, byte-identical across
 * requests) and an uncached tail (live scene context). A hit requires the head to match exactly.
 */
const buildSystemBlocks = (
  system: string,
  stableChars: number | undefined
): Array<Record<string, unknown>> => {
  if (stableChars === undefined || stableChars >= system.length) {
    return [{ type: 'text', text: system, cache_control: EPHEMERAL }];
  }
  if (stableChars <= 0) {
    return [{ type: 'text', text: system }];
  }
  return [
    { type: 'text', text: system.slice(0, stableChars), cache_control: EPHEMERAL },
    { type: 'text', text: system.slice(stableChars) },
  ];
};

const toAnthropicMessage = (message: LlmMessage): Record<string, unknown> => ({
  role: message.role,
  content: toBlocks(message.content).map(toAnthropicBlock),
});

const toAnthropicBlock = (block: LlmContentBlock): Record<string, unknown> => {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: block.mimeType, data: block.data },
      };
    case 'tool-use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} };
    case 'tool-result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        ...(block.isError ? { is_error: true } : {}),
      };
  }
};

const parseResponse = (payload: unknown): LlmResult => {
  if (!isRecord(payload) || !Array.isArray(payload.content)) {
    throw new LlmError('unknown', 'Malformed Anthropic response (no content array).');
  }

  const content: LlmContentBlock[] = [];
  for (const block of payload.content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      content.push({ type: 'text', text: block.text });
    } else if (
      block.type === 'tool_use' &&
      typeof block.id === 'string' &&
      typeof block.name === 'string'
    ) {
      content.push({ type: 'tool-use', id: block.id, name: block.name, input: block.input ?? {} });
    }
  }

  const stopReason = mapStopReason(
    typeof payload.stop_reason === 'string' ? payload.stop_reason : ''
  );

  if (stopReason === 'blocked') {
    throw new LlmError('blocked', describeRefusal(payload));
  }

  return { content, stopReason, usage: extractUsage(payload), raw: payload };
};

const readJson = async (response: Response): Promise<unknown> => {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (isAbortError(error)) {
      throw new LlmError('aborted', 'The request was cancelled.');
    }
    throw new LlmError('network', 'Network error reading the Anthropic response.', undefined, {
      cause: error,
    });
  }
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { rawText: text };
  }
};

const mapStopReason = (stopReason: string): LlmStopReason => {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'blocked';
    default:
      return 'unknown';
  }
};

const extractUsage = (payload: unknown): LlmUsage | undefined => {
  if (!isRecord(payload) || !isRecord(payload.usage)) return undefined;
  const usage = payload.usage;
  const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheCreation = num(usage.cache_creation_input_tokens);
  // Anthropic's `input_tokens` counts only the fresh (non-cached) prompt; the cached portions are
  // reported separately. Sum them so `inputTokens` stays the full, cache-inclusive context size.
  return {
    inputTokens:
      typeof usage.input_tokens === 'number'
        ? usage.input_tokens + cacheRead + cacheCreation
        : undefined,
    outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
    cacheReadTokens: typeof usage.cache_read_input_tokens === 'number' ? cacheRead : undefined,
    cacheCreationTokens:
      typeof usage.cache_creation_input_tokens === 'number' ? cacheCreation : undefined,
  };
};

const extractErrorMessage = (payload: unknown): string | null => {
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string') {
    return payload.error.message;
  }
  return null;
};

const describeStatus = (status: number): string => {
  switch (status) {
    case 400:
      return 'Bad request to the Anthropic API. Check the model id and parameters.';
    case 401:
    case 403:
      return 'Your Anthropic API key was rejected. Re-check the key or its permissions.';
    case 429:
      return 'Rate limit or quota reached. Check your Anthropic billing, then retry.';
    default:
      return `Anthropic API error (HTTP ${status}).`;
  }
};

const describeRefusal = (payload: unknown): string => {
  if (isRecord(payload) && isRecord(payload.stop_details)) {
    const details = payload.stop_details;
    if (typeof details.explanation === 'string' && details.explanation.trim()) {
      return `The model declined this request: ${details.explanation.trim()}`;
    }
  }
  return 'The model declined this request (safety refusal).';
};
