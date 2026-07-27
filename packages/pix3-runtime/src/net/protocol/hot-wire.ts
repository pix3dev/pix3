/**
 * Hand-packed codecs for the hot plane (TypeIds 67 / 68 / 69 / 130).
 *
 * Everything here is `DataView`-based, little-endian and allocation-light, and every reader returns
 * `boolean` — malformed or truncated input must never throw, because it arrives from the network.
 * Writers return the number of bytes written, or `0` when the destination is too small, so a caller
 * can fill a frame until it stops fitting without ever computing sizes twice.
 *
 * The state fields moved here are the **quantized integers**. No codec in this file converts to or
 * from a float; that is `WorldQuantizer`'s job, at the edges only.
 *
 * Server→client records address entities by `u16 Slot`; client→server records address them by
 * `u32 NetId`, because the server needs the generation bits to reject a mutation aimed at a slot that
 * has since been reused. That asymmetry is the entire reason {@link writeUpdateRecord} and
 * {@link writeOwnerUpdateRecord} are two functions.
 */
import { DeltaMask, deltaMaskPayloadSize } from './enums';
import { MessageTypeIds } from './type-ids';

// ── Record and header geometry ───────────────────────────────────────────────

/**
 * `FullRecord` is fixed at 20 bytes: `u32 NetId`, `u16 Kind`, `u32 OwnerId`, `u16 QX`, `u16 QY`,
 * `u8 QRot`, `i16 QVx`, `i16 QVy`, `u8 Flags`.
 */
export const FULL_RECORD_SIZE = 20;

/** Bytes before the masked payload of an `UpdateRecord`: `u16 Slot` + `u8 Mask`. */
export const MIN_UPDATE_RECORD_SIZE = 3;

/** Largest `UpdateRecord`: header plus every masked field. */
export const MAX_UPDATE_RECORD_SIZE = MIN_UPDATE_RECORD_SIZE + DeltaMask.MaxPayloadSize; // 13

/** Bytes before the masked payload of an `OwnerUpdateRecord`: `u32 NetId` + `u8 Mask`. */
export const MIN_OWNER_UPDATE_RECORD_SIZE = 5;

/** Largest `OwnerUpdateRecord`: header plus every masked field. */
export const MAX_OWNER_UPDATE_RECORD_SIZE = MIN_OWNER_UPDATE_RECORD_SIZE + DeltaMask.MaxPayloadSize; // 15

/** Bytes a removal entry occupies in a `DeltaPacket` removed section: a bare `u16 Slot`. */
export const REMOVED_SLOT_SIZE = 2;

/** Bytes a `u16` section count occupies. */
export const SECTION_COUNT_SIZE = 2;

/** `[u8 TypeId=68][u16 Seq][u32 ServerTick][u8 FrameFlags][u16 Count]`. */
export const SNAPSHOT_PACKET_HEADER_SIZE = 10;

/** Offset of the `u8 FrameFlags` slot inside a `SnapshotPacket`. */
export const SNAPSHOT_PACKET_FRAME_FLAGS_OFFSET = 7;

/** Offset of the `u16 Count` slot inside a `SnapshotPacket`. */
export const SNAPSHOT_PACKET_COUNT_OFFSET = 8;

/** `[u8 TypeId=69][u16 Seq][u32 ServerTick]`; the three section counts follow. */
export const DELTA_PACKET_HEADER_SIZE = 7;

/**
 * Bytes a `DeltaPacket` costs with all three sections empty: the header plus the three always-present
 * `u16` counts. This — not {@link DELTA_PACKET_HEADER_SIZE} — is the header cost in the bandwidth
 * budget, and it is also the smallest well-formed packet.
 */
export const DELTA_PACKET_FIXED_OVERHEAD = DELTA_PACKET_HEADER_SIZE + SECTION_COUNT_SIZE * 3; // 13

/** `[u8 TypeId=67][u32 ClientTick][u8 Count]`. */
export const ENTITY_UPDATE_PACKET_HEADER_SIZE = 6;

/** Offset of the `u8 Count` slot inside an `EntityUpdatePacket`. */
export const ENTITY_UPDATE_PACKET_COUNT_OFFSET = 5;

/** Largest record count an `EntityUpdatePacket` can express (the count field is a byte). */
export const MAX_ENTITY_UPDATE_RECORDS = 255;

/** `[u8 TypeId=130][u16 Seq][u32 ServerTick][u8 Count]`. */
export const SIGNAL_BATCH_PACKET_HEADER_SIZE = 8;

/** Offset of the `u8 Count` slot inside a `SignalBatchPacket`. */
export const SIGNAL_BATCH_PACKET_COUNT_OFFSET = 7;

/** Largest entry count a `SignalBatchPacket` can express (the count field is a byte). */
export const MAX_SIGNAL_BATCH_ENTRIES = 255;

/**
 * Fixed bytes of one `SignalBatchPacket` entry: `u32 SenderClientId` + `u8 NameLength` +
 * `u8 PayloadLength`. The two variable blocks follow their lengths.
 */
export const SIGNAL_ENTRY_OVERHEAD_SIZE = 6;

/** A signal name may not be empty. */
export const MIN_SIGNAL_NAME_LENGTH = 1;

/** Longest signal name, in UTF-8 bytes, a batch entry can express. */
export const MAX_SIGNAL_NAME_LENGTH = 64;

