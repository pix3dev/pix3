/**
 * Harness inversion: exposes the stateless Anthropic Messages protocol (which pix3's agent loop
 * speaks) on top of stateful Claude Agent SDK sessions (the sanctioned consumer of a Claude
 * Code / MAX-subscription login).
 *
 * How one pix3 request round-trips:
 *
 *   1. pix3 POSTs `/v1/messages` (system + tools + full history). The manager routes it to a live
 *      session (or starts one). New trailing user message -> pushed into the SDK's streaming input.
 *   2. The SDK calls the model. pix3's tools are registered as an in-process MCP server whose
 *      CallTool handler BLOCKS: when the model requests a tool, the assistant message (with
 *      `tool_use` blocks) is returned as the HTTP response and the handler's promise stays pending.
 *   3. pix3 executes the tool in the editor and POSTs again with `tool_result` blocks. Those
 *      resolve the blocked handlers, the SDK forwards the results to the model, and the next
 *      assistant message answers this HTTP request. A turn with no tool calls ends with the SDK's
 *      `result` message -> `stop_reason: "end_turn"`.
 *
 * The real conversation state lives in the SDK session; pix3's replayed history is used only for
 * routing/correlation. When nothing matches (bridge restart, edited history, model switch) the
 * manager degrades gracefully: it starts a fresh session whose first user message is a plain-text
 * transcript of the history.
 */

import { randomUUID } from 'node:crypto';
import os from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  HttpError,
  extractToolResults,
  isRecord,
  renderTranscript,
  systemToText,
  toUserContent,
} from './wire.ts';
import type { WireBlock, WireMessagesRequest, WireToolDefinition, WireToolResult } from './wire.ts';

const MCP_SERVER_NAME = 'pix3';
const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
/** Hard cap on how long one `/v1/messages` request may wait for the model. */
const RESPONSE_TIMEOUT_MS = 20 * 60 * 1000;
const IDLE_TIMEOUT_MS = 45 * 60 * 1000;
const MAX_SESSIONS = 4;

export type Logger = (line: string) => void;

interface PendingCall {
  readonly name: string;
  readonly input: unknown;
  resolve: (result: CallToolResult) => void;
  /** Anthropic `tool_use` block id this call was matched to (assigned from the assistant message). */
  toolUseId?: string;
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/** Push-based async iterable used as the SDK's streaming input. */
class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.buffer.push(item);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false });
        }
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise(resolve => this.waiters.push(resolve));
      },
    };
  }
}

const toolUseName = (block: WireBlock): string =>
  typeof block.name === 'string' ? block.name : '';

const stripPrefix = (name: string): string =>
  name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;

const sameJson = (a: unknown, b: unknown): boolean => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

const toCallToolResult = (result: WireToolResult): CallToolResult => ({
  content: [{ type: 'text', text: result.content || '(empty result)' }],
  ...(result.isError ? { isError: true } : {}),
});

export interface BridgeResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export class BridgeSession {
  readonly id = randomUUID().slice(0, 8);
  model: string;
  /** Expected `messages.length` of pix3's NEXT request if this chat simply continues. */
  transcriptLen = 0;
  lastActivity = Date.now();
  closed = false;

  private readonly log: Logger;
  private readonly q: Query;
  private readonly input = new AsyncQueue<SDKUserMessage>();
  private readonly toolNames: Set<string>;
  private readonly pending: PendingCall[] = [];
  /** Assistant content blocks accumulated since the last HTTP response. */
  private buffer: WireBlock[] = [];
  private readonly seenToolUseIds = new Set<string>();
  private waiting: Deferred<BridgeResponse> | null = null;
  private waitingTimer: NodeJS.Timeout | null = null;
  private requestLen = 0;
  private lastUsage: Record<string, unknown> | null = null;
  private lastSystem: string;
  private pendingContextRefresh: string | null = null;
  /** Set after an interrupt: the interrupted turn's late `result` must not answer a new request. */
  private discardNextResult = false;

