import {
  LlmError,
  isAbortError,
  isRecord,
  toBlocks,
  type ChatParams,
  type LlmContentBlock,
  type LlmListModelsContext,
  type LlmMessage,
  type LlmModel,
  type LlmProvider,
  type LlmRequestContext,
  type LlmResult,
  type LlmStopReason,
  type LlmUsage,
} from './LlmTypes';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MAX_TOKENS = 4096;

/**
 * OpenAI-compatible Chat Completions provider (`POST {base}/chat/completions`, `Authorization:
 * Bearer`). A single configurable base URL covers hosted OpenAI plus local runtimes that speak the
 * same API — Ollama (`OLLAMA_ORIGINS`) and LM Studio — so `baseUrl` comes from prefs and the model
 * list here is only a hint; any `modelId` (including local model names) is passed straight through.
 *
 * Tool-use mapping is the awkward one: OpenAI splits a tool call and its result across two message
 * roles. An assistant turn carries `tool_calls` (`function.arguments` is a JSON **string**), and each
 * result is its **own** `{role: "tool", tool_call_id}` message. So our unified messages are flattened
 * — a user turn's `tool-result` blocks become separate `tool` messages emitted before the turn's
 * text/image content.
 *
 * @see https://platform.openai.com/docs/api-reference/chat
 */
export class OpenAICompatLlmProvider implements LlmProvider {
  // Widened (not literal) types so subclasses like CerebrasLlmProvider can override the identity/host.
  readonly id: string = 'openai-compat';
  readonly label: string = 'OpenAI-compatible (OpenAI / Ollama / LM Studio)';
  readonly apiKeySecretId: string = 'ai-provider:openai-compat:api-key';
  readonly apiKeyHelpUrl: string = 'https://platform.openai.com/api-keys';
  readonly requiresBaseUrl: boolean = true;
  readonly defaultBaseUrl: string = DEFAULT_BASE_URL;

  readonly models: readonly LlmModel[] = [
    {
      id: 'gpt-4.1',
      label: 'GPT-4.1 (OpenAI)',
      description: 'Hosted OpenAI default.',
      capabilities: {
        supportsTools: true,
        supportsImages: true,
        supportsSystemPrompt: true,
        maxOutputTokens: 8192,
      },
    },
    {
      id: 'gpt-4.1-mini',
      label: 'GPT-4.1 mini (OpenAI)',
      description: 'Cheaper OpenAI lane.',
      capabilities: {
        supportsTools: true,
        supportsImages: true,
        supportsSystemPrompt: true,
        maxOutputTokens: 8192,
      },
    },
    {
      id: 'llama3.1',
      label: 'Local model (Ollama / LM Studio)',
      description: 'Placeholder — type your local model id in settings.',
      capabilities: {
        supportsTools: true,
        supportsImages: false,
        supportsSystemPrompt: true,
        maxOutputTokens: 4096,
      },
    },
  ];

  getModel(modelId: string): LlmModel | undefined {
    return this.models.find(model => model.id === modelId);
  }

