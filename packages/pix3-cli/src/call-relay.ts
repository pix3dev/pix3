import { randomUUID } from 'node:crypto';

/**
 * Parking lot between the agent's MCP calls and the editor window that holds the lease.
 *
 * Same idea as `tools/pix3-agent-bridge/src/tool-relay.ts` (copied, not imported — the bridge is a
 * separate package with its own cadence): an MCP handler parks a call and blocks on a promise; the
 * leased window picks the call up with `GET /calls` and settles it with `POST /calls/:id`. Unlike
 * the bridge there is no Anthropic wire here — a call is just `{ id, name, input }`.
 *
 * Shared by both loopback servers: the FSA link server delivers calls through its `GET /calls`
 * long-poll, the workspace server (`serve/`) pushes them over the lease holder's WebSocket. The
 * relay itself knows nothing about the transport — a transport listens for parks, takes the
 * undelivered calls, and hands them back with `requeueDelivered()` when its holder goes away.
 */

/** The subset of MCP's `CallToolResult` this channel carries — text content plus an error flag. */
export interface ToolCallResult {
  readonly content: Array<{ readonly type: 'text'; readonly text: string }>;
  readonly isError?: boolean;
  /** MCP results are open records; the index signature keeps this assignable to the SDK type. */
  readonly [key: string]: unknown;
}

/** One call as the editor sees it in a `GET /calls` answer. */
export interface WireCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

interface ParkedCall extends WireCall {
  readonly resolve: (result: ToolCallResult) => void;
  readonly timer: NodeJS.Timeout;
  /** True once handed to a window, so a poll does not deliver it twice. */
  flushed: boolean;
}

export const textResult = (text: string, isError = false): ToolCallResult => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Validate a result a window sent back; null when it is not `{ content: [{type:'text',text}], isError? }`. */
export const parseToolResult = (value: unknown): ToolCallResult | null => {
  if (!isObject(value) || !Array.isArray(value.content)) return null;
  const content: Array<{ type: 'text'; text: string }> = [];
  for (const block of value.content) {
    if (!isObject(block) || block.type !== 'text' || typeof block.text !== 'string') return null;
    content.push({ type: 'text', text: block.text });
  }
  return { content, ...(value.isError === true ? { isError: true } : {}) };
};

/** Ceiling on parked calls; a normal agent has one or two in flight. */
const MAX_PARKED = 64;

export class CallRelay {
  private readonly parked = new Map<string, ParkedCall>();
  private onPark: (() => void) | null = null;

  setParkListener(listener: (() => void) | null): void {
    this.onPark = listener;
  }

  /** Park a call; the promise settles with the window's answer, or an error result on timeout. */
  park(name: string, input: unknown, timeoutMs: number): Promise<ToolCallResult> {
    if (this.parked.size >= MAX_PARKED) {
      return Promise.resolve(textResult('Too many editor calls are already in flight.', true));
    }
    const id = `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    return new Promise<ToolCallResult>(resolve => {
      const timer = setTimeout(() => {
        if (this.parked.delete(id)) {
          resolve(
            textResult(
              `The Pix3 editor did not answer "${name}" within ${Math.round(timeoutMs / 1000)} s.`,
              true
            )
          );
        }
      }, timeoutMs);
      this.parked.set(id, { id, name, input, resolve, timer, flushed: false });
      this.onPark?.();
    });
  }

  hasUnflushed(): boolean {
    for (const call of this.parked.values()) if (!call.flushed) return true;
    return false;
  }

  /** Every call not yet delivered, marking them delivered. */
  takeUnflushed(): WireCall[] {
    const calls: WireCall[] = [];
    for (const call of this.parked.values()) {
      if (call.flushed) continue;
      call.flushed = true;
      calls.push({ id: call.id, name: call.name, input: call.input });
    }
    return calls;
  }

  /**
   * The window that received these calls is gone (lease expired or taken over): make them
   * deliverable again, so the next holder answers them instead of the agent timing out.
   */
  requeueDelivered(): void {
    for (const call of this.parked.values()) call.flushed = false;
  }

  /** Settle one parked call. False when the id is unknown (already answered or timed out). */
  resolve(id: string, result: ToolCallResult): boolean {
    const call = this.parked.get(id);
    if (!call) return false;
    this.parked.delete(id);
    clearTimeout(call.timer);
    call.resolve(result);
    return true;
  }

  cancelAll(message: string): void {
    for (const call of [...this.parked.values()]) this.resolve(call.id, textResult(message, true));
  }

  get size(): number {
    return this.parked.size;
  }
}
