/**
 * `NetworkService` — one multiplayer session: join/leave, the entity registry, signals, room vars,
 * and the send pump.
 *
 * **Ownership (plan decision D5).** The session is owned by the *host* of a `SceneRunner`, not by the
 * scene: it is constructed at the three bootstraps and handed to `SceneService`, so it survives
 * `changeScene` and a script reaches it as `this.scene.network`. The pump is a `setInterval`, never
 * rAF — `pause()` cancels rAF outright and a backgrounded phone must not silently drop out of a room.
 *
 * **Offline-safe by construction.** Every accessor has a sane default and every method is a harmless
 * no-op before `connect()`. A single-player game touching `this.scene.network` must never throw and
 * must never need a guard at the call site.
 *
 * **Scope.** This is Phase 1.2. It owns the *data*: `netId → record`, the slot table, peers, room
 * vars, signals. Binding entities to scene nodes — `core:NetworkedNode`, `core:ReplicatedTransform`,
 * spawn/despawn, interpolation — is Phase 1.3 and deliberately absent here. Nothing in this module
 * imports `three` or a node class.
 *
 * The wire contract is `docs/protocol.md` in the pix3-rooms repo; every byte goes through the codec
 * in `./protocol`, which is pinned by golden vectors and must not be re-implemented here.
 */
import {
  applyMaskedState,
  createDeltaPacketSections,
  createEntityWireState,
  createFullRecord,
  createQuantizedPosition,
  createSignalBatchEntry,
  createSignalBatchSections,
  createSnapshotPacketView,
  createUpdateRecord,
  DeltaMask,
  encodeControlMessage,
  ENTITY_UPDATE_PACKET_HEADER_SIZE,
  framePayload,
  frameTypeId,
  isFinalFrame,
  isValidWorld,
  MessageTypeIds,
  netIdSlot,
  ownerUpdateRecordSize,
  patchEntityUpdatePacketCount,
  PROTOCOL_VERSION,
  readDeltaPacket,
  readEnterRecord,
  readNextSignalEntry,
  readNextUpdateRecord,
  readRemovedSlotAt,
  readSignalBatchPacket,
  readSnapshotPacket,
  readSnapshotRecord,
  RejectCode,
  RoomMode,
  SignalTarget,
  tryQuantizeRotation,
  tryQuantizeVelocity,
  UnknownTypeIdTally,
  WorldQuantizer,
  writeEntityUpdatePacketHeader,
  writeOwnerUpdateRecord,
  decodeControlMessage,
  type ControlMessage,
  type EntityWireState,
  type RejectCodeValue,
  type SignalTargetValue,
  type WelcomeEvent,
} from './protocol';
import {
  WsTransport,
  type WsBackoffOptions,
  type WsSocketFactory,
  type WsTransportCloseInfo,
  type WsTransportStats,
  type WsTransportState,
} from './WsTransport';

// ── Session-facing types ─────────────────────────────────────────────────────

/** Where the session is in its lifecycle. `'online'` means a `WelcomeEvent` has been received. */
export type NetworkStatus = 'offline' | 'connecting' | 'online' | 'reconnecting';

/** Credentials and destination for {@link NetworkService.connect}. */
export interface NetworkConnectOptions {
  /** `wss://rooms.pix3.dev/…` — the fabric's WebSocket endpoint. */
  url: string;
  /** Room token minted by pix3-cloud (a JWT, or `dev:<sub>:<roomId>` against an insecure dev room). */
  token: string;
  /** The room to join. Must match the room bound into the token. */
  roomId: string;
  /** Requested display name; the server may sanitise, truncate or replace it. */
  displayName?: string;
  /** Client capability bits. Reserved by the protocol; send 0. */
  capabilities?: number;
}

/** What a successful join learned about the room. Mirrors `WelcomeEvent`. */
export interface NetworkSessionInfo {
  /** Room-unique id for this session, preserved across a successful resume. */
  readonly clientId: number;
  /** The room actually joined. */
  readonly roomId: string;
  /** Room tick rate. */
  readonly tickHz: number;
  /** A `RoomMode` value: 0 relay (client authority), 1 authoritative. */
  readonly mode: number;
  /** The negotiated protocol version both sides speak for the whole session. */
  readonly protocolVersion: number;
  /** Room member cap. */
  readonly maxPlayers: number;
  /** Hard cap on entities this client can be told about at once. */
  readonly maxVisibleEntities: number;
  /** AOI enter radius in world units; exit is 1.25× this. */
  readonly aoiRadius: number;
  /** Current host, or 0 when the room has none. */
  readonly hostClientId: number;
  /** True when this welcome answered a resume rather than a fresh join. */
  readonly resumed: boolean;
  /** World bounds this room quantizes against. */
  readonly world: { readonly originX: number; readonly originY: number; readonly size: number };
}

/** A room member. The local client is included, flagged with {@link NetPeer.isLocal}. */
export interface NetPeer {
  readonly clientId: number;
  readonly displayName: string;
  /** True for this client's own entry. */
  readonly isLocal: boolean;
}

/**
 * One replicated entity, in its **quantized** form — the quantized integers *are* the replicated
 * values, on both sides, including for dirty detection. Dequantize through {@link
 * NetworkService.quantizer} when a game needs world units.
 */
export interface NetEntityRecord extends EntityWireState {
  /** Opaque net id. Never decompose it; use it as a key. */
  netId: number;
}

/** What happened to one entity while a frame was applied. */
export type NetEntityChangeKind = 'enter' | 'update' | 'leave';

/** A single registry change, delivered in batches by {@link NetworkService.onEntitiesChange}. */
export interface NetEntityChange {
  readonly kind: NetEntityChangeKind;
  readonly netId: number;
  /** The record after the change — for `'leave'`, the record as it last was. */
  readonly entity: Readonly<NetEntityRecord>;
  /** For `'update'`, which fields the record carried; 0 otherwise. */
  readonly mask: number;
}

/** The fields {@link NetworkService.publish} accepts. Everything is optional and world-space. */
export interface NetPublishState {
  /** World X. Quantized against the room's bounds. */
  x?: number;
  /** World Y. Quantized against the room's bounds. */
  y?: number;
  /** Rotation in radians. Quantized to 256 steps per turn. */
  rotation?: number;
  /** Linear velocity X in units/second. Off the wire by default — only send it if the game needs it. */
  vx?: number;
  /** Linear velocity Y in units/second. */
  vy?: number;
  /** The entity flags byte: ownership policy in bits 0–1, app bits in 3–7. */
  flags?: number;
  /** Marks this update a discontinuity (respawn, warp) so receivers snap instead of interpolating. */
  teleport?: boolean;
}

/** Where an emitted signal goes. A raw `clientId` means "that peer only". */
export type NetSignalDestination = 'server' | 'peers' | 'aoi' | number;

/** Options for {@link NetworkService.emit}. */
export interface NetEmitOptions {
  /** Routing. Default `'peers'` (every other member). */
  to?: NetSignalDestination;
}

/** A signal payload a game may hand to {@link NetworkService.emit}. */
export type NetSignalPayload = Uint8Array | string | number | boolean | null | object;

/** Receives an inbound signal. `payload` is a view over the receive buffer — copy it if you keep it. */
export type NetSignalHandler = (payload: Uint8Array, senderClientId: number) => void;

