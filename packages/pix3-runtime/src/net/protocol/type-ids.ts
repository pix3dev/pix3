/**
 * The single authoritative TypeId map. Every WebSocket binary frame is `[u8 TypeId][payload]`.
 * Ranges are reserved; never allocate an id outside its range.
 *
 * - `0–63` core (handshake, session, chat, room vars, client prefs) — MemoryPack payloads.
 * - `64–127` state sync — MemoryPack except the three hot-plane packets (67/68/69).
 * - `128–191` signals (networked game events) — MemoryPack except `SignalBatchPacket` (130).
 * - `192–255` reserved for app/game extensions; the fabric never interprets these.
 *
 * A constant here is spelled exactly like the message it names, so one grep finds a message's whole
 * path — wire id, interface, codec.
 *
 * **An unknown TypeId is ignored and counted, never fatal**, in both directions. That is what lets a
 * game published six months ago keep working when the fabric adds messages; see
 * {@link UnknownTypeIdTally}.
 */
export const MessageTypeIds = {
  // ── Core: handshake, session, chat, room vars, client prefs (0–63) ──────────
  /** C→S. Must be the first frame a client sends. */
  HelloCommand: 1,
  /** S→C. Handshake accepted. */
  WelcomeEvent: 2,
  /** S→C. Always precedes a close whose reason is known. */
  RejectedEvent: 3,
  /** C→S round-trip probe; also proof of liveness. */
  PingCommand: 4,
  /** S→C reply to `PingCommand`. */
  PongEvent: 5,
  /** S→C. A member joined. */
  PeerJoinedEvent: 6,
  /** S→C. A member is gone. */
  PeerLeftEvent: 7,
  /** S→C coarse room telemetry, ~1 Hz. */
  RoomInfoEvent: 8,
  /** C→S chat line. */
  SendChatCommand: 9,
  /** S→C chat line, attributed. */
  ChatMessageEvent: 10,
  /** C→S voluntary goodbye (empty payload). */
  LeaveCommand: 11,
  /** C→S write one room var. */
  SetRoomVarCommand: 12,
  /** S→C room vars: the full set on join, the changed subset afterwards. */
  RoomVarsChangedEvent: 13,
  /** C→S "my known set is untrustworthy, re-send it" (empty payload). */
  ResyncCommand: 14,
  /** C→S hidden-tab and send-rate preferences. */
  SetClientPrefsCommand: 15,
  /** S→C host migration announcement. */
  HostChangedEvent: 16,
  /** S→C the complete membership, including the recipient. Chunked with `Final`; join and resume. */
  RoomRosterEvent: 17,

  // ── State sync: entities (64–127) ──────────────────────────────────────────
  /** C→S spawn request. */
  SpawnEntityRequest: 64,
  /** S→C spawn answer, sent only to the requester. */
  SpawnEntityResponse: 65,
  /** C→S despawn (owner only). */
  DespawnEntityCommand: 66,
  /** C→S hot plane, hand-packed. See `hot-wire.ts`. */
  EntityUpdatePacket: 67,
  /** S→C hot plane, hand-packed. See `hot-wire.ts`. */
  SnapshotPacket: 68,
  /** S→C hot plane, hand-packed. See `hot-wire.ts`. */
  DeltaPacket: 69,
  /** C→S replace an entity's cold props. */
  SetEntityPropsCommand: 70,
  /** S→C an entity's cold props changed. Fanned out room-wide, not AOI-scoped. */
  EntityPropsChangedEvent: 71,

  // ── Signals: networked game events (128–191) ───────────────────────────────
  /** C→S emit a signal; `Target` selects the routing. */
  EmitSignalCommand: 128,
  /** S→C one relayed signal, one frame per recipient. */
  SignalEvent: 129,
  /** S→C hot plane, hand-packed; **no message interface**. AOI-scoped signals, batched per tick. */
  SignalBatchPacket: 130,
} as const;

/** Any value of {@link MessageTypeIds}. */
export type MessageTypeId = (typeof MessageTypeIds)[keyof typeof MessageTypeIds];

// ── Range boundaries (inclusive) ─────────────────────────────────────────────

