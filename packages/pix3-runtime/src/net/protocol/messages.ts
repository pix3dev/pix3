/**
 * The 24 control-plane messages, hand-written against MemoryPack's version-tolerant object format.
 *
 * Every message here is **version-tolerant with explicit member ordering**, which is what lets a field
 * be appended without a protocol version bump. Two rules follow from that and are obeyed by every
 * codec below:
 *
 * - **Writing** emits every member this version defines, in order, never a prefix — the reader on the
 *   other side matches members by position, not by name.
 * - **Reading** visits `min(theirMemberCount, ours)` members: a longer object leaves its surplus
 *   unvisited (and therefore skipped, using the declared lengths the reader already parsed), a shorter
 *   one leaves our surplus fields at their defaults.
 *
 * An `encode…` returns the **payload only** — no TypeId. Use `encodeFrame` (or
 * {@link encodeControlMessage}) to put it on the wire. The hot plane (67/68/69/130) never comes
 * through here; see `hot-wire.ts`.
 */
import { MemoryPackReader } from './MemoryPackReader';
import { MemoryPackWriter } from './MemoryPackWriter';
import { MessageTypeIds, encodeFrame } from './type-ids';

/** The empty-payload messages. Their encoding is the single byte `00`: a member count of zero. */
export type EmptyMessage = Record<string, never>;

const EMPTY_BYTES = new Uint8Array(0);

// ── HelloCommand (1, C→S) ────────────────────────────────────────────────────

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
export function createHelloCommand(): HelloCommand {
  return {
    protocolVersion: 0,
    token: '',
    roomId: '',
    displayName: '',
    capabilities: 0,
    resumeKey: null,
  };
}

export function encodeHelloCommand(message: HelloCommand): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeUint16(message.protocolVersion);
  w.endMember();
  w.writeString(message.token);
  w.endMember();
  w.writeString(message.roomId);
  w.endMember();
  w.writeString(message.displayName);
  w.endMember();
  w.writeUint16(message.capabilities);
  w.endMember();
  w.writeBytes(message.resumeKey);
  w.endMember();
  return w.finish();
}

export function decodeHelloCommand(payload: Uint8Array): HelloCommand {
  const r = new MemoryPackReader(payload);
  const message = createHelloCommand();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.protocolVersion = r.readUint16();
  }
  if (r.hasMember(1)) {
    r.seekMember(1);
    message.token = r.readString() ?? '';
  }
  if (r.hasMember(2)) {
    r.seekMember(2);
    message.roomId = r.readString() ?? '';
  }
  if (r.hasMember(3)) {
    r.seekMember(3);
    message.displayName = r.readString() ?? '';
  }
  if (r.hasMember(4)) {
    r.seekMember(4);
    message.capabilities = r.readUint16();
  }
  if (r.hasMember(5)) {
    r.seekMember(5);
    message.resumeKey = r.readBytes();
  }
  return message;
}

// ── WelcomeEvent (2, S→C) ────────────────────────────────────────────────────

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
export function createWelcomeEvent(): WelcomeEvent {
  return {
    clientId: 0,
    roomId: '',
    tickHz: 0,
    serverTimeMs: 0,
    serverTick: 0,
    aoiRadius: 0,
    maxPlayers: 0,
    protocolVersion: 0,
    worldOriginX: 0,
    worldOriginY: 0,
    worldSize: 0,
    mode: 0,
    maxVisibleEntities: 0,
    hostClientId: 0,
    resumeKey: EMPTY_BYTES,
    resumed: false,
  };
}

export function encodeWelcomeEvent(message: WelcomeEvent): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeUint32(message.clientId);
  w.endMember();
  w.writeString(message.roomId);
  w.endMember();
  w.writeUint8(message.tickHz);
  w.endMember();
  w.writeInt64(message.serverTimeMs);
  w.endMember();
  w.writeUint32(message.serverTick);
  w.endMember();
  w.writeFloat32(message.aoiRadius);
  w.endMember();
  w.writeUint16(message.maxPlayers);
  w.endMember();
  w.writeUint16(message.protocolVersion);
  w.endMember();
  w.writeFloat32(message.worldOriginX);
  w.endMember();
  w.writeFloat32(message.worldOriginY);
  w.endMember();
  w.writeFloat32(message.worldSize);
  w.endMember();
  w.writeUint8(message.mode);
  w.endMember();
  w.writeUint16(message.maxVisibleEntities);
  w.endMember();
  w.writeUint32(message.hostClientId);
  w.endMember();
  w.writeBytes(message.resumeKey);
  w.endMember();
  w.writeBool(message.resumed);
  w.endMember();
  return w.finish();
}

