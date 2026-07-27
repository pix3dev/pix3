/**
 * `WsTransport` — bytes in, bytes out, and nothing else.
 *
 * This layer deliberately knows nothing about TypeIds, handshakes or sequence numbers: it opens a
 * WebSocket, hands every inbound **binary** frame to a callback, sends outbound frames, and
 * reconnects with jittered exponential backoff up to an attempt cap. Everything protocol-shaped
 * lives one level up in `NetworkService`.
 *
 * Two policies are load-bearing and easy to get wrong:
 *
 * - **Never queue while not open.** `send` returns `false` and counts the drop rather than buffering.
 *   A queue that survives a disconnect replays stale positions into a room that has moved on, and the
 *   hot plane is self-healing anyway — every entity update carries absolute values and is re-sent
 *   while dirty.
 * - **A text frame is a protocol violation.** The fabric rejects text with close 4007; a server that
 *   sends us one is broken or is not our server at all, so we count it and close instead of guessing.
 *
 * Nothing here touches `three`, the node tree, or the DOM beyond the `WebSocket` constructor itself
 * (injectable), so the module stays headless-capable.
 */

/** Where the transport is in its lifecycle. */
export type WsTransportState =
  /** Constructed, never asked to connect. */
  | 'idle'
  /** A socket is opening for the first time. */
  | 'connecting'
  /** A socket is open and frames may be sent. */
  | 'open'
  /** The socket dropped; a retry is scheduled or in flight. */
  | 'reconnecting'
  /** Terminal. Nothing will reconnect; only `connect()` on a fresh instance revives it. */
  | 'closed';

/** Why a transport reached the terminal `closed` state. */
export type WsTransportCloseReason =
  /** `close()` or `dispose()` was called locally. */
  | 'client'
  /** The peer closed the socket and the reconnect policy declined to retry. */
  | 'server'
  /** The socket errored or could not be constructed at all. */
  | 'error'
  /** The peer sent a text frame — the fabric's own close 4007 case, applied in reverse. */
  | 'protocol-violation'
  /** The reconnect attempt cap ran out. */
  | 'attempts-exhausted';

/** Everything the layer above needs to turn a close into a real message for a player. */
export interface WsTransportCloseInfo {
  /** The typed reason this transport gave up. */
  readonly reason: WsTransportCloseReason;
  /**
   * The WebSocket close code, or `null` when no close frame was seen (a construction failure, or a
   * socket that errored without closing). Codes 4001–4008 are the fabric's own; see `protocol.md`.
   */
  readonly code: number | null;
  /** The close frame's reason text, or a local description when there was no close frame. */
  readonly message: string;
  /** Whether the close frame was clean. False for an abrupt drop. */
  readonly wasClean: boolean;
}

/**
 * The structural subset of `WebSocket` this transport uses. A real `WebSocket` satisfies it, and a
 * test double can implement it without a network — which is the whole point of
 * {@link WsTransportOptions.socketFactory}.
 */
export interface WsLikeSocket {
  /** Must be `'arraybuffer'`; the transport sets it immediately after construction. */
  binaryType: BinaryType;
  /** `WebSocket.CONNECTING | OPEN | CLOSING | CLOSED`. */
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
}

/** Builds a socket for a URL. Defaults to the global `WebSocket`; injected wholesale by tests. */
export type WsSocketFactory = (url: string) => WsLikeSocket;

/** Reconnect pacing. Every field is injectable so tests never wait on a real clock. */
export interface WsBackoffOptions {
  /** Delay before the first retry, in ms. Default 500. */
  initialDelayMs?: number;
  /** Ceiling for the exponential growth, in ms. Default 15000. */
  maxDelayMs?: number;
  /** Growth factor per attempt. Default 2. */
  factor?: number;
  /**
   * Fraction of the computed delay to spread the retry over, `0…1`. Default 0.25, i.e. ±25%.
   * Without jitter, every client of a room that just restarted retries in lockstep.
   */
  jitterRatio?: number;
  /** How many retries before giving up with `attempts-exhausted`. Default 8. */
  maxAttempts?: number;
}