/**
 * Longest signal payload a batch entry can express. A larger payload is not eligible for the hot path
 * at all and is refused with the `quota` counter: batched signals are small game events, not a data
 * channel.
 */
export const MAX_SIGNAL_PAYLOAD_LENGTH = 255;

/** Smallest possible entry: overhead plus a one-byte name and an empty payload. */
export const MIN_SIGNAL_ENTRY_SIZE = SIGNAL_ENTRY_OVERHEAD_SIZE + MIN_SIGNAL_NAME_LENGTH; // 7

// ── Entity state ─────────────────────────────────────────────────────────────

/**
 * The canonical mutable entity state on the wire, in its **quantized** form.
 *
 * There are no floats here on purpose: the quantized integers *are* the replicated values, and
 * **dirty detection compares these integers**. Comparing floats would keep an idle entity dirty
 * forever on sub-quantum noise, so a float field here would be a bug waiting to happen.
 *
 * {@link EntityWireState.kind} and {@link EntityWireState.ownerId} travel only in a `FullRecord`; an
 * update record carries the masked subset of the rest.
 */
export interface EntityWireState {
  /** Quantized world X, `0…65535`. */
  qx: number;
  /** Quantized world Y, `0…65535`. */
  qy: number;
  /** Quantized rotation, 256 steps per turn. */
  qrot: number;
  /** Quantized linear velocity along X, 1/8 u/s per step. Off the wire by default. */
  qvx: number;
  /** Quantized linear velocity along Y, 1/8 u/s per step. Off the wire by default. */
  qvy: number;
  /** Application-defined entity kind, indexing the build's prefab table. Full records only. */
  kind: number;
  /** ClientId of the owner (0 = server-owned, read-only to every client). Full records only. */
  ownerId: number;
  /** Bit flags: ownership policy in bits 0–1, app bits in 3–7. */
  flags: number;
}

/** A zeroed {@link EntityWireState}, ready to be filled by a reader or a caller. */
export function createEntityWireState(): EntityWireState {
  return { qx: 0, qy: 0, qrot: 0, qvx: 0, qvy: 0, kind: 0, ownerId: 0, flags: 0 };
}

/** Resets every field to zero, so a reader can reuse one object across records. */
export function resetEntityWireState(state: EntityWireState): void {
  state.qx = 0;
  state.qy = 0;
  state.qrot = 0;
  state.qvx = 0;
  state.qvy = 0;
  state.kind = 0;
  state.ownerId = 0;
  state.flags = 0;
}

/**
 * Copies from `source` only the fields selected by `mask`, leaving everything else untouched. This is
 * the one place mask semantics are implemented, so a decoded update is merged rather than assigned
 * wholesale — an unmasked field in a decoded record is zero, not "unchanged".
 */
export function applyMaskedState(
  target: EntityWireState,
  mask: number,
  source: EntityWireState
): void {
  if ((mask & DeltaMask.X) !== 0) target.qx = source.qx;
  if ((mask & DeltaMask.Y) !== 0) target.qy = source.qy;
  if ((mask & DeltaMask.Rot) !== 0) target.qrot = source.qrot;
  if ((mask & DeltaMask.Vx) !== 0) target.qvx = source.qvx;
  if ((mask & DeltaMask.Vy) !== 0) target.qvy = source.qvy;
  if ((mask & DeltaMask.Flags) !== 0) target.flags = source.flags;
}

// ── FullRecord ───────────────────────────────────────────────────────────────

/** Decoded `FullRecord`, filled in place by {@link readFullRecord}. */
export interface FullRecord {
  /** The entity's opaque net id. */
  netId: number;
  /** Every field of the record — a full record is never masked. */
  state: EntityWireState;
}

/** A zeroed {@link FullRecord} to pass as an out-parameter. */
export function createFullRecord(): FullRecord {
  return { netId: 0, state: createEntityWireState() };
}

/**
 * Writes one `FullRecord` at `offset`. Returns {@link FULL_RECORD_SIZE}, or 0 if the destination is
 * too small (nothing is written in that case).
 */
export function writeFullRecord(
  target: DataView,
  offset: number,
  netId: number,
  state: EntityWireState
): number {
  if (target.byteLength - offset < FULL_RECORD_SIZE) {
    return 0;
  }

  target.setUint32(offset, netId, true);
  target.setUint16(offset + 4, state.kind, true);
  target.setUint32(offset + 6, state.ownerId, true);
  target.setUint16(offset + 10, state.qx, true);
  target.setUint16(offset + 12, state.qy, true);
  target.setUint8(offset + 14, state.qrot);
  target.setInt16(offset + 15, state.qvx, true);
  target.setInt16(offset + 17, state.qvy, true);
  target.setUint8(offset + 19, state.flags);
  return FULL_RECORD_SIZE;
}

/** Reads one `FullRecord` at `offset`. False when fewer than {@link FULL_RECORD_SIZE} bytes remain. */
export function readFullRecord(source: DataView, offset: number, out: FullRecord): boolean {
  out.netId = 0;
  resetEntityWireState(out.state);
  if (offset < 0 || source.byteLength - offset < FULL_RECORD_SIZE) {
    return false;
  }

  out.netId = source.getUint32(offset, true);
  out.state.kind = source.getUint16(offset + 4, true);
  out.state.ownerId = source.getUint32(offset + 6, true);
  out.state.qx = source.getUint16(offset + 10, true);
  out.state.qy = source.getUint16(offset + 12, true);
  out.state.qrot = source.getUint8(offset + 14);
  out.state.qvx = source.getInt16(offset + 15, true);
  out.state.qvy = source.getInt16(offset + 17, true);
  out.state.flags = source.getUint8(offset + 19);
  return true;
}