export function decodeWelcomeEvent(payload: Uint8Array): WelcomeEvent {
  const r = new MemoryPackReader(payload);
  const message = createWelcomeEvent();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.clientId = r.readUint32();
  }
  if (r.hasMember(1)) {
    r.seekMember(1);
    message.roomId = r.readString() ?? '';
  }
  if (r.hasMember(2)) {
    r.seekMember(2);
    message.tickHz = r.readUint8();
  }
  if (r.hasMember(3)) {
    r.seekMember(3);
    message.serverTimeMs = r.readInt64AsNumber();
  }
  if (r.hasMember(4)) {
    r.seekMember(4);
    message.serverTick = r.readUint32();
  }
  if (r.hasMember(5)) {
    r.seekMember(5);
    message.aoiRadius = r.readFloat32();
  }
  if (r.hasMember(6)) {
    r.seekMember(6);
    message.maxPlayers = r.readUint16();
  }
  if (r.hasMember(7)) {
    r.seekMember(7);
    message.protocolVersion = r.readUint16();
  }
  if (r.hasMember(8)) {
    r.seekMember(8);
    message.worldOriginX = r.readFloat32();
  }
  if (r.hasMember(9)) {
    r.seekMember(9);
    message.worldOriginY = r.readFloat32();
  }
  if (r.hasMember(10)) {
    r.seekMember(10);
    message.worldSize = r.readFloat32();
  }
  if (r.hasMember(11)) {
    r.seekMember(11);
    message.mode = r.readUint8();
  }
  if (r.hasMember(12)) {
    r.seekMember(12);
    message.maxVisibleEntities = r.readUint16();
  }
  if (r.hasMember(13)) {
    r.seekMember(13);
    message.hostClientId = r.readUint32();
  }
  if (r.hasMember(14)) {
    r.seekMember(14);
    message.resumeKey = r.readBytes() ?? EMPTY_BYTES;
  }
  if (r.hasMember(15)) {
    r.seekMember(15);
    message.resumed = r.readBool();
  }
  return message;
}

// ── RejectedEvent (3, S→C) ───────────────────────────────────────────────────

/** S→C. Sent before every close whose reason is known, so the client can show a real message. */
export interface RejectedEvent {
  /** A `RejectCode` value, kept as a `ushort` so an unknown code survives a round trip. */
  code: number;
  /** Human-readable detail. Never contains secrets or stack traces. */
  message: string;
}

/** A `RejectedEvent` with every member at its wire default. */
export function createRejectedEvent(): RejectedEvent {
  return { code: 0, message: '' };
}

export function encodeRejectedEvent(message: RejectedEvent): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeUint16(message.code);
  w.endMember();
  w.writeString(message.message);
  w.endMember();
  return w.finish();
}

export function decodeRejectedEvent(payload: Uint8Array): RejectedEvent {
  const r = new MemoryPackReader(payload);
  const message = createRejectedEvent();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.code = r.readUint16();
  }
  if (r.hasMember(1)) {
    r.seekMember(1);
    message.message = r.readString() ?? '';
  }
  return message;
}

// ── PingCommand (4, C→S) ─────────────────────────────────────────────────────

/** C→S round-trip probe; also proof of liveness. */
export interface PingCommand {
  /** Client clock in milliseconds; echoed verbatim in the `PongEvent`. */
  clientTimeMs: number;
}

/** A `PingCommand` with every member at its wire default. */
export function createPingCommand(): PingCommand {
  return { clientTimeMs: 0 };
}

export function encodePingCommand(message: PingCommand): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeInt64(message.clientTimeMs);
  w.endMember();
  return w.finish();
}

export function decodePingCommand(payload: Uint8Array): PingCommand {
  const r = new MemoryPackReader(payload);
  const message = createPingCommand();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.clientTimeMs = r.readInt64AsNumber();
  }
  return message;
}

// ── PongEvent (5, S→C) ───────────────────────────────────────────────────────

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
export function createPongEvent(): PongEvent {
  return { clientTimeMs: 0, serverTimeMs: 0, serverTick: 0 };
}

export function encodePongEvent(message: PongEvent): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeInt64(message.clientTimeMs);
  w.endMember();
  w.writeInt64(message.serverTimeMs);
  w.endMember();
  w.writeUint32(message.serverTick);
  w.endMember();
  return w.finish();
}

export function decodePongEvent(payload: Uint8Array): PongEvent {
  const r = new MemoryPackReader(payload);
  const message = createPongEvent();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.clientTimeMs = r.readInt64AsNumber();
  }
  if (r.hasMember(1)) {
    r.seekMember(1);
    message.serverTimeMs = r.readInt64AsNumber();
  }
  if (r.hasMember(2)) {
    r.seekMember(2);
    message.serverTick = r.readUint32();
  }
  return message;
}

// ── PeerJoinedEvent (6, S→C) ─────────────────────────────────────────────────