  constructor(request: WireMessagesRequest, log: Logger) {
    this.log = log;
    this.model = request.model;
    this.lastSystem = systemToText(request.system);
    const tools = request.tools ?? [];
    this.toolNames = new Set(tools.map(tool => tool.name));

    this.q = query({
      prompt: this.input,
      options: {
        model: request.model,
        systemPrompt: this.lastSystem || undefined,
        // pix3's tools, exposed verbatim (JSON Schema and all) via an in-process MCP server.
        mcpServers: {
          [MCP_SERVER_NAME]: { type: 'sdk', name: MCP_SERVER_NAME, instance: this.buildMcpServer(tools) },
        },
        strictMcpConfig: true,
        // No built-in tools: the bridge process must never touch the local FS/shell/web on the
        // model's behalf — every capability comes from pix3 and executes inside the editor.
        tools: [],
        allowedTools: tools.map(tool => `${MCP_PREFIX}${tool.name}`),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        persistSession: false,
        cwd: os.tmpdir(),
        includePartialMessages: false,
        stderr: data => {
          const line = data.trim();
          if (line) this.log(`[${this.id}] cli: ${line.slice(0, 400)}`);
        },
      },
    });
    void this.pump();
  }

  get busy(): boolean {
    return this.waiting !== null;
  }

  hasPendingToolUse(toolUseId: string): boolean {
    return this.pending.some(call => call.toolUseId === toolUseId);
  }

  toolsMatch(tools: readonly WireToolDefinition[] | undefined): boolean {
    const names = (tools ?? []).map(tool => tool.name);
    return names.length === this.toolNames.size && names.every(name => this.toolNames.has(name));
  }

  /** Advance the session with one pix3 request and wait for the next assistant boundary. */
  handleRequest(request: WireMessagesRequest, signal: AbortSignal): Promise<BridgeResponse> {
    if (this.closed) throw new HttpError(409, 'Session already closed.');
    if (this.waiting) throw new HttpError(409, 'Session is still processing a previous request.');
    this.lastActivity = Date.now();
    this.trackSystemDrift(request);

    const last = request.messages[request.messages.length - 1];
    const toolResults = extractToolResults(last);
    if (toolResults.length > 0) {
      this.resolveToolResults(toolResults);
    } else {
      this.pushUserMessage(toUserContent(last));
    }
    return this.awaitResponse(request, signal);
  }

  /**
   * Recovery path: no live session matched, so this fresh session is seeded with a plain-text
   * transcript of pix3's history (built by the manager) instead of a real user message.
   */
  handleTranscriptReplay(
    request: WireMessagesRequest,
    transcript: string,
    signal: AbortSignal
  ): Promise<BridgeResponse> {
    this.lastActivity = Date.now();
    this.pushUserMessage([{ type: 'text', text: transcript }]);
    return this.awaitResponse(request, signal);
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.log(`[${this.id}] closing (${reason})`);
    this.cancelPendingCalls('The session was closed.');
    this.failWaiting(new HttpError(500, `Claude Code session closed: ${reason}`));
    this.input.end();
    try {
      this.q.close();
    } catch {
      /* already terminated */
    }
  }

  // -- request plumbing -------------------------------------------------------

  private awaitResponse(
    request: WireMessagesRequest,
    signal: AbortSignal
  ): Promise<BridgeResponse> {
    const waiting = new Deferred<BridgeResponse>();
    this.waiting = waiting;
    this.requestLen = request.messages.length;
    this.waitingTimer = setTimeout(() => {
      if (this.waiting === waiting) {
        this.waiting = null;
        waiting.reject(new HttpError(504, 'Timed out waiting for the model.'));
      }
    }, RESPONSE_TIMEOUT_MS);
    if (signal.aborted) {
      this.onHttpAbort(waiting);
    } else {
      signal.addEventListener('abort', () => this.onHttpAbort(waiting), { once: true });
    }
    // A tool_use flush may already be satisfiable (parallel calls resolved in a prior tick).
    this.tryAssignAndFlush();
    return waiting.promise.finally(() => {
      if (this.waitingTimer) clearTimeout(this.waitingTimer);
      this.waitingTimer = null;
      this.lastActivity = Date.now();
    });
  }

