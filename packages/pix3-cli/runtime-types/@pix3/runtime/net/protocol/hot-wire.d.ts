/**
 * `FullRecord` is fixed at 20 bytes: `u32 NetId`, `u16 Kind`, `u32 OwnerId`, `u16 QX`, `u16 QY`,
 * `u8 QRot`, `i16 QVx`, `i16 QVy`, `u8 Flags`.
 */
export declare const FULL_RECORD_SIZE = 20;
/** Bytes before the masked payload of an `UpdateRecord`: `u16 Slot` + `u8 Mask`. */
export declare const MIN_UPDATE_RECORD_SIZE = 3;
/** Largest `UpdateRecord`: header plus every masked field. */
export declare const MAX_UPDATE_RECORD_SIZE: number;
/** Bytes before the masked payload of an `OwnerUpdateRecord`: `u32 NetId` + `u8 Mask`. */
export declare const MIN_OWNER_UPDATE_RECORD_SIZE = 5;
/** Largest `OwnerUpdateRecord`: header plus every masked field. */
export declare const MAX_OWNER_UPDATE_RECORD_SIZE: number;
/** Bytes a removal entry occupies in a `DeltaPacket` removed section: a bare `u16 Slot`. */
export declare const REMOVED_SLOT_SIZE = 2;
/** Bytes a `u16` section count occupies. */
export declare const SECTION_COUNT_SIZE = 2;
/** `[u8 TypeId=68][u16 Seq][u32 ServerTick][u8 FrameFlags][u16 Count]`. */
export declare const SNAPSHOT_PACKET_HEADER_SIZE = 10;
/** Offset of the `u8 FrameFlags` slot inside a `SnapshotPacket`. */
export declare const SNAPSHOT_PACKET_FRAME_FLAGS_OFFSET = 7;
/** Offset of the `u16 Count` slot inside a `SnapshotPacket`. */
export declare const SNAPSHOT_PACKET_COUNT_OFFSET = 8;
/** `[u8 TypeId=69][u16 Seq][u32 ServerTick]`; the three section counts follow. */
export declare const DELTA_PACKET_HEADER_SIZE = 7;
/**
 * Bytes a `DeltaPacket` costs with all three sections empty: the header plus the three always-present
 * `u16` counts. This — not {@link DELTA_PACKET_HEADER_SIZE} — is the header cost in the bandwidth
 * budget, and it is also the smallest well-formed packet.
 */
export declare const DELTA_PACKET_FIXED_OVERHEAD: number;
/** `[u8 TypeId=67][u32 ClientTick][u8 Count]`. */
export declare const ENTITY_UPDATE_PACKET_HEADER_SIZE = 6;
/** Offset of the `u8 Count` slot inside an `EntityUpdatePacket`. */
export declare const ENTITY_UPDATE_PACKET_COUNT_OFFSET = 5;
/** Largest record count an `EntityUpdatePacket` can express (the count field is a byte). */
export declare const MAX_ENTITY_UPDATE_RECORDS = 255;
/** `[u8 TypeId=130][u16 Seq][u32 ServerTick][u8 Count]`. */
export declare const SIGNAL_BATCH_PACKET_HEADER_SIZE = 8;
/** Offset of the `u8 Count` slot inside a `SignalBatchPacket`. */
export declare const SIGNAL_BATCH_PACKET_COUNT_OFFSET = 7;
/** Largest entry count a `SignalBatchPacket` can express (the count field is a byte). */
export declare const MAX_SIGNAL_BATCH_ENTRIES = 255;
/**
 * Fixed bytes of one `SignalBatchPacket` entry: `u32 SenderClientId` + `u8 NameLength` +
 * `u8 PayloadLength`. The two variable blocks follow their lengths.
 */
export declare const SIGNAL_ENTRY_OVERHEAD_SIZE = 6;
/** A signal name may not be empty. */
export declare const MIN_SIGNAL_NAME_LENGTH = 1;
/** Longest signal name, in UTF-8 bytes, a batch entry can express. */
export declare const MAX_SIGNAL_NAME_LENGTH = 64;
/**
 * Longest signal payload a batch entry can express. A larger payload is not eligible for the hot path
 * at all and is refused with the `quota` counter: batched signals are small game events, not a data
 * channel.
 */
export declare const MAX_SIGNAL_PAYLOAD_LENGTH = 255;
/** Smallest possible entry: overhead plus a one-byte name and an empty payload. */
export declare const MIN_SIGNAL_ENTRY_SIZE: number;
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
export declare function createEntityWireState(): EntityWireState;
/** Resets every field to zero, so a reader can reuse one object across records. */
export declare function resetEntityWireState(state: EntityWireState): void;
/**
 * Copies from `source` only the fields selected by `mask`, leaving everything else untouched. This is
 * the one place mask semantics are implemented, so a decoded update is merged rather than assigned
 * wholesale — an unmasked field in a decoded record is zero, not "unchanged".
 */