/** S→C. Fanned out to the existing members after a join. Membership is room-wide, not AOI-filtered. */
export interface PeerJoinedEvent {
  /** The new member's client id. */
  clientId: number;
  /** The name the server accepted for that member. */
  displayName: string;
}

/** A `PeerJoinedEvent` with every member at its wire default. */
export function createPeerJoinedEvent(): PeerJoinedEvent {
  return { clientId: 0, displayName: '' };
}

export function encodePeerJoinedEvent(message: PeerJoinedEvent): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeUint32(message.clientId);
  w.endMember();
  w.writeString(message.displayName);
  w.endMember();
  return w.finish();
}

export function decodePeerJoinedEvent(payload: Uint8Array): PeerJoinedEvent {
  const r = new MemoryPackReader(payload);
  const message = createPeerJoinedEvent();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.clientId = r.readUint32();
  }
  if (r.hasMember(1)) {
    r.seekMember(1);
    message.displayName = r.readString() ?? '';
  }
  return message;
}

// ── PeerLeftEvent (7, S→C) ───────────────────────────────────────────────────

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
export function createPeerLeftEvent(): PeerLeftEvent {
  return { clientId: 0, reason: 0 };
}

export function encodePeerLeftEvent(message: PeerLeftEvent): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeUint32(message.clientId);
  w.endMember();
  w.writeUint8(message.reason);
  w.endMember();
  return w.finish();
}

export function decodePeerLeftEvent(payload: Uint8Array): PeerLeftEvent {
  const r = new MemoryPackReader(payload);
  const message = createPeerLeftEvent();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.clientId = r.readUint32();
  }
  if (r.hasMember(1)) {
    r.seekMember(1);
    message.reason = r.readUint8();
  }
  return message;
}

// ── RoomInfoEvent (8, S→C) ───────────────────────────────────────────────────

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
export function createRoomInfoEvent(): RoomInfoEvent {
  return { playerCount: 0, entityCount: 0, serverTick: 0 };
}

export function encodeRoomInfoEvent(message: RoomInfoEvent): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeUint16(message.playerCount);
  w.endMember();
  w.writeUint16(message.entityCount);
  w.endMember();
  w.writeUint32(message.serverTick);
  w.endMember();
  return w.finish();
}

export function decodeRoomInfoEvent(payload: Uint8Array): RoomInfoEvent {
  const r = new MemoryPackReader(payload);
  const message = createRoomInfoEvent();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.playerCount = r.readUint16();
  }
  if (r.hasMember(1)) {
    r.seekMember(1);
    message.entityCount = r.readUint16();
  }
  if (r.hasMember(2)) {
    r.seekMember(2);
    message.serverTick = r.readUint32();
  }
  return message;
}

// ── SendChatCommand (9, C→S) ─────────────────────────────────────────────────

/** C→S chat line. Quota-limited; the sender's id comes from the session, never from the payload. */
export interface SendChatCommand {
  /** Message text. Length-capped and sanitised by the server before fan-out. */
  text: string;
}

/** A `SendChatCommand` with every member at its wire default. */
export function createSendChatCommand(): SendChatCommand {
  return { text: '' };
}

export function encodeSendChatCommand(message: SendChatCommand): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeString(message.text);
  w.endMember();
  return w.finish();
}

export function decodeSendChatCommand(payload: Uint8Array): SendChatCommand {
  const r = new MemoryPackReader(payload);
  const message = createSendChatCommand();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.text = r.readString() ?? '';
  }
  return message;
}

// ── ChatMessageEvent (10, S→C) ───────────────────────────────────────────────

/** S→C chat line attributed to a member. */
export interface ChatMessageEvent {
  /** Sender, resolved by the server from the session that sent the command. */
  clientId: number;
  /** The accepted text. */
  text: string;
}

/** A `ChatMessageEvent` with every member at its wire default. */
export function createChatMessageEvent(): ChatMessageEvent {
  return { clientId: 0, text: '' };
}

export function encodeChatMessageEvent(message: ChatMessageEvent): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeUint32(message.clientId);
  w.endMember();
  w.writeString(message.text);
  w.endMember();
  return w.finish();
}

export function decodeChatMessageEvent(payload: Uint8Array): ChatMessageEvent {
  const r = new MemoryPackReader(payload);
  const message = createChatMessageEvent();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.clientId = r.readUint32();
  }
  if (r.hasMember(1)) {
    r.seekMember(1);
    message.text = r.readString() ?? '';
  }
  return message;
}

// ── LeaveCommand (11, C→S) and ResyncCommand (14, C→S) ───────────────────────

/** C→S voluntary goodbye, so peers see `LeaveReason.LeftVoluntarily` instead of a plain disconnect. */
export type LeaveCommand = EmptyMessage;

