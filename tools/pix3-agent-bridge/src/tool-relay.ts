/**
 * The bridge's tool inversion, in its simplest form.
 *
 * Both lanes work the same way: the model asks for an editor tool through an MCP server the bridge
 * owns, the handler BLOCKS, the HTTP request in flight is answered with `stop_reason: "tool_use"`,
 * and the editor's next POST carries the `tool_result` that unblocks the handler. This file is the
 * parking lot in the middle of that.
 *
 * The Antigravity lane is markedly simpler than the Agent-SDK one, and deliberately does not reuse
 * its matching heuristics. The SDK emits every call TWICE — once as a `tool_use` block in an
 * assistant message and once as an MCP invocation — so `sessions.ts` has to correlate the two by
 * name and arguments (`tryAssignAndFlush`, `orphanResults`, `unparkedBlocks`, `seenToolUseIds`).
 * `agy` emits the MCP call and nothing else, so the call IS the block: the relay mints the
 * `toolu_…` id itself at park time and correlation never arises.
 */

import { randomUUID } from 'node:crypto';

import { Deferred } from './util.ts';
import type { WireBlock, WireToolDefinition, WireToolResult } from './wire.ts';

/** The subset of MCP's `CallToolResult` the bridge produces — text content plus an error flag. */
export interface ToolCallResult {
  readonly content: Array<{ readonly type: 'text'; readonly text: string }>;
  readonly isError?: boolean;
  /** MCP results are open records; the index signature keeps this assignable to its SDK type. */
  readonly [key: string]: unknown;
}

export const toCallToolResult = (result: WireToolResult): ToolCallResult => ({
  content: [{ type: 'text', text: result.content || '(empty result)' }],
  ...(result.isError ? { isError: true } : {}),
});

/** MCP `tools/list` shape for one editor tool, with the schema passed through untouched. */
const toMcpTool = (tool: WireToolDefinition): Record<string, unknown> => ({
  name: tool.name,
  description: tool.description,
  inputSchema:
    typeof tool.input_schema?.type === 'string'
      ? tool.input_schema
      : { type: 'object', ...tool.input_schema },
});

interface ParkedCall {
  readonly toolUseId: string;
  readonly name: string;
  readonly input: unknown;
  readonly deferred: Deferred<ToolCallResult>;
  /** False once the block has been handed to the editor, so it is not sent twice. */
  flushed: boolean;
}

/**
 * Ceiling on parked calls. agy runs one MCP call at a time, so this only bounds a pathological
 * client; it is not a normal working depth.
 */
const MAX_PARKED = 64;

export class ToolRelay {
  private tools: readonly WireToolDefinition[] = [];
  private readonly parked = new Map<string, ParkedCall>();
  /** Called when a new call parks, so the session can flush a waiting HTTP response. */
  private onPark: (() => void) | null = null;

  setTools(tools: readonly WireToolDefinition[] | undefined): void {
    this.tools = tools ?? [];
  }

  getToolNames(): string[] {
    return this.tools.map(tool => tool.name);
  }

  /** Do the tools of an incoming request match the set this relay was built with? */
  toolsMatch(tools: readonly WireToolDefinition[] | undefined): boolean {
    const names = (tools ?? []).map(tool => tool.name);
    const mine = this.getToolNames();
    return names.length === mine.length && names.every(name => mine.includes(name));
  }

  setParkListener(listener: (() => void) | null): void {
    this.onPark = listener;
  }

  /** MCP `tools/list` payload served to the shim. */
  listTools(): { tools: Array<Record<string, unknown>> } {
    return { tools: this.tools.map(toMcpTool) };
  }

  /**
   * MCP `tools/call`: park the call and hand back a promise that settles when the editor answers.
   * An unknown tool fails immediately — the model invented it, and blocking would waste the turn.
   */
  call(name: string, input: unknown): Promise<ToolCallResult> {
    if (!this.tools.some(tool => tool.name === name)) {
      return Promise.resolve({
        content: [
          {
            type: 'text',
            text: `No editor tool named "${name}". Available: ${this.getToolNames().join(', ') || '(none)'}.`,
          },
        ],
        isError: true,
      });
    }
    if (this.parked.size >= MAX_PARKED) {
      return Promise.resolve({
        content: [{ type: 'text', text: 'Too many editor tool calls are already in flight.' }],
        isError: true,
      });
    }
    const toolUseId = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const deferred = new Deferred<ToolCallResult>();
    this.parked.set(toolUseId, { toolUseId, name, input, deferred, flushed: false });
    this.onPark?.();
    return deferred.promise;
  }

  /** True while at least one parked call has not been shown to the editor yet. */
  hasUnflushed(): boolean {
    for (const call of this.parked.values()) if (!call.flushed) return true;
    return false;
  }

  hasPendingToolUse(toolUseId: string): boolean {
    return this.parked.has(toolUseId);
  }

  /** The `tool_use` blocks for every call not yet sent, marking them as sent. */
  takeUnflushedBlocks(): WireBlock[] {
    const blocks: WireBlock[] = [];
    for (const call of this.parked.values()) {
      if (call.flushed) continue;
      call.flushed = true;
      blocks.push({ type: 'tool_use', id: call.toolUseId, name: call.name, input: call.input });
    }
    return blocks;
  }

  /** Hand the editor's results to their parked calls. Returns how many found a home. */
  resolveResults(results: readonly WireToolResult[]): number {
    let matched = 0;
    for (const result of results) {
      const call = this.parked.get(result.toolUseId);
      if (!call) continue;
      this.parked.delete(result.toolUseId);
      call.deferred.resolve(toCallToolResult(result));
      matched += 1;
    }
    return matched;
  }

  /** Fail every parked call — the turn was cancelled or the session is going away. */
  cancelAll(message: string): void {
    for (const call of [...this.parked.values()]) {
      this.parked.delete(call.toolUseId);
      call.deferred.resolve({ content: [{ type: 'text', text: message }], isError: true });
    }
  }
}