  private pushUserMessage(blocks: WireBlock[]): void {
    const content: WireBlock[] = [];
    if (this.pendingContextRefresh) {
      content.push({
        type: 'text',
        text: `<context-refresh>\nUpdated live editor context (replaces the earlier snapshot):\n${this.pendingContextRefresh}\n</context-refresh>`,
      });
      this.pendingContextRefresh = null;
    }
    content.push(...blocks);
    if (content.length === 0) content.push({ type: 'text', text: '(empty message)' });
    this.input.push({
      type: 'user',
      message: { role: 'user', content: content as never },
      parent_tool_use_id: null,
    });
  }

  private resolveToolResults(results: WireToolResult[]): void {
    for (const result of results) {
      let index = this.pending.findIndex(call => call.toolUseId === result.toolUseId);
      if (index < 0) index = this.pending.findIndex(call => call.toolUseId === undefined);
      if (index < 0) {
        this.log(`[${this.id}] no pending tool call for result ${result.toolUseId} — dropped`);
        continue;
      }
      const [call] = this.pending.splice(index, 1);
      call.resolve(toCallToolResult(result));
    }
  }

  /**
   * pix3 saw the `system` field change between requests (the editor appends live scene context to
   * a stable head). The SDK session's system prompt is fixed, so the drift is injected into the
   * next user message instead.
   */
  private trackSystemDrift(request: WireMessagesRequest): void {
    const system = systemToText(request.system);
    if (system === this.lastSystem) return;
    let common = 0;
    const max = Math.min(system.length, this.lastSystem.length);
    while (common < max && system[common] === this.lastSystem[common]) common += 1;
    // Back up to a line boundary so the injected snippet starts cleanly.
    const lineStart = system.lastIndexOf('\n', common);
    const suffix = system.slice(lineStart >= 0 ? lineStart + 1 : 0);
    this.pendingContextRefresh = suffix.slice(0, 32_000);
    this.lastSystem = system;
  }

  private onHttpAbort(waiting: Deferred<BridgeResponse>): void {
    if (this.waiting !== waiting) return;
    this.log(`[${this.id}] request aborted by client — interrupting`);
    this.waiting = null;
    waiting.reject(new HttpError(499, 'Request cancelled.'));
    this.buffer = [];
    this.discardNextResult = true;
    this.cancelPendingCalls('Cancelled by the user.');
    void this.q.interrupt().catch(() => {});
  }

  private cancelPendingCalls(message: string): void {
    for (const call of this.pending.splice(0)) {
      call.resolve({ content: [{ type: 'text', text: message }], isError: true });
    }
  }

  private failWaiting(error: unknown): void {
    const waiting = this.waiting;
    if (!waiting) return;
    this.waiting = null;
    waiting.reject(error);
  }

  // -- SDK message pump -------------------------------------------------------