/** Constructor options. Only `url` is required. */
export interface WsTransportOptions {
  /** `ws://` or `wss://` endpoint. */
  url: string;
  /** Socket constructor. Defaults to the global `WebSocket`. */
  socketFactory?: WsSocketFactory;
  /** Clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Jitter source, `[0, 1)`. Defaults to `Math.random`. */
  random?: () => number;
  /** Reconnect pacing. */
  backoff?: WsBackoffOptions;
  /**
   * Reconnect policy. Called on every unexpected close; returning `false` makes the close terminal.
   * The default retries everything. `NetworkService` supplies a policy that refuses the permanent
   * rejections (bad token, wrong room, version mismatch), because retrying those is just noise.
   */
  shouldReconnect?: (info: WsTransportCloseInfo) => boolean;
}

/** Counters for diagnostics. Cheap to keep, and the only way to see a silently dropping link. */
export interface WsTransportStats {
  /** Frames handed to the socket successfully. */
  framesSent: number;
  /** Binary frames delivered to `onFrame`. */
  framesReceived: number;
  /** Bytes handed to the socket. */
  bytesSent: number;
  /** Bytes delivered to `onFrame`. */
  bytesReceived: number;
  /** `send` calls refused because the socket was not open, plus any that threw. */
  framesDropped: number;
  /** Text frames from the peer. Any value above zero means the session was killed for it. */
  textFramesReceived: number;
  /** Inbound messages whose payload was neither a string nor bytes. Ignored, never fatal. */
  unusableFramesReceived: number;
  /** Reconnect attempts started since the last successful open. */
  reconnectAttempts: number;
  /** Successful opens, including the first. */
  opens: number;
}

const DEFAULT_BACKOFF: Required<WsBackoffOptions> = {
  initialDelayMs: 500,
  maxDelayMs: 15_000,
  factor: 2,
  jitterRatio: 0.25,
  maxAttempts: 8,
};

/**
 * The close code we send when the peer commits a protocol violation. It mirrors the fabric's own
 * 4007 (`BadRequest`), so both ends label the same failure the same way.
 */
export const WS_CLOSE_PROTOCOL_VIOLATION = 4007;

/** Normal closure, per RFC 6455. Browsers only allow this and 3000–4999 from script. */
export const WS_CLOSE_NORMAL = 1000;

function defaultSocketFactory(url: string): WsLikeSocket {
  if (typeof WebSocket === 'undefined') {
    throw new Error(
      'WsTransport: no global WebSocket in this environment. Pass options.socketFactory.'
    );
  }
  return new WebSocket(url);
}

export class WsTransport {
  /** The endpoint this transport was built for. */
  readonly url: string;

  private readonly socketFactory: WsSocketFactory;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly backoff: Required<WsBackoffOptions>;
  private readonly shouldReconnect: (info: WsTransportCloseInfo) => boolean;

  private socket: WsLikeSocket | null = null;
  private currentState: WsTransportState = 'idle';
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private disposed = false;
  /** True between a local `close()`/`dispose()` and the resulting close event. */
  private closingLocally = false;
  private lastClose: WsTransportCloseInfo | null = null;
  /** Timestamp of the last inbound frame, for the idle detection the session layer needs. */
  private lastFrameAtMs = 0;

  private readonly counters: WsTransportStats = {
    framesSent: 0,
    framesReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
    framesDropped: 0,
    textFramesReceived: 0,
    unusableFramesReceived: 0,
    reconnectAttempts: 0,
    opens: 0,
  };

  /** Called with every inbound binary frame, `[u8 TypeId][payload …]`, in arrival order. */
  onFrame: ((frame: Uint8Array) => void) | null = null;

