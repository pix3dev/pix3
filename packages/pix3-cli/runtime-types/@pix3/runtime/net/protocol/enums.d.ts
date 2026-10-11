/**
 * The protocol's enumerations and bit-field vocabularies.
 *
 * All of them are plain `const` objects rather than TypeScript `enum`s: they are read and written on
 * the hot path, they must serialise as bare numbers, and a `const` object erases completely at build
 * time while an `enum` emits a runtime object and a reverse map nobody here wants.
 */
/**
 * Why a request, a join or a session was refused. Travels as `RejectedEvent.code` and as
 * `SpawnEntityResponse.rejectCode`. Every close whose reason is known is preceded by a
 * `RejectedEvent`, so the client can show a real message instead of a bare socket error.
 *
 * Kept as a `ushort` on the wire so an **unknown** code survives a round trip — treat a code you do
 * not recognise as a generic failure, never as a decoder error.
 */
export declare const RejectCode: {
    /** No error. Never sent as a rejection; the "ok" value in responses. */
    readonly None: 0;
    /** Announced version is below the server's minimum. Close 4001. */
    readonly ProtocolVersionMismatch: 1;
    /** Room token missing, malformed or signature invalid. Close 4002. */
    readonly InvalidToken: 2;
    /** Room token is well-formed but past its expiry. Close 4002. */
    readonly TokenExpired: 3;
    /** Room token is valid but was minted for a different room. Close 4002. */
    readonly TokenRoomMismatch: 4;
    /** No room with the requested id exists on this server. Close 4003. */
    readonly RoomNotFound: 5;
    /** Room is at `MaxPlayers`. Close 4003. */
    readonly RoomFull: 6;
    /** Room is shutting down and refuses new members. Close 4003. */
    readonly RoomClosing: 7;
    /** Per-connection message/byte rate limit tripped. Close 4004. */
    readonly RateLimited: 8;
    /** A single frame exceeded `MaxPayloadBytes`. Close 4004. */
    readonly PayloadTooLarge: 9;
    /** A per-room or per-connection quota was exceeded. Close 4004. */
    readonly QuotaExceeded: 10;
    /** Process is draining. Close 4005. */
    readonly ServerShuttingDown: 11;
    /** Connection sent nothing for `IdleTimeoutSeconds`. Close 4006. */
    readonly IdleTimeout: 12;
    /** Frame was undecodable, out of order, or the first frame was not a Hello. Close 4007. */
    readonly BadRequest: 13;
    /** The same identity reconnected and displaced this session. Close 4008. */
    readonly SessionReplaced: 14;
    /** Room already holds `MaxEntities`. Spawn response only — never a close reason. */
    readonly EntityLimitReached: 15;
    /** Caller does not own the entity it tried to mutate. Spawn/despawn response only. */
    readonly NotEntityOwner: 16;
    /** Unexpected server-side failure. Close 4000. */
    readonly InternalError: 17;
    /** The requested `kind` is not on the room's allowlist. Spawn response only. */
    readonly KindNotAllowed: 18;
    /**
     * The control send queue overflowed: this client could not drain what the room owed it. Close 4004.
     * Deliberately distinct from {@link RejectCode.RateLimited} — that one means the client sent too
     * much, this one means it read too little.
     */
    readonly SendQueueOverflow: 19;
};
/** Any value of {@link RejectCode}. */
export type RejectCodeValue = (typeof RejectCode)[keyof typeof RejectCode];
/**
 * Why a member is no longer in the room. Travels as `PeerLeftEvent.reason`.
 *
 * A drop inside the resume grace emits **no** `PeerLeftEvent` at all — peers are not told about a
 * blip. {@link LeaveReason.Timeout} is what peers see when the grace expires.
 */
