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
} from './LlmTypes';

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 8192;

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
  readonly id = 'anthropic';
  readonly label = 'Anthropic (Claude)';
  readonly apiKeySecretId = 'ai-provider:anthropic:api-key';
  readonly apiKeyHelpUrl = 'https://console.anthropic.com/settings/keys';

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
      },
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
      },
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
      },
    },
  ];

  getModel(modelId: string): LlmModel | undefined {
    return this.models.find(model => model.id === modelId);
  }

  async chat(params: ChatParams, ctx: LlmRequestContext): Promise<LlmResult> {
    if (!ctx.apiKey) {
      throw new LlmError('missing-key', 'No Anthropic API key configured.');
    }
    if (!ctx.modelId) {
      throw new LlmError('unknown', 'No Anthropic model selected.');
    }

    const fetchImpl = ctx.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const baseUrl = (ctx.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    const body = this.buildBody(params, ctx.modelId);

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ctx.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
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
    const body: Record<string, unknown> = {
      model: modelId,
      max_tokens: maxTokens,
      messages: params.messages.map(toAnthropicMessage),
    };
    if (params.system) {
      body.system = params.system;
    }
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }
    return body;
  }
}

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
  return {
    inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
    outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
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
