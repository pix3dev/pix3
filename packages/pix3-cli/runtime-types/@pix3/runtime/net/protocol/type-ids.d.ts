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
export declare const MessageTypeIds: {
    /** C→S. Must be the first frame a client sends. */
    readonly HelloCommand: 1;
    /** S→C. Handshake accepted. */
    readonly WelcomeEvent: 2;
    /** S→C. Always precedes a close whose reason is known. */
    readonly RejectedEvent: 3;
    /** C→S round-trip probe; also proof of liveness. */
    readonly PingCommand: 4;
    /** S→C reply to `PingCommand`. */
    readonly PongEvent: 5;
    /** S→C. A member joined. */
    readonly PeerJoinedEvent: 6;
    /** S→C. A member is gone. */
    readonly PeerLeftEvent: 7;
    /** S→C coarse room telemetry, ~1 Hz. */
    readonly RoomInfoEvent: 8;
    /** C→S chat line. */
    readonly SendChatCommand: 9;
    /** S→C chat line, attributed. */
    readonly ChatMessageEvent: 10;
    /** C→S voluntary goodbye (empty payload). */
    readonly LeaveCommand: 11;
    /** C→S write one room var. */
    readonly SetRoomVarCommand: 12;
    /** S→C room vars: the full set on join, the changed subset afterwards. */
    readonly RoomVarsChangedEvent: 13;
    /** C→S "my known set is untrustworthy, re-send it" (empty payload). */
    readonly ResyncCommand: 14;
    /** C→S hidden-tab and send-rate preferences. */
    readonly SetClientPrefsCommand: 15;
    /** S→C host migration announcement. */
    readonly HostChangedEvent: 16;
    /** S→C the complete membership, including the recipient. Chunked with `Final`; join and resume. */
    readonly RoomRosterEvent: 17;
    /** C→S spawn request. */
    readonly SpawnEntityRequest: 64;
    /** S→C spawn answer, sent only to the requester. */
    readonly SpawnEntityResponse: 65;
    /** C→S despawn (owner only). */
    readonly DespawnEntityCommand: 66;
    /** C→S hot plane, hand-packed. See `hot-wire.ts`. */
    readonly EntityUpdatePacket: 67;
    /** S→C hot plane, hand-packed. See `hot-wire.ts`. */
    readonly SnapshotPacket: 68;
    /** S→C hot plane, hand-packed. See `hot-wire.ts`. */
    readonly DeltaPacket: 69;
    /** C→S replace an entity's cold props. */
    readonly SetEntityPropsCommand: 70;
    /** S→C an entity's cold props changed. Fanned out room-wide, not AOI-scoped. */
    readonly EntityPropsChangedEvent: 71;
    /** C→S emit a signal; `Target` selects the routing. */
    readonly EmitSignalCommand: 128;
    /** S→C one relayed signal, one frame per recipient. */
    readonly SignalEvent: 129;
    /** S→C hot plane, hand-packed; **no message interface**. AOI-scoped signals, batched per tick. */
    readonly SignalBatchPacket: 130;
};
/** Any value of {@link MessageTypeIds}. */
export type MessageTypeId = (typeof MessageTypeIds)[keyof typeof MessageTypeIds];
/** First id of the core range. */
export declare const CORE_RANGE_FIRST = 0;
/** Last id of the core range. */
export declare const CORE_RANGE_LAST = 63;
/** First id of the state-sync range. */
export declare const STATE_RANGE_FIRST = 64;
/** Last id of the state-sync range. */
export declare const STATE_RANGE_LAST = 127;
/** First id of the signal range. */
export declare const SIGNAL_RANGE_FIRST = 128;
/** Last id of the signal range. */
export declare const SIGNAL_RANGE_LAST = 191;
/** First id reserved for application/game extensions. */
export declare const APP_RANGE_FIRST = 192;
/** Last id reserved for application/game extensions. */
export declare const APP_RANGE_LAST = 255;
/** True for core ids (handshake, session, chat, room vars, client prefs). */
export declare function isCoreTypeId(typeId: number): boolean;
/** True for state-sync ids (entities). */
export declare function isStateTypeId(typeId: number): boolean;
/** True for signal ids (networked game events). */
export declare function isSignalTypeId(typeId: number): boolean;
/** True for the app/game extension range. The fabric never interprets these. */
export declare function isAppTypeId(typeId: number): boolean;
/**
 * True for the four hand-packed packets (67/68/69/130). Those must never go through MemoryPack —
 * they are on the 600-players-per-room path and carry fixed hand-packed layouts.
 */
export declare function isHotPlane(typeId: number): boolean;
/**
 * Human-readable name for logs and metrics labels. `"Unknown"` for unmapped ids — a name is never
 * a decoding decision, only a label.
 */
export declare function messageTypeIdName(typeId: number): string;
/**
 * Wraps a payload in its frame: `[u8 TypeId][payload]`. Length prefixing belongs to the transport
 * (a WebSocket frame already carries its length), so nothing else is added.
 */
export declare function encodeFrame(typeId: number, payload: Uint8Array): Uint8Array;
/** The TypeId of a received frame, or `-1` when the frame is empty. */
export declare function frameTypeId(frame: Uint8Array): number;
/** The payload of a received frame, as a view over the same buffer (no copy). */
export declare function framePayload(frame: Uint8Array): Uint8Array;
/**
 * Counts the TypeIds we chose to ignore, per direction or per connection as the caller prefers.
 *
 * Unknown ids must never be fatal — that is the whole forward-compatibility story — but a sustained
 * stream of them is still abuse, so the count has to be observable rather than swallowed.
 */
export declare class UnknownTypeIdTally {
    private counts;
    private total;
    /** Total unknown frames seen. */
    get count(): number;
    /** Records one ignored frame and returns the new total. */
    record(typeId: number): number;
    /** How many frames carried this particular unknown id. */
    countFor(typeId: number): number;
    /** Every unknown id seen so far, in first-seen order. */
    seenTypeIds(): number[];
    /** Forgets everything. Useful when the tally is reported per window rather than per session. */
    reset(): void;
}