  /** Called on every state transition. `info` is non-null only for the terminal `closed` state. */
  onStateChange: ((state: WsTransportState, info: WsTransportCloseInfo | null) => void) | null =
    null;

  constructor(options: WsTransportOptions) {
    this.url = options.url;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.shouldReconnect = options.shouldReconnect ?? (() => true);
  }

  /** Current lifecycle state. */
  get state(): WsTransportState {
    return this.currentState;
  }

  /** True while frames can actually be sent. */
  get isOpen(): boolean {
    return this.currentState === 'open';
  }

  /** How the transport reached `closed`, or `null` while it has not. */
  get closeInfo(): WsTransportCloseInfo | null {
    return this.currentState === 'closed' ? this.lastClose : null;
  }

  /** The most recent close, terminal or not — useful while `reconnecting`. */
  get lastCloseInfo(): WsTransportCloseInfo | null {
    return this.lastClose;
  }

  /** A snapshot copy of the counters. */
  get stats(): Readonly<WsTransportStats> {
    return { ...this.counters };
  }

  /** Retries used since the last successful open. */
  get attemptCount(): number {
    return this.attempt;
  }

  /**
   * Milliseconds since the last inbound frame, or `null` when none has arrived on this transport.
   * The session layer uses it to tell "quiet room" from "dead link" before its ping does.
   */
  get msSinceLastFrame(): number | null {
    return this.lastFrameAtMs === 0 ? null : Math.max(0, this.now() - this.lastFrameAtMs);
  }

  /**
   * Opens the socket. A no-op when already connecting/open, when a retry is pending, or after
   * `dispose()`. From the terminal `closed` state it starts a fresh attempt series.
   */
  connect(): void {
    if (this.disposed) {
      return;
    }
    if (this.currentState === 'connecting' || this.currentState === 'open') {
      return;
    }
    if (this.retryTimer !== null) {
      return;
    }
    this.attempt = 0;
    this.openSocket('connecting');
  }

  /**
   * Sends one frame. Returns `false` — counting a drop — when the socket is not open or the send
   * threw. **Never queues**: a frame that could not go now must not go later.
   */
  send(frame: Uint8Array): boolean {
    const socket = this.socket;
    if (this.disposed || this.currentState !== 'open' || !socket) {
      this.counters.framesDropped += 1;
      return false;
    }

    try {
      socket.send(frame);
    } catch {
      this.counters.framesDropped += 1;
      return false;
    }

    this.counters.framesSent += 1;
    this.counters.bytesSent += frame.byteLength;
    return true;
  }

  /**
   * Closes deliberately and terminally — no reconnect follows. Use it for "leave the room", not for
   * a blip.
   */
  close(code: number = WS_CLOSE_NORMAL, reason = ''): void {
    if (this.currentState === 'closed' || this.disposed) {
      return;
    }
    this.closingLocally = true;
    this.cancelRetry();
    this.closeSocket(code, reason);
    this.finish({ reason: 'client', code, message: reason, wasClean: true });
  }

