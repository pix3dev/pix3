/**
 * The protocol's enumerations and bit-field vocabularies.
 *
 * All of them are plain `const` objects rather than TypeScript `enum`s: they are read and written on
 * the hot path, they must serialise as bare numbers, and a `const` object erases completely at build
 * time while an `enum` emits a runtime object and a reverse map nobody here wants.
 */

// ── RejectCode (ushort) ──────────────────────────────────────────────────────

/**
 * Why a request, a join or a session was refused. Travels as `RejectedEvent.code` and as
 * `SpawnEntityResponse.rejectCode`. Every close whose reason is known is preceded by a
 * `RejectedEvent`, so the client can show a real message instead of a bare socket error.
 *
 * Kept as a `ushort` on the wire so an **unknown** code survives a round trip — treat a code you do
 * not recognise as a generic failure, never as a decoder error.
 */
export const RejectCode = {
  /** No error. Never sent as a rejection; the "ok" value in responses. */
  None: 0,
  /** Announced version is below the server's minimum. Close 4001. */
  ProtocolVersionMismatch: 1,
  /** Room token missing, malformed or signature invalid. Close 4002. */
  InvalidToken: 2,
  /** Room token is well-formed but past its expiry. Close 4002. */
  TokenExpired: 3,
  /** Room token is valid but was minted for a different room. Close 4002. */
  TokenRoomMismatch: 4,
  /** No room with the requested id exists on this server. Close 4003. */
  RoomNotFound: 5,
  /** Room is at `MaxPlayers`. Close 4003. */
  RoomFull: 6,
  /** Room is shutting down and refuses new members. Close 4003. */
  RoomClosing: 7,
  /** Per-connection message/byte rate limit tripped. Close 4004. */
  RateLimited: 8,
  /** A single frame exceeded `MaxPayloadBytes`. Close 4004. */
  PayloadTooLarge: 9,
  /** A per-room or per-connection quota was exceeded. Close 4004. */
  QuotaExceeded: 10,
  /** Process is draining. Close 4005. */
  ServerShuttingDown: 11,
  /** Connection sent nothing for `IdleTimeoutSeconds`. Close 4006. */
  IdleTimeout: 12,
  /** Frame was undecodable, out of order, or the first frame was not a Hello. Close 4007. */
  BadRequest: 13,
  /** The same identity reconnected and displaced this session. Close 4008. */
  SessionReplaced: 14,
  /** Room already holds `MaxEntities`. Spawn response only — never a close reason. */
  EntityLimitReached: 15,
  /** Caller does not own the entity it tried to mutate. Spawn/despawn response only. */
  NotEntityOwner: 16,
  /** Unexpected server-side failure. Close 4000. */
  InternalError: 17,
  /** The requested `kind` is not on the room's allowlist. Spawn response only. */
  KindNotAllowed: 18,
  /**
   * The control send queue overflowed: this client could not drain what the room owed it. Close 4004.
   * Deliberately distinct from {@link RejectCode.RateLimited} — that one means the client sent too
   * much, this one means it read too little.
   */
  SendQueueOverflow: 19,
} as const;

/** Any value of {@link RejectCode}. */
export type RejectCodeValue = (typeof RejectCode)[keyof typeof RejectCode];

// ── LeaveReason (byte) ───────────────────────────────────────────────────────

/**
 * Why a member is no longer in the room. Travels as `PeerLeftEvent.reason`.
 *
 * A drop inside the resume grace emits **no** `PeerLeftEvent` at all — peers are not told about a
 * blip. {@link LeaveReason.Timeout} is what peers see when the grace expires.
 */
export const LeaveReason = {
  /** Socket dropped without a protocol-level goodbye, and no resume grace applied. */
  Disconnected: 0,
  /** Client sent `LeaveCommand`. */
  LeftVoluntarily: 1,
  /** Removed by an operator or an admin API call. */
  Kicked: 2,
  /** The resume grace expired, or an idle/heartbeat timeout fired. */
  Timeout: 3,
  /** The room itself was destroyed. */
  RoomClosed: 4,
  /** Removed because of a server-side or protocol error. */
  Error: 5,
} as const;

/** Any value of {@link LeaveReason}. */
export type LeaveReasonValue = (typeof LeaveReason)[keyof typeof LeaveReason];