// ── UpdateRecord (S→C, slot-addressed) ───────────────────────────────────────

/** Decoded `UpdateRecord`. Fields absent from `mask` are left at zero — merge, never assign. */
export interface UpdateRecord {
  /** The receiver's slot for this entity, resolved through its own slot → netId table. */
  slot: number;
  /** Which fields the record carried. */
  mask: number;
  /** The masked fields; everything else is zero. */
  state: EntityWireState;
  /** Bytes the record occupied; 0 when the read failed. */
  bytesRead: number;
}

/** A zeroed {@link UpdateRecord} to pass as an out-parameter. */
export function createUpdateRecord(): UpdateRecord {
  return { slot: 0, mask: 0, state: createEntityWireState(), bytesRead: 0 };
}

/** Encoded size of an `UpdateRecord` with this mask: 3 header bytes plus the masked payload. */
export function updateRecordSize(mask: number): number {
  return MIN_UPDATE_RECORD_SIZE + deltaMaskPayloadSize(mask);
}

/**
 * Writes one `UpdateRecord`: `u16 Slot`, `u8 Mask`, then the masked fields in bit order. Returns the
 * byte count, or 0 if the destination is too small.
 */
export function writeUpdateRecord(
  target: DataView,
  offset: number,
  slot: number,
  mask: number,
  state: EntityWireState
): number {
  const size = updateRecordSize(mask);
  if (target.byteLength - offset < size) {
    return 0;
  }

  target.setUint16(offset, slot, true);
  target.setUint8(offset + 2, mask);
  writeMaskedFields(target, offset + MIN_UPDATE_RECORD_SIZE, mask, state);
  return size;
}

/** Reads one `UpdateRecord` at `offset`. False on a truncated record. */
export function readUpdateRecord(source: DataView, offset: number, out: UpdateRecord): boolean {
  out.slot = 0;
  out.mask = 0;
  out.bytesRead = 0;
  resetEntityWireState(out.state);

  if (offset < 0 || source.byteLength - offset < MIN_UPDATE_RECORD_SIZE) {
    return false;
  }

  const mask = source.getUint8(offset + 2);
  const size = updateRecordSize(mask);
  if (source.byteLength - offset < size) {
    return false;
  }

  out.slot = source.getUint16(offset, true);
  out.mask = mask;
  readMaskedFields(source, offset + MIN_UPDATE_RECORD_SIZE, mask, out.state);
  out.bytesRead = size;
  return true;
}

// ── OwnerUpdateRecord (C→S, netId-addressed) ─────────────────────────────────

/** Decoded `OwnerUpdateRecord`. Same fields as an {@link UpdateRecord}, keyed by net id. */
export interface OwnerUpdateRecord {
  /** The entity being mutated; its generation bits are what let the server reject a reused slot. */
  netId: number;
  /** Which fields the record carried. */
  mask: number;
  /** The masked fields; everything else is zero. */
  state: EntityWireState;
  /** Bytes the record occupied; 0 when the read failed. */
  bytesRead: number;
}

/** A zeroed {@link OwnerUpdateRecord} to pass as an out-parameter. */
export function createOwnerUpdateRecord(): OwnerUpdateRecord {
  return { netId: 0, mask: 0, state: createEntityWireState(), bytesRead: 0 };
}

/** Encoded size of an `OwnerUpdateRecord` with this mask: 5 header bytes plus the masked payload. */
export function ownerUpdateRecordSize(mask: number): number {
  return MIN_OWNER_UPDATE_RECORD_SIZE + deltaMaskPayloadSize(mask);
}

/**
 * Writes one `OwnerUpdateRecord`: `u32 NetId`, `u8 Mask`, then the masked fields in bit order.
 * Returns the byte count, or 0 if the destination is too small.
 */
export function writeOwnerUpdateRecord(
  target: DataView,
  offset: number,
  netId: number,
  mask: number,
  state: EntityWireState
): number {
  const size = ownerUpdateRecordSize(mask);
  if (target.byteLength - offset < size) {
    return 0;
  }

  target.setUint32(offset, netId, true);
  target.setUint8(offset + 4, mask);
  writeMaskedFields(target, offset + MIN_OWNER_UPDATE_RECORD_SIZE, mask, state);
  return size;
}

/**
 * Reads one `OwnerUpdateRecord` at `offset`. The caller still has to validate ownership, the
 * generation bits and `isClientMaskLegal` — this only decodes.
 */
export function readOwnerUpdateRecord(
  source: DataView,
  offset: number,
  out: OwnerUpdateRecord
): boolean {
  out.netId = 0;
  out.mask = 0;
  out.bytesRead = 0;
  resetEntityWireState(out.state);

  if (offset < 0 || source.byteLength - offset < MIN_OWNER_UPDATE_RECORD_SIZE) {
    return false;
  }

  const mask = source.getUint8(offset + 4);
  const size = ownerUpdateRecordSize(mask);
  if (source.byteLength - offset < size) {
    return false;
  }

  out.netId = source.getUint32(offset, true);
  out.mask = mask;
  readMaskedFields(source, offset + MIN_OWNER_UPDATE_RECORD_SIZE, mask, out.state);
  out.bytesRead = size;
  return true;
}