/** C→S "my known set is untrustworthy, re-send it". Sent when a `Seq` gap is seen. Quota-limited. */
export type ResyncCommand = EmptyMessage;

/** Encodes an empty message: a lone member count of zero. */
export function encodeEmptyMessage(): Uint8Array {
  return new MemoryPackWriter(1).finish();
}

/**
 * Decodes an empty message. It still parses the header, so a peer that appended members to a
 * previously-empty message is skipped correctly rather than mistaken for a malformed frame.
 */
export function decodeEmptyMessage(payload: Uint8Array): EmptyMessage {
  // Parsing validates the header and throws on a malformed one; there is nothing to read out.
  new MemoryPackReader(payload);
  return {};
}

// ── SetRoomVarCommand (12, C→S) ──────────────────────────────────────────────

/** C→S. Writes one entry of the room's opaque key/value bag. The server never interprets the bytes. */
export interface SetRoomVarCommand {
  /** Variable name. Length-capped by the server. */
  key: string;
  /** Opaque value. Size-capped by the server; empty means "delete". */
  value: Uint8Array;
}

/** A `SetRoomVarCommand` with every member at its wire default. */
export function createSetRoomVarCommand(): SetRoomVarCommand {
  return { key: '', value: EMPTY_BYTES };
}

export function encodeSetRoomVarCommand(message: SetRoomVarCommand): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeString(message.key);
  w.endMember();
  w.writeBytes(message.value);
  w.endMember();
  return w.finish();
}

export function decodeSetRoomVarCommand(payload: Uint8Array): SetRoomVarCommand {
  const r = new MemoryPackReader(payload);
  const message = createSetRoomVarCommand();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.key = r.readString() ?? '';
  }
  if (r.hasMember(1)) {
    r.seekMember(1);
    message.value = r.readBytes() ?? EMPTY_BYTES;
  }
  return message;
}

// ── RoomVarsChangedEvent (13, S→C) ───────────────────────────────────────────

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
export function createRoomVarsChangedEvent(): RoomVarsChangedEvent {
  return { keys: [], values: [] };
}

export function encodeRoomVarsChangedEvent(message: RoomVarsChangedEvent): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeStringArray(message.keys);
  w.endMember();
  w.writeBytesArray(message.values);
  w.endMember();
  return w.finish();
}

export function decodeRoomVarsChangedEvent(payload: Uint8Array): RoomVarsChangedEvent {
  const r = new MemoryPackReader(payload);
  const message = createRoomVarsChangedEvent();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.keys = (r.readStringArray() ?? []).map(key => key ?? '');
  }
  if (r.hasMember(1)) {
    r.seekMember(1);
    message.values = (r.readBytesArray() ?? []).map(value => value ?? EMPTY_BYTES);
  }
  return message;
}

// ── SetClientPrefsCommand (15, C→S) ──────────────────────────────────────────

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
export function createSetClientPrefsCommand(): SetClientPrefsCommand {
  return { hidden: false, sendRateDivisor: 0 };
}

export function encodeSetClientPrefsCommand(message: SetClientPrefsCommand): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeBool(message.hidden);
  w.endMember();
  w.writeUint8(message.sendRateDivisor);
  w.endMember();
  return w.finish();
}

export function decodeSetClientPrefsCommand(payload: Uint8Array): SetClientPrefsCommand {
  const r = new MemoryPackReader(payload);
  const message = createSetClientPrefsCommand();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.hidden = r.readBool();
  }
  if (r.hasMember(1)) {
    r.seekMember(1);
    message.sendRateDivisor = r.readUint8();
  }
  return message;
}

// ── HostChangedEvent (16, S→C) ───────────────────────────────────────────────

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
export function createHostChangedEvent(): HostChangedEvent {
  return { hostClientId: 0, previousHostClientId: 0 };
}

export function encodeHostChangedEvent(message: HostChangedEvent): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeUint32(message.hostClientId);
  w.endMember();
  w.writeUint32(message.previousHostClientId);
  w.endMember();
  return w.finish();
}

export function decodeHostChangedEvent(payload: Uint8Array): HostChangedEvent {
  const r = new MemoryPackReader(payload);
  const message = createHostChangedEvent();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.hostClientId = r.readUint32();
  }
  if (r.hasMember(1)) {
    r.seekMember(1);
    message.previousHostClientId = r.readUint32();
  }
  return message;
}

// ── RoomRosterEvent (17, S→C) ────────────────────────────────────────────────

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
export function createRoomRosterEvent(): RoomRosterEvent {
  return { clientIds: [], displayNames: [], frameFlags: 0 };
}

export function encodeRoomRosterEvent(message: RoomRosterEvent): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeUint32Array(message.clientIds);
  w.endMember();
  w.writeStringArray(message.displayNames);
  w.endMember();
  w.writeUint8(message.frameFlags);
  w.endMember();
  return w.finish();
}