export declare function applyMaskedState(target: EntityWireState, mask: number, source: EntityWireState): void;
/** Decoded `FullRecord`, filled in place by {@link readFullRecord}. */
export interface FullRecord {
    /** The entity's opaque net id. */
    netId: number;
    /** Every field of the record — a full record is never masked. */
    state: EntityWireState;
}
/** A zeroed {@link FullRecord} to pass as an out-parameter. */
export declare function createFullRecord(): FullRecord;
/**
 * Writes one `FullRecord` at `offset`. Returns {@link FULL_RECORD_SIZE}, or 0 if the destination is
 * too small (nothing is written in that case).
 */
export declare function writeFullRecord(target: DataView, offset: number, netId: number, state: EntityWireState): number;
/** Reads one `FullRecord` at `offset`. False when fewer than {@link FULL_RECORD_SIZE} bytes remain. */
export declare function readFullRecord(source: DataView, offset: number, out: FullRecord): boolean;
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
export declare function createUpdateRecord(): UpdateRecord;
/** Encoded size of an `UpdateRecord` with this mask: 3 header bytes plus the masked payload. */
export declare function updateRecordSize(mask: number): number;
/**
 * Writes one `UpdateRecord`: `u16 Slot`, `u8 Mask`, then the masked fields in bit order. Returns the
 * byte count, or 0 if the destination is too small.
 */
export declare function writeUpdateRecord(target: DataView, offset: number, slot: number, mask: number, state: EntityWireState): number;
/** Reads one `UpdateRecord` at `offset`. False on a truncated record. */
export declare function readUpdateRecord(source: DataView, offset: number, out: UpdateRecord): boolean;
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
export declare function createOwnerUpdateRecord(): OwnerUpdateRecord;
/** Encoded size of an `OwnerUpdateRecord` with this mask: 5 header bytes plus the masked payload. */
export declare function ownerUpdateRecordSize(mask: number): number;
/**
 * Writes one `OwnerUpdateRecord`: `u32 NetId`, `u8 Mask`, then the masked fields in bit order.
 * Returns the byte count, or 0 if the destination is too small.
 */
export declare function writeOwnerUpdateRecord(target: DataView, offset: number, netId: number, mask: number, state: EntityWireState): number;
/**
 * Reads one `OwnerUpdateRecord` at `offset`. The caller still has to validate ownership, the
 * generation bits and `isClientMaskLegal` — this only decodes.
 */
export declare function readOwnerUpdateRecord(source: DataView, offset: number, out: OwnerUpdateRecord): boolean;
/**
 * Reserves a `u16` section-count slot, pre-filled with 0. Returns {@link SECTION_COUNT_SIZE}, or 0 if
 * the destination is too small. Remember the absolute offset and patch it with
 * {@link patchSectionCount} once the records are in — reserve-then-patch is what makes
 * encode-once/memcpy-many fan-out possible.
 */
export declare function writeSectionCountPlaceholder(target: DataView, offset: number): number;
/**
 * Overwrites a reserved `u16` count slot at `countOffset` (absolute, from the start of the frame).
 * False when the offset is outside the frame or the count does not fit in a `u16`.
 */
export declare function patchSectionCount(frame: DataView, countOffset: number, count: number): boolean;
/** Appends a removed `u16 Slot`. Returns {@link REMOVED_SLOT_SIZE}, or 0 if it does not fit. */
export declare function writeRemovedSlot(target: DataView, offset: number, slot: number): number;
/** Reads a bare `u16 Slot` (a removed-section entry). `-1` when fewer than 2 bytes are available. */
export declare function readRemovedSlot(source: DataView, offset: number): number;
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
export declare function createSnapshotPacketView(): SnapshotPacketView;
/**
 * Stamps `[u8 68][u16 Seq][u32 ServerTick][u8 FrameFlags = 0][u16 Count = 0]`. Append `FullRecord`s
 * after it, then call {@link patchSnapshotPacketCount} and — on the last frame of a split snapshot —
 * {@link patchSnapshotPacketFrameFlags}. Both the flags byte and the count start at zero because
 * neither is known until the frame has been filled.
 */
export declare function writeSnapshotPacketHeader(target: DataView, offset: number, seq: number, serverTick: number): number;
/** Patches the record count of a `SnapshotPacket` written into `frame`. */
export declare function patchSnapshotPacketCount(frame: DataView, count: number): boolean;
/** Patches the `FrameFlags` byte — in practice to stamp `Final` on the frame that ended a snapshot. */
export declare function patchSnapshotPacketFrameFlags(frame: DataView, frameFlags: number): boolean;
/**
 * Validates a complete `SnapshotPacket` (TypeId included) and locates its record block. False on a
 * wrong TypeId, a short header, or a count the buffer cannot hold.
 */
