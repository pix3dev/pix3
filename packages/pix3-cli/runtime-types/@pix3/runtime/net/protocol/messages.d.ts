import { MessageTypeIds } from './type-ids';
/** The empty-payload messages. Their encoding is the single byte `00`: a member count of zero. */
export type EmptyMessage = Record<string, never>;
/**
 * C→S. Must be the **first** frame on a connection; anything else earns `RejectCode.BadRequest` and
 * close 4007.
 */
export interface HelloCommand {
    /**
     * The **highest** version this client speaks. Negotiation is by range, not equality: below the
     * server's minimum is rejected with 4001, anything else runs at `min(this, server)`.
     */
    protocolVersion: number;
    /** Room token (a JWT, or a `dev:<sub>:<roomId>` string in insecure dev mode). */
    token: string;
    /** Room the client wants to join; must match the room bound into the token. */
    roomId: string;
    /** Requested display name. The server may sanitise, truncate or replace it. */
    displayName: string;
    /** Client capability bits. Reserved; send 0. */
    capabilities: number;
    /**
     * The 16-byte key from a previous `WelcomeEvent.resumeKey`, to re-attach a session that dropped
     * inside its grace. `null` — or any stale, wrong or expired value — is simply not a resume: it
     * silently degrades to a fresh join, never an error path.
     */
    resumeKey: Uint8Array | null;
}
/** A `HelloCommand` with every member at its wire default. */
export declare function createHelloCommand(): HelloCommand;
export declare function encodeHelloCommand(message: HelloCommand): Uint8Array;
export declare function decodeHelloCommand(payload: Uint8Array): HelloCommand;
/**
 * S→C. Handshake accepted; the client is now a room member. Followed by a `RoomVarsChangedEvent`,
 * then one or more `RoomRosterEvent`s and one or more `SnapshotPacket`s (each series' last frame
 * carrying `FrameFlags.Final`).
 */