// ── SignalTarget (byte) ──────────────────────────────────────────────────────

/**
 * Routing selector for `EmitSignalCommand.target`. A **signal** is a networked game event — pix3's
 * own term, matching its signals engine.
 */
export const SignalTarget = {
  /** Handled by the room itself; nothing is fanned out. */
  Server: 0,
  /** Delivered to every other member as a `SignalEvent`. A 600× amplifier, so the tightest quota. */
  AllPeers: 1,
  /** Delivered only to `EmitSignalCommand.targetClientId`, as a `SignalEvent`. */
  SinglePeer: 2,
  /** Delivered to the peers inside the sender's AOI, batched into one `SignalBatchPacket` per tick. */
  AoiPeers: 3,
} as const;

/** Any value of {@link SignalTarget}. */
export type SignalTargetValue = (typeof SignalTarget)[keyof typeof SignalTarget];

// ── OwnershipPolicy (bits 0–1 of the entity flags byte) ──────────────────────

/** What the fabric does with an entity when its owner leaves the room. */
export const OwnershipPolicy = {
  /** Despawned when its owner leaves. The default, and the right answer for avatars. */
  Owned: 0,
  /** Reassigned to the newly promoted host. World props, pickups, spawners. */
  Shared: 1,
  /** Reassignable to any client, not just the host. Carryable objects. */
  Transferable: 2,
  /** Reserved encoding. Never sent; treated as {@link OwnershipPolicy.Owned} if received. */
  Reserved: 3,
} as const;

/** Any value of {@link OwnershipPolicy}. */
export type OwnershipPolicyValue = (typeof OwnershipPolicy)[keyof typeof OwnershipPolicy];

// ── RoomMode (WelcomeEvent.mode) ─────────────────────────────────────────────

/**
 * The room's authority mode, announced in `WelcomeEvent.mode`. Part of the wire contract, which is
 * what makes Level-2 server validation a zero-byte, non-breaking upgrade rather than a protocol break.
 */
export const RoomMode = {
  /** Client authority (Level 1): you simulate and publish what you own. */
  Relay: 0,
  /** Server authority. */
  Authoritative: 1,
} as const;

/** Any value of {@link RoomMode}. */
export type RoomModeValue = (typeof RoomMode)[keyof typeof RoomMode];

// ── EntityFlags (the entity flags byte) ──────────────────────────────────────

/**
 * Bit layout of the entity `flags` byte, which travels in every `FullRecord` and is maskable in
 * updates via {@link DeltaMask.Flags}.
 *
 * Bit 2 is reserved for the fabric: it must be **sent as 0 and ignored on receipt**, so claiming it
 * later is not a wire break. Bits 3–7 stay app-defined and are replicated verbatim.
 */
export const EntityFlags = {
  /** Bits 0–1: the {@link OwnershipPolicy}. */
  PolicyMask: 0b0000_0011,
  /** Bit 2: reserved for the fabric. Sent as 0, ignored on receipt. */
  ReservedMask: 0b0000_0100,
  /** Bits 3–7: app-defined, replicated verbatim. */
  AppMask: 0b1111_1000,
  /** Position of the lowest app-defined bit, for callers that want them right-aligned. */
  AppBitShift: 3,
  /** All bits the fabric owns (policy plus the reserved bit). */
  FabricMask: 0b0000_0111,
} as const;

/** Reads the ownership policy out of a flags byte. */
export function entityFlagsPolicy(flags: number): OwnershipPolicyValue {
  return (flags & EntityFlags.PolicyMask) as OwnershipPolicyValue;
}

/**
 * Returns `flags` with its policy bits replaced. The reserved bit and every app bit are preserved
 * untouched, so `withPolicy(appBits(f), p)` rebuilds a valid flags byte.
 */
export function entityFlagsWithPolicy(flags: number, policy: OwnershipPolicyValue): number {
  return ((flags & ~EntityFlags.PolicyMask) | (policy & EntityFlags.PolicyMask)) & 0xff;
}

/**
 * The app-defined bits, **masked in place** (still at bits 3–7) rather than shifted down. Shift by
 * {@link EntityFlags.AppBitShift} if a right-aligned value is wanted.
 */
export function entityFlagsAppBits(flags: number): number {
  return flags & EntityFlags.AppMask;
}

