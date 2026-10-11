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
 * **Scope.** This owns the *data*: `netId → record`, the slot table, peers, room vars, signals, and
 * the spawn/despawn request lane. Binding an entity to a scene node — `core:NetworkedNode`,
 * `core:ReplicatedTransform`, remote prefab instantiation, interpolation — belongs to
 * `core/NetworkNodeBinder` and the two components, because those need the node tree. Nothing in this
 * module imports `three` or a node class.
 *
 * The wire contract is `docs/protocol.md` in the pix3-rooms repo; every byte goes through the codec
 * in `./protocol`, which is pinned by golden vectors and must not be re-implemented here.
 */
import { RejectCode, WorldQuantizer, type EntityWireState, type RejectCodeValue } from './protocol';
import { type NetKindTable } from './net-kind-table';
import { type WsBackoffOptions, type WsSocketFactory, type WsTransportStats } from './WsTransport';
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
    readonly world: {
        readonly originX: number;
        readonly originY: number;
        readonly size: number;
    };
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
/**
 * What happens to an entity when its owner leaves — the low two bits of the flags byte.
 *
 * - `owned` — despawned with its owner. The right policy for an avatar.
 * - `shared` — reassigned to the new host (this is what keeps a departing host's props alive).
 * - `transferable` — reassignable to any client.
 */
export type NetOwnershipPolicy = 'owned' | 'shared' | 'transferable';
/** Mask of the ownership-policy bits inside the flags byte. */
export declare const NET_OWNERSHIP_MASK = 3;
/** Bit 2 is fabric-reserved and must be sent as 0; app bits are 3–7. */
export declare const NET_APP_FLAGS_SHIFT = 3;
/** Reads the ownership policy out of a flags byte. */
export declare function netOwnershipOf(flags: number): NetOwnershipPolicy;
/** Composes a flags byte: ownership in bits 0–1, bit 2 forced to 0, app bits in 3–7. */
export declare function netFlagsByte(ownership: NetOwnershipPolicy, appFlags?: number): number;
/** True when an update's mask carried the `Teleport` bit: snap to it, never interpolate. */
export declare function isNetTeleport(mask: number): boolean;
/** Initial state for {@link NetworkService.spawn}. Everything is world-space and optional. */
export interface NetSpawnOptions {
    /** Initial world position. Quantized against the room's bounds before it goes out. */
    position?: {
        x: number;
        y: number;
    };
    /** Initial rotation in radians. */
    rotation?: number;
    /** Initial linear velocity in units/second. Off the wire by default; send it only if needed. */
    velocity?: {
        x: number;
        y: number;
    };
    /** What happens when this client leaves. Default `'owned'`. */
    ownership?: NetOwnershipPolicy;
    /** Game-defined flag bits 3–7, replicated verbatim; the fabric never interprets them. */
    appFlags?: number;
    /** Optional cold props: bytes verbatim, or any JSON-serializable value. Capped at 512 B server-side. */
    props?: Uint8Array | object | null;
}
/** Why a {@link NetworkService.spawn} failed. Each one is a different thing to do about it. */
export type NetworkSpawnErrorKind = 
/** No room membership. */
'offline'
/** The prefab has no kind: it is missing from the build's `netKindTable`. */
 | 'unknown-kind'
/** This client's own 240-spawns-per-minute budget, refused before the frame left. */
 | 'rate-limited'
/** `RejectCode.QuotaExceeded` — **this owner's** 64-entity budget. Despawn something. */
 | 'quota'
/** `RejectCode.EntityLimitReached` — the **room's** table is full. Nothing this client can do. */
 | 'entity-limit'
/** `RejectCode.KindNotAllowed` — the kind is not on the room's allowlist (a build mismatch). */
 | 'kind-not-allowed'
/** Any other `RejectCode` the fabric answered with. */
 | 'rejected'
/** The socket dropped, or the session left `online`, while the request was in flight. */
 | 'transport'
/** `disconnect()` or `dispose()` happened while the request was in flight. */
 | 'cancelled'
/** The frame could not be handed to the transport at all. */
 | 'invalid';