/**
 * The masked payload, in bit order, shared by both update records — one implementation so the two
 * layouts can never drift in anything but their header.
 */
function writeMaskedFields(
  target: DataView,
  offset: number,
  mask: number,
  state: EntityWireState
): void {
  let at = offset;
  if ((mask & DeltaMask.X) !== 0) {
    target.setUint16(at, state.qx, true);
    at += 2;
  }
  if ((mask & DeltaMask.Y) !== 0) {
    target.setUint16(at, state.qy, true);
    at += 2;
  }
  if ((mask & DeltaMask.Rot) !== 0) {
    target.setUint8(at, state.qrot);
    at += 1;
  }
  if ((mask & DeltaMask.Vx) !== 0) {
    target.setInt16(at, state.qvx, true);
    at += 2;
  }
  if ((mask & DeltaMask.Vy) !== 0) {
    target.setInt16(at, state.qvy, true);
    at += 2;
  }
  if ((mask & DeltaMask.Flags) !== 0) {
    target.setUint8(at, state.flags);
  }
}

/** Mirror of {@link writeMaskedFields}; the record has already been length-checked. */
function readMaskedFields(
  source: DataView,
  offset: number,
  mask: number,
  state: EntityWireState
): void {
  let at = offset;
  if ((mask & DeltaMask.X) !== 0) {
    state.qx = source.getUint16(at, true);
    at += 2;
  }
  if ((mask & DeltaMask.Y) !== 0) {
    state.qy = source.getUint16(at, true);
    at += 2;
  }
  if ((mask & DeltaMask.Rot) !== 0) {
    state.qrot = source.getUint8(at);
    at += 1;
  }
  if ((mask & DeltaMask.Vx) !== 0) {
    state.qvx = source.getInt16(at, true);
    at += 2;
  }
  if ((mask & DeltaMask.Vy) !== 0) {
    state.qvy = source.getInt16(at, true);
    at += 2;
  }
  if ((mask & DeltaMask.Flags) !== 0) {
    state.flags = source.getUint8(at);
  }
}

// ── Shared section primitives ────────────────────────────────────────────────

/**
 * Reserves a `u16` section-count slot, pre-filled with 0. Returns {@link SECTION_COUNT_SIZE}, or 0 if
 * the destination is too small. Remember the absolute offset and patch it with
 * {@link patchSectionCount} once the records are in — reserve-then-patch is what makes
 * encode-once/memcpy-many fan-out possible.
 */
export function writeSectionCountPlaceholder(target: DataView, offset: number): number {
  if (target.byteLength - offset < SECTION_COUNT_SIZE) {
    return 0;
  }
  target.setUint16(offset, 0, true);
  return SECTION_COUNT_SIZE;
}

/**
 * Overwrites a reserved `u16` count slot at `countOffset` (absolute, from the start of the frame).
 * False when the offset is outside the frame or the count does not fit in a `u16`.
 */
export function patchSectionCount(frame: DataView, countOffset: number, count: number): boolean {
  if (count < 0 || count > 0xffff) {
    return false;
  }
  if (countOffset < 0 || countOffset + SECTION_COUNT_SIZE > frame.byteLength) {
    return false;
  }
  frame.setUint16(countOffset, count, true);
  return true;
}

/** Appends a removed `u16 Slot`. Returns {@link REMOVED_SLOT_SIZE}, or 0 if it does not fit. */
export function writeRemovedSlot(target: DataView, offset: number, slot: number): number {
  if (target.byteLength - offset < REMOVED_SLOT_SIZE) {
    return 0;
  }
  target.setUint16(offset, slot, true);
  return REMOVED_SLOT_SIZE;
}

/** Reads a bare `u16 Slot` (a removed-section entry). `-1` when fewer than 2 bytes are available. */
export function readRemovedSlot(source: DataView, offset: number): number {
  if (offset < 0 || source.byteLength - offset < REMOVED_SLOT_SIZE) {
    return -1;
  }
  return source.getUint16(offset, true);
}

// ── SnapshotPacket (68, S→C) ─────────────────────────────────────────────────

/** Decoded `SnapshotPacket` header plus the bounds of its record block. */
export interface SnapshotPacketView {
  /** Per-client sequence number; a gap means desync. */
  seq: number;
  /** Server tick the packet was produced on. */
  serverTick: number;
  /** `FrameFlags`; bit 0 is `Final`. */
  frameFlags: number;
  /** Number of `FullRecord`s that follow. */
  count: number;
  /** Offset of the first `FullRecord` inside the frame. */
  recordsOffset: number;
  /** Exactly `count × FULL_RECORD_SIZE` bytes. */
  recordsLength: number;
}

/** A zeroed {@link SnapshotPacketView} to pass as an out-parameter. */
export function createSnapshotPacketView(): SnapshotPacketView {
  return { seq: 0, serverTick: 0, frameFlags: 0, count: 0, recordsOffset: 0, recordsLength: 0 };
}