export function decodeRoomRosterEvent(payload: Uint8Array): RoomRosterEvent {
  const r = new MemoryPackReader(payload);
  const message = createRoomRosterEvent();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.clientIds = r.readUint32Array() ?? [];
  }
  if (r.hasMember(1)) {
    r.seekMember(1);
    message.displayNames = (r.readStringArray() ?? []).map(name => name ?? '');
  }
  if (r.hasMember(2)) {
    r.seekMember(2);
    message.frameFlags = r.readUint8();
  }
  return message;
}

// ── SpawnEntityRequest (64, C→S) ─────────────────────────────────────────────

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
export function createSpawnEntityRequest(): SpawnEntityRequest {
  return { requestId: 0, kind: 0, qx: 0, qy: 0, qrot: 0, qvx: 0, qvy: 0, flags: 0, props: null };
}

export function encodeSpawnEntityRequest(message: SpawnEntityRequest): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeUint32(message.requestId);
  w.endMember();
  w.writeUint16(message.kind);
  w.endMember();
  w.writeUint16(message.qx);
  w.endMember();
  w.writeUint16(message.qy);
  w.endMember();
  w.writeUint8(message.qrot);
  w.endMember();
  w.writeInt16(message.qvx);
  w.endMember();
  w.writeInt16(message.qvy);
  w.endMember();
  w.writeUint8(message.flags);
  w.endMember();
  w.writeBytes(message.props);
  w.endMember();
  return w.finish();
}

export function decodeSpawnEntityRequest(payload: Uint8Array): SpawnEntityRequest {
  const r = new MemoryPackReader(payload);
  const message = createSpawnEntityRequest();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.requestId = r.readUint32();
  }
  if (r.hasMember(1)) {
    r.seekMember(1);
    message.kind = r.readUint16();
  }
  if (r.hasMember(2)) {
    r.seekMember(2);
    message.qx = r.readUint16();
  }
  if (r.hasMember(3)) {
    r.seekMember(3);
    message.qy = r.readUint16();
  }
  if (r.hasMember(4)) {
    r.seekMember(4);
    message.qrot = r.readUint8();
  }
  if (r.hasMember(5)) {
    r.seekMember(5);
    message.qvx = r.readInt16();
  }
  if (r.hasMember(6)) {
    r.seekMember(6);
    message.qvy = r.readInt16();
  }
  if (r.hasMember(7)) {
    r.seekMember(7);
    message.flags = r.readUint8();
  }
  if (r.hasMember(8)) {
    r.seekMember(8);
    message.props = r.readBytes();
  }
  return message;
}

// ── SpawnEntityResponse (65, S→C) ────────────────────────────────────────────

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
export function createSpawnEntityResponse(): SpawnEntityResponse {
  return { requestId: 0, netId: 0, rejectCode: 0 };
}

export function encodeSpawnEntityResponse(message: SpawnEntityResponse): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeUint32(message.requestId);
  w.endMember();
  w.writeUint32(message.netId);
  w.endMember();
  w.writeUint16(message.rejectCode);
  w.endMember();
  return w.finish();
}

export function decodeSpawnEntityResponse(payload: Uint8Array): SpawnEntityResponse {
  const r = new MemoryPackReader(payload);
  const message = createSpawnEntityResponse();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.requestId = r.readUint32();
  }
  if (r.hasMember(1)) {
    r.seekMember(1);
    message.netId = r.readUint32();
  }
  if (r.hasMember(2)) {
    r.seekMember(2);
    message.rejectCode = r.readUint16();
  }
  return message;
}

// ── DespawnEntityCommand (66, C→S) ───────────────────────────────────────────

/** C→S. Only the owner may despawn an entity; anyone else is refused with `NotEntityOwner`. */
export interface DespawnEntityCommand {
  /** The entity to remove. Its generation bits must still match the live slot. */
  netId: number;
}

/** A `DespawnEntityCommand` with every member at its wire default. */
export function createDespawnEntityCommand(): DespawnEntityCommand {
  return { netId: 0 };
}

export function encodeDespawnEntityCommand(message: DespawnEntityCommand): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeUint32(message.netId);
  w.endMember();
  return w.finish();
}

export function decodeDespawnEntityCommand(payload: Uint8Array): DespawnEntityCommand {
  const r = new MemoryPackReader(payload);
  const message = createDespawnEntityCommand();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.netId = r.readUint32();
  }
  return message;
}

// ── SetEntityPropsCommand (70, C→S) ──────────────────────────────────────────

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
export function createSetEntityPropsCommand(): SetEntityPropsCommand {
  return { netId: 0, json: EMPTY_BYTES };
}