  /** Stops everything and never reconnects. Idempotent; the instance is spent afterwards. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.closingLocally = true;
    this.cancelRetry();
    this.closeSocket(WS_CLOSE_NORMAL, 'disposed');
    this.disposed = true;
    if (this.currentState !== 'closed') {
      this.finish({ reason: 'client', code: WS_CLOSE_NORMAL, message: 'disposed', wasClean: true });
    }
    this.onFrame = null;
    this.onStateChange = null;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private openSocket(nextState: 'connecting' | 'reconnecting'): void {
    this.closingLocally = false;
    this.setState(nextState);

    let socket: WsLikeSocket;
    try {
      socket = this.socketFactory(this.url);
    } catch (error) {
      // A constructor that throws means a bad URL or no WebSocket implementation at all — retrying
      // that on a timer would just spin, so a construction failure is terminal.
      const message = error instanceof Error ? error.message : String(error);
      this.finish({ reason: 'error', code: null, message, wasClean: false });
      return;
    }

    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => this.handleOpen();
    socket.onmessage = event => this.handleMessage(event);
    socket.onerror = () => this.handleError();
    socket.onclose = event => this.handleClose(event);
  }

  private handleOpen(): void {
    if (this.disposed) {
      return;
    }
    this.attempt = 0;
    this.counters.opens += 1;
    this.setState('open');
  }

  private handleMessage(event: MessageEvent): void {
    if (this.disposed) {
      return;
    }

    const data: unknown = event.data;
    if (typeof data === 'string') {
      // The fabric answers a text frame with close 4007; a server that sends us one is either broken
      // or not our server, and decoding it as bytes would be worse than closing.
      this.counters.textFramesReceived += 1;
      this.closingLocally = true;
      this.cancelRetry();
      this.closeSocket(WS_CLOSE_PROTOCOL_VIOLATION, 'text frame');
      this.finish({
        reason: 'protocol-violation',
        code: WS_CLOSE_PROTOCOL_VIOLATION,
        message: 'The server sent a text frame; this protocol is binary-only.',
        wasClean: false,
      });
      return;
    }

    let frame: Uint8Array;
    if (data instanceof ArrayBuffer) {
      frame = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      frame = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      this.counters.unusableFramesReceived += 1;
      return;
    }

    this.counters.framesReceived += 1;
    this.counters.bytesReceived += frame.byteLength;
    this.lastFrameAtMs = this.now();
    this.onFrame?.(frame);
  }

  private handleError(): void {
    // Browsers fire `error` and then `close`; the close carries the real code, so nothing is decided
    // here. A socket that errors without closing is handled by the retry timer never being armed —
    // which is why the state is left alone rather than forced to `closed`.
  }

  private handleClose(event: CloseEvent): void {
    this.detachSocket();
    if (this.disposed || this.currentState === 'closed') {
      return;
    }

    if (this.closingLocally) {
      this.closingLocally = false;
      return;
    }

    this.handleUnexpectedClose({
      reason: 'server',
      code: typeof event.code === 'number' ? event.code : null,
      message: typeof event.reason === 'string' ? event.reason : '',
      wasClean: Boolean(event.wasClean),
    });
  }

  private handleUnexpectedClose(info: WsTransportCloseInfo): void {
    this.lastClose = info;

    if (!this.shouldReconnect(info)) {
      this.finish(info);
      return;
    }

    if (this.attempt >= this.backoff.maxAttempts) {
      this.finish({ ...info, reason: 'attempts-exhausted' });
      return;
    }

    const delay = this.nextDelay(this.attempt);
    this.attempt += 1;
    this.counters.reconnectAttempts += 1;
    this.setState('reconnecting');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.disposed || this.currentState === 'closed') {
        return;
      }
      this.openSocket('reconnecting');
    }, delay);
  }

  /**
   * `initial × factor^attempt`, capped, then spread by ±`jitterRatio`. The spread is what stops every
   * client of a restarted room from retrying on the same millisecond.
   */
  private nextDelay(attempt: number): number {
    const base = Math.min(
      this.backoff.maxDelayMs,
      this.backoff.initialDelayMs * Math.pow(this.backoff.factor, attempt)
    );
    const spread = base * this.backoff.jitterRatio * (this.random() * 2 - 1);
    return Math.max(0, Math.round(base + spread));
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private closeSocket(code: number, reason: string): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    this.detachSocket();
    try {
      socket.close(code, reason);
    } catch {
      // A socket that refuses to close is already gone; nothing left to do.
    }
  }

  private detachSocket(): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    this.socket = null;
  }

  private finish(info: WsTransportCloseInfo): void {
    this.lastClose = info;
    this.cancelRetry();
    this.setState('closed', info);
  }

  private setState(state: WsTransportState, info: WsTransportCloseInfo | null = null): void {
    if (this.currentState === state && state !== 'closed') {
      return;
    }
    this.currentState = state;
    this.onStateChange?.(state, info);
  }
}