  private async pump(): Promise<void> {
    try {
      for await (const message of this.q) {
        if (message.type === 'assistant' && !message.parent_tool_use_id) {
          this.onAssistantMessage(message.message as unknown as Record<string, unknown>);
        } else if (message.type === 'result') {
          this.onResult(message as unknown as Record<string, unknown>);
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'init') {
          this.log(`[${this.id}] Claude Code session ${(message as { session_id?: string }).session_id ?? '?'} (${this.model})`);
        }
      }
      if (!this.closed) this.close('CLI stream ended');
    } catch (error) {
      this.log(`[${this.id}] pump error: ${error instanceof Error ? error.message : String(error)}`);
      if (!this.closed) {
        this.closed = true;
        this.cancelPendingCalls('The session crashed.');
        this.failWaiting(new HttpError(502, `Claude Code error: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  }

  private onAssistantMessage(message: Record<string, unknown>): void {
    const content = Array.isArray(message.content) ? (message.content as WireBlock[]) : [];
    for (const block of content) {
      if (block.type === 'tool_use') {
        const id = typeof block.id === 'string' ? block.id : '';
        if (this.seenToolUseIds.has(id)) continue;
        this.seenToolUseIds.add(id);
      }
      this.buffer.push(block);
    }
    if (isRecord(message.usage)) this.lastUsage = message.usage;
    this.tryAssignAndFlush();
  }

  private onResult(result: Record<string, unknown>): void {
    if (this.discardNextResult) {
      this.discardNextResult = false;
      this.buffer = [];
      return;
    }
    if (result.subtype !== 'success') {
      const errors = Array.isArray(result.errors) ? result.errors.join('; ') : String(result.subtype);
      this.failWaiting(new HttpError(502, `Claude Code stopped: ${errors}`));
      this.buffer = [];
      return;
    }
    if (!this.waiting) {
      this.buffer = [];
      return;
    }
    if (this.buffer.length === 0 && typeof result.result === 'string' && result.result) {
      this.buffer.push({ type: 'text', text: result.result });
    }
    const stop = result.stop_reason === 'max_tokens' || result.stop_reason === 'refusal'
      ? (result.stop_reason as string)
      : 'end_turn';
    this.respond(stop);
  }

  /** Handler for the in-process MCP server: park the call until pix3 posts its tool_result. */
  private onToolCall(name: string, input: unknown): Promise<CallToolResult> {
    this.log(`[${this.id}] tool call: ${name}`);
    return new Promise<CallToolResult>(resolve => {
      this.pending.push({ name, input, resolve });
      this.tryAssignAndFlush();
    });
  }

  /**
   * Match parked MCP calls to the `tool_use` blocks buffered from the assistant message (by name +
   * identical input, falling back to first-with-same-name), then — if an HTTP request is waiting
   * and every buffered pix3 tool_use has its parked call — answer it with `stop_reason: tool_use`.
   */
  private tryAssignAndFlush(): void {
    const toolUseBlocks = this.buffer.filter(
      block => block.type === 'tool_use' && toolUseName(block).startsWith(MCP_PREFIX)
    );
    const assigned = new Set(
      this.pending.map(call => call.toolUseId).filter((id): id is string => id !== undefined)
    );
    for (const call of this.pending) {
      if (call.toolUseId) continue;
      const candidates = toolUseBlocks.filter(
        block =>
          !assigned.has(String(block.id)) && stripPrefix(toolUseName(block)) === call.name
      );
      const match = candidates.find(block => sameJson(block.input ?? {}, call.input)) ?? candidates[0];
      if (match) {
        call.toolUseId = String(match.id);
        assigned.add(call.toolUseId);
      }
    }
    if (!this.waiting || toolUseBlocks.length === 0) return;
    const allParked = toolUseBlocks.every(block =>
      this.pending.some(call => call.toolUseId === String(block.id))
    );
    if (allParked) this.respond('tool_use');
  }

  private respond(stopReason: string): void {
    const waiting = this.waiting;
    if (!waiting) {
      this.buffer = [];
      return;
    }
    const content = this.buffer
      .filter(
        block =>
          block.type === 'text' ||
          (block.type === 'tool_use' && toolUseName(block).startsWith(MCP_PREFIX))
      )
      .map(block =>
        block.type === 'tool_use'
          ? { ...block, name: stripPrefix(toolUseName(block)) }
          : block
      );
    this.buffer = [];
    this.waiting = null;
    this.transcriptLen = this.requestLen + 1;
    waiting.resolve({
      status: 200,
      body: {
        id: `msg_bridge_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content,
        stop_reason: stopReason,
        usage: this.lastUsage ?? {},
      },
    });
  }

  private buildMcpServer(tools: readonly WireToolDefinition[]): McpServer {
    const server = new McpServer(
      { name: MCP_SERVER_NAME, version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: (isRecord(tool.input_schema) && typeof tool.input_schema.type === 'string'
          ? tool.input_schema
          : { type: 'object', ...tool.input_schema }) as { type: 'object' },
        _meta: { 'anthropic/alwaysLoad': true },
      })),
    }));
    server.server.setRequestHandler(CallToolRequestSchema, async request =>
      this.onToolCall(request.params.name, request.params.arguments ?? {})
    );
    return server;
  }
}