export interface WelcomeEvent {
    /** Room-unique id for this session. Preserved across a successful resume. */
    clientId: number;
    /** The room actually joined. */
    roomId: string;
    /** Room tick rate, for client-side interpolation buffers. */
    tickHz: number;
    /** Server wall clock in Unix milliseconds at send, for clock-offset estimation. */
    serverTimeMs: number;
    /** Tick the join was processed on. */
    serverTick: number;
    /** AOI **enter** radius in world units. Exit is 1.25 × this (hysteresis). */
    aoiRadius: number;
    /** Room member cap. */
    maxPlayers: number;
    /** The **negotiated** session version. Both sides speak it for the whole session. */
    protocolVersion: number;
    /** World-bounds origin X this room quantizes against. */
    worldOriginX: number;
    /** World-bounds origin Y this room quantizes against. */
    worldOriginY: number;
    /** World side length this room quantizes against. */
    worldSize: number;
    /** A `RoomMode` value: relay (client authority) or authoritative. */
    mode: number;
    /** Hard cap on entities this client can be told about at once — a receive-table sizing hint. */
    maxVisibleEntities: number;
    /** Current host (longest-present member), or 0 when none. */
    hostClientId: number;
    /** 16 bytes, regenerated on every connect so a leaked key cannot be replayed for a later session. */
    resumeKey: Uint8Array;
    /**
     * True when this welcome answered a **successful resume**: the client's entities are still alive and
     * its known set was rebuilt, so it must not reset its local state.
     */
    resumed: boolean;
}
/** A `WelcomeEvent` with every member at its wire default. */
export declare function createWelcomeEvent(): WelcomeEvent;
export declare function encodeWelcomeEvent(message: WelcomeEvent): Uint8Array;
export declare function decodeWelcomeEvent(payload: Uint8Array): WelcomeEvent;
/** S→C. Sent before every close whose reason is known, so the client can show a real message. */
export interface RejectedEvent {
    /** A `RejectCode` value, kept as a `ushort` so an unknown code survives a round trip. */
    code: number;
    /** Human-readable detail. Never contains secrets or stack traces. */
    message: string;
}
/** A `RejectedEvent` with every member at its wire default. */
export declare function createRejectedEvent(): RejectedEvent;
export declare function encodeRejectedEvent(message: RejectedEvent): Uint8Array;
export declare function decodeRejectedEvent(payload: Uint8Array): RejectedEvent;
/** C→S round-trip probe; also proof of liveness. */
export interface PingCommand {
    /** Client clock in milliseconds; echoed verbatim in the `PongEvent`. */
    clientTimeMs: number;
}
/** A `PingCommand` with every member at its wire default. */
export declare function createPingCommand(): PingCommand;
export declare function encodePingCommand(message: PingCommand): Uint8Array;
export declare function decodePingCommand(payload: Uint8Array): PingCommand;
/** S→C reply to a `PingCommand`. */
export interface PongEvent {
    /** Echo of `PingCommand.clientTimeMs`. */
    clientTimeMs: number;
    /** Server wall clock in Unix milliseconds when the ping was handled. */
    serverTimeMs: number;
    /** Tick the ping was handled on. */
    serverTick: number;
}
/** A `PongEvent` with every member at its wire default. */
export declare function createPongEvent(): PongEvent;
export declare function encodePongEvent(message: PongEvent): Uint8Array;
export declare function decodePongEvent(payload: Uint8Array): PongEvent;
/** S→C. Fanned out to the existing members after a join. Membership is room-wide, not AOI-filtered. */
export interface PeerJoinedEvent {
    /** The new member's client id. */
    clientId: number;
    /** The name the server accepted for that member. */
    displayName: string;
}
/** A `PeerJoinedEvent` with every member at its wire default. */
export declare function createPeerJoinedEvent(): PeerJoinedEvent;
export declare function encodePeerJoinedEvent(message: PeerJoinedEvent): Uint8Array;
export declare function decodePeerJoinedEvent(payload: Uint8Array): PeerJoinedEvent;
/**
 * S→C. A member is gone; its entities are resolved by their ownership policy. A drop inside the
 * resume grace emits nothing at all, so peers are never told about a blip.
 */
export interface PeerLeftEvent {
    /** The departed member's client id. */
    clientId: number;
    /** A `LeaveReason` value. */
    reason: number;
}
/** A `PeerLeftEvent` with every member at its wire default. */
export declare function createPeerLeftEvent(): PeerLeftEvent;
export declare function encodePeerLeftEvent(message: PeerLeftEvent): Uint8Array;
export declare function decodePeerLeftEvent(payload: Uint8Array): PeerLeftEvent;
/** S→C coarse room telemetry, sent at roughly 1 Hz. Cheap enough to broadcast unfiltered. */
export interface RoomInfoEvent {
    /** Current member count. */
    playerCount: number;
    /** Total live entities in the room (not the AOI-filtered count). */
    entityCount: number;
    /** Tick the sample was taken on. */
    serverTick: number;
}
/** A `RoomInfoEvent` with every member at its wire default. */
export declare function createRoomInfoEvent(): RoomInfoEvent;
export declare function encodeRoomInfoEvent(message: RoomInfoEvent): Uint8Array;
export declare function decodeRoomInfoEvent(payload: Uint8Array): RoomInfoEvent;
/** C→S chat line. Quota-limited; the sender's id comes from the session, never from the payload. */
export interface SendChatCommand {
    /** Message text. Length-capped and sanitised by the server before fan-out. */
    text: string;
}
/** A `SendChatCommand` with every member at its wire default. */
export declare function createSendChatCommand(): SendChatCommand;
export declare function encodeSendChatCommand(message: SendChatCommand): Uint8Array;
export declare function decodeSendChatCommand(payload: Uint8Array): SendChatCommand;
/** S→C chat line attributed to a member. */
export interface ChatMessageEvent {
    /** Sender, resolved by the server from the session that sent the command. */
    clientId: number;
    /** The accepted text. */
    text: string;
}
/** A `ChatMessageEvent` with every member at its wire default. */
export declare function createChatMessageEvent(): ChatMessageEvent;
export declare function encodeChatMessageEvent(message: ChatMessageEvent): Uint8Array;
export declare function decodeChatMessageEvent(payload: Uint8Array): ChatMessageEvent;
/** C→S voluntary goodbye, so peers see `LeaveReason.LeftVoluntarily` instead of a plain disconnect. */
export type LeaveCommand = EmptyMessage;
/** C→S "my known set is untrustworthy, re-send it". Sent when a `Seq` gap is seen. Quota-limited. */
export type ResyncCommand = EmptyMessage;
/** Encodes an empty message: a lone member count of zero. */
export declare function encodeEmptyMessage(): Uint8Array;
/**
 * Decodes an empty message. It still parses the header, so a peer that appended members to a
 * previously-empty message is skipped correctly rather than mistaken for a malformed frame.
 */
