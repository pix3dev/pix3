/**
 * Wire types + mapping helpers for the Anthropic Messages-shaped requests that the pix3 editor
 * sends (see pix3's `AnthropicLlmProvider.buildBody`). Everything arrives as untyped JSON, so the
 * shapes here are deliberately loose records with narrow accessor helpers.
 */

export interface WireToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export interface WireMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | WireBlock[];
}

export type WireBlock = Record<string, unknown>;

export interface WireMessagesRequest {
  readonly model: string;
  readonly max_tokens?: number;
  readonly system?: string | WireBlock[];
  readonly messages: WireMessage[];
  readonly tools?: WireToolDefinition[];
}

export interface WireToolResult {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parse + minimally validate a `/v1/messages` body. Throws {@link HttpError} on bad input. */
export const parseMessagesRequest = (raw: unknown): WireMessagesRequest => {
  if (!isRecord(raw)) throw new HttpError(400, 'Request body must be a JSON object.');
  if (typeof raw.model !== 'string' || !raw.model) throw new HttpError(400, 'Missing "model".');
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    throw new HttpError(400, 'Missing "messages".');
  }
  for (const message of raw.messages) {
    if (!isRecord(message) || (message.role !== 'user' && message.role !== 'assistant')) {
      throw new HttpError(400, 'Each message needs a user/assistant role.');
    }
  }
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools)) throw new HttpError(400, '"tools" must be an array.');
    for (const tool of raw.tools) {
      if (!isRecord(tool) || typeof tool.name !== 'string' || typeof tool.description !== 'string') {
        throw new HttpError(400, 'Each tool needs a name and description.');
      }
    }
  }
  return raw as unknown as WireMessagesRequest;
};

/** Flatten the `system` field (string, or Anthropic text blocks) into one plain string. */
export const systemToText = (system: WireMessagesRequest['system']): string => {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map(block => (typeof block.text === 'string' ? block.text : ''))
      .join('');
  }
  return '';
};

export const contentToBlocks = (content: WireMessage['content']): WireBlock[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : content;

/** Extract `tool_result` blocks from a message (pix3 sends result content as a plain string). */
export const extractToolResults = (message: WireMessage): WireToolResult[] => {
  const results: WireToolResult[] = [];
  for (const block of contentToBlocks(message.content)) {
    if (block.type !== 'tool_result') continue;
    const content =
      typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content
              .map(part => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
              .join('\n')
          : '';
    results.push({
      toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
      content,
      isError: block.is_error === true,
    });
  }
  return results;
};

/**
 * Map user-authored blocks (text/image) to Anthropic user content; tool_result blocks are skipped.
 * pix3's `cache_control` breakpoints are stripped — the Claude Code harness manages its own cache
 * breakpoints, and stacking pix3's on top could exceed the API's 4-breakpoint limit.
 */
export const toUserContent = (message: WireMessage): WireBlock[] =>
  contentToBlocks(message.content)
    .filter(block => block.type === 'text' || block.type === 'image')
    .map(block => {
      if ('cache_control' in block) {
        const { cache_control: _dropped, ...rest } = block;
        return rest;
      }
      return block;
    });

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}… [truncated]` : text;

/**
 * Render a pix3 conversation history as a plain-text transcript. Used as a degraded recovery path
 * when no live Claude Code session matches the request (bridge restart, edited history, model
 * switch): the transcript becomes the first user message of a fresh session.
 */
export const renderTranscript = (messages: readonly WireMessage[]): string => {
  const lines: string[] = [];
  for (const message of messages) {
    const speaker = message.role === 'user' ? 'User' : 'Assistant';
    for (const block of contentToBlocks(message.content)) {
      switch (block.type) {
        case 'text':
          if (typeof block.text === 'string' && block.text.trim()) {
            lines.push(`${speaker}: ${clip(block.text, 6000)}`);
          }
          break;
        case 'image':
          lines.push(`${speaker}: [image omitted]`);
          break;
        case 'tool_use':
          lines.push(
            `Assistant called tool ${String(block.name)}(${clip(JSON.stringify(block.input ?? {}), 2000)})`
          );
          break;
        case 'tool_result': {
          const text =
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          lines.push(
            `Tool result${block.is_error === true ? ' (error)' : ''}: ${clip(text, 4000)}`
          );
          break;
        }
        default:
          break;
      }
    }
  }
  return lines.join('\n');
};
