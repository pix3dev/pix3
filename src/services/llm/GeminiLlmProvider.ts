import {
  LlmError,
  collectToolNames,
  isAbortError,
  isRecord,
  toBlocks,
  type ChatParams,
  type LlmContentBlock,
  type LlmModel,
  type LlmProvider,
  type LlmRequestContext,
  type LlmResult,
  type LlmStopReason,
  type LlmUsage,
} from './LlmTypes';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Google Gemini chat via the `generateContent` endpoint (`POST /v1beta/models/{model}:generateContent`,
 * header `x-goog-api-key`). The key-auth endpoint allows browser CORS — the same access the Asset
 * Generator's {@link import('../image-gen/GeminiImageProvider').GeminiImageProvider} relies on.
 *
 * Tool-use mapping is the delicate part. Gemini expresses tool calls as `functionCall` parts and
 * results as `functionResponse` parts, and it matches them **by function name, not by id** — there
 * are no call ids on the wire. So we synthesise stable ids for the tool-use blocks we return
 * (`gemini-tool-<n>`) and, when serialising a tool-result back, resolve its function name from the
 * originating tool-use block (via `toolName` or a conversation-wide lookup).
 *
 * @see https://ai.google.dev/gemini-api/docs/function-calling
 */
export class GeminiLlmProvider implements LlmProvider {
  readonly id = 'gemini';
  readonly label = 'Google Gemini';
  readonly apiKeySecretId = 'ai-provider:gemini:api-key';
  readonly apiKeyHelpUrl = 'https://aistudio.google.com/apikey';

  readonly models: readonly LlmModel[] = [
    {
      id: 'gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
      description: 'Fast, reliable default.',
      capabilities: {
        supportsTools: true,
        supportsImages: true,
        supportsSystemPrompt: true,
        maxOutputTokens: 8192,
      },
    },
    {
      id: 'gemini-2.5-pro',
      label: 'Gemini 2.5 Pro',
      description: 'Higher quality, slower.',
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
      throw new LlmError('missing-key', 'No Gemini API key configured.');
    }
    if (!ctx.modelId) {
      throw new LlmError('unknown', 'No Gemini model selected.');
    }

    const fetchImpl = ctx.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const baseUrl = (ctx.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    const body = this.buildBody(params);
    const url = `${baseUrl}/models/${ctx.modelId}:generateContent`;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.apiKey },
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new LlmError('aborted', 'The request was cancelled.');
      }
      throw new LlmError('network', 'Network error contacting the Gemini API.', undefined, {
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

    return this.parseResponse(payload);
  }

  private buildBody(params: ChatParams): Record<string, unknown> {
    const toolNames = collectToolNames(params.messages);
    const contents = params.messages.map(message => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: toBlocks(message.content).map(block => toGeminiPart(block, toolNames)),
    }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: { maxOutputTokens: params.maxTokens ?? DEFAULT_MAX_TOKENS },
    };

    if (params.system) {
      body.systemInstruction = { parts: [{ text: params.system }] };
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: params.tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
        },
      ];
    }

    return body;
  }

  private parseResponse(payload: unknown): LlmResult {
    const candidate = firstCandidate(payload);
    const parts = candidate && isRecord(candidate.content) ? candidate.content.parts : undefined;
    const content: LlmContentBlock[] = [];
    let toolIndex = 0;

    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (!isRecord(part)) continue;
        if (typeof part.text === 'string' && part.text.length > 0) {
          content.push({ type: 'text', text: part.text });
        }
        const call = part.functionCall ?? part.function_call;
        if (isRecord(call) && typeof call.name === 'string') {
          content.push({
            type: 'tool-use',
            id: `gemini-tool-${toolIndex++}`,
            name: call.name,
            input: isRecord(call.args) ? call.args : {},
          });
        }
      }
    }

    const hasToolUse = content.some(block => block.type === 'tool-use');
    const finishReason =
      candidate && typeof candidate.finishReason === 'string' ? candidate.finishReason : '';

    if (content.length === 0) {
      throw new LlmError('blocked', describeNoContent(payload));
    }

    return {
      content,
      stopReason: mapStopReason(finishReason, hasToolUse),
      usage: extractUsage(payload),
      raw: payload,
    };
  }
}

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
  functionCall?: { name: string; args: unknown };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

const toGeminiPart = (block: LlmContentBlock, toolNames: Map<string, string>): GeminiPart => {
  switch (block.type) {
    case 'text':
      return { text: block.text };
    case 'image':
      return { inline_data: { mime_type: block.mimeType, data: block.data } };
    case 'tool-use':
      return { functionCall: { name: block.name, args: block.input ?? {} } };
    case 'tool-result': {
      const name = block.toolName ?? toolNames.get(block.toolUseId) ?? block.toolUseId;
      return {
        functionResponse: {
          name,
          response: block.isError ? { error: block.content } : { result: block.content },
        },
      };
    }
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
    throw new LlmError('network', 'Network error reading the Gemini response.', undefined, {
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

const firstCandidate = (payload: unknown): Record<string, unknown> | null => {
  if (isRecord(payload) && Array.isArray(payload.candidates) && isRecord(payload.candidates[0])) {
    return payload.candidates[0];
  }
  return null;
};

const mapStopReason = (finishReason: string, hasToolUse: boolean): LlmStopReason => {
  if (hasToolUse) return 'tool_use';
  switch (finishReason) {
    case 'STOP':
      return 'end_turn';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
      return 'blocked';
    default:
      return 'end_turn';
  }
};

const extractUsage = (payload: unknown): LlmUsage | undefined => {
  if (!isRecord(payload) || !isRecord(payload.usageMetadata)) return undefined;
  const meta = payload.usageMetadata;
  return {
    inputTokens: typeof meta.promptTokenCount === 'number' ? meta.promptTokenCount : undefined,
    outputTokens:
      typeof meta.candidatesTokenCount === 'number' ? meta.candidatesTokenCount : undefined,
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
      return 'Bad request to the Gemini API. Check your key and try again.';
    case 403:
      return 'Your API key was rejected. Re-check the key or its permissions.';
    case 429:
      return 'Rate limit reached (free tier). Wait a moment and try again.';
    default:
      return `Gemini API error (HTTP ${status}).`;
  }
};

const describeNoContent = (payload: unknown): string => {
  const candidate = firstCandidate(payload);
  if (candidate && typeof candidate.finishReason === 'string') {
    return `The model returned no content (finish reason: ${candidate.finishReason}).`;
  }
  if (isRecord(payload) && isRecord(payload.promptFeedback)) {
    const feedback = payload.promptFeedback;
    if (typeof feedback.blockReason === 'string') {
      return `The request was blocked by safety filters (${feedback.blockReason}).`;
    }
  }
  return 'The model returned no content.';
};