/** The typed failure {@link NetworkService.spawn} rejects with. */
export declare class NetworkSpawnError extends Error {
    /** Which class of failure this is. */
    readonly kind: NetworkSpawnErrorKind;
    /** The prefab path the caller asked for. */
    readonly prefabPath: string;
    /** The `RejectCode` the server answered with, or `RejectCode.None` for a local refusal. */
    readonly rejectCode: number;
    constructor(kind: NetworkSpawnErrorKind, prefabPath: string, message: string, rejectCode?: number);
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
    /** `SpawnEntityRequest`s that left this client. */
    spawnsSent: number;
    /** Spawns the fabric refused (any `RejectCode`). */
    spawnsRejected: number;
    /** Spawns the local 240/min or 64-entity budget refused before they went out. */
    spawnsThrottled: number;
    /** `DespawnEntityCommand`s that left this client. */
    despawnsSent: number;
}
/** Why a connect attempt failed. */
export type NetworkErrorKind = 
/** The server answered `RejectedEvent`. {@link NetworkConnectError.rejectCode} says why. */
'rejected'
/** The socket never opened, or dropped before a `WelcomeEvent` arrived. */
 | 'transport'
/** `dispose()` or `disconnect()` happened while the connect was in flight. */
 | 'cancelled'
/** The caller passed something unusable. */
 | 'invalid';
/** The typed failure `connect()` rejects with. */
export declare class NetworkConnectError extends Error {
    /** Which class of failure this is. */
    readonly kind: NetworkErrorKind;
    /** The `RejectCode` value when `kind === 'rejected'`, else `RejectCode.None`. */
    readonly rejectCode: number;
    /** The WebSocket close code when one was seen. */
    readonly closeCode: number | null;
    constructor(kind: NetworkErrorKind, message: string, rejectCode?: number, closeCode?: number | null);
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
    /**
     * `kind ↔ prefab path` table. Defaults to the process-wide one, read on every use so a host may
     * install the build's table after the service exists.
     */
    kindTable?: NetKindTable;
}
/**
 * A human-readable line for any `RejectCode`, including one this build has never heard of. An unknown
 * code is a generic failure, never a decoder error — the field is a `ushort` precisely so it survives.
 */
export declare function describeRejectCode(code: number): string;
/**
 * Server-owned room variables (`net.vars`). Reads are local and free; a write goes out as
 * `SetRoomVarCommand` and only lands if the room's ACL allows it — a Level-2 decision, so treat
 * `set()` as a request, never as an assignment.
 */