/**
 * True when the fabric's reserved bit is clear, i.e. the byte is well-formed for this protocol
 * version. A sender must satisfy this; a receiver treats a set bit as "ignore", never as fatal.
 */
export function isEntityReservedBitClear(flags: number): boolean {
  return (flags & EntityFlags.ReservedMask) === 0;
}

// ── DeltaMask (which fields an update record carries) ────────────────────────

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
export const DeltaMask = {
  /** Nothing changed. A legal but empty record (header only). */
  None: 0x00,
  /** `u16 QX` present. */
  X: 0x01,
  /** `u16 QY` present. */
  Y: 0x02,
  /** `u8 QRot` present. */
  Rot: 0x04,
  /** `i16 QVx` present. */
  Vx: 0x08,
  /** `i16 QVy` present. */
  Vy: 0x10,
  /** `u8 Flags` present. */
  Flags: 0x20,
  /** Cold props changed; expect an `EntityPropsChangedEvent`. No payload bytes. */
  ColdDirty: 0x40,
  /** Discontinuity — the receiver must snap instead of interpolating. No payload bytes. */
  Teleport: 0x80,

  /** Bits whose payload is two bytes wide: X, Y, Vx, Vy. */
  TwoByteFieldBits: 0x1b,
  /** Bits whose payload is one byte wide: Rot, Flags. */
  OneByteFieldBits: 0x24,
  /** All bits that contribute payload bytes. */
  PayloadBits: 0x3f,
  /** Bits that are pure signals and contribute no payload bytes. */
  SignalBits: 0xc0,
  /** Payload bytes a record with every field present carries (2 × 4 + 1 × 2). */
  MaxPayloadSize: 10,
} as const;

/**
 * Bytes the masked fields occupy, **excluding** the record header:
 * `2 × popcount(mask & (X|Y|Vx|Vy)) + popcount(mask & (Rot|Flags))`. Signal bits contribute nothing.
 */
export function deltaMaskPayloadSize(mask: number): number {
  return (
    (popCount8(mask & DeltaMask.TwoByteFieldBits) << 1) +
    popCount8(mask & DeltaMask.OneByteFieldBits)
  );
}

/** Population count of the low 8 bits. Small enough that a loop beats any table lookup. */
function popCount8(value: number): number {
  let bits = value & 0xff;
  let count = 0;
  while (bits !== 0) {
    bits &= bits - 1;
    count += 1;
  }
  return count;
}

/**
 * The only mask bits a client may set: the six payload bits plus {@link DeltaMask.Teleport}.
 * {@link DeltaMask.ColdDirty} is server-authored (it promises a follow-up `EntityPropsChangedEvent`),
 * so a client setting it is a protocol violation.
 */
export const CLIENT_ALLOWED_MASK_BITS = DeltaMask.PayloadBits | DeltaMask.Teleport; // 0xBF

/** Bits a client may never set. */
export const CLIENT_FORBIDDEN_MASK_BITS = ~CLIENT_ALLOWED_MASK_BITS & 0xff; // 0x40

/**
 * True when every bit in `mask` is client-settable. {@link DeltaMask.None} is legal (an empty, no-op
 * record); rejecting no-ops is a quota decision, not a protocol one.
 */
export function isClientMaskLegal(mask: number): boolean {
  return (mask & CLIENT_FORBIDDEN_MASK_BITS) === 0;
}

// ── FrameFlags (SnapshotPacket byte at offset 7) ─────────────────────────────

/**
 * The `FrameFlags` byte at offset 7 of a `SnapshotPacket`.
 *
 * A large snapshot is split across several self-contained frames and only the last carries
 * {@link FrameFlags.Final}. Without that bit a client has no way to know a multi-frame snapshot is
 * complete.
 */
export const FrameFlags = {
  /** No flags. Every non-final snapshot frame. */
  None: 0x00,
  /** Bit 0 — the last frame of the snapshot; the client's known set is now complete. */
  Final: 0x01,
  /** Bits 1–7. Reserved, sent as 0, ignored on receipt. */
  ReservedBits: 0xfe,
} as const;

/** True when {@link FrameFlags.Final} is set. */
export function isFinalFrame(frameFlags: number): boolean {
  return (frameFlags & FrameFlags.Final) !== 0;
}