export declare function readSnapshotPacket(frame: DataView, out: SnapshotPacketView): boolean;
/** Reads the `FullRecord` at `index` of a decoded snapshot. False when out of range. */
export declare function readSnapshotRecord(frame: DataView, snapshot: SnapshotPacketView, index: number, out: FullRecord): boolean;
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
export declare function createDeltaPacketSections(): DeltaPacketSections;
/** Stamps `[u8 69][u16 Seq][u32 ServerTick]`. The three sections follow, each count-then-records. */
export declare function writeDeltaPacketHeader(target: DataView, offset: number, seq: number, serverTick: number): number;
/**
 * Validates a complete `DeltaPacket` (TypeId included) and splits it into its three sections. The
 * removed and enter sections are checked byte-exactly; the update section is checked against its
 * minimum size (records are variable length) and is then walked with {@link readNextUpdateRecord}.
 */
export declare function readDeltaPacket(frame: DataView, out: DeltaPacketSections): boolean;
/** True when the packet carries nothing at all (a conforming server never sends one). */
export declare function isDeltaPacketEmpty(sections: DeltaPacketSections): boolean;
/** Reads the removed slot at `index`. `-1` when out of range. */
export declare function readRemovedSlotAt(frame: DataView, sections: DeltaPacketSections, index: number): number;
/** Reads the AOI-enter `FullRecord` at `index`. False when out of range. */
export declare function readEnterRecord(frame: DataView, sections: DeltaPacketSections, index: number, out: FullRecord): boolean;
/**
 * Reads the `UpdateRecord` at `cursor` bytes into the update section. Start at 0 and advance by
 * `out.bytesRead`; it returns false on a truncated record, so a malformed packet simply stops the walk.
 */
export declare function readNextUpdateRecord(frame: DataView, sections: DeltaPacketSections, cursor: number, out: UpdateRecord): boolean;
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
export declare function createEntityUpdatePacketView(): EntityUpdatePacketView;
/** Stamps `[u8 67][u32 ClientTick][u8 Count = 0]`. Patch the count once the records are in. */
export declare function writeEntityUpdatePacketHeader(target: DataView, offset: number, clientTick: number): number;
/** Patches the `u8` record count. False when the frame is too short or the count exceeds 255. */
export declare function patchEntityUpdatePacketCount(frame: DataView, count: number): boolean;
/**
 * Validates a complete `EntityUpdatePacket` (TypeId included) and locates its record block. Records
 * are variable length, so only the minimum size is checked here; walk the block with
 * {@link readOwnerUpdateRecord}, which validates each record and reports how many bytes it consumed.
 */
export declare function readEntityUpdatePacket(frame: DataView, out: EntityUpdatePacketView): boolean;
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
export declare function createSignalBatchSections(): SignalBatchSections;
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
/** A zeroed {@link SignalBatchEntry} to pass as an out-parameter. */
export declare function createSignalBatchEntry(): SignalBatchEntry;
/**
 * Encoded size of one batch entry. Returns 0 when either length is outside its legal range, so a
 * caller can use this as the eligibility test before renting space: an over-large signal is simply
 * not eligible for the hot path.
 */
export declare function signalEntrySize(nameLength: number, payloadLength: number): number;
/** Stamps `[u8 130][u16 Seq][u32 ServerTick][u8 Count = 0]`. Patch the count once entries are in. */
export declare function writeSignalBatchPacketHeader(target: DataView, offset: number, seq: number, serverTick: number): number;
/** Patches the `u8` entry count. False when the frame is too short or the count exceeds 255. */
export declare function patchSignalBatchPacketCount(frame: DataView, count: number): boolean;
/**
 * Writes one batch entry: `u32 SenderClientId`, `u8 NameLength`, the UTF-8 name, `u8 PayloadLength`,
 * the payload. Returns the byte count, or 0 when the destination is too small *or* a length is
 * illegal.
 */
export declare function writeSignalEntry(target: DataView, offset: number, senderClientId: number, name: Uint8Array, payload: Uint8Array): number;
/**
 * Reads one batch entry at `offset`. False on a truncated entry, a zero `NameLength`, or a name longer
 * than {@link MAX_SIGNAL_NAME_LENGTH} — malformed input is a normal event here and never throws.
 */
export declare function readSignalEntry(source: DataView, offset: number, out: SignalBatchEntry): boolean;
/**
 * Validates a complete `SignalBatchPacket` (TypeId included) and locates its entry block. Entries are
 * variable length, so only the aggregate minimum is checked here; each entry is validated as
 * {@link readNextSignalEntry} walks it.
 */
export declare function readSignalBatchPacket(frame: DataView, out: SignalBatchSections): boolean;
/**
 * Reads the entry at `cursor` bytes into the entry block. Start at 0, advance by `out.bytesRead`, and
 * loop at most `sections.count` times.
 */
export declare function readNextSignalEntry(frame: DataView, sections: SignalBatchSections, cursor: number, out: SignalBatchEntry): boolean;
