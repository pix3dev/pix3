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

/** One content block of a result: text, or an image as base64 WITHOUT a `data:` prefix. */
export type ToolContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string };

/**
 * Why the relay itself (not the editor) produced a result: the window never answered in time
 * (`timeout`), the call was dropped with the lease or the server (`cancelled`), there was no
 * window to deliver to (`no_editor`), or too many calls were parked (`overloaded`). Absent on every
 * result a window sent.
 */
export type RelayFailure = 'timeout' | 'cancelled' | 'no_editor' | 'overloaded';

/**
 * The subset of MCP's `CallToolResult` this channel carries — text and image content, an error
 * flag, and `_meta` (structured side data for the `pix3 mcp` process, e.g. the revision a running
 * game started from; never shown to the model as such).
 */
export interface ToolCallResult {
  readonly content: ToolContentBlock[];
  readonly isError?: boolean;
  readonly _meta?: Record<string, unknown>;
  /** Set only on results the relay made up itself — see {@link RelayFailure}. */
  readonly relayFailure?: RelayFailure;
  /** MCP results are open records; the index signature keeps this assignable to the SDK type. */
  readonly [key: string]: unknown;
}

/** One call as the editor sees it in a `GET /calls` answer. */
export interface WireCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  /** Extra frame fields for the window (the workspace lane sends `agent` here). */
  readonly extra?: Record<string, unknown>;
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

/** An error result the relay produced itself (see {@link RelayFailure}). */
export const relayFailure = (failure: RelayFailure, text: string): ToolCallResult => ({
  content: [{ type: 'text', text }],
  isError: true,
  relayFailure: failure,
});

/** Every text block of a result, joined with newlines. */
export const resultText = (result: ToolCallResult): string =>
  result.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n');

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Validate a result a window sent back; null when it is not
 * `{ content: [{type:'text',text} | {type:'image',data,mimeType}], isError?, _meta? }`.
 * Anything else a window sends is dropped (a window cannot forge `relayFailure`).
 */
export const parseToolResult = (value: unknown): ToolCallResult | null => {
  if (!isObject(value) || !Array.isArray(value.content)) return null;
  const content: ToolContentBlock[] = [];
  for (const block of value.content) {
    if (!isObject(block)) return null;
    if (block.type === 'text' && typeof block.text === 'string') {
      content.push({ type: 'text', text: block.text });
    } else if (
      block.type === 'image' &&
      typeof block.data === 'string' &&
      typeof block.mimeType === 'string'
    ) {
      content.push({ type: 'image', data: block.data, mimeType: block.mimeType });
    } else {
      return null;
    }
  }
  return {
    content,
    ...(value.isError === true ? { isError: true } : {}),
    ...(isObject(value._meta) ? { _meta: value._meta } : {}),
  };
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
  park(
    name: string,
    input: unknown,
    timeoutMs: number,
    extra?: Record<string, unknown>
  ): Promise<ToolCallResult> {
    if (this.parked.size >= MAX_PARKED) {
      return Promise.resolve(
        relayFailure('overloaded', 'Too many editor calls are already in flight.')
      );
    }
    const id = `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    return new Promise<ToolCallResult>(resolve => {
      const timer = setTimeout(() => {
        if (this.parked.delete(id)) {
          resolve(
            relayFailure(
              'timeout',
              `The Pix3 editor did not answer "${name}" within ${Math.round(timeoutMs / 1000)} s.`
            )
          );
        }
      }, timeoutMs);
      this.parked.set(id, {
        id,
        name,
        input,
        ...(extra ? { extra } : {}),
        resolve,
        timer,
        flushed: false,
      });
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
      calls.push({
        id: call.id,
        name: call.name,
        input: call.input,
        ...(call.extra ? { extra: call.extra } : {}),
      });
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
    for (const call of [...this.parked.values()])
      this.resolve(call.id, relayFailure('cancelled', message));
  }

  get size(): number {
    return this.parked.size;
  }
}