export declare function decodeEmptyMessage(payload: Uint8Array): EmptyMessage;
/** C→S. Writes one entry of the room's opaque key/value bag. The server never interprets the bytes. */
export interface SetRoomVarCommand {
    /** Variable name. Length-capped by the server. */
    key: string;
    /** Opaque value. Size-capped by the server; empty means "delete". */
    value: Uint8Array;
}
/** A `SetRoomVarCommand` with every member at its wire default. */
export declare function createSetRoomVarCommand(): SetRoomVarCommand;
export declare function encodeSetRoomVarCommand(message: SetRoomVarCommand): Uint8Array;
export declare function decodeSetRoomVarCommand(payload: Uint8Array): SetRoomVarCommand;
/**
 * S→C. The full room-var set on join, and only the changed subset afterwards.
 * {@link RoomVarsChangedEvent.keys} and {@link RoomVarsChangedEvent.values} are parallel arrays of
 * equal length.
 */
export interface RoomVarsChangedEvent {
    /** Variable names, positionally paired with {@link RoomVarsChangedEvent.values}. */
    keys: string[];
    /** Opaque values, positionally paired with {@link RoomVarsChangedEvent.keys}. */
    values: Uint8Array[];
}
/** A `RoomVarsChangedEvent` with every member at its wire default. */
export declare function createRoomVarsChangedEvent(): RoomVarsChangedEvent;
export declare function encodeRoomVarsChangedEvent(message: RoomVarsChangedEvent): Uint8Array;
export declare function decodeRoomVarsChangedEvent(payload: Uint8Array): RoomVarsChangedEvent;
/** C→S per-client delivery preferences. Neither of them affects the control plane. */
export interface SetClientPrefsCommand {
    /**
     * True suspends this client's hot plane **entirely** (no deltas, no snapshots, no signal batches,
     * and `Seq` stops advancing); un-hiding implies a resync. A backgrounded tab cannot drain a 20 Hz
     * stream, it buffers it.
     */
    hidden: boolean;
    /** Serve this client every `n`th tick. 0 and 1 both mean every tick; the server clamps to `[1, 8]`. */
    sendRateDivisor: number;
}
/** A `SetClientPrefsCommand` with every member at its wire default. */
export declare function createSetClientPrefsCommand(): SetClientPrefsCommand;
export declare function encodeSetClientPrefsCommand(message: SetClientPrefsCommand): Uint8Array;
export declare function decodeSetClientPrefsCommand(payload: Uint8Array): SetClientPrefsCommand;
/**
 * S→C. The room promoted a new host (the longest-present member) and reassigned the `Shared` entities
 * to it. A client may be written for this before the server ever sends it, because an unknown TypeId
 * is ignored rather than fatal.
 */