export declare const LeaveReason: {
    /** Socket dropped without a protocol-level goodbye, and no resume grace applied. */
    readonly Disconnected: 0;
    /** Client sent `LeaveCommand`. */
    readonly LeftVoluntarily: 1;
    /** Removed by an operator or an admin API call. */
    readonly Kicked: 2;
    /** The resume grace expired, or an idle/heartbeat timeout fired. */
    readonly Timeout: 3;
    /** The room itself was destroyed. */
    readonly RoomClosed: 4;
    /** Removed because of a server-side or protocol error. */
    readonly Error: 5;
};
/** Any value of {@link LeaveReason}. */
export type LeaveReasonValue = (typeof LeaveReason)[keyof typeof LeaveReason];
/**
 * Routing selector for `EmitSignalCommand.target`. A **signal** is a networked game event — pix3's
 * own term, matching its signals engine.
 */
export declare const SignalTarget: {
    /** Handled by the room itself; nothing is fanned out. */
    readonly Server: 0;
    /** Delivered to every other member as a `SignalEvent`. A 600× amplifier, so the tightest quota. */
    readonly AllPeers: 1;
    /** Delivered only to `EmitSignalCommand.targetClientId`, as a `SignalEvent`. */
    readonly SinglePeer: 2;
    /** Delivered to the peers inside the sender's AOI, batched into one `SignalBatchPacket` per tick. */
    readonly AoiPeers: 3;
};
/** Any value of {@link SignalTarget}. */
export type SignalTargetValue = (typeof SignalTarget)[keyof typeof SignalTarget];
/** What the fabric does with an entity when its owner leaves the room. */
export declare const OwnershipPolicy: {
    /** Despawned when its owner leaves. The default, and the right answer for avatars. */
    readonly Owned: 0;
    /** Reassigned to the newly promoted host. World props, pickups, spawners. */
    readonly Shared: 1;
    /** Reassignable to any client, not just the host. Carryable objects. */
    readonly Transferable: 2;
    /** Reserved encoding. Never sent; treated as {@link OwnershipPolicy.Owned} if received. */
    readonly Reserved: 3;
};
/** Any value of {@link OwnershipPolicy}. */
export type OwnershipPolicyValue = (typeof OwnershipPolicy)[keyof typeof OwnershipPolicy];
/**
 * The room's authority mode, announced in `WelcomeEvent.mode`. Part of the wire contract, which is
 * what makes Level-2 server validation a zero-byte, non-breaking upgrade rather than a protocol break.
 */
export declare const RoomMode: {
    /** Client authority (Level 1): you simulate and publish what you own. */
    readonly Relay: 0;
    /** Server authority. */
    readonly Authoritative: 1;
};
/** Any value of {@link RoomMode}. */
export type RoomModeValue = (typeof RoomMode)[keyof typeof RoomMode];
/**
 * Bit layout of the entity `flags` byte, which travels in every `FullRecord` and is maskable in
 * updates via {@link DeltaMask.Flags}.
 *
 * Bit 2 is reserved for the fabric: it must be **sent as 0 and ignored on receipt**, so claiming it
 * later is not a wire break. Bits 3–7 stay app-defined and are replicated verbatim.
 */
export declare const EntityFlags: {
    /** Bits 0–1: the {@link OwnershipPolicy}. */
    readonly PolicyMask: 3;
    /** Bit 2: reserved for the fabric. Sent as 0, ignored on receipt. */
    readonly ReservedMask: 4;
    /** Bits 3–7: app-defined, replicated verbatim. */
    readonly AppMask: 248;
    /** Position of the lowest app-defined bit, for callers that want them right-aligned. */
    readonly AppBitShift: 3;
    /** All bits the fabric owns (policy plus the reserved bit). */
    readonly FabricMask: 7;
};
/** Reads the ownership policy out of a flags byte. */
export declare function entityFlagsPolicy(flags: number): OwnershipPolicyValue;
/**
 * Returns `flags` with its policy bits replaced. The reserved bit and every app bit are preserved
 * untouched, so `withPolicy(appBits(f), p)` rebuilds a valid flags byte.
 */
export declare function entityFlagsWithPolicy(flags: number, policy: OwnershipPolicyValue): number;
/**
 * The app-defined bits, **masked in place** (still at bits 3–7) rather than shifted down. Shift by
 * {@link EntityFlags.AppBitShift} if a right-aligned value is wanted.
 */