export function encodeSetEntityPropsCommand(message: SetEntityPropsCommand): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeUint32(message.netId);
  w.endMember();
  w.writeBytes(message.json);
  w.endMember();
  return w.finish();
}

export function decodeSetEntityPropsCommand(payload: Uint8Array): SetEntityPropsCommand {
  const r = new MemoryPackReader(payload);
  const message = createSetEntityPropsCommand();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.netId = r.readUint32();
  }
  if (r.hasMember(1)) {
    r.seekMember(1);
    message.json = r.readBytes() ?? EMPTY_BYTES;
  }
  return message;
}

// ── EntityPropsChangedEvent (71, S→C) ────────────────────────────────────────

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
export function createEntityPropsChangedEvent(): EntityPropsChangedEvent {
  return { netId: 0, json: EMPTY_BYTES };
}

export function encodeEntityPropsChangedEvent(message: EntityPropsChangedEvent): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeUint32(message.netId);
  w.endMember();
  w.writeBytes(message.json);
  w.endMember();
  return w.finish();
}

export function decodeEntityPropsChangedEvent(payload: Uint8Array): EntityPropsChangedEvent {
  const r = new MemoryPackReader(payload);
  const message = createEntityPropsChangedEvent();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.netId = r.readUint32();
  }
  if (r.hasMember(1)) {
    r.seekMember(1);
    message.json = r.readBytes() ?? EMPTY_BYTES;
  }
  return message;
}

// ── EmitSignalCommand (128, C→S) ─────────────────────────────────────────────

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
export function createEmitSignalCommand(): EmitSignalCommand {
  return { name: '', target: 0, targetClientId: 0, payload: EMPTY_BYTES };
}

export function encodeEmitSignalCommand(message: EmitSignalCommand): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeString(message.name);
  w.endMember();
  w.writeUint8(message.target);
  w.endMember();
  w.writeUint32(message.targetClientId);
  w.endMember();
  w.writeBytes(message.payload);
  w.endMember();
  return w.finish();
}

export function decodeEmitSignalCommand(payload: Uint8Array): EmitSignalCommand {
  const r = new MemoryPackReader(payload);
  const message = createEmitSignalCommand();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.name = r.readString() ?? '';
  }
  if (r.hasMember(1)) {
    r.seekMember(1);
    message.target = r.readUint8();
  }
  if (r.hasMember(2)) {
    r.seekMember(2);
    message.targetClientId = r.readUint32();
  }
  if (r.hasMember(3)) {
    r.seekMember(3);
    message.payload = r.readBytes() ?? EMPTY_BYTES;
  }
  return message;
}

// ── SignalEvent (129, S→C) ───────────────────────────────────────────────────

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
export function createSignalEvent(): SignalEvent {
  return { senderClientId: 0, name: '', payload: EMPTY_BYTES };
}

export function encodeSignalEvent(message: SignalEvent): Uint8Array {
  const w = new MemoryPackWriter();
  w.writeUint32(message.senderClientId);
  w.endMember();
  w.writeString(message.name);
  w.endMember();
  w.writeBytes(message.payload);
  w.endMember();
  return w.finish();
}