export class SessionManager {
  private readonly log: Logger;
  private sessions: BridgeSession[] = [];
  private readonly sweeper: NodeJS.Timeout;

  constructor(log: Logger) {
    this.log = log;
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  async handle(request: WireMessagesRequest, signal: AbortSignal): Promise<BridgeResponse> {
    this.sessions = this.sessions.filter(session => !session.closed);
    const last = request.messages[request.messages.length - 1];
    const toolResults = extractToolResults(last);

    if (toolResults.length > 0) {
      const session = this.sessions.find(candidate =>
        toolResults.every(result => candidate.hasPendingToolUse(result.toolUseId))
      );
      if (session) return session.handleRequest(request, signal);
      this.log('tool results with no live session (bridge restarted?) — replaying transcript');
      return this.replay(request, signal);
    }

    if (request.messages.length > 1) {
      const session = this.sessions.find(
        candidate =>
          !candidate.busy &&
          candidate.transcriptLen === request.messages.length - 1 &&
          candidate.model === request.model &&
          candidate.toolsMatch(request.tools)
      );
      if (session) return session.handleRequest(request, signal);
      this.log(
        `no session matches a ${request.messages.length}-message history (restart/edit/model switch) — replaying transcript`
      );
      return this.replay(request, signal);
    }

    const session = this.create(request);
    this.log(`[${session.id}] new session (${request.model}, ${request.tools?.length ?? 0} tools)`);
    return session.handleRequest(request, signal);
  }

  closeAll(reason: string): void {
    clearInterval(this.sweeper);
    for (const session of this.sessions.splice(0)) session.close(reason);
  }

  private replay(request: WireMessagesRequest, signal: AbortSignal): Promise<BridgeResponse> {
    const session = this.create(request);
    const transcript = [
      'The conversation below already happened in the pix3 editor (the previous bridge session was lost).',
      'Continue it from where it left off — do not re-introduce yourself or redo completed work.',
      '',
      '<conversation-replay>',
      renderTranscript(request.messages),
      '</conversation-replay>',
      '',
      'Respond to the last entry above.',
    ].join('\n');
    this.log(`[${session.id}] replay session (${request.messages.length} messages)`);
    return session.handleTranscriptReplay(request, transcript, signal);
  }

  private create(request: WireMessagesRequest): BridgeSession {
    while (this.sessions.length >= MAX_SESSIONS) {
      const idle = this.sessions.filter(session => !session.busy);
      const victim = (idle.length > 0 ? idle : this.sessions).reduce((a, b) =>
        a.lastActivity <= b.lastActivity ? a : b
      );
      this.sessions = this.sessions.filter(session => session !== victim);
      victim.close('evicted (too many sessions)');
    }
    const session = new BridgeSession(request, this.log);
    this.sessions.push(session);
    return session;
  }

  private sweep(): void {
    const now = Date.now();
    for (const session of [...this.sessions]) {
      if (session.closed || (!session.busy && now - session.lastActivity > IDLE_TIMEOUT_MS)) {
        this.sessions = this.sessions.filter(candidate => candidate !== session);
        if (!session.closed) session.close('idle timeout');
      }
    }
  }
}