/**
 * Stamps `[u8 68][u16 Seq][u32 ServerTick][u8 FrameFlags = 0][u16 Count = 0]`. Append `FullRecord`s
 * after it, then call {@link patchSnapshotPacketCount} and — on the last frame of a split snapshot —
 * {@link patchSnapshotPacketFrameFlags}. Both the flags byte and the count start at zero because
 * neither is known until the frame has been filled.
 */
export function writeSnapshotPacketHeader(
  target: DataView,
  offset: number,
  seq: number,
  serverTick: number
): number {
  if (target.byteLength - offset < SNAPSHOT_PACKET_HEADER_SIZE) {
    return 0;
  }
  target.setUint8(offset, MessageTypeIds.SnapshotPacket);
  target.setUint16(offset + 1, seq, true);
  target.setUint32(offset + 3, serverTick, true);
  target.setUint8(offset + SNAPSHOT_PACKET_FRAME_FLAGS_OFFSET, 0);
  target.setUint16(offset + SNAPSHOT_PACKET_COUNT_OFFSET, 0, true);
  return SNAPSHOT_PACKET_HEADER_SIZE;
}

/** Patches the record count of a `SnapshotPacket` written into `frame`. */
export function patchSnapshotPacketCount(frame: DataView, count: number): boolean {
  return patchSectionCount(frame, SNAPSHOT_PACKET_COUNT_OFFSET, count);
}

/** Patches the `FrameFlags` byte — in practice to stamp `Final` on the frame that ended a snapshot. */
export function patchSnapshotPacketFrameFlags(frame: DataView, frameFlags: number): boolean {
  if (frame.byteLength <= SNAPSHOT_PACKET_FRAME_FLAGS_OFFSET) {
    return false;
  }
  frame.setUint8(SNAPSHOT_PACKET_FRAME_FLAGS_OFFSET, frameFlags);
  return true;
}

/**
 * Validates a complete `SnapshotPacket` (TypeId included) and locates its record block. False on a
 * wrong TypeId, a short header, or a count the buffer cannot hold.
 */
export function readSnapshotPacket(frame: DataView, out: SnapshotPacketView): boolean {
  out.seq = 0;
  out.serverTick = 0;
  out.frameFlags = 0;
  out.count = 0;
  out.recordsOffset = 0;
  out.recordsLength = 0;

  if (
    frame.byteLength < SNAPSHOT_PACKET_HEADER_SIZE ||
    frame.getUint8(0) !== MessageTypeIds.SnapshotPacket
  ) {
    return false;
  }

  const declared = frame.getUint16(SNAPSHOT_PACKET_COUNT_OFFSET, true);
  const payloadBytes = declared * FULL_RECORD_SIZE;
  if (frame.byteLength - SNAPSHOT_PACKET_HEADER_SIZE < payloadBytes) {
    return false;
  }

  out.seq = frame.getUint16(1, true);
  out.serverTick = frame.getUint32(3, true);
  out.frameFlags = frame.getUint8(SNAPSHOT_PACKET_FRAME_FLAGS_OFFSET);
  out.count = declared;
  out.recordsOffset = SNAPSHOT_PACKET_HEADER_SIZE;
  out.recordsLength = payloadBytes;
  return true;
}

/** Reads the `FullRecord` at `index` of a decoded snapshot. False when out of range. */
export function readSnapshotRecord(
  frame: DataView,
  snapshot: SnapshotPacketView,
  index: number,
  out: FullRecord
): boolean {
  if (index < 0 || index >= snapshot.count) {
    out.netId = 0;
    resetEntityWireState(out.state);
    return false;
  }
  return readFullRecord(frame, snapshot.recordsOffset + index * FULL_RECORD_SIZE, out);
}

// ── DeltaPacket (69, S→C) ────────────────────────────────────────────────────

/**
 * The validated view of one `DeltaPacket`.
 *
 * Sections must be applied in wire order: **removals first**, then enters, then updates. That is what
 * makes slot addressing safe on an ordered stream — a slot's removal always precedes any reuse of it.
 */
export interface DeltaPacketSections {
  /** Per-client sequence number; a gap means desync — send `ResyncCommand`. */
  seq: number;
  /** Server tick the packet was produced on. */
  serverTick: number;
  /** Number of slots in the removed section. */
  removedCount: number;
  /** Offset of the first removed `u16 Slot`. */
  removedOffset: number;
  /** Number of `FullRecord`s in the enter section. */
  enterCount: number;
  /** Offset of the first enter `FullRecord`. */
  enterOffset: number;
  /** Number of `UpdateRecord`s in the update section. */
  updateCount: number;
  /** Offset of the first `UpdateRecord`. */
  updatesOffset: number;
  /** Bytes the update section occupies — everything to the end of the frame. */
  updatesLength: number;
}

/** A zeroed {@link DeltaPacketSections} to pass as an out-parameter. */
export function createDeltaPacketSections(): DeltaPacketSections {
  return {
    seq: 0,
    serverTick: 0,
    removedCount: 0,
    removedOffset: 0,
    enterCount: 0,
    enterOffset: 0,
    updateCount: 0,
    updatesOffset: 0,
    updatesLength: 0,
  };
}