export function decodeSignalEvent(payload: Uint8Array): SignalEvent {
  const r = new MemoryPackReader(payload);
  const message = createSignalEvent();
  if (r.hasMember(0)) {
    r.seekMember(0);
    message.senderClientId = r.readUint32();
  }
  if (r.hasMember(1)) {
    r.seekMember(1);
    message.name = r.readString() ?? '';
  }
  if (r.hasMember(2)) {
    r.seekMember(2);
    message.payload = r.readBytes() ?? EMPTY_BYTES;
  }
  return message;
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * Every control message, discriminated by its TypeId. The hot-plane packets are deliberately absent:
 * they are hand-packed frames, not MemoryPack objects, and never come through here.
 */
export type ControlMessage =
  | { typeId: typeof MessageTypeIds.HelloCommand; body: HelloCommand }
  | { typeId: typeof MessageTypeIds.WelcomeEvent; body: WelcomeEvent }
  | { typeId: typeof MessageTypeIds.RejectedEvent; body: RejectedEvent }
  | { typeId: typeof MessageTypeIds.PingCommand; body: PingCommand }
  | { typeId: typeof MessageTypeIds.PongEvent; body: PongEvent }
  | { typeId: typeof MessageTypeIds.PeerJoinedEvent; body: PeerJoinedEvent }
  | { typeId: typeof MessageTypeIds.PeerLeftEvent; body: PeerLeftEvent }
  | { typeId: typeof MessageTypeIds.RoomInfoEvent; body: RoomInfoEvent }
  | { typeId: typeof MessageTypeIds.SendChatCommand; body: SendChatCommand }
  | { typeId: typeof MessageTypeIds.ChatMessageEvent; body: ChatMessageEvent }
  | { typeId: typeof MessageTypeIds.LeaveCommand; body: LeaveCommand }
  | { typeId: typeof MessageTypeIds.SetRoomVarCommand; body: SetRoomVarCommand }
  | { typeId: typeof MessageTypeIds.RoomVarsChangedEvent; body: RoomVarsChangedEvent }
  | { typeId: typeof MessageTypeIds.ResyncCommand; body: ResyncCommand }
  | { typeId: typeof MessageTypeIds.SetClientPrefsCommand; body: SetClientPrefsCommand }
  | { typeId: typeof MessageTypeIds.HostChangedEvent; body: HostChangedEvent }
  | { typeId: typeof MessageTypeIds.RoomRosterEvent; body: RoomRosterEvent }
  | { typeId: typeof MessageTypeIds.SpawnEntityRequest; body: SpawnEntityRequest }
  | { typeId: typeof MessageTypeIds.SpawnEntityResponse; body: SpawnEntityResponse }
  | { typeId: typeof MessageTypeIds.DespawnEntityCommand; body: DespawnEntityCommand }
  | { typeId: typeof MessageTypeIds.SetEntityPropsCommand; body: SetEntityPropsCommand }
  | { typeId: typeof MessageTypeIds.EntityPropsChangedEvent; body: EntityPropsChangedEvent }
  | { typeId: typeof MessageTypeIds.EmitSignalCommand; body: EmitSignalCommand }
  | { typeId: typeof MessageTypeIds.SignalEvent; body: SignalEvent };

/** True when this TypeId names a MemoryPack control message this build knows how to decode. */
export function isKnownControlTypeId(typeId: number): boolean {
  return KNOWN_CONTROL_TYPE_IDS.has(typeId);
}

const KNOWN_CONTROL_TYPE_IDS: ReadonlySet<number> = new Set<number>([
  MessageTypeIds.HelloCommand,
  MessageTypeIds.WelcomeEvent,
  MessageTypeIds.RejectedEvent,
  MessageTypeIds.PingCommand,
  MessageTypeIds.PongEvent,
  MessageTypeIds.PeerJoinedEvent,
  MessageTypeIds.PeerLeftEvent,
  MessageTypeIds.RoomInfoEvent,
  MessageTypeIds.SendChatCommand,
  MessageTypeIds.ChatMessageEvent,
  MessageTypeIds.LeaveCommand,
  MessageTypeIds.SetRoomVarCommand,
  MessageTypeIds.RoomVarsChangedEvent,
  MessageTypeIds.ResyncCommand,
  MessageTypeIds.SetClientPrefsCommand,
  MessageTypeIds.HostChangedEvent,
  MessageTypeIds.RoomRosterEvent,
  MessageTypeIds.SpawnEntityRequest,
  MessageTypeIds.SpawnEntityResponse,
  MessageTypeIds.DespawnEntityCommand,
  MessageTypeIds.SetEntityPropsCommand,
  MessageTypeIds.EntityPropsChangedEvent,
  MessageTypeIds.EmitSignalCommand,
  MessageTypeIds.SignalEvent,
]);

/**
 * Decodes one control payload, or returns `undefined` for a TypeId this build does not know.
 *
 * `undefined` is **not** an error: an unknown TypeId is ignored and counted, never fatal, which is
 * what lets a game published six months ago keep working when the fabric adds messages. Count the
 * miss with an `UnknownTypeIdTally`. A payload that *is* known but malformed still throws — that is a
 * broken peer, not an old one.
 */
export function decodeControlMessage(
  typeId: number,
  payload: Uint8Array
): ControlMessage | undefined {
  switch (typeId) {
    case MessageTypeIds.HelloCommand:
      return { typeId, body: decodeHelloCommand(payload) };
    case MessageTypeIds.WelcomeEvent:
      return { typeId, body: decodeWelcomeEvent(payload) };
    case MessageTypeIds.RejectedEvent:
      return { typeId, body: decodeRejectedEvent(payload) };
    case MessageTypeIds.PingCommand:
      return { typeId, body: decodePingCommand(payload) };
    case MessageTypeIds.PongEvent:
      return { typeId, body: decodePongEvent(payload) };
    case MessageTypeIds.PeerJoinedEvent:
      return { typeId, body: decodePeerJoinedEvent(payload) };
    case MessageTypeIds.PeerLeftEvent:
      return { typeId, body: decodePeerLeftEvent(payload) };
    case MessageTypeIds.RoomInfoEvent:
      return { typeId, body: decodeRoomInfoEvent(payload) };
    case MessageTypeIds.SendChatCommand:
      return { typeId, body: decodeSendChatCommand(payload) };
    case MessageTypeIds.ChatMessageEvent:
      return { typeId, body: decodeChatMessageEvent(payload) };
    case MessageTypeIds.LeaveCommand:
      return { typeId, body: decodeEmptyMessage(payload) };
    case MessageTypeIds.SetRoomVarCommand:
      return { typeId, body: decodeSetRoomVarCommand(payload) };
    case MessageTypeIds.RoomVarsChangedEvent:
      return { typeId, body: decodeRoomVarsChangedEvent(payload) };
    case MessageTypeIds.ResyncCommand:
      return { typeId, body: decodeEmptyMessage(payload) };
    case MessageTypeIds.SetClientPrefsCommand:
      return { typeId, body: decodeSetClientPrefsCommand(payload) };
    case MessageTypeIds.HostChangedEvent:
      return { typeId, body: decodeHostChangedEvent(payload) };
    case MessageTypeIds.RoomRosterEvent:
      return { typeId, body: decodeRoomRosterEvent(payload) };
    case MessageTypeIds.SpawnEntityRequest:
      return { typeId, body: decodeSpawnEntityRequest(payload) };
    case MessageTypeIds.SpawnEntityResponse:
      return { typeId, body: decodeSpawnEntityResponse(payload) };
    case MessageTypeIds.DespawnEntityCommand:
      return { typeId, body: decodeDespawnEntityCommand(payload) };
    case MessageTypeIds.SetEntityPropsCommand:
      return { typeId, body: decodeSetEntityPropsCommand(payload) };
    case MessageTypeIds.EntityPropsChangedEvent:
      return { typeId, body: decodeEntityPropsChangedEvent(payload) };
    case MessageTypeIds.EmitSignalCommand:
      return { typeId, body: decodeEmitSignalCommand(payload) };
    case MessageTypeIds.SignalEvent:
      return { typeId, body: decodeSignalEvent(payload) };
    default:
      return undefined;
  }
}

/** Encodes a control message into a complete frame: `[u8 TypeId][MemoryPack payload]`. */
export function encodeControlMessage(message: ControlMessage): Uint8Array {
  return encodeFrame(message.typeId, encodeControlPayload(message));
}

/** Encodes a control message's payload, without the TypeId byte. */
export function encodeControlPayload(message: ControlMessage): Uint8Array {
  switch (message.typeId) {
    case MessageTypeIds.HelloCommand:
      return encodeHelloCommand(message.body);
    case MessageTypeIds.WelcomeEvent:
      return encodeWelcomeEvent(message.body);
    case MessageTypeIds.RejectedEvent:
      return encodeRejectedEvent(message.body);
    case MessageTypeIds.PingCommand:
      return encodePingCommand(message.body);
    case MessageTypeIds.PongEvent:
      return encodePongEvent(message.body);
    case MessageTypeIds.PeerJoinedEvent:
      return encodePeerJoinedEvent(message.body);
    case MessageTypeIds.PeerLeftEvent:
      return encodePeerLeftEvent(message.body);
    case MessageTypeIds.RoomInfoEvent:
      return encodeRoomInfoEvent(message.body);
    case MessageTypeIds.SendChatCommand:
      return encodeSendChatCommand(message.body);
    case MessageTypeIds.ChatMessageEvent:
      return encodeChatMessageEvent(message.body);
    case MessageTypeIds.LeaveCommand:
      return encodeEmptyMessage();
    case MessageTypeIds.SetRoomVarCommand:
      return encodeSetRoomVarCommand(message.body);
    case MessageTypeIds.RoomVarsChangedEvent:
      return encodeRoomVarsChangedEvent(message.body);
    case MessageTypeIds.ResyncCommand:
      return encodeEmptyMessage();
    case MessageTypeIds.SetClientPrefsCommand:
      return encodeSetClientPrefsCommand(message.body);
    case MessageTypeIds.HostChangedEvent:
      return encodeHostChangedEvent(message.body);
    case MessageTypeIds.RoomRosterEvent:
      return encodeRoomRosterEvent(message.body);
    case MessageTypeIds.SpawnEntityRequest:
      return encodeSpawnEntityRequest(message.body);
    case MessageTypeIds.SpawnEntityResponse:
      return encodeSpawnEntityResponse(message.body);
    case MessageTypeIds.DespawnEntityCommand:
      return encodeDespawnEntityCommand(message.body);
    case MessageTypeIds.SetEntityPropsCommand:
      return encodeSetEntityPropsCommand(message.body);
    case MessageTypeIds.EntityPropsChangedEvent:
      return encodeEntityPropsChangedEvent(message.body);
    case MessageTypeIds.EmitSignalCommand:
      return encodeEmitSignalCommand(message.body);
    case MessageTypeIds.SignalEvent:
      return encodeSignalEvent(message.body);
  }
}