/** Counters for the Game tab, the profiler and bug reports. */
export interface NetworkStats {
  /** Frames handed to the session by the transport. */
  framesReceived: number;
  /** Frames whose TypeId this build does not know. Ignored and counted, never fatal. */
  unknownTypeIds: number;
  /** Frames with a known TypeId that failed to decode. A broken peer, not an old one. */
  malformedFrames: number;
  /** Sequence gaps detected on the hot plane. */
  seqGaps: number;
  /** `ResyncCommand`s actually sent. */
  resyncsSent: number;
  /** Resyncs the 2/s quota suppressed. */
  resyncsSuppressed: number;
  /** `EntityUpdatePacket`s the pump sent. */
  entityPacketsSent: number;
  /** Owner update records inside those packets. */
  entityRecordsSent: number;
  /** Update records addressed to a slot this client has no full record for. */
  unknownSlotUpdates: number;
  /** Publishes refused because a value was not finite. */
  nonFiniteRejected: number;
  /** Signals dropped because a handler threw. */
  signalHandlerErrors: number;
}

/** Why a connect attempt failed. */
export type NetworkErrorKind =
  /** The server answered `RejectedEvent`. {@link NetworkConnectError.rejectCode} says why. */
  | 'rejected'
  /** The socket never opened, or dropped before a `WelcomeEvent` arrived. */
  | 'transport'
  /** `dispose()` or `disconnect()` happened while the connect was in flight. */
  | 'cancelled'
  /** The caller passed something unusable. */
  | 'invalid';

/** The typed failure `connect()` rejects with. */
export class NetworkConnectError extends Error {
  /** Which class of failure this is. */
  readonly kind: NetworkErrorKind;
  /** The `RejectCode` value when `kind === 'rejected'`, else `RejectCode.None`. */
  readonly rejectCode: number;
  /** The WebSocket close code when one was seen. */
  readonly closeCode: number | null;

  constructor(
    kind: NetworkErrorKind,
    message: string,
    rejectCode = 0,
    closeCode: number | null = null
  ) {
    super(message);
    this.name = 'NetworkConnectError';
    this.kind = kind;
    this.rejectCode = rejectCode;
    this.closeCode = closeCode;
  }
}