/** Stamps `[u8 69][u16 Seq][u32 ServerTick]`. The three sections follow, each count-then-records. */
export function writeDeltaPacketHeader(
  target: DataView,
  offset: number,
  seq: number,
  serverTick: number
): number {
  if (target.byteLength - offset < DELTA_PACKET_HEADER_SIZE) {
    return 0;
  }
  target.setUint8(offset, MessageTypeIds.DeltaPacket);
  target.setUint16(offset + 1, seq, true);
  target.setUint32(offset + 3, serverTick, true);
  return DELTA_PACKET_HEADER_SIZE;
}

/**
 * Validates a complete `DeltaPacket` (TypeId included) and splits it into its three sections. The
 * removed and enter sections are checked byte-exactly; the update section is checked against its
 * minimum size (records are variable length) and is then walked with {@link readNextUpdateRecord}.
 */
export function readDeltaPacket(frame: DataView, out: DeltaPacketSections): boolean {
  out.seq = 0;
  out.serverTick = 0;
  out.removedCount = 0;
  out.removedOffset = 0;
  out.enterCount = 0;
  out.enterOffset = 0;
  out.updateCount = 0;
  out.updatesOffset = 0;
  out.updatesLength = 0;

  if (
    frame.byteLength < DELTA_PACKET_FIXED_OVERHEAD ||
    frame.getUint8(0) !== MessageTypeIds.DeltaPacket
  ) {
    return false;
  }

  const seq = frame.getUint16(1, true);
  const serverTick = frame.getUint32(3, true);
  let offset = DELTA_PACKET_HEADER_SIZE;

  const removedCount = frame.getUint16(offset, true);
  offset += SECTION_COUNT_SIZE;
  const removedBytes = removedCount * REMOVED_SLOT_SIZE;
  if (frame.byteLength - offset < removedBytes) {
    return false;
  }
  const removedOffset = offset;
  offset += removedBytes;

  if (frame.byteLength - offset < SECTION_COUNT_SIZE) {
    return false;
  }
  const enterCount = frame.getUint16(offset, true);
  offset += SECTION_COUNT_SIZE;
  const enterBytes = enterCount * FULL_RECORD_SIZE;
  if (frame.byteLength - offset < enterBytes) {
    return false;
  }
  const enterOffset = offset;
  offset += enterBytes;

  if (frame.byteLength - offset < SECTION_COUNT_SIZE) {
    return false;
  }
  const updateCount = frame.getUint16(offset, true);
  offset += SECTION_COUNT_SIZE;
  const updateBytes = frame.byteLength - offset;
  if (updateBytes < updateCount * MIN_UPDATE_RECORD_SIZE) {
    return false;
  }

  out.seq = seq;
  out.serverTick = serverTick;
  out.removedCount = removedCount;
  out.removedOffset = removedOffset;
  out.enterCount = enterCount;
  out.enterOffset = enterOffset;
  out.updateCount = updateCount;
  out.updatesOffset = offset;
  out.updatesLength = updateBytes;
  return true;
}

/** True when the packet carries nothing at all (a conforming server never sends one). */
export function isDeltaPacketEmpty(sections: DeltaPacketSections): boolean {
  return sections.removedCount === 0 && sections.enterCount === 0 && sections.updateCount === 0;
}

/** Reads the removed slot at `index`. `-1` when out of range. */
export function readRemovedSlotAt(
  frame: DataView,
  sections: DeltaPacketSections,
  index: number
): number {
  if (index < 0 || index >= sections.removedCount) {
    return -1;
  }
  return readRemovedSlot(frame, sections.removedOffset + index * REMOVED_SLOT_SIZE);
}

/** Reads the AOI-enter `FullRecord` at `index`. False when out of range. */
export function readEnterRecord(
  frame: DataView,
  sections: DeltaPacketSections,
  index: number,
  out: FullRecord
): boolean {
  if (index < 0 || index >= sections.enterCount) {
    out.netId = 0;
    resetEntityWireState(out.state);
    return false;
  }
  return readFullRecord(frame, sections.enterOffset + index * FULL_RECORD_SIZE, out);
}

/**
 * Reads the `UpdateRecord` at `cursor` bytes into the update section. Start at 0 and advance by
 * `out.bytesRead`; it returns false on a truncated record, so a malformed packet simply stops the walk.
 */
export function readNextUpdateRecord(
  frame: DataView,
  sections: DeltaPacketSections,
  cursor: number,
  out: UpdateRecord
): boolean {
  if (cursor < 0 || cursor >= sections.updatesLength) {
    out.slot = 0;
    out.mask = 0;
    out.bytesRead = 0;
    resetEntityWireState(out.state);
    return false;
  }
  return readUpdateRecord(frame, sections.updatesOffset + cursor, out);
}

// ── EntityUpdatePacket (67, C→S) ─────────────────────────────────────────────

/** Decoded `EntityUpdatePacket` header plus the bounds of its record block. */
export interface EntityUpdatePacketView {
  /**
   * The sender's tick. **Advisory only**: the server stamps its own tick and must never trust this
   * for ordering decisions that affect other clients.
   */
  clientTick: number;
  /** Number of `OwnerUpdateRecord`s the header declares. */
  count: number;
  /** Offset of the first record. */
  recordsOffset: number;
  /** Bytes the record block occupies — everything to the end of the frame. */
  recordsLength: number;
}

/** A zeroed {@link EntityUpdatePacketView} to pass as an out-parameter. */
export function createEntityUpdatePacketView(): EntityUpdatePacketView {
  return { clientTick: 0, count: 0, recordsOffset: 0, recordsLength: 0 };
}