export interface HostChangedEvent {
    /** The newly promoted host, or 0 when the room has no members left. */
    hostClientId: number;
    /** The host being replaced, or 0 when there was none. */
    previousHostClientId: number;
}
/** A `HostChangedEvent` with every member at its wire default. */
export declare function createHostChangedEvent(): HostChangedEvent;
export declare function encodeHostChangedEvent(message: HostChangedEvent): Uint8Array;
export declare function decodeHostChangedEvent(payload: Uint8Array): HostChangedEvent;
/**
 * S→C. The room's **complete** membership, **including the receiving client itself**, sent on every
 * join and every resume. {@link RoomRosterEvent.clientIds} and {@link RoomRosterEvent.displayNames}
 * are parallel arrays of equal length.
 *
 * It is a **full-state** message, not a delta: replace the roster with it, exactly as a snapshot
 * replaces the known set. `PeerJoinedEvent`/`PeerLeftEvent` carry the changes afterwards, and like
 * them this is room-scoped, never AOI-filtered.
 *
 * **Chunked**: a roster that does not fit the 4 KiB payload cap arrives as several self-contained
 * `RoomRosterEvent`s and only the last carries `FrameFlags.Final`, so a receiver must **accumulate**
 * chunks and commit at `Final`. One chunk is always sent, even for an empty roster, so the completion
 * is never merely implied.
 */
export interface RoomRosterEvent {
    /** Client ids, positionally paired with {@link RoomRosterEvent.displayNames}. */
    clientIds: number[];
    /** Display names, positionally paired with {@link RoomRosterEvent.clientIds}. */
    displayNames: string[];
    /** `FrameFlags`: bit 0 is `Final`. Bits 1–7 are reserved and must be ignored, never rejected. */
    frameFlags: number;
}
/** A `RoomRosterEvent` with every member at its wire default. */
export declare function createRoomRosterEvent(): RoomRosterEvent;
export declare function encodeRoomRosterEvent(message: RoomRosterEvent): Uint8Array;
export declare function decodeRoomRosterEvent(payload: Uint8Array): RoomRosterEvent;
/**
 * C→S. Asks the room to create an entity owned by the sender; answered by exactly one
 * `SpawnEntityResponse`.
 *
 * The initial transform is carried **quantized**, not as floats: the quantized integers are the
 * replicated values everywhere, so a spawn must not be able to introduce a value the delta plane could
 * not have expressed. Convert with `WorldQuantizer` before sending, and reject a non-finite input at
 * that edge rather than here.
 */
export interface SpawnEntityRequest {
    /** Client-chosen correlation id, echoed in the response. Not a net id. */
    requestId: number;
    /** Entity kind, indexing the build's prefab table. Checked against the room's allowlist. */
    kind: number;
    /** Quantized initial world X. */
    qx: number;
    /** Quantized initial world Y. */
    qy: number;
    /** Quantized initial rotation, 256 steps per turn. */
    qrot: number;
    /** Quantized initial velocity along X, 1/8 u/s per step. */
    qvx: number;
    /** Quantized initial velocity along Y, 1/8 u/s per step. */
    qvy: number;
    /** Initial flags: ownership policy in bits 0–1, app bits in 3–7. */
    flags: number;
    /** Optional opaque cold props (JSON bytes by convention). Size-capped by the server. */
    props: Uint8Array | null;
}
/** A `SpawnEntityRequest` with every member at its wire default. */
export declare function createSpawnEntityRequest(): SpawnEntityRequest;
export declare function encodeSpawnEntityRequest(message: SpawnEntityRequest): Uint8Array;
export declare function decodeSpawnEntityRequest(payload: Uint8Array): SpawnEntityRequest;
/** S→C. The answer to one `SpawnEntityRequest`, sent only to the requester. */
export interface SpawnEntityResponse {
    /** Echo of `SpawnEntityRequest.requestId`. */
    requestId: number;
    /** The assigned net id, or 0 when the spawn was refused. */
    netId: number;
    /** A `RejectCode` value; 0 means the spawn succeeded. */
    rejectCode: number;
}
/** A `SpawnEntityResponse` with every member at its wire default. */
export declare function createSpawnEntityResponse(): SpawnEntityResponse;
export declare function encodeSpawnEntityResponse(message: SpawnEntityResponse): Uint8Array;
export declare function decodeSpawnEntityResponse(payload: Uint8Array): SpawnEntityResponse;
/** C→S. Only the owner may despawn an entity; anyone else is refused with `NotEntityOwner`. */
export interface DespawnEntityCommand {
    /** The entity to remove. Its generation bits must still match the live slot. */
    netId: number;
}
/** A `DespawnEntityCommand` with every member at its wire default. */
export declare function createDespawnEntityCommand(): DespawnEntityCommand;
export declare function encodeDespawnEntityCommand(message: DespawnEntityCommand): Uint8Array;
export declare function decodeDespawnEntityCommand(payload: Uint8Array): DespawnEntityCommand;
/**
 * C→S. Replaces the entity's low-frequency opaque blob. Owner-only. Sets `DeltaMask.ColdDirty` for
 * subscribers, which then receive an `EntityPropsChangedEvent`.
 */