  /**
   * Live model listing via the standard discovery endpoint (`GET {base}/models`, `{data: [{id}]}`).
   * Works for hosted OpenAI, Cerebras, OpenCode Zen and local Ollama / LM Studio — so a local
   * endpoint's actually-installed models show up in the picker instead of a hand-typed id. Ids that
   * match a static catalog entry keep its capability hints; unknown ids get safe defaults.
   */
  async listModels(ctx: LlmListModelsContext): Promise<LlmModel[]> {
    const baseUrl = (ctx.baseUrl ?? this.defaultBaseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    const fetchImpl = ctx.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const headers: Record<string, string> = {};
    if (ctx.apiKey) {
      headers.Authorization = `Bearer ${ctx.apiKey}`;
    }

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/models`, {
        method: 'GET',
        headers,
        signal: ctx.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new LlmError('aborted', 'The request was cancelled.');
      }
      throw new LlmError('network', 'Network error fetching the model list.', undefined, {
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

    const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
    const models: LlmModel[] = [];
    for (const item of data) {
      if (!isRecord(item) || typeof item.id !== 'string' || !item.id) continue;
      models.push(
        this.getModel(item.id) ?? {
          id: item.id,
          label: item.id,
          capabilities: {
            supportsTools: true,
            supportsImages: false,
            supportsSystemPrompt: true,
            maxOutputTokens: DEFAULT_MAX_TOKENS,
          },
        }
      );
    }
    if (models.length === 0) {
      throw new LlmError('unknown', 'The endpoint returned no models.');
    }
    return models.sort((a, b) => a.label.localeCompare(b.label));
  }

  /**
   * Whether an empty API key should be rejected before hitting the endpoint. A locally-hosted
   * endpoint (Ollama / LM Studio) needs no key, so the hosted OpenAI default is the only host that
   * requires one here. Subclasses that target an always-keyed host (e.g. Cerebras) override this.
   */
  protected requiresApiKey(baseUrl: string): boolean {
    return baseUrl === DEFAULT_BASE_URL;
  }

  /** User-facing message when {@link requiresApiKey} rejects a missing key. */
  protected readonly missingKeyMessage: string = 'No OpenAI API key configured.';

  async chat(params: ChatParams, ctx: LlmRequestContext): Promise<LlmResult> {
    // A locally-hosted endpoint may not require a key; only reject an empty key when the target host
    // requires one (see requiresApiKey).
    const baseUrl = (ctx.baseUrl ?? this.defaultBaseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    if (!ctx.apiKey && this.requiresApiKey(baseUrl)) {
      throw new LlmError('missing-key', this.missingKeyMessage);
    }
    if (!ctx.modelId) {
      throw new LlmError('unknown', 'No model selected.');
    }

    const fetchImpl = ctx.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const body = this.buildBody(params, ctx.modelId);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (ctx.apiKey) {
      headers.Authorization = `Bearer ${ctx.apiKey}`;
    }

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new LlmError('aborted', 'The request was cancelled.');
      }
      throw new LlmError(
        'network',
        'Network error contacting the endpoint. For local models (Ollama / LM Studio), enable CORS (e.g. set OLLAMA_ORIGINS) and check the base URL.',
        undefined,
        { cause: error }
      );
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
    const messages: Record<string, unknown>[] = [];
    if (params.system) {
      messages.push({ role: 'system', content: params.system });
    }
    for (const message of params.messages) {
      messages.push(...toOpenAIMessages(message));
    }

    const body: Record<string, unknown> = {
      model: modelId,
      // Prefer the model's advertised output budget over the flat default (dynamic-catalog models
      // are not in the static list; callers pass their budget via params.maxTokens).
      max_tokens:
        params.maxTokens ??
        this.getModel(modelId)?.capabilities.maxOutputTokens ??
        DEFAULT_MAX_TOKENS,
      messages,
    };

    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    }

    return body;
  }
}

/**
 * Flatten one unified message into one or more OpenAI messages. Tool results become standalone
 * `role: "tool"` messages (emitted first, so they follow the prior assistant's `tool_calls`), then
 * any text/image content becomes a single user/assistant message.
 */
const toOpenAIMessages = (message: LlmMessage): Record<string, unknown>[] => {
  const blocks = toBlocks(message.content);
  const out: Record<string, unknown>[] = [];

  for (const block of blocks) {
    if (block.type === 'tool-result') {
      out.push({
        role: 'tool',
        tool_call_id: block.toolUseId,
        content: block.isError ? `ERROR: ${block.content}` : block.content,
      });
    }
  }

  const toolUses = blocks.filter(
    (b): b is Extract<LlmContentBlock, { type: 'tool-use' }> => b.type === 'tool-use'
  );
  const contentBlocks = blocks.filter(b => b.type === 'text' || b.type === 'image');

  if (message.role === 'assistant') {
    if (toolUses.length > 0 || contentBlocks.length > 0) {
      const assistant: Record<string, unknown> = { role: 'assistant' };
      assistant.content = contentBlocks.length > 0 ? textContent(contentBlocks) : '';
      if (toolUses.length > 0) {
        assistant.tool_calls = toolUses.map(block => ({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        }));
      }
      out.push(assistant);
    }
    return out;
  }

  // user role
  if (contentBlocks.length > 0) {
    out.push({ role: 'user', content: toUserContent(contentBlocks) });
  }
  return out;
};

/** Collapse text-only content to a plain string; otherwise return the multi-part array. */
const toUserContent = (blocks: readonly LlmContentBlock[]): unknown => {
  if (blocks.every(b => b.type === 'text')) {
    return textContent(blocks);
  }
  return blocks.map(block => {
    if (block.type === 'image') {
      return {
        type: 'image_url',
        image_url: { url: `data:${block.mimeType};base64,${block.data}` },
      };
    }
    return { type: 'text', text: block.type === 'text' ? block.text : '' };
  });
};

const textContent = (blocks: readonly LlmContentBlock[]): string =>
  blocks
    .filter((b): b is Extract<LlmContentBlock, { type: 'text' }> => b.type === 'text')
    .map(b => b.text)
    .join('\n');

const parseResponse = (payload: unknown): LlmResult => {
  const choice =
    isRecord(payload) && Array.isArray(payload.choices) && isRecord(payload.choices[0])
      ? payload.choices[0]
      : null;
  const messageObj = choice && isRecord(choice.message) ? choice.message : null;
  if (!messageObj) {
    throw new LlmError('unknown', 'Malformed response (no choices/message).');
  }

  const content: LlmContentBlock[] = [];
  if (typeof messageObj.content === 'string' && messageObj.content.length > 0) {
    content.push({ type: 'text', text: messageObj.content });
  }

  if (Array.isArray(messageObj.tool_calls)) {
    for (const call of messageObj.tool_calls) {
      if (!isRecord(call) || !isRecord(call.function)) continue;
      const fn = call.function;
      if (typeof fn.name !== 'string') continue;
      content.push({
        type: 'tool-use',
        id: typeof call.id === 'string' ? call.id : `call-${content.length}`,
        name: fn.name,
        input: parseArguments(fn.arguments),
      });
    }
  }

  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : '';

  return {
    content,
    stopReason: mapStopReason(
      finishReason,
      content.some(b => b.type === 'tool-use')
    ),
    usage: extractUsage(payload),
    raw: payload,
  };
};

const parseArguments = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return isRecord(raw) ? raw : {};
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { _raw: raw };
  }
};

const readJson = async (response: Response): Promise<unknown> => {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (isAbortError(error)) {
      throw new LlmError('aborted', 'The request was cancelled.');
    }
    throw new LlmError('network', 'Network error reading the response.', undefined, {
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

const mapStopReason = (finishReason: string, hasToolUse: boolean): LlmStopReason => {
  if (hasToolUse || finishReason === 'tool_calls') return 'tool_use';
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'blocked';
    default:
      return 'end_turn';
  }
};

const extractUsage = (payload: unknown): LlmUsage | undefined => {
  if (!isRecord(payload) || !isRecord(payload.usage)) return undefined;
  const usage = payload.usage;
  return {
    inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
    outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
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
      return 'Bad request. Check the model id and parameters.';
    case 401:
    case 403:
      return 'The API key was rejected. Re-check the key or its permissions.';
    case 404:
      return 'Endpoint or model not found. Check the base URL and model id.';
    case 429:
      return 'Rate limit or quota reached. Wait a moment and retry.';
    default:
      return `API error (HTTP ${status}).`;
  }
};