/** Stamps `[u8 67][u32 ClientTick][u8 Count = 0]`. Patch the count once the records are in. */
export function writeEntityUpdatePacketHeader(
  target: DataView,
  offset: number,
  clientTick: number
): number {
  if (target.byteLength - offset < ENTITY_UPDATE_PACKET_HEADER_SIZE) {
    return 0;
  }
  target.setUint8(offset, MessageTypeIds.EntityUpdatePacket);
  target.setUint32(offset + 1, clientTick, true);
  target.setUint8(offset + ENTITY_UPDATE_PACKET_COUNT_OFFSET, 0);
  return ENTITY_UPDATE_PACKET_HEADER_SIZE;
}

/** Patches the `u8` record count. False when the frame is too short or the count exceeds 255. */
export function patchEntityUpdatePacketCount(frame: DataView, count: number): boolean {
  if (count < 0 || count > MAX_ENTITY_UPDATE_RECORDS) {
    return false;
  }
  if (frame.byteLength <= ENTITY_UPDATE_PACKET_COUNT_OFFSET) {
    return false;
  }
  frame.setUint8(ENTITY_UPDATE_PACKET_COUNT_OFFSET, count);
  return true;
}

/**
 * Validates a complete `EntityUpdatePacket` (TypeId included) and locates its record block. Records
 * are variable length, so only the minimum size is checked here; walk the block with
 * {@link readOwnerUpdateRecord}, which validates each record and reports how many bytes it consumed.
 */
export function readEntityUpdatePacket(frame: DataView, out: EntityUpdatePacketView): boolean {
  out.clientTick = 0;
  out.count = 0;
  out.recordsOffset = 0;
  out.recordsLength = 0;

  if (
    frame.byteLength < ENTITY_UPDATE_PACKET_HEADER_SIZE ||
    frame.getUint8(0) !== MessageTypeIds.EntityUpdatePacket
  ) {
    return false;
  }

  const declared = frame.getUint8(ENTITY_UPDATE_PACKET_COUNT_OFFSET);
  const available = frame.byteLength - ENTITY_UPDATE_PACKET_HEADER_SIZE;
  if (available < declared * MIN_OWNER_UPDATE_RECORD_SIZE) {
    return false;
  }

  out.clientTick = frame.getUint32(1, true);
  out.count = declared;
  out.recordsOffset = ENTITY_UPDATE_PACKET_HEADER_SIZE;
  out.recordsLength = available;
  return true;
}

// ── SignalBatchPacket (130, S→C) ─────────────────────────────────────────────

/** The validated view of one `SignalBatchPacket`. */
export interface SignalBatchSections {
  /** Per-client sequence number, shared with the other hot frames. */
  seq: number;
  /** Server tick the packet was produced on. */
  serverTick: number;
  /** Number of entries the header declares. */
  count: number;
  /** Offset of the first entry, immediately after the 8-byte header. */
  entriesOffset: number;
  /** Bytes the entry block occupies — everything to the end of the frame. */
  entriesLength: number;
}

/** A zeroed {@link SignalBatchSections} to pass as an out-parameter. */
export function createSignalBatchSections(): SignalBatchSections {
  return { seq: 0, serverTick: 0, count: 0, entriesOffset: 0, entriesLength: 0 };
}

/** One decoded batch entry. `name` and `payload` are views over the frame, not copies. */
export interface SignalBatchEntry {
  /** Sender, stamped by the server; never copied from the emitter's payload. */
  senderClientId: number;
  /** The signal name, 1…64 UTF-8 bytes. */
  name: Uint8Array;
  /** The opaque payload, 0…255 bytes. */
  payload: Uint8Array;
  /** Bytes the entry occupied; 0 when the read failed. */
  bytesRead: number;
}

const EMPTY_BYTES = new Uint8Array(0);

/** A zeroed {@link SignalBatchEntry} to pass as an out-parameter. */
export function createSignalBatchEntry(): SignalBatchEntry {
  return { senderClientId: 0, name: EMPTY_BYTES, payload: EMPTY_BYTES, bytesRead: 0 };
}

/**
 * Encoded size of one batch entry. Returns 0 when either length is outside its legal range, so a
 * caller can use this as the eligibility test before renting space: an over-large signal is simply
 * not eligible for the hot path.
 */
export function signalEntrySize(nameLength: number, payloadLength: number): number {
  if (nameLength < MIN_SIGNAL_NAME_LENGTH || nameLength > MAX_SIGNAL_NAME_LENGTH) {
    return 0;
  }
  if (payloadLength < 0 || payloadLength > MAX_SIGNAL_PAYLOAD_LENGTH) {
    return 0;
  }
  return SIGNAL_ENTRY_OVERHEAD_SIZE + nameLength + payloadLength;
}

/** Stamps `[u8 130][u16 Seq][u32 ServerTick][u8 Count = 0]`. Patch the count once entries are in. */
export function writeSignalBatchPacketHeader(
  target: DataView,
  offset: number,
  seq: number,
  serverTick: number
): number {
  if (target.byteLength - offset < SIGNAL_BATCH_PACKET_HEADER_SIZE) {
    return 0;
  }
  target.setUint8(offset, MessageTypeIds.SignalBatchPacket);
  target.setUint16(offset + 1, seq, true);
  target.setUint32(offset + 3, serverTick, true);
  target.setUint8(offset + SIGNAL_BATCH_PACKET_COUNT_OFFSET, 0);
  return SIGNAL_BATCH_PACKET_HEADER_SIZE;
}