export interface SetEntityPropsCommand {
    /** Target entity. */
    netId: number;
    /** Opaque payload (JSON bytes by convention). Quota-limited to 512 B and 2/s per entity. */
    json: Uint8Array;
}
/** A `SetEntityPropsCommand` with every member at its wire default. */
export declare function createSetEntityPropsCommand(): SetEntityPropsCommand;
export declare function encodeSetEntityPropsCommand(message: SetEntityPropsCommand): Uint8Array;
export declare function decodeSetEntityPropsCommand(payload: Uint8Array): SetEntityPropsCommand;
/**
 * S→C. Delivers an entity's cold props. Fanned out **room-wide**, not AOI-scoped, which is why it is
 * rate-limited to 2/s per entity and capped at 512 B.
 */
export interface EntityPropsChangedEvent {
    /** The entity the blob belongs to. */
    netId: number;
    /** Opaque payload, byte-for-byte as the owner set it. */
    json: Uint8Array;
}
/** An `EntityPropsChangedEvent` with every member at its wire default. */
export declare function createEntityPropsChangedEvent(): EntityPropsChangedEvent;
export declare function encodeEntityPropsChangedEvent(message: EntityPropsChangedEvent): Uint8Array;
export declare function decodeEntityPropsChangedEvent(payload: Uint8Array): EntityPropsChangedEvent;
/**
 * C→S. A **signal** is a networked game event; {@link EmitSignalCommand.target} selects the routing.
 * The server never interprets the name or the payload.
 */
export interface EmitSignalCommand {
    /**
     * Application-defined signal name. On the `AoiPeers` path it must fit the 1–64 UTF-8 bytes a
     * `SignalBatchPacket` entry can express.
     */
    name: string;
    /** A `SignalTarget` value selecting the routing. */
    target: number;
    /** Recipient when the target is `SinglePeer`; ignored otherwise. */
    targetClientId: number;
    /** Opaque payload. Above 255 B it is not eligible for the `AoiPeers` hot path at all. */
    payload: Uint8Array;
}
/** An `EmitSignalCommand` with every member at its wire default. */
export declare function createEmitSignalCommand(): EmitSignalCommand;
export declare function encodeEmitSignalCommand(message: EmitSignalCommand): Uint8Array;
export declare function decodeEmitSignalCommand(payload: Uint8Array): EmitSignalCommand;
/**
 * S→C. One relayed signal with the sender stamped by the server, delivered one frame per recipient.
 * This is the `AllPeers`/`SinglePeer` path; AOI-scoped signals travel in a `SignalBatchPacket` instead.
 */
export interface SignalEvent {
    /** Sender, resolved from the session, never copied from the command payload. */
    senderClientId: number;
    /** The signal name as sent. */
    name: string;
    /** The payload as sent. */
    payload: Uint8Array;
}
/** A `SignalEvent` with every member at its wire default. */
export declare function createSignalEvent(): SignalEvent;
export declare function encodeSignalEvent(message: SignalEvent): Uint8Array;
export declare function decodeSignalEvent(payload: Uint8Array): SignalEvent;
/**
 * Every control message, discriminated by its TypeId. The hot-plane packets are deliberately absent:
 * they are hand-packed frames, not MemoryPack objects, and never come through here.
 */