export declare function entityFlagsAppBits(flags: number): number;
/**
 * True when the fabric's reserved bit is clear, i.e. the byte is well-formed for this protocol
 * version. A sender must satisfy this; a receiver treats a set bit as "ignore", never as fatal.
 */
export declare function isEntityReservedBitClear(flags: number): boolean;
/**
 * Which fields an `UpdateRecord` (S→C) or `OwnerUpdateRecord` (C→S) carries.
 *
 * Payload fields appear in the record in **bit order** (X, Y, Rot, Vx, Vy, Flags) and are the
 * quantized integers, not floats. {@link DeltaMask.ColdDirty} and {@link DeltaMask.Teleport} carry no
 * payload bytes at all.
 *
 * Velocity stays in this vocabulary but is off the wire by default: at 20 Hz, linear interpolation of
 * 2D sprites does not need it. A typical moving entity therefore costs 8 B on the wire
 * (`u16 Slot` + mask + QX + QY + QRot).
 */
export declare const DeltaMask: {
    /** Nothing changed. A legal but empty record (header only). */
    readonly None: 0;
    /** `u16 QX` present. */
    readonly X: 1;
    /** `u16 QY` present. */
    readonly Y: 2;
    /** `u8 QRot` present. */
    readonly Rot: 4;
    /** `i16 QVx` present. */
    readonly Vx: 8;
    /** `i16 QVy` present. */
    readonly Vy: 16;
    /** `u8 Flags` present. */
    readonly Flags: 32;
    /** Cold props changed; expect an `EntityPropsChangedEvent`. No payload bytes. */
    readonly ColdDirty: 64;
    /** Discontinuity — the receiver must snap instead of interpolating. No payload bytes. */
    readonly Teleport: 128;
    /** Bits whose payload is two bytes wide: X, Y, Vx, Vy. */
    readonly TwoByteFieldBits: 27;
    /** Bits whose payload is one byte wide: Rot, Flags. */
    readonly OneByteFieldBits: 36;
    /** All bits that contribute payload bytes. */
    readonly PayloadBits: 63;
    /** Bits that are pure signals and contribute no payload bytes. */
    readonly SignalBits: 192;
    /** Payload bytes a record with every field present carries (2 × 4 + 1 × 2). */
    readonly MaxPayloadSize: 10;
};
/**
 * Bytes the masked fields occupy, **excluding** the record header:
 * `2 × popcount(mask & (X|Y|Vx|Vy)) + popcount(mask & (Rot|Flags))`. Signal bits contribute nothing.
 */
export declare function deltaMaskPayloadSize(mask: number): number;
/**
 * The only mask bits a client may set: the six payload bits plus {@link DeltaMask.Teleport}.
 * {@link DeltaMask.ColdDirty} is server-authored (it promises a follow-up `EntityPropsChangedEvent`),
 * so a client setting it is a protocol violation.
 */
export declare const CLIENT_ALLOWED_MASK_BITS: number;
/** Bits a client may never set. */
export declare const CLIENT_FORBIDDEN_MASK_BITS: number;
/**
 * True when every bit in `mask` is client-settable. {@link DeltaMask.None} is legal (an empty, no-op
 * record); rejecting no-ops is a quota decision, not a protocol one.
 */
export declare function isClientMaskLegal(mask: number): boolean;
/**
 * The `FrameFlags` byte at offset 7 of a `SnapshotPacket`.
 *
 * A large snapshot is split across several self-contained frames and only the last carries
 * {@link FrameFlags.Final}. Without that bit a client has no way to know a multi-frame snapshot is
 * complete.
 */
export declare const FrameFlags: {
    /** No flags. Every non-final snapshot frame. */
    readonly None: 0;
    /** Bit 0 — the last frame of the snapshot; the client's known set is now complete. */
    readonly Final: 1;
    /** Bits 1–7. Reserved, sent as 0, ignored on receipt. */
    readonly ReservedBits: 254;
};
/** True when {@link FrameFlags.Final} is set. */
export declare function isFinalFrame(frameFlags: number): boolean;
