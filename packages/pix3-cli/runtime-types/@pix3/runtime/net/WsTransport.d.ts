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
'idle'
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
'client'
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
/**
 * The close code we send when the peer commits a protocol violation. It mirrors the fabric's own
 * 4007 (`BadRequest`), so both ends label the same failure the same way.
 */
export declare const WS_CLOSE_PROTOCOL_VIOLATION = 4007;
/** Normal closure, per RFC 6455. Browsers only allow this and 3000–4999 from script. */
export declare const WS_CLOSE_NORMAL = 1000;
export declare class WsTransport {
    /** The endpoint this transport was built for. */
    readonly url: string;
    private readonly socketFactory;
    private readonly now;
    private readonly random;
    private readonly backoff;
    private readonly shouldReconnect;
    private socket;
    private currentState;
    private retryTimer;
    private attempt;
    private disposed;
    /** True between a local `close()`/`dispose()` and the resulting close event. */
    private closingLocally;
    private lastClose;
    /** Timestamp of the last inbound frame, for the idle detection the session layer needs. */
    private lastFrameAtMs;
    private readonly counters;
    /** Called with every inbound binary frame, `[u8 TypeId][payload …]`, in arrival order. */
    onFrame: ((frame: Uint8Array) => void) | null;
    /** Called on every state transition. `info` is non-null only for the terminal `closed` state. */
    onStateChange: ((state: WsTransportState, info: WsTransportCloseInfo | null) => void) | null;
    constructor(options: WsTransportOptions);
    /** Current lifecycle state. */
    get state(): WsTransportState;
    /** True while frames can actually be sent. */
    get isOpen(): boolean;
    /** How the transport reached `closed`, or `null` while it has not. */
    get closeInfo(): WsTransportCloseInfo | null;
    /** The most recent close, terminal or not — useful while `reconnecting`. */
    get lastCloseInfo(): WsTransportCloseInfo | null;
    /** A snapshot copy of the counters. */
    get stats(): Readonly<WsTransportStats>;
    /** Retries used since the last successful open. */
    get attemptCount(): number;
    /**
     * Milliseconds since the last inbound frame, or `null` when none has arrived on this transport.
     * The session layer uses it to tell "quiet room" from "dead link" before its ping does.
     */
    get msSinceLastFrame(): number | null;
    /**
     * Opens the socket. A no-op when already connecting/open, when a retry is pending, or after
     * `dispose()`. From the terminal `closed` state it starts a fresh attempt series.
     */
    connect(): void;
    /**
     * Sends one frame. Returns `false` — counting a drop — when the socket is not open or the send
     * threw. **Never queues**: a frame that could not go now must not go later.
     */
    send(frame: Uint8Array): boolean;
    /**
     * Closes deliberately and terminally — no reconnect follows. Use it for "leave the room", not for
     * a blip.
     */
    close(code?: number, reason?: string): void;
    /** Stops everything and never reconnects. Idempotent; the instance is spent afterwards. */
    dispose(): void;
    private openSocket;
    private handleOpen;
    private handleMessage;
    private handleError;
    private handleClose;
    private handleUnexpectedClose;
    /**
     * `initial × factor^attempt`, capped, then spread by ±`jitterRatio`. The spread is what stops every
     * client of a restarted room from retrying on the same millisecond.
     */
    private nextDelay;
    private cancelRetry;
    private closeSocket;
    private detachSocket;
    private finish;
    private setState;
}