/** First id of the core range. */
export const CORE_RANGE_FIRST = 0;
/** Last id of the core range. */
export const CORE_RANGE_LAST = 63;
/** First id of the state-sync range. */
export const STATE_RANGE_FIRST = 64;
/** Last id of the state-sync range. */
export const STATE_RANGE_LAST = 127;
/** First id of the signal range. */
export const SIGNAL_RANGE_FIRST = 128;
/** Last id of the signal range. */
export const SIGNAL_RANGE_LAST = 191;
/** First id reserved for application/game extensions. */
export const APP_RANGE_FIRST = 192;
/** Last id reserved for application/game extensions. */
export const APP_RANGE_LAST = 255;

/** True for core ids (handshake, session, chat, room vars, client prefs). */
export function isCoreTypeId(typeId: number): boolean {
  return typeId >= CORE_RANGE_FIRST && typeId <= CORE_RANGE_LAST;
}

/** True for state-sync ids (entities). */
export function isStateTypeId(typeId: number): boolean {
  return typeId >= STATE_RANGE_FIRST && typeId <= STATE_RANGE_LAST;
}

/** True for signal ids (networked game events). */
export function isSignalTypeId(typeId: number): boolean {
  return typeId >= SIGNAL_RANGE_FIRST && typeId <= SIGNAL_RANGE_LAST;
}

/** True for the app/game extension range. The fabric never interprets these. */
export function isAppTypeId(typeId: number): boolean {
  return typeId >= APP_RANGE_FIRST && typeId <= APP_RANGE_LAST;
}

/**
 * True for the four hand-packed packets (67/68/69/130). Those must never go through MemoryPack —
 * they are on the 600-players-per-room path and carry fixed hand-packed layouts.
 */
export function isHotPlane(typeId: number): boolean {
  return (
    typeId === MessageTypeIds.EntityUpdatePacket ||
    typeId === MessageTypeIds.SnapshotPacket ||
    typeId === MessageTypeIds.DeltaPacket ||
    typeId === MessageTypeIds.SignalBatchPacket
  );
}

const TYPE_ID_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(MessageTypeIds).map(([name, id]) => [id as number, name])
);

/**
 * Human-readable name for logs and metrics labels. `"Unknown"` for unmapped ids — a name is never
 * a decoding decision, only a label.
 */
export function messageTypeIdName(typeId: number): string {
  return TYPE_ID_NAMES.get(typeId) ?? 'Unknown';
}

// ── Framing ──────────────────────────────────────────────────────────────────

/**
 * Wraps a payload in its frame: `[u8 TypeId][payload]`. Length prefixing belongs to the transport
 * (a WebSocket frame already carries its length), so nothing else is added.
 */
export function encodeFrame(typeId: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = typeId;
  frame.set(payload, 1);
  return frame;
}

/** The TypeId of a received frame, or `-1` when the frame is empty. */
export function frameTypeId(frame: Uint8Array): number {
  return frame.length === 0 ? -1 : frame[0];
}

/** The payload of a received frame, as a view over the same buffer (no copy). */
export function framePayload(frame: Uint8Array): Uint8Array {
  return frame.subarray(1);
}

/**
 * Counts the TypeIds we chose to ignore, per direction or per connection as the caller prefers.
 *
 * Unknown ids must never be fatal — that is the whole forward-compatibility story — but a sustained
 * stream of them is still abuse, so the count has to be observable rather than swallowed.
 */
export class UnknownTypeIdTally {
  private counts = new Map<number, number>();
  private total = 0;

  /** Total unknown frames seen. */
  get count(): number {
    return this.total;
  }

  /** Records one ignored frame and returns the new total. */
  record(typeId: number): number {
    this.counts.set(typeId, (this.counts.get(typeId) ?? 0) + 1);
    this.total += 1;
    return this.total;
  }

  /** How many frames carried this particular unknown id. */
  countFor(typeId: number): number {
    return this.counts.get(typeId) ?? 0;
  }

  /** Every unknown id seen so far, in first-seen order. */
  seenTypeIds(): number[] {
    return [...this.counts.keys()];
  }

  /** Forgets everything. Useful when the tally is reported per window rather than per session. */
  reset(): void {
    this.counts.clear();
    this.total = 0;
  }
}