export type ControlMessage = {
    typeId: typeof MessageTypeIds.HelloCommand;
    body: HelloCommand;
} | {
    typeId: typeof MessageTypeIds.WelcomeEvent;
    body: WelcomeEvent;
} | {
    typeId: typeof MessageTypeIds.RejectedEvent;
    body: RejectedEvent;
} | {
    typeId: typeof MessageTypeIds.PingCommand;
    body: PingCommand;
} | {
    typeId: typeof MessageTypeIds.PongEvent;
    body: PongEvent;
} | {
    typeId: typeof MessageTypeIds.PeerJoinedEvent;
    body: PeerJoinedEvent;
} | {
    typeId: typeof MessageTypeIds.PeerLeftEvent;
    body: PeerLeftEvent;
} | {
    typeId: typeof MessageTypeIds.RoomInfoEvent;
    body: RoomInfoEvent;
} | {
    typeId: typeof MessageTypeIds.SendChatCommand;
    body: SendChatCommand;
} | {
    typeId: typeof MessageTypeIds.ChatMessageEvent;
    body: ChatMessageEvent;
} | {
    typeId: typeof MessageTypeIds.LeaveCommand;
    body: LeaveCommand;
} | {
    typeId: typeof MessageTypeIds.SetRoomVarCommand;
    body: SetRoomVarCommand;
} | {
    typeId: typeof MessageTypeIds.RoomVarsChangedEvent;
    body: RoomVarsChangedEvent;
} | {
    typeId: typeof MessageTypeIds.ResyncCommand;
    body: ResyncCommand;
} | {
    typeId: typeof MessageTypeIds.SetClientPrefsCommand;
    body: SetClientPrefsCommand;
} | {
    typeId: typeof MessageTypeIds.HostChangedEvent;
    body: HostChangedEvent;
} | {
    typeId: typeof MessageTypeIds.RoomRosterEvent;
    body: RoomRosterEvent;
} | {
    typeId: typeof MessageTypeIds.SpawnEntityRequest;
    body: SpawnEntityRequest;
} | {
    typeId: typeof MessageTypeIds.SpawnEntityResponse;
    body: SpawnEntityResponse;
} | {
    typeId: typeof MessageTypeIds.DespawnEntityCommand;
    body: DespawnEntityCommand;
} | {
    typeId: typeof MessageTypeIds.SetEntityPropsCommand;
    body: SetEntityPropsCommand;
} | {
    typeId: typeof MessageTypeIds.EntityPropsChangedEvent;
    body: EntityPropsChangedEvent;
} | {
    typeId: typeof MessageTypeIds.EmitSignalCommand;
    body: EmitSignalCommand;
} | {
    typeId: typeof MessageTypeIds.SignalEvent;
    body: SignalEvent;
};
/** True when this TypeId names a MemoryPack control message this build knows how to decode. */
export declare function isKnownControlTypeId(typeId: number): boolean;
/**
 * Decodes one control payload, or returns `undefined` for a TypeId this build does not know.
 *
 * `undefined` is **not** an error: an unknown TypeId is ignored and counted, never fatal, which is
 * what lets a game published six months ago keep working when the fabric adds messages. Count the
 * miss with an `UnknownTypeIdTally`. A payload that *is* known but malformed still throws — that is a
 * broken peer, not an old one.
 */
export declare function decodeControlMessage(typeId: number, payload: Uint8Array): ControlMessage | undefined;
/** Encodes a control message into a complete frame: `[u8 TypeId][MemoryPack payload]`. */
export declare function encodeControlMessage(message: ControlMessage): Uint8Array;
/** Encodes a control message's payload, without the TypeId byte. */
export declare function encodeControlPayload(message: ControlMessage): Uint8Array;