/** The `document`-shaped surface used for hidden-tab preferences. Injectable so `net/` stays headless. */
export interface NetworkVisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/** Construction options. Every one of them exists so a test can drive the session deterministically. */
export interface NetworkServiceOptions {
  /** Outbound entity-update rate in Hz. Default 20 — the pump interval is `1000 / sendRateHz`. */
  sendRateHz?: number;
  /** Heartbeat period in ms. Default 2000. */
  pingIntervalMs?: number;
  /** Clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Socket constructor handed to the transport. Defaults to the global `WebSocket`. */
  socketFactory?: WsSocketFactory;
  /** Reconnect pacing handed to the transport. */
  backoff?: WsBackoffOptions;
  /** Jitter source handed to the transport. */
  random?: () => number;
  /**
   * Hidden-tab source. Defaults to the global `document` when there is one, `null` otherwise; pass
   * `null` explicitly to opt out.
   */
  visibility?: NetworkVisibilitySource | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Quota: `Entity updates — 8 records per EntityUpdatePacket`. A ninth record needs a second packet. */
const MAX_RECORDS_PER_ENTITY_UPDATE_PACKET = 8;

/** Quota: `Resync requests — 2/s per connection`. */
const MAX_RESYNCS_PER_WINDOW = 2;
const RESYNC_WINDOW_MS = 1000;

/** `u16 Seq` wraps mod 2¹⁶. */
const SEQ_MODULO = 0x1_0000;

/** Close codes the fabric uses for failures no retry can fix. */
const PERMANENT_CLOSE_CODES: ReadonlySet<number> = new Set([4001, 4002, 4003, 4007, 4008]);

/** Rejections no retry can fix either — the token, the room or the version is simply wrong. */
const PERMANENT_REJECT_CODES: ReadonlySet<number> = new Set<number>([
  RejectCode.ProtocolVersionMismatch,
  RejectCode.InvalidToken,
  RejectCode.TokenExpired,
  RejectCode.TokenRoomMismatch,
  RejectCode.RoomNotFound,
  RejectCode.RoomFull,
  RejectCode.RoomClosing,
  RejectCode.BadRequest,
  RejectCode.SessionReplaced,
]);

const REJECT_CODE_MESSAGES: ReadonlyMap<number, string> = new Map<number, string>([
  [RejectCode.None, 'No error.'],
  [
    RejectCode.ProtocolVersionMismatch,
    'This build speaks an unsupported protocol version — update the game.',
  ],
  [RejectCode.InvalidToken, 'The room token is missing, malformed or not signed by pix3-cloud.'],
  [RejectCode.TokenExpired, 'The room token has expired — request a new one and rejoin.'],
  [RejectCode.TokenRoomMismatch, 'The room token was minted for a different room.'],
  [RejectCode.RoomNotFound, 'No such room on this server.'],
  [RejectCode.RoomFull, 'The room is full.'],
  [RejectCode.RoomClosing, 'The room is shutting down and is not accepting members.'],
  [RejectCode.RateLimited, 'Rate limit tripped — this client sent too much, too fast.'],
  [RejectCode.PayloadTooLarge, 'A frame exceeded the 4 KiB control-frame limit.'],
  [RejectCode.QuotaExceeded, 'A room or connection quota was exceeded.'],
  [RejectCode.ServerShuttingDown, 'The server is draining and closed the session.'],
  [RejectCode.IdleTimeout, 'The connection was idle for too long.'],
  [RejectCode.BadRequest, 'The server refused a malformed or out-of-order frame.'],
  [
    RejectCode.SessionReplaced,
    'This session was displaced by a newer connection for the same identity.',
  ],
  [RejectCode.EntityLimitReached, 'The room is holding as many entities as it can.'],
  [RejectCode.NotEntityOwner, 'That entity belongs to someone else.'],
  [RejectCode.InternalError, 'The server hit an internal error.'],
  [RejectCode.KindNotAllowed, 'That entity kind is not on the room allowlist.'],
  [RejectCode.SendQueueOverflow, 'The send queue overflowed — this client could not keep up.'],
]);

/**
 * A human-readable line for any `RejectCode`, including one this build has never heard of. An unknown
 * code is a generic failure, never a decoder error — the field is a `ushort` precisely so it survives.
 */
export function describeRejectCode(code: number): string {
  return REJECT_CODE_MESSAGES.get(code) ?? `The server refused the session (code ${code}).`;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Per-owned-entity publish bookkeeping: what was last *sent*, and what is dirty since. */
interface PublishEntry {
  readonly netId: number;
  /** Quantized values already accepted by the transport. */
  readonly sent: EntityWireState;
  /** Quantized values a flush would send. */
  readonly next: EntityWireState;
  /** Mask of fields that changed since the last successful send. */
  mask: number;
  /** False until one record for this entity has actually gone out. */
  hasSent: boolean;
}

// ── Room vars ────────────────────────────────────────────────────────────────

/**
 * Server-owned room variables (`net.vars`). Reads are local and free; a write goes out as
 * `SetRoomVarCommand` and only lands if the room's ACL allows it — a Level-2 decision, so treat
 * `set()` as a request, never as an assignment.
 */
export class NetRoomVars {
  private readonly values = new Map<string, Uint8Array>();

  /** @internal — constructed by {@link NetworkService}. */
  constructor(private readonly send: (key: string, value: Uint8Array) => boolean) {}

  /** Raw bytes, or `undefined` when the room has no such variable. */
  get(key: string): Uint8Array | undefined {
    return this.values.get(key);
  }

  /** The value decoded as UTF-8 text. */
  getText(key: string): string | undefined {
    const raw = this.values.get(key);
    return raw === undefined ? undefined : textDecoder.decode(raw);
  }

  /** The value parsed as JSON, or `undefined` when absent or unparseable. */
  getJson<T>(key: string): T | undefined {
    const text = this.getText(key);
    if (text === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  }

  /** True when the room has this variable. */
  has(key: string): boolean {
    return this.values.has(key);
  }

  /** Every known variable name. */
  keys(): string[] {
    return [...this.values.keys()];
  }

  /** How many variables the room has published. */
  get size(): number {
    return this.values.size;
  }

  /**
   * Asks the server to set a variable. Returns whether the request left this client — never whether
   * the server accepted it; the authoritative answer arrives as a `RoomVarsChangedEvent`.
   */
  set(key: string, value: Uint8Array | string): boolean {
    const bytes = typeof value === 'string' ? textEncoder.encode(value) : value;
    return this.send(key, bytes);
  }

  /** @internal Replaces the whole set (the full set that follows a join or a resume). */
  replaceAll(keys: readonly string[], values: readonly Uint8Array[]): string[] {
    const changed = new Set<string>(this.values.keys());
    this.values.clear();
    for (let i = 0; i < keys.length; i += 1) {
      this.values.set(keys[i], values[i] ?? new Uint8Array(0));
      changed.add(keys[i]);
    }
    return [...changed];
  }

  /** @internal Merges a changed subset. */
  merge(keys: readonly string[], values: readonly Uint8Array[]): string[] {
    for (let i = 0; i < keys.length; i += 1) {
      this.values.set(keys[i], values[i] ?? new Uint8Array(0));
    }
    return [...keys];
  }

  /** @internal Drops everything (a fresh join after a failed resume). */
  clear(): void {
    this.values.clear();
  }
}

// ── The session ──────────────────────────────────────────────────────────────

export class NetworkService {
  private readonly sendIntervalMs: number;
  private readonly pingIntervalMs: number;
  private readonly now: () => number;
  private readonly socketFactory?: WsSocketFactory;
  private readonly backoffOptions?: WsBackoffOptions;
  private readonly random?: () => number;
  private readonly visibility: NetworkVisibilitySource | null;

  private transport: WsTransport | null = null;
  private credentials: Required<NetworkConnectOptions> | null = null;
  private disposed = false;

  private currentStatus: NetworkStatus = 'offline';
  private session: NetworkSessionInfo | null = null;
  private worldQuantizer: WorldQuantizer | null = null;
  private resumeKey: Uint8Array | null = null;
  /** True once any `WelcomeEvent` has been seen on this session — gates resume and reconnect. */
  private hasWelcomed = false;
  private lastRejectCode: number | null = null;

  private rttMs = 0;
  private clockOffsetMs = 0;
  private lastPingSentAtMs = 0;
  private lastPingClientTimeMs = 0;

  private pumpTimer: ReturnType<typeof setInterval> | null = null;
  private clientTick = 0;

  private readonly peerMap = new Map<number, NetPeer>();
  private readonly entityMap = new Map<number, NetEntityRecord>();
  private readonly slotToNetId = new Map<number, number>();
  private readonly publishStates = new Map<number, PublishEntry>();
  private readonly roomVars: NetRoomVars;
  /**
   * False until the first `RoomVarsChangedEvent` of a session. That first event is the **full** set
   * (on a join and on a resume alike); everything after it is a changed subset.
   */
  private receivedRoomVarsForSession = false;

  /** Accumulates a possibly multi-frame snapshot; committed only when `FrameFlags.Final` arrives. */
  private readonly pendingSnapshot = new Map<number, NetEntityRecord>();
  private snapshotInProgress = false;
  private snapshotComplete = false;

  private lastSeq: number | null = null;
  /** True between a detected gap and the snapshot that cures it; hot frames are dropped meanwhile. */
  private desynced = false;
  private readonly resyncTimestamps: number[] = [];

  private readonly unknownTypeIds = new UnknownTypeIdTally();
  private readonly counters: NetworkStats = {
    framesReceived: 0,
    unknownTypeIds: 0,
    malformedFrames: 0,
    seqGaps: 0,
    resyncsSent: 0,
    resyncsSuppressed: 0,
    entityPacketsSent: 0,
    entityRecordsSent: 0,
    unknownSlotUpdates: 0,
    nonFiniteRejected: 0,
    signalHandlerErrors: 0,
  };

  private readonly signalHandlers = new Map<string, Set<NetSignalHandler>>();
  private readonly statusListeners = new Set<(status: NetworkStatus) => void>();
  private readonly peerListeners = new Set<(peers: readonly NetPeer[]) => void>();
  private readonly entityListeners = new Set<(changes: readonly NetEntityChange[]) => void>();
  private readonly roomVarListeners = new Set<(keys: readonly string[]) => void>();
  private readonly errorListeners = new Set<(error: NetworkConnectError) => void>();

  private pendingConnect: {
    resolve: (info: NetworkSessionInfo) => void;
    reject: (error: NetworkConnectError) => void;
  } | null = null;
  private connectPromise: Promise<NetworkSessionInfo> | null = null;

  private hidden = false;
  private readonly onVisibilityChange = (): void => this.handleVisibilityChange();

  // Reusable decode scratch — the receive path runs 20×/s and must not allocate per frame.
  private readonly snapshotView = createSnapshotPacketView();
  private readonly deltaSections = createDeltaPacketSections();
  private readonly fullRecord = createFullRecord();
  private readonly updateRecord = createUpdateRecord();
  private readonly signalSections = createSignalBatchSections();
  private readonly signalEntry = createSignalBatchEntry();
  private readonly quantizedPosition = createQuantizedPosition();
  private readonly scratchChanges: NetEntityChange[] = [];

  constructor(options: NetworkServiceOptions = {}) {
    const sendRateHz = options.sendRateHz && options.sendRateHz > 0 ? options.sendRateHz : 20;
    this.sendIntervalMs = Math.max(1, Math.round(1000 / sendRateHz));
    this.pingIntervalMs = options.pingIntervalMs ?? 2000;
    this.now = options.now ?? Date.now;
    this.socketFactory = options.socketFactory;
    this.backoffOptions = options.backoff;
    this.random = options.random;
    this.visibility =
      options.visibility === undefined ? defaultVisibilitySource() : options.visibility;
    this.roomVars = new NetRoomVars((key, value) => this.sendSetRoomVar(key, value));
  }

  // ── Session state (all offline-safe) ───────────────────────────────────────

  /** Lifecycle status. `'offline'` until a `WelcomeEvent` lands. */
  get status(): NetworkStatus {
    return this.currentStatus;
  }

  /** True only while a room membership is live. */
  get isOnline(): boolean {
    return this.currentStatus === 'online';
  }

  /** Room-unique id for this client, or 0 while offline. */
  get clientId(): number {
    return this.session?.clientId ?? 0;
  }

  /** The joined room, or `''` while offline. */
  get roomId(): string {
    return this.session?.roomId ?? '';
  }

  /** The room's tick rate, or 0 while offline. */
  get tickHz(): number {
    return this.session?.tickHz ?? 0;
  }

  /** A `RoomMode` value. Defaults to `Relay` (client authority) while offline. */
  get mode(): number {
    return this.session?.mode ?? RoomMode.Relay;
  }

  /** The current host, or 0 when there is none. */
  get hostClientId(): number {
    return this.session?.hostClientId ?? 0;
  }

  /** True when this client is the room host. Always false while offline. */
  get isHost(): boolean {
    const host = this.session?.hostClientId ?? 0;
    return host !== 0 && host === this.clientId;
  }

  /** Hard cap on entities this client may be told about at once. 0 while offline. */
  get maxVisibleEntities(): number {
    return this.session?.maxVisibleEntities ?? 0;
  }

  /** The room's member cap, or 0 while offline. */
  get maxPlayers(): number {
    return this.session?.maxPlayers ?? 0;
  }

  /** AOI enter radius in world units, or 0 while offline. */
  get aoiRadius(): number {
    return this.session?.aoiRadius ?? 0;
  }

  /** Everything the welcome said about the room, or `null` while offline. */
  get sessionInfo(): NetworkSessionInfo | null {
    return this.session;
  }

  /**
   * The quantizer bound to this room's world bounds, or `null` while offline. It is the only correct
   * way to convert between world units and the replicated integers — the quantized values *are* the
   * state, on both sides.
   */
  get quantizer(): WorldQuantizer | null {
    return this.worldQuantizer;
  }

  /** Last measured round-trip time in ms, or 0 before the first pong. */
  get rtt(): number {
    return this.rttMs;
  }

  /** `serverTime − localTime` in ms, estimated from the last pong. 0 before one arrives. */
  get clockOffset(): number {
    return this.clockOffsetMs;
  }

  /** The server's wall clock right now, in Unix ms, as well as this client can estimate it. */
  get serverTimeMs(): number {
    return this.now() + this.clockOffsetMs;
  }

  /** Room members, local client first. Empty while offline. */
  get peers(): readonly NetPeer[] {
    return [...this.peerMap.values()];
  }

  /**
   * The replicated entity table. Live and read-only — mutate through {@link publish} for entities you
   * own; everything else belongs to the server or another client.
   */
  get entities(): ReadonlyMap<number, Readonly<NetEntityRecord>> {
    return this.entityMap;
  }

  /** How many entities this client can currently see. */
  get entityCount(): number {
    return this.entityMap.size;
  }

  /** True once a snapshot has completed (its `Final` frame arrived) and no gap has invalidated it. */
  get hasCompleteSnapshot(): boolean {
    return this.snapshotComplete && !this.desynced;
  }

  /** True while hot frames are being ignored pending the snapshot that cures a detected gap. */
  get isDesynced(): boolean {
    return this.desynced;
  }

  /** Server-owned room variables. Always present, empty while offline. */
  get vars(): NetRoomVars {
    return this.roomVars;
  }

  /** A snapshot copy of the diagnostics counters. */
  get stats(): Readonly<NetworkStats> {
    return { ...this.counters };
  }

  /** Transport counters, or `null` when no transport has been created yet. */
  get transportStats(): Readonly<WsTransportStats> | null {
    return this.transport ? this.transport.stats : null;
  }

  /** One entity by net id, or `undefined`. */
  getEntity(netId: number): Readonly<NetEntityRecord> | undefined {
    return this.entityMap.get(netId);
  }

  /** The net id currently occupying a wire slot, or 0 when the slot is unknown. */
  resolveSlot(slot: number): number {
    return this.slotToNetId.get(slot) ?? 0;
  }

  // ── Connect / disconnect ───────────────────────────────────────────────────

  /**
   * Joins a room. Resolves when `WelcomeEvent` arrives; rejects with a {@link NetworkConnectError} on
   * `RejectedEvent` (every `RejectCode` is mapped) or on a transport failure.
   *
   * `HelloCommand` is always the **first** frame on the socket — anything else earns a 4007.
   */
  connect(options: NetworkConnectOptions): Promise<NetworkSessionInfo> {
    if (this.disposed) {
      return Promise.reject(
        new NetworkConnectError('cancelled', 'This NetworkService has been disposed.')
      );
    }
    if (!options.url || !options.roomId) {
      return Promise.reject(
        new NetworkConnectError('invalid', 'connect() needs both a url and a roomId.')
      );
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    if (this.session) {
      return Promise.resolve(this.session);
    }
    if (this.transport) {
      // A transport with no session is one that is mid-reconnect. Starting a second one here would
      // orphan the first and leave two sockets racing for the same room membership.
      return Promise.reject(
        new NetworkConnectError(
          'invalid',
          'This session is still reconnecting; call disconnect() before joining another room.'
        )
      );
    }

    this.credentials = {
      url: options.url,
      token: options.token ?? '',
      roomId: options.roomId,
      displayName: options.displayName ?? '',
      capabilities: options.capabilities ?? 0,
    };
    this.lastRejectCode = null;
    this.hasWelcomed = false;
    this.resumeKey = null;

    const promise = new Promise<NetworkSessionInfo>((resolve, reject) => {
      this.pendingConnect = { resolve, reject };
    });
    this.connectPromise = promise;

    this.transport = new WsTransport({
      url: this.credentials.url,
      socketFactory: this.socketFactory,
      now: this.now,
      random: this.random,
      backoff: this.backoffOptions,
      shouldReconnect: info => this.shouldReconnect(info),
    });
    this.transport.onFrame = frame => this.handleFrame(frame);
    this.transport.onStateChange = (state, info) => this.handleTransportState(state, info);

    this.attachVisibility();
    this.startPump();
    this.transport.connect();

    return promise;
  }

  /**
   * Leaves the room: a `LeaveCommand` if the socket is still open, then a terminal close. The service
   * itself stays usable — call {@link connect} again for a new session.
   */
  disconnect(): void {
    if (this.transport) {
      this.sendControl({ typeId: MessageTypeIds.LeaveCommand, body: {} });
      // Detach first: a deliberate goodbye must not surface as a session error.
      this.transport.onFrame = null;
      this.transport.onStateChange = null;
      this.transport.dispose();
      this.transport = null;
    }
    this.rejectPendingConnect(
      new NetworkConnectError('cancelled', 'The session was disconnected locally.')
    );
    this.stopPump();
    this.detachVisibility();
    this.resetSessionState();
    this.session = null;
    this.worldQuantizer = null;
    this.hasWelcomed = false;
    this.resumeKey = null;
    this.credentials = null;
    this.setStatus('offline');
  }

  /** Clears the pump, disposes the transport and drops every listener. Idempotent. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disconnect();
    this.disposed = true;
    this.signalHandlers.clear();
    this.statusListeners.clear();
    this.peerListeners.clear();
    this.entityListeners.clear();
    this.roomVarListeners.clear();
    this.errorListeners.clear();
  }

  // ── Change notifications ───────────────────────────────────────────────────

  /** Subscribes to lifecycle changes. Returns an unsubscribe. */
  onStatusChange(listener: (status: NetworkStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Subscribes to membership changes (join, leave, host migration). Returns an unsubscribe. */
  onPeersChange(listener: (peers: readonly NetPeer[]) => void): () => void {
    this.peerListeners.add(listener);
    return () => this.peerListeners.delete(listener);
  }

  /**
   * Subscribes to registry changes, batched per applied frame and ordered removals-first. Phase 1.3
   * binds nodes to entities through exactly this.
   */
  onEntitiesChange(listener: (changes: readonly NetEntityChange[]) => void): () => void {
    this.entityListeners.add(listener);
    return () => this.entityListeners.delete(listener);
  }

  /** Subscribes to room-variable changes; the listener gets the changed keys. */
  onRoomVarsChange(listener: (keys: readonly string[]) => void): () => void {
    this.roomVarListeners.add(listener);
    return () => this.roomVarListeners.delete(listener);
  }

  /** Subscribes to session-level failures (rejections, terminal transport closes). */
  onError(listener: (error: NetworkConnectError) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  // ── Signals ────────────────────────────────────────────────────────────────

  /** Registers a handler for a signal name. Returns an unsubscribe; `off` does the same thing. */
  on(name: string, handler: NetSignalHandler): () => void {
    let handlers = this.signalHandlers.get(name);
    if (!handlers) {
      handlers = new Set();
      this.signalHandlers.set(name, handlers);
    }
    handlers.add(handler);
    return () => this.off(name, handler);
  }

  /** Removes one handler, or every handler for `name` when none is given. */
  off(name: string, handler?: NetSignalHandler): void {
    const handlers = this.signalHandlers.get(name);
    if (!handlers) {
      return;
    }
    if (handler) {
      handlers.delete(handler);
    } else {
      handlers.clear();
    }
    if (handlers.size === 0) {
      this.signalHandlers.delete(name);
    }
  }

  /**
   * Emits a networked game event. `payload` may be bytes (sent verbatim) or any JSON-serializable
   * value (encoded as UTF-8 JSON — the v0 payload format). Returns whether the frame left this client.
   *
   * Routing: `'server'` (handled by the room, Level 2/3), `'peers'` (every other member — the 2/s
   * quota lives here, it is a 600× amplifier), `'aoi'` (peers near you, batched server-side), or a
   * `clientId` for a single peer.
   */
  emit(name: string, payload: NetSignalPayload = null, options: NetEmitOptions = {}): boolean {
    if (!this.isOnline) {
      return false;
    }

    const destination = options.to ?? 'peers';
    let target: SignalTargetValue = SignalTarget.AllPeers;
    let targetClientId = 0;
    if (typeof destination === 'number') {
      target = SignalTarget.SinglePeer;
      targetClientId = destination;
    } else if (destination === 'server') {
      target = SignalTarget.Server;
    } else if (destination === 'aoi') {
      target = SignalTarget.AoiPeers;
    }

    return this.sendControl({
      typeId: MessageTypeIds.EmitSignalCommand,
      body: { name, target, targetClientId, payload: encodeSignalPayload(payload) },
    });
  }

  // ── Publishing owned entity state ──────────────────────────────────────────

  /**
   * Marks an owned entity dirty. The pump flushes it as an `EntityUpdatePacket` on the next tick.
   *
   * **Dirty detection compares quantized integers, never floats.** Sub-quantum float noise would
   * otherwise keep an idle entity dirty forever, and the quantized integers are what actually
   * replicate — so a move smaller than a quantum is genuinely no change at all.
   *
   * Returns `false` while offline, when the room's world bounds are unusable, or when a value is not
   * finite (counted as `nonFiniteRejected` — one NaN poisons a spatial hash).
   */
  publish(netId: number, state: NetPublishState): boolean {
    const quantizer = this.worldQuantizer;
    if (!this.isOnline || !quantizer) {
      return false;
    }

    const entry = this.getPublishEntry(netId);
    let mask = entry.mask;

    if (state.x !== undefined || state.y !== undefined) {
      // Round-tripping the axis that was NOT supplied is exact: requantizing a dequantized value
      // lands on the same integer (that fixed point is why the world-bounds ratio is enforced).
      const x = state.x ?? quantizer.dequantizeX(entry.next.qx);
      const y = state.y ?? quantizer.dequantizeY(entry.next.qy);
      if (!quantizer.tryQuantizePosition(x, y, this.quantizedPosition)) {
        this.counters.nonFiniteRejected += 1;
        return false;
      }
      if (
        state.x !== undefined &&
        (!entry.hasSent || this.quantizedPosition.qx !== entry.sent.qx)
      ) {
        entry.next.qx = this.quantizedPosition.qx;
        mask |= DeltaMask.X;
      }
      if (
        state.y !== undefined &&
        (!entry.hasSent || this.quantizedPosition.qy !== entry.sent.qy)
      ) {
        entry.next.qy = this.quantizedPosition.qy;
        mask |= DeltaMask.Y;
      }
    }

    if (state.rotation !== undefined) {
      const qrot = tryQuantizeRotation(state.rotation);
      if (qrot === null) {
        this.counters.nonFiniteRejected += 1;
        return false;
      }
      if (!entry.hasSent || qrot !== entry.sent.qrot) {
        entry.next.qrot = qrot;
        mask |= DeltaMask.Rot;
      }
    }

    if (state.vx !== undefined) {
      const qvx = tryQuantizeVelocity(state.vx);
      if (qvx === null) {
        this.counters.nonFiniteRejected += 1;
        return false;
      }
      if (!entry.hasSent || qvx !== entry.sent.qvx) {
        entry.next.qvx = qvx;
        mask |= DeltaMask.Vx;
      }
    }

    if (state.vy !== undefined) {
      const qvy = tryQuantizeVelocity(state.vy);
      if (qvy === null) {
        this.counters.nonFiniteRejected += 1;
        return false;
      }
      if (!entry.hasSent || qvy !== entry.sent.qvy) {
        entry.next.qvy = qvy;
        mask |= DeltaMask.Vy;
      }
    }

    if (state.flags !== undefined) {
      const flags = state.flags & 0xff;
      if (!entry.hasSent || flags !== entry.sent.flags) {
        entry.next.flags = flags;
        mask |= DeltaMask.Flags;
      }
    }

    if (state.teleport) {
      mask |= DeltaMask.Teleport;
    }

    entry.mask = mask;
    return true;
  }

  /** Forgets an entity's publish bookkeeping (it despawned, or this client stopped owning it). */
  clearPublished(netId: number): void {
    this.publishStates.delete(netId);
  }

  /**
   * Runs the send pump immediately instead of waiting for the interval. Exposed for hosts that want a
   * flush at a deterministic moment (an editor stepping frames, a test); the interval is the norm.
   */
  flush(): void {
    this.pump();
  }

  /** Asks the server to re-send this client's whole visible set. Honours the 2/s quota. */
  requestResync(): boolean {
    if (!this.isOnline) {
      return false;
    }
    const now = this.now();
    while (this.resyncTimestamps.length > 0 && now - this.resyncTimestamps[0] >= RESYNC_WINDOW_MS) {
      this.resyncTimestamps.shift();
    }
    if (this.resyncTimestamps.length >= MAX_RESYNCS_PER_WINDOW) {
      this.counters.resyncsSuppressed += 1;
      return false;
    }
    if (!this.sendControl({ typeId: MessageTypeIds.ResyncCommand, body: {} })) {
      return false;
    }
    this.resyncTimestamps.push(now);
    this.counters.resyncsSent += 1;
    return true;
  }

  /** Sends a chat line. Quota: 10/min, ≤240 characters. */
  sendChat(text: string): boolean {
    if (!this.isOnline) {
      return false;
    }
    return this.sendControl({ typeId: MessageTypeIds.SendChatCommand, body: { text } });
  }

  // ── Transport plumbing ─────────────────────────────────────────────────────

  private shouldReconnect(info: WsTransportCloseInfo): boolean {
    // Before the first welcome, a failure is the caller's to handle: connect() rejects and the UI
    // decides. Retrying blind would only delay a "wrong token" message by half a minute.
    if (!this.hasWelcomed) {
      return false;
    }
    if (info.code !== null && PERMANENT_CLOSE_CODES.has(info.code)) {
      return false;
    }
    if (this.lastRejectCode !== null && PERMANENT_REJECT_CODES.has(this.lastRejectCode)) {
      return false;
    }
    return true;
  }

  private handleTransportState(state: WsTransportState, info: WsTransportCloseInfo | null): void {
    switch (state) {
      case 'connecting':
        this.setStatus('connecting');
        break;
      case 'open':
        this.sendHello();
        break;
      case 'reconnecting':
        this.session = null;
        this.setStatus('reconnecting');
        break;
      case 'closed': {
        const error = this.describeClose(info);
        this.session = null;
        this.setStatus('offline');
        this.rejectPendingConnect(error);
        this.notifyError(error);
        break;
      }
      default:
        break;
    }
  }

  private describeClose(info: WsTransportCloseInfo | null): NetworkConnectError {
    if (this.lastRejectCode !== null) {
      return new NetworkConnectError(
        'rejected',
        describeRejectCode(this.lastRejectCode),
        this.lastRejectCode,
        info?.code ?? null
      );
    }
    const detail = info
      ? `${info.reason}${info.message ? `: ${info.message}` : ''}`
      : 'connection closed';
    return new NetworkConnectError(
      'transport',
      `The room connection closed (${detail}).`,
      0,
      info?.code ?? null
    );
  }

  private sendHello(): void {
    const credentials = this.credentials;
    if (!credentials) {
      return;
    }
    // Always the first frame on the socket, on the first connect and on every reconnect.
    this.sendControl({
      typeId: MessageTypeIds.HelloCommand,
      body: {
        protocolVersion: PROTOCOL_VERSION,
        token: credentials.token,
        roomId: credentials.roomId,
        displayName: credentials.displayName,
        capabilities: credentials.capabilities,
        resumeKey: this.resumeKey,
      },
    });
  }

  private sendControl(message: ControlMessage): boolean {
    const transport = this.transport;
    if (!transport) {
      return false;
    }
    return transport.send(encodeControlMessage(message));
  }

  private sendSetRoomVar(key: string, value: Uint8Array): boolean {
    if (!this.isOnline) {
      return false;
    }
    return this.sendControl({ typeId: MessageTypeIds.SetRoomVarCommand, body: { key, value } });
  }

  // ── Inbound frames ─────────────────────────────────────────────────────────

  private handleFrame(frame: Uint8Array): void {
    this.counters.framesReceived += 1;
    const typeId = frameTypeId(frame);
    if (typeId < 0) {
      this.counters.malformedFrames += 1;
      return;
    }

    switch (typeId) {
      case MessageTypeIds.SnapshotPacket:
        this.applySnapshotPacket(frame);
        return;
      case MessageTypeIds.DeltaPacket:
        this.applyDeltaPacket(frame);
        return;
      case MessageTypeIds.SignalBatchPacket:
        this.applySignalBatchPacket(frame);
        return;
      default:
        break;
    }

    let message: ReturnType<typeof decodeControlMessage>;
    try {
      message = decodeControlMessage(typeId, framePayload(frame));
    } catch {
      // A known TypeId that will not decode is a broken peer, not an old one — but it must not take
      // the session down either.
      this.counters.malformedFrames += 1;
      return;
    }

    if (!message) {
      this.unknownTypeIds.record(typeId);
      this.counters.unknownTypeIds += 1;
      return;
    }

    this.dispatchControl(message);
  }

  private dispatchControl(message: NonNullable<ReturnType<typeof decodeControlMessage>>): void {
    switch (message.typeId) {
      case MessageTypeIds.WelcomeEvent:
        this.handleWelcome(message.body);
        break;
      case MessageTypeIds.RejectedEvent:
        this.handleRejected(message.body.code, message.body.message);
        break;
      case MessageTypeIds.PongEvent:
        this.handlePong(message.body.clientTimeMs, message.body.serverTimeMs);
        break;
      case MessageTypeIds.PeerJoinedEvent:
        this.peerMap.set(message.body.clientId, {
          clientId: message.body.clientId,
          displayName: message.body.displayName,
          isLocal: message.body.clientId === this.clientId,
        });
        this.notifyPeers();
        break;
      case MessageTypeIds.PeerLeftEvent:
        if (this.peerMap.delete(message.body.clientId)) {
          this.notifyPeers();
        }
        break;
      case MessageTypeIds.HostChangedEvent:
        if (this.session) {
          this.session = { ...this.session, hostClientId: message.body.hostClientId };
        }
        this.notifyPeers();
        break;
      case MessageTypeIds.RoomVarsChangedEvent:
        this.handleRoomVars(message.body.keys, message.body.values);
        break;
      case MessageTypeIds.SignalEvent:
        this.dispatchSignal(message.body.name, message.body.payload, message.body.senderClientId);
        break;
      default:
        // Every other control message (chat, room info, spawn responses, cold props) belongs to a
        // later phase. Decoded, ignored, and deliberately not counted as unknown.
        break;
    }
  }

  private handleWelcome(welcome: WelcomeEvent): void {
    // A resume is only a resume if we had a session to resume. A first welcome claiming `resumed`
    // would otherwise let a hostile or buggy server keep stale local state alive.
    const resumed = welcome.resumed && this.hasWelcomed;
    if (!resumed) {
      this.resetSessionState();
    }

    // The known set is rebuilt from scratch on every welcome, resumed or not — the spec is explicit
    // that a resume answers with a fresh snapshot and never assumes the old slot table.
    this.slotToNetId.clear();
    this.pendingSnapshot.clear();
    this.snapshotInProgress = false;
    this.snapshotComplete = false;
    this.lastSeq = null;
    this.desynced = false;
    this.lastRejectCode = null;
    // A resume answers with the full room-var set too, so the next vars event replaces either way.
    this.receivedRoomVarsForSession = false;

    this.worldQuantizer = isValidWorld(
      welcome.worldOriginX,
      welcome.worldOriginY,
      welcome.worldSize
    )
      ? new WorldQuantizer(welcome.worldOriginX, welcome.worldOriginY, welcome.worldSize)
      : null;

    // The key is a view over the receive buffer, which the next frame reuses.
    this.resumeKey = welcome.resumeKey.length > 0 ? welcome.resumeKey.slice() : null;
    this.hasWelcomed = true;

    this.session = {
      clientId: welcome.clientId,
      roomId: welcome.roomId,
      tickHz: welcome.tickHz,
      mode: welcome.mode,
      protocolVersion: welcome.protocolVersion,
      maxPlayers: welcome.maxPlayers,
      maxVisibleEntities: welcome.maxVisibleEntities,
      aoiRadius: welcome.aoiRadius,
      hostClientId: welcome.hostClientId,
      resumed,
      world: {
        originX: welcome.worldOriginX,
        originY: welcome.worldOriginY,
        size: welcome.worldSize,
      },
    };

    this.peerMap.set(welcome.clientId, {
      clientId: welcome.clientId,
      displayName: this.credentials?.displayName ?? '',
      isLocal: true,
    });

    // Clock offset from the welcome, so the first frame already has a usable server clock; the
    // heartbeat refines it.
    this.clockOffsetMs = welcome.serverTimeMs - this.now();

    this.setStatus('online');
    this.notifyPeers();

    if (this.hidden) {
      this.sendClientPrefs();
    }

    const resolve = this.pendingConnect?.resolve;
    this.pendingConnect = null;
    this.connectPromise = null;
    resolve?.(this.session);
  }

  private handleRejected(code: number, message: string): void {
    this.lastRejectCode = code;
    const error = new NetworkConnectError(
      'rejected',
      message && message.length > 0 ? message : describeRejectCode(code),
      code,
      null
    );
    this.rejectPendingConnect(error);
    this.notifyError(error);
  }

  private handlePong(clientTimeMs: number, serverTimeMs: number): void {
    if (clientTimeMs !== this.lastPingClientTimeMs) {
      // A pong for a ping we no longer track (a stale reply across a reconnect) still carries a
      // usable server clock, but its round trip is meaningless.
      this.clockOffsetMs = serverTimeMs - this.now();
      return;
    }
    const now = this.now();
    this.rttMs = Math.max(0, now - clientTimeMs);
    this.clockOffsetMs = serverTimeMs + this.rttMs / 2 - now;
  }

  private handleRoomVars(keys: readonly string[], values: readonly Uint8Array[]): void {
    // Full set on join and on resume, changed subset afterwards. The welcome is what marks the
    // boundary: the first vars event after it replaces, later ones merge.
    const isFullSet = !this.receivedRoomVarsForSession;
    this.receivedRoomVarsForSession = true;
    const changedKeys = isFullSet
      ? this.roomVars.replaceAll(keys, values.map(copyBytes))
      : this.roomVars.merge(keys, values.map(copyBytes));
    if (changedKeys.length > 0) {
      for (const listener of [...this.roomVarListeners]) {
        listener(changedKeys);
      }
    }
  }

  // ── Hot plane ──────────────────────────────────────────────────────────────

  private applySnapshotPacket(frame: Uint8Array): void {
    const view = viewOf(frame);
    if (!readSnapshotPacket(view, this.snapshotView)) {
      this.counters.malformedFrames += 1;
      return;
    }
    if (!this.acceptHotFrame(this.snapshotView.seq, true)) {
      return;
    }

    if (!this.snapshotInProgress) {
      this.pendingSnapshot.clear();
      this.snapshotInProgress = true;
    }

    for (let i = 0; i < this.snapshotView.count; i += 1) {
      if (!readSnapshotRecord(view, this.snapshotView, i, this.fullRecord)) {
        this.counters.malformedFrames += 1;
        break;
      }
      this.pendingSnapshot.set(
        this.fullRecord.netId,
        toRecord(this.fullRecord.netId, this.fullRecord.state)
      );
    }

    if (isFinalFrame(this.snapshotView.frameFlags)) {
      this.commitSnapshot();
    }
  }

  /**
   * A snapshot is the authoritative visible set, so committing it *replaces* the registry: anything
   * missing from it left the AOI (or the room) while we were not listening.
   */
  private commitSnapshot(): void {
    const changes = this.beginChanges();

    for (const [netId, entity] of this.entityMap) {
      if (!this.pendingSnapshot.has(netId)) {
        changes.push({ kind: 'leave', netId, entity, mask: 0 });
      }
    }

    this.entityMap.clear();
    this.slotToNetId.clear();
    for (const [netId, entity] of this.pendingSnapshot) {
      this.entityMap.set(netId, entity);
      this.slotToNetId.set(netIdSlot(netId), netId);
      changes.push({ kind: 'enter', netId, entity, mask: 0 });
    }

    this.pendingSnapshot.clear();
    this.snapshotInProgress = false;
    this.snapshotComplete = true;
    this.desynced = false;
    this.flushChanges(changes);
  }

  private applyDeltaPacket(frame: Uint8Array): void {
    const view = viewOf(frame);
    if (!readDeltaPacket(view, this.deltaSections)) {
      this.counters.malformedFrames += 1;
      return;
    }
    if (!this.acceptHotFrame(this.deltaSections.seq, false)) {
      return;
    }

    const changes = this.beginChanges();

    // 1. Removals first — within a frame a slot's removal always precedes any reuse of it. Applying
    //    enters first would resolve a reused slot to the entity that just left.
    for (let i = 0; i < this.deltaSections.removedCount; i += 1) {
      const slot = readRemovedSlotAt(view, this.deltaSections, i);
      if (slot < 0) {
        this.counters.malformedFrames += 1;
        break;
      }
      const netId = this.slotToNetId.get(slot);
      if (netId === undefined) {
        continue;
      }
      const entity = this.entityMap.get(netId);
      this.slotToNetId.delete(slot);
      this.entityMap.delete(netId);
      this.publishStates.delete(netId);
      if (entity) {
        changes.push({ kind: 'leave', netId, entity, mask: 0 });
      }
    }

    // 2. Enters — a full record, which is also what teaches this client the slot → netId mapping.
    for (let i = 0; i < this.deltaSections.enterCount; i += 1) {
      if (!readEnterRecord(view, this.deltaSections, i, this.fullRecord)) {
        this.counters.malformedFrames += 1;
        break;
      }
      const netId = this.fullRecord.netId;
      const entity = toRecord(netId, this.fullRecord.state);
      this.entityMap.set(netId, entity);
      this.slotToNetId.set(netIdSlot(netId), netId);
      changes.push({ kind: 'enter', netId, entity, mask: 0 });
    }

    // 3. Updates — masked merges onto entities this client already knows.
    let cursor = 0;
    for (let i = 0; i < this.deltaSections.updateCount; i += 1) {
      if (!readNextUpdateRecord(view, this.deltaSections, cursor, this.updateRecord)) {
        this.counters.malformedFrames += 1;
        break;
      }
      cursor += this.updateRecord.bytesRead;

      const netId = this.slotToNetId.get(this.updateRecord.slot);
      const entity = netId === undefined ? undefined : this.entityMap.get(netId);
      if (!entity) {
        // Invariant 3: no delta without a prior full record. Count it and move on.
        this.counters.unknownSlotUpdates += 1;
        continue;
      }
      applyMaskedState(entity, this.updateRecord.mask, this.updateRecord.state);
      changes.push({ kind: 'update', netId: entity.netId, entity, mask: this.updateRecord.mask });
    }

    this.flushChanges(changes);
  }

  private applySignalBatchPacket(frame: Uint8Array): void {
    const view = viewOf(frame);
    if (!readSignalBatchPacket(view, this.signalSections)) {
      this.counters.malformedFrames += 1;
      return;
    }
    if (!this.acceptHotFrame(this.signalSections.seq, false)) {
      return;
    }

    let cursor = 0;
    for (let i = 0; i < this.signalSections.count; i += 1) {
      if (!readNextSignalEntry(view, this.signalSections, cursor, this.signalEntry)) {
        this.counters.malformedFrames += 1;
        break;
      }
      cursor += this.signalEntry.bytesRead;
      this.dispatchSignal(
        textDecoder.decode(this.signalEntry.name),
        this.signalEntry.payload,
        this.signalEntry.senderClientId
      );
    }
  }

  /**
   * The `u16 Seq` rule. A gap means our own send queue dropped a frame, and enters/removals do not
   * self-heal — so the cure is a `ResyncCommand` plus ignoring hot frames until the snapshot arrives.
   *
   * A snapshot is exempt: it *is* the cure, so it is accepted even across a gap (any partially
   * accumulated snapshot is discarded first, because a frame of it may be what went missing).
   */
  private acceptHotFrame(seq: number, isSnapshot: boolean): boolean {
    if (this.desynced && !isSnapshot) {
      return false;
    }

    const expected = this.lastSeq === null ? seq : (this.lastSeq + 1) % SEQ_MODULO;
    if (seq !== expected) {
      this.counters.seqGaps += 1;
      if (!isSnapshot) {
        this.desynced = true;
        this.snapshotComplete = false;
        this.requestResync();
        return false;
      }
      this.pendingSnapshot.clear();
      this.snapshotInProgress = false;
    }

    if (isSnapshot) {
      this.desynced = false;
    }
    this.lastSeq = seq;
    return true;
  }

  private dispatchSignal(name: string, payload: Uint8Array, senderClientId: number): void {
    const handlers = this.signalHandlers.get(name);
    if (!handlers || handlers.size === 0) {
      return;
    }
    for (const handler of [...handlers]) {
      try {
        handler(payload, senderClientId);
      } catch (error) {
        // A throwing game handler must never take the session with it.
        this.counters.signalHandlerErrors += 1;
        console.error(`[NetworkService] Signal handler for "${name}" threw:`, error);
      }
    }
  }

  // ── The pump (interval-driven, never rAF) ──────────────────────────────────

  private startPump(): void {
    if (this.pumpTimer !== null) {
      return;
    }
    this.pumpTimer = setInterval(() => this.pump(), this.sendIntervalMs);
  }

  private stopPump(): void {
    if (this.pumpTimer !== null) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = null;
    }
  }

  private pump(): void {
    if (!this.isOnline) {
      return;
    }
    this.flushDirtyEntities();
    this.maybePing();
  }

  private maybePing(): void {
    const now = this.now();
    if (this.lastPingSentAtMs !== 0 && now - this.lastPingSentAtMs < this.pingIntervalMs) {
      return;
    }
    this.lastPingSentAtMs = now;
    this.lastPingClientTimeMs = now;
    this.sendControl({ typeId: MessageTypeIds.PingCommand, body: { clientTimeMs: now } });
  }

  /**
   * Packs every dirty owned entity into `EntityUpdatePacket`s, at most
   * {@link MAX_RECORDS_PER_ENTITY_UPDATE_PACKET} records each (the server's quota), and commits the
   * sent values only for packets the transport actually accepted — a refused packet stays dirty and
   * goes out next tick with *current* values.
   */
  private flushDirtyEntities(): void {
    const dirty: PublishEntry[] = [];
    for (const entry of this.publishStates.values()) {
      if (entry.mask !== 0) {
        dirty.push(entry);
      }
    }
    if (dirty.length === 0) {
      return;
    }

    this.clientTick = (this.clientTick + 1) >>> 0;

    for (let start = 0; start < dirty.length; start += MAX_RECORDS_PER_ENTITY_UPDATE_PACKET) {
      const chunk = dirty.slice(start, start + MAX_RECORDS_PER_ENTITY_UPDATE_PACKET);
      let size = ENTITY_UPDATE_PACKET_HEADER_SIZE;
      for (const entry of chunk) {
        size += ownerUpdateRecordSize(entry.mask);
      }

      const buffer = new ArrayBuffer(size);
      const view = new DataView(buffer);
      let offset = writeEntityUpdatePacketHeader(view, 0, this.clientTick);
      for (const entry of chunk) {
        offset += writeOwnerUpdateRecord(view, offset, entry.netId, entry.mask, entry.next);
      }
      patchEntityUpdatePacketCount(view, chunk.length);

      if (!this.transport?.send(new Uint8Array(buffer))) {
        return;
      }

      this.counters.entityPacketsSent += 1;
      this.counters.entityRecordsSent += chunk.length;
      for (const entry of chunk) {
        entry.sent.qx = entry.next.qx;
        entry.sent.qy = entry.next.qy;
        entry.sent.qrot = entry.next.qrot;
        entry.sent.qvx = entry.next.qvx;
        entry.sent.qvy = entry.next.qvy;
        entry.sent.flags = entry.next.flags;
        entry.mask = 0;
        entry.hasSent = true;
      }
    }
  }

  private getPublishEntry(netId: number): PublishEntry {
    let entry = this.publishStates.get(netId);
    if (!entry) {
      entry = {
        netId,
        sent: createEntityWireState(),
        next: createEntityWireState(),
        mask: 0,
        hasSent: false,
      };
      this.publishStates.set(netId, entry);
    }
    return entry;
  }

  // ── Hidden tabs ────────────────────────────────────────────────────────────

  private attachVisibility(): void {
    if (!this.visibility) {
      return;
    }
    this.hidden = this.visibility.hidden;
    this.visibility.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  private detachVisibility(): void {
    this.visibility?.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  /**
   * A hidden tab cannot drain a 20 Hz stream, it buffers it — so we tell the server to suspend our
   * hot plane entirely. It re-snapshots on un-hide, which is also why `Seq` does not gap across one.
   */
  private handleVisibilityChange(): void {
    const hidden = this.visibility?.hidden ?? false;
    if (hidden === this.hidden) {
      return;
    }
    this.hidden = hidden;
    this.sendClientPrefs();
  }

  private sendClientPrefs(): void {
    this.sendControl({
      typeId: MessageTypeIds.SetClientPrefsCommand,
      body: { hidden: this.hidden, sendRateDivisor: 0 },
    });
  }

  // ── Bookkeeping ────────────────────────────────────────────────────────────

  private resetSessionState(): void {
    this.entityMap.clear();
    this.slotToNetId.clear();
    this.pendingSnapshot.clear();
    this.publishStates.clear();
    this.peerMap.clear();
    this.roomVars.clear();
    this.receivedRoomVarsForSession = false;
    this.snapshotInProgress = false;
    this.snapshotComplete = false;
    this.desynced = false;
    this.lastSeq = null;
    this.resyncTimestamps.length = 0;
    this.clientTick = 0;
    this.lastPingSentAtMs = 0;
    this.lastPingClientTimeMs = 0;
    this.rttMs = 0;
  }

  private setStatus(status: NetworkStatus): void {
    if (this.currentStatus === status) {
      return;
    }
    this.currentStatus = status;
    for (const listener of [...this.statusListeners]) {
      listener(status);
    }
  }

  private notifyPeers(): void {
    const peers = this.peers;
    for (const listener of [...this.peerListeners]) {
      listener(peers);
    }
  }

  private notifyError(error: NetworkConnectError): void {
    for (const listener of [...this.errorListeners]) {
      listener(error);
    }
  }

  private rejectPendingConnect(error: NetworkConnectError): void {
    const reject = this.pendingConnect?.reject;
    this.pendingConnect = null;
    this.connectPromise = null;
    reject?.(error);
  }

  /** Reuses one array for the per-frame change batch; listeners get a frozen copy. */
  private beginChanges(): NetEntityChange[] {
    this.scratchChanges.length = 0;
    return this.scratchChanges;
  }

  private flushChanges(changes: NetEntityChange[]): void {
    if (changes.length === 0 || this.entityListeners.size === 0) {
      changes.length = 0;
      return;
    }
    const batch = [...changes];
    changes.length = 0;
    for (const listener of [...this.entityListeners]) {
      listener(batch);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function viewOf(frame: Uint8Array): DataView {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
}

function toRecord(netId: number, state: EntityWireState): NetEntityRecord {
  return {
    netId,
    qx: state.qx,
    qy: state.qy,
    qrot: state.qrot,
    qvx: state.qvx,
    qvy: state.qvy,
    kind: state.kind,
    ownerId: state.ownerId,
    flags: state.flags,
  };
}

/** Decoded byte arrays are views over the receive buffer; anything we retain has to be copied. */
function copyBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

/**
 * Bytes for a signal payload: `Uint8Array` verbatim, anything else as UTF-8 JSON (the v0 payload
 * format — debuggable now, schema-packed later without a wire change).
 */
export function encodeSignalPayload(payload: NetSignalPayload): Uint8Array {
  if (payload === null) {
    return new Uint8Array(0);
  }
  if (payload instanceof Uint8Array) {
    return payload;
  }
  return textEncoder.encode(JSON.stringify(payload));
}

/** The inverse of {@link encodeSignalPayload} for JSON payloads; `undefined` when it will not parse. */
export function decodeSignalPayload<T>(payload: Uint8Array): T | undefined {
  if (payload.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(textDecoder.decode(payload)) as T;
  } catch {
    return undefined;
  }
}

function defaultVisibilitySource(): NetworkVisibilitySource | null {
  const doc = (globalThis as { document?: NetworkVisibilitySource }).document;
  return doc && typeof doc.addEventListener === 'function' ? doc : null;
}

/** Re-exported so a host can name the reject codes without reaching into the internal codec. */
export { RejectCode, type RejectCodeValue };