export declare class NetRoomVars {
    private readonly send;
    private readonly values;
    /** @internal — constructed by {@link NetworkService}. */
    constructor(send: (key: string, value: Uint8Array) => boolean);
    /** Raw bytes, or `undefined` when the room has no such variable. */
    get(key: string): Uint8Array | undefined;
    /** The value decoded as UTF-8 text. */
    getText(key: string): string | undefined;
    /** The value parsed as JSON, or `undefined` when absent or unparseable. */
    getJson<T>(key: string): T | undefined;
    /** True when the room has this variable. */
    has(key: string): boolean;
    /** Every known variable name. */
    keys(): string[];
    /** How many variables the room has published. */
    get size(): number;
    /**
     * Asks the server to set a variable. Returns whether the request left this client — never whether
     * the server accepted it; the authoritative answer arrives as a `RoomVarsChangedEvent`.
     */
    set(key: string, value: Uint8Array | string): boolean;
    /** @internal Replaces the whole set (the full set that follows a join or a resume). */
    replaceAll(keys: readonly string[], values: readonly Uint8Array[]): string[];
    /** @internal Merges a changed subset. */
    merge(keys: readonly string[], values: readonly Uint8Array[]): string[];
    /** @internal Drops everything (a fresh join after a failed resume). */
    clear(): void;
}
export declare class NetworkService {
    private readonly sendIntervalMs;
    private readonly pingIntervalMs;
    private readonly now;
    private readonly socketFactory?;
    private readonly backoffOptions?;
    private readonly random?;
    private readonly visibility;
    private transport;
    private credentials;
    private disposed;
    private currentStatus;
    private session;
    private worldQuantizer;
    private resumeKey;
    /** True once any `WelcomeEvent` has been seen on this session — gates resume and reconnect. */
    private hasWelcomed;
    private lastRejectCode;
    private rttMs;
    private clockOffsetMs;
    private lastPingSentAtMs;
    private lastPingClientTimeMs;
    private pumpTimer;
    private clientTick;
    private readonly peerMap;
    private readonly entityMap;
    private readonly slotToNetId;
    private readonly publishStates;
    /** Correlated `SpawnEntityRequest`s. Emptied on every path that ends a session — never leaked. */
    private readonly pendingSpawns;
    private nextRequestId;
    private readonly spawnTimestamps;
    /** Entities this client spawned and has not despawned — the 64-per-owner budget. */
    private readonly ownedNetIds;
    private readonly kindTableOverride;
    private readonly roomVars;
    /**
     * False until the first `RoomVarsChangedEvent` of a session. That first event is the **full** set
     * (on a join and on a resume alike); everything after it is a changed subset.
     */
    private receivedRoomVarsForSession;
    /** Accumulates a possibly multi-frame snapshot; committed only when `FrameFlags.Final` arrives. */
    private readonly pendingSnapshot;
    private snapshotInProgress;
    private snapshotComplete;
    /** Accumulates a possibly multi-chunk `RoomRosterEvent`; committed only at `FrameFlags.Final`. */
    private readonly pendingRoster;
    private rosterInProgress;
    private lastSeq;
    /** True between a detected gap and the snapshot that cures it; hot frames are dropped meanwhile. */
    private desynced;
    private readonly resyncTimestamps;
    private readonly unknownTypeIds;
    private readonly counters;
    private readonly signalHandlers;
    private readonly statusListeners;
    private readonly peerListeners;
    private readonly entityListeners;
    private readonly roomVarListeners;
    private readonly errorListeners;
    private pendingConnect;
    private connectPromise;
    private hidden;
    private readonly onVisibilityChange;
    private readonly snapshotView;
    private readonly deltaSections;
    private readonly fullRecord;
    private readonly updateRecord;
    private readonly signalSections;
    private readonly signalEntry;
    private readonly quantizedPosition;
    private readonly scratchChanges;
    constructor(options?: NetworkServiceOptions);
    /** Lifecycle status. `'offline'` until a `WelcomeEvent` lands. */
    get status(): NetworkStatus;
    /** True only while a room membership is live. */
    get isOnline(): boolean;
    /** Room-unique id for this client, or 0 while offline. */
    get clientId(): number;
    /** The joined room, or `''` while offline. */
    get roomId(): string;
    /** The room's tick rate, or 0 while offline. */
    get tickHz(): number;
    /** A `RoomMode` value. Defaults to `Relay` (client authority) while offline. */
    get mode(): number;
    /** The current host, or 0 when there is none. */
    get hostClientId(): number;
    /** True when this client is the room host. Always false while offline. */
    get isHost(): boolean;
    /** Hard cap on entities this client may be told about at once. 0 while offline. */
    get maxVisibleEntities(): number;
    /** The room's member cap, or 0 while offline. */
    get maxPlayers(): number;
    /** AOI enter radius in world units, or 0 while offline. */
    get aoiRadius(): number;
    /** Everything the welcome said about the room, or `null` while offline. */
    get sessionInfo(): NetworkSessionInfo | null;
    /**
     * The quantizer bound to this room's world bounds, or `null` while offline. It is the only correct
     * way to convert between world units and the replicated integers — the quantized values *are* the
     * state, on both sides.
     */
    get quantizer(): WorldQuantizer | null;
    /** Last measured round-trip time in ms, or 0 before the first pong. */
    get rtt(): number;
    /** `serverTime − localTime` in ms, estimated from the last pong. 0 before one arrives. */
    get clockOffset(): number;
    /** The server's wall clock right now, in Unix ms, as well as this client can estimate it. */
    get serverTimeMs(): number;
    /** Room members, local client first. Empty while offline. */
    get peers(): readonly NetPeer[];
    /**
     * The replicated entity table. Live and read-only — mutate through {@link publish} for entities you
     * own; everything else belongs to the server or another client.
     */
    get entities(): ReadonlyMap<number, Readonly<NetEntityRecord>>;
    /** How many entities this client can currently see. */
    get entityCount(): number;
    /** True once a snapshot has completed (its `Final` frame arrived) and no gap has invalidated it. */
    get hasCompleteSnapshot(): boolean;
    /** True while hot frames are being ignored pending the snapshot that cures a detected gap. */
    get isDesynced(): boolean;
    /** Server-owned room variables. Always present, empty while offline. */
    get vars(): NetRoomVars;
    /** A snapshot copy of the diagnostics counters. */
    get stats(): Readonly<NetworkStats>;
    /** Transport counters, or `null` when no transport has been created yet. */
    get transportStats(): Readonly<WsTransportStats> | null;
    /** One entity by net id, or `undefined`. */
    getEntity(netId: number): Readonly<NetEntityRecord> | undefined;
    /** The net id currently occupying a wire slot, or 0 when the slot is unknown. */
    resolveSlot(slot: number): number;
    /**
     * Joins a room. Resolves when `WelcomeEvent` arrives; rejects with a {@link NetworkConnectError} on
     * `RejectedEvent` (every `RejectCode` is mapped) or on a transport failure.
     *
     * `HelloCommand` is always the **first** frame on the socket — anything else earns a 4007.
     */
    connect(options: NetworkConnectOptions): Promise<NetworkSessionInfo>;
    /**
     * Leaves the room: a `LeaveCommand` if the socket is still open, then a terminal close. The service
     * itself stays usable — call {@link connect} again for a new session.
     */
    disconnect(): void;
    /** Clears the pump, disposes the transport and drops every listener. Idempotent. */
    dispose(): void;
    /** Subscribes to lifecycle changes. Returns an unsubscribe. */
    onStatusChange(listener: (status: NetworkStatus) => void): () => void;
    /** Subscribes to membership changes (join, leave, host migration). Returns an unsubscribe. */
    onPeersChange(listener: (peers: readonly NetPeer[]) => void): () => void;
    /**
     * Subscribes to registry changes, batched per applied frame and ordered removals-first. Phase 1.3
     * binds nodes to entities through exactly this.
     */
    onEntitiesChange(listener: (changes: readonly NetEntityChange[]) => void): () => void;
    /** Subscribes to room-variable changes; the listener gets the changed keys. */
    onRoomVarsChange(listener: (keys: readonly string[]) => void): () => void;
    /** Subscribes to session-level failures (rejections, terminal transport closes). */
    onError(listener: (error: NetworkConnectError) => void): () => void;
    /** Registers a handler for a signal name. Returns an unsubscribe; `off` does the same thing. */
    on(name: string, handler: NetSignalHandler): () => void;
    /** Removes one handler, or every handler for `name` when none is given. */
    off(name: string, handler?: NetSignalHandler): void;
    /**
     * Emits a networked game event. `payload` may be bytes (sent verbatim) or any JSON-serializable
     * value (encoded as UTF-8 JSON — the v0 payload format). Returns whether the frame left this client.
     *
     * Routing: `'server'` (handled by the room, Level 2/3), `'peers'` (every other member — the 2/s
     * quota lives here, it is a 600× amplifier), `'aoi'` (peers near you, batched server-side), or a
     * `clientId` for a single peer.
     */
    emit(name: string, payload?: NetSignalPayload, options?: NetEmitOptions): boolean;
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
    publish(netId: number, state: NetPublishState): boolean;
    /** Forgets an entity's publish bookkeeping (it despawned, or this client stopped owning it). */
    clearPublished(netId: number): void;
    /** The `kind ↔ prefab path` table this session resolves spawns against. */
    get kinds(): NetKindTable;
    /** Net ids this client spawned and has not despawned. Bounded by the 64-per-owner quota. */
    get ownedEntityCount(): number;
    /** True when this client spawned `netId` and still owns it. */
    ownsEntity(netId: number): boolean;
    /**
     * Asks the room to create an entity of the prefab's kind, owned by this client. Resolves with the
     * **server-minted** `netId` (plan decision D6: nothing is networked until the fabric mints its id).
     *
     * Every field goes out **quantized**, so a spawn cannot introduce a position the delta plane could
     * not have expressed — the quantized integers are the replicated values on both sides.
     *
     * Rejects with a {@link NetworkSpawnError} whose `kind` separates the cases that need different
     * handling: `'quota'` (this owner's 64-entity budget — despawn something), `'entity-limit'` (the
     * room's table is full — nothing this client can do), `'kind-not-allowed'` (build/allowlist
     * mismatch), plus the local `'offline'` / `'unknown-kind'` / `'rate-limited'` refusals. A request
     * still in flight when the socket drops rejects with `'transport'` rather than hanging forever.
     */
    spawn(prefabPath: string, options?: NetSpawnOptions): Promise<number>;
    /**
     * Asks the room to remove an entity this client owns. Returns whether the command left this
     * client; the authoritative removal arrives as a `DeltaPacket` removal record.
     */
    despawn(netId: number): boolean;
    /**
     * Snaps a world position onto the room's quantization grid — the position peers will actually
     * receive. Writes into `out` and returns `false` (writing nothing) while offline or on a
     * non-finite input.
     */
    snapPosition(x: number, y: number, out: {
        x: number;
        y: number;
    }): boolean;
    /**
     * Snaps a rotation onto the wire's 256 steps per turn, returning it wrapped into `[0, 2π)`, or
     * `null` when `rotation` is not finite.
     */
    snapRotation(rotation: number): number | null;
    /**
     * Runs the send pump immediately instead of waiting for the interval. Exposed for hosts that want a
     * flush at a deterministic moment (an editor stepping frames, a test); the interval is the norm.
     */
    flush(): void;
    /** Asks the server to re-send this client's whole visible set. Honours the 2/s quota. */
    requestResync(): boolean;
    /** Sends a chat line. Quota: 10/min, ≤240 characters. */
    sendChat(text: string): boolean;
    private shouldReconnect;
    private handleTransportState;
    private describeClose;
    private sendHello;
    private sendControl;
    private sendSetRoomVar;
    private handleFrame;
    private dispatchControl;
    private handleWelcome;
    /**
     * Correlates one `SpawnEntityResponse` back to its request. An unknown `RequestId` is a response
     * to a request this session already gave up on (a resume, a race with `disconnect()`); it is
     * ignored rather than counted, because the fabric did nothing wrong.
     */
    private handleSpawnResponse;
    /**
     * Settles every in-flight spawn. Called from every path that ends a session — a socket drop, a
     * reconnect, `disconnect()`, `dispose()` — because the fabric will never answer a request whose
     * connection is gone, and an unsettled promise is a leak a game script cannot see or recover from.
     */
    private rejectPendingSpawns;
    private handleRejected;
    private handlePong;
    private handleRoomVars;
    /**
     * Accumulates one roster chunk. A roster may be split across several self-contained
     * `RoomRosterEvent`s and only the last carries `Final`, so nothing is applied until then — the same
     * discipline a multi-frame snapshot uses, and for the same reason: half a full-state message is not
     * a state.
     */
    private handleRoomRoster;
    /**
     * A roster is the authoritative membership, so committing it *replaces* the peer list: anyone
     * missing from it is gone. That is what heals the one case `PeerLeftEvent` cannot — a member who
     * left while this client was inside its resume grace, whose event it was not connected to receive —
     * and it is why a resumed session reconciles here instead of resetting at the welcome.
     */
    private commitRoster;
    private applySnapshotPacket;
    /**
     * A snapshot is the authoritative visible set, so committing it *replaces* the registry: anything
     * missing from it left the AOI (or the room) while we were not listening.
     */
    private commitSnapshot;
    private applyDeltaPacket;
    private applySignalBatchPacket;
    /**
     * The `u16 Seq` rule. A gap means our own send queue dropped a frame, and enters/removals do not
     * self-heal — so the cure is a `ResyncCommand` plus ignoring hot frames until the snapshot arrives.
     *
     * A snapshot is exempt: it *is* the cure, so it is accepted even across a gap (any partially
     * accumulated snapshot is discarded first, because a frame of it may be what went missing).
     */
    private acceptHotFrame;
    private dispatchSignal;
    private startPump;
    private stopPump;
    private pump;
    private maybePing;
    /**
     * Packs every dirty owned entity into `EntityUpdatePacket`s, at most
     * {@link MAX_RECORDS_PER_ENTITY_UPDATE_PACKET} records each (the server's quota), and commits the
     * sent values only for packets the transport actually accepted — a refused packet stays dirty and
     * goes out next tick with *current* values.
     */
    private flushDirtyEntities;
    private getPublishEntry;
    private attachVisibility;
    private detachVisibility;
    /**
     * A hidden tab cannot drain a 20 Hz stream, it buffers it — so we tell the server to suspend our
     * hot plane entirely. It re-snapshots on un-hide, which is also why `Seq` does not gap across one.
     */
    private handleVisibilityChange;
    private sendClientPrefs;
    private resetSessionState;
    private setStatus;
    private notifyPeers;
    private notifyError;
    private rejectPendingConnect;
    /** Reuses one array for the per-frame change batch; listeners get a frozen copy. */
    private beginChanges;
    private flushChanges;
}
/**
 * Bytes for a signal payload: `Uint8Array` verbatim, anything else as UTF-8 JSON (the v0 payload
 * format — debuggable now, schema-packed later without a wire change).
 */
export declare function encodeSignalPayload(payload: NetSignalPayload): Uint8Array;
/** The inverse of {@link encodeSignalPayload} for JSON payloads; `undefined` when it will not parse. */
export declare function decodeSignalPayload<T>(payload: Uint8Array): T | undefined;
/** Re-exported so a host can name the reject codes without reaching into the internal codec. */
export { RejectCode, type RejectCodeValue };