/** Patches the `u8` entry count. False when the frame is too short or the count exceeds 255. */
export function patchSignalBatchPacketCount(frame: DataView, count: number): boolean {
  if (count < 0 || count > MAX_SIGNAL_BATCH_ENTRIES) {
    return false;
  }
  if (frame.byteLength <= SIGNAL_BATCH_PACKET_COUNT_OFFSET) {
    return false;
  }
  frame.setUint8(SIGNAL_BATCH_PACKET_COUNT_OFFSET, count);
  return true;
}

/**
 * Writes one batch entry: `u32 SenderClientId`, `u8 NameLength`, the UTF-8 name, `u8 PayloadLength`,
 * the payload. Returns the byte count, or 0 when the destination is too small *or* a length is
 * illegal.
 */
export function writeSignalEntry(
  target: DataView,
  offset: number,
  senderClientId: number,
  name: Uint8Array,
  payload: Uint8Array
): number {
  const size = signalEntrySize(name.length, payload.length);
  if (size === 0 || target.byteLength - offset < size) {
    return 0;
  }

  target.setUint32(offset, senderClientId, true);
  target.setUint8(offset + 4, name.length);
  bytesOf(target, offset + 5, name.length).set(name);

  const payloadLengthOffset = offset + 5 + name.length;
  target.setUint8(payloadLengthOffset, payload.length);
  bytesOf(target, payloadLengthOffset + 1, payload.length).set(payload);
  return size;
}

/**
 * Reads one batch entry at `offset`. False on a truncated entry, a zero `NameLength`, or a name longer
 * than {@link MAX_SIGNAL_NAME_LENGTH} — malformed input is a normal event here and never throws.
 */
export function readSignalEntry(source: DataView, offset: number, out: SignalBatchEntry): boolean {
  out.senderClientId = 0;
  out.name = EMPTY_BYTES;
  out.payload = EMPTY_BYTES;
  out.bytesRead = 0;

  if (offset < 0 || source.byteLength - offset < MIN_SIGNAL_ENTRY_SIZE) {
    return false;
  }

  const nameLength = source.getUint8(offset + 4);
  if (nameLength < MIN_SIGNAL_NAME_LENGTH || nameLength > MAX_SIGNAL_NAME_LENGTH) {
    return false;
  }

  const payloadLengthOffset = offset + 5 + nameLength;
  if (source.byteLength <= payloadLengthOffset) {
    return false;
  }

  const payloadLength = source.getUint8(payloadLengthOffset);
  const size = SIGNAL_ENTRY_OVERHEAD_SIZE + nameLength + payloadLength;
  if (source.byteLength - offset < size) {
    return false;
  }

  out.senderClientId = source.getUint32(offset, true);
  out.name = bytesOf(source, offset + 5, nameLength);
  out.payload = bytesOf(source, payloadLengthOffset + 1, payloadLength);
  out.bytesRead = size;
  return true;
}

/**
 * Validates a complete `SignalBatchPacket` (TypeId included) and locates its entry block. Entries are
 * variable length, so only the aggregate minimum is checked here; each entry is validated as
 * {@link readNextSignalEntry} walks it.
 */
export function readSignalBatchPacket(frame: DataView, out: SignalBatchSections): boolean {
  out.seq = 0;
  out.serverTick = 0;
  out.count = 0;
  out.entriesOffset = 0;
  out.entriesLength = 0;

  if (
    frame.byteLength < SIGNAL_BATCH_PACKET_HEADER_SIZE ||
    frame.getUint8(0) !== MessageTypeIds.SignalBatchPacket
  ) {
    return false;
  }

  const declared = frame.getUint8(SIGNAL_BATCH_PACKET_COUNT_OFFSET);
  const available = frame.byteLength - SIGNAL_BATCH_PACKET_HEADER_SIZE;
  if (available < declared * MIN_SIGNAL_ENTRY_SIZE) {
    return false;
  }

  out.seq = frame.getUint16(1, true);
  out.serverTick = frame.getUint32(3, true);
  out.count = declared;
  out.entriesOffset = SIGNAL_BATCH_PACKET_HEADER_SIZE;
  out.entriesLength = available;
  return true;
}

/**
 * Reads the entry at `cursor` bytes into the entry block. Start at 0, advance by `out.bytesRead`, and
 * loop at most `sections.count` times.
 */
export function readNextSignalEntry(
  frame: DataView,
  sections: SignalBatchSections,
  cursor: number,
  out: SignalBatchEntry
): boolean {
  if (cursor < 0 || cursor >= sections.entriesLength) {
    out.senderClientId = 0;
    out.name = EMPTY_BYTES;
    out.payload = EMPTY_BYTES;
    out.bytesRead = 0;
    return false;
  }
  return readSignalEntry(frame, sections.entriesOffset + cursor, out);
}

/** A `Uint8Array` window onto a `DataView`'s buffer — the closest thing JavaScript has to a span. */
function bytesOf(view: DataView, offset: number, length: number): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset + offset, length);
}
