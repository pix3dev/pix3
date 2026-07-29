/**
 * Checks this codec against the golden-vector file every implementation of the pix3-rooms wire
 * protocol shares.
 *
 * **Provenance.** `fixtures/protocol-vectors.json` is a byte-identical copy of
 * `docs/protocol-vectors.json` in the **pix3-rooms** repository, at **protocol version 2**. It carries
 * no stamp and no reformatting on purpose: a plain `diff` between the two files is what proves the two
 * repos are in sync. The authority for every layout is `docs/protocol.md` in that same repo, and the
 * C# side checks itself against the identical file in
 * `tests/Pix3.Rooms.Tests/Protocol/GoldenVectorFileTests.cs`.
 *
 * **Nothing here computes an expectation.** Every quantized integer and every byte string is read out
 * of the published file, which was derived by hand from the spec. A disagreement found here is a
 * disagreement between this codec and the contract — never something to be "fixed" by editing the
 * fixture.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DeltaMask,
  deltaMaskPayloadSize,
  entityFlagsPolicy,
  isClientMaskLegal,
  OwnershipPolicy,
} from './enums';
import {
  createDeltaPacketSections,
  createEntityUpdatePacketView,
  createEntityWireState,
  createFullRecord,
  createOwnerUpdateRecord,
  createSignalBatchEntry,
  createSignalBatchSections,
  createSnapshotPacketView,
  createUpdateRecord,
  DELTA_PACKET_FIXED_OVERHEAD,
  ENTITY_UPDATE_PACKET_HEADER_SIZE,
  FULL_RECORD_SIZE,
  MAX_OWNER_UPDATE_RECORD_SIZE,
  MAX_UPDATE_RECORD_SIZE,
  ownerUpdateRecordSize,
  patchEntityUpdatePacketCount,
  patchSectionCount,
  patchSignalBatchPacketCount,
  patchSnapshotPacketCount,
  patchSnapshotPacketFrameFlags,
  readDeltaPacket,
  readEnterRecord,
  readEntityUpdatePacket,
  readFullRecord,
  readNextSignalEntry,
  readNextUpdateRecord,
  readOwnerUpdateRecord,
  readRemovedSlot,
  readRemovedSlotAt,
  readSignalBatchPacket,
  readSnapshotPacket,
  readSnapshotRecord,
  readUpdateRecord,
  REMOVED_SLOT_SIZE,
  SIGNAL_BATCH_PACKET_HEADER_SIZE,
  signalEntrySize,
  SNAPSHOT_PACKET_HEADER_SIZE,
  updateRecordSize,
  writeDeltaPacketHeader,
  writeEntityUpdatePacketHeader,
  writeFullRecord,
  writeOwnerUpdateRecord,
  writeRemovedSlot,
  writeSectionCountPlaceholder,
  writeSignalBatchPacketHeader,
  writeSignalEntry,
  writeSnapshotPacketHeader,
  writeUpdateRecord,
  type EntityWireState,
} from './hot-wire';
import { MemoryPackReader } from './MemoryPackReader';
import { decodeControlMessage, encodeControlPayload, type ControlMessage } from './messages';
import { isValidNetId, netIdGeneration, netIdSlot, packNetId } from './net-id';
import { isHotPlane, MessageTypeIds, messageTypeIdName, UnknownTypeIdTally } from './type-ids';
import {
  dequantizeRotation,
  dequantizeVelocity,
  isValidWorld,
  tryQuantizeRotation,
  tryQuantizeVelocity,
  WorldQuantizer,
  createQuantizedPosition,
} from './WorldQuantizer';

// ── Fixture loading and shared helpers ───────────────────────────────────────

interface QuantizationVector {
  name: string;
  /** A decimal the file guarantees is exactly representable in float32. */
  input?: number;
  /** An explicit float32 bit pattern, used where a decimal literal would round differently. */
  bits?: string;
  q: number;
}

interface PositionDequantizeVector {
  q: number;
  expect: number;
}

interface SignalEntryVector {
  sender: number;
  name: string;
  payloadHex: string;
}

interface HotVector {
  name: string;
  hex: string;
  slot?: number;
  mask?: number;
  seq?: number;
  serverTick?: number;
  clientTick?: number;
  frameFlags?: number;
  count?: number;
  removedSlots?: number[];
  enterCount?: number;
  updateCount?: number;
  embedsUpdateRecord?: string;
  embedsOwnerUpdateRecord?: string;
  entries?: SignalEntryVector[];
}

interface HotSample {
  netId: number;
  kind: number;
  ownerId: number;
  qx: number;
  qy: number;
  qrot: number;
  qvx: number;
  qvy: number;
  flags: number;
}

interface ControlVector {
  message: string;
  name?: string;
  fields: Record<string, unknown>;
  hex: string;
}

interface VectorFile {
  protocolVersion: number;
  quantization: {
    world: { originX: number; originY: number; size: number };
    position: QuantizationVector[];
    positionDequantize: PositionDequantizeVector[];
    rotation: QuantizationVector[];
    velocity: QuantizationVector[];
    nonFinite: { inputs: string[] };
  };
  hot: { sample: HotSample; vectors: HotVector[] };
  control: { vectors: ControlVector[] };
}

const VECTORS = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'packages/pix3-runtime/src/net/protocol/fixtures/protocol-vectors.json'),
    'utf8'
  )
) as VectorFile;

function normalizeHex(hex: string): string {
  return hex.replace(/\s+/g, '').toUpperCase();
}

function hexBytes(hex: string): Uint8Array {
  const clean = normalizeHex(hex);
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return hex;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Fails loudly rather than substituting a zero, so a fixture rename can never silently pass. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`Vector is missing "${what}".`);
  }
  return value;
}

// ── Quantization ─────────────────────────────────────────────────────────────

/**
 * A vector's float input. `input` is a decimal the file guarantees is exactly representable in
 * float32; `bits` is an explicit big-endian float32 bit pattern, used for the three rotation cases
 * where a decimal literal would round differently in the two languages.
 */
function vectorInput(vector: QuantizationVector): number {
  if (vector.bits !== undefined) {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, Number.parseInt(vector.bits, 16), false);
    return view.getFloat32(0, false);
  }
  return required(vector.input, 'input');
}

function vectorWorld(): WorldQuantizer {
  const world = VECTORS.quantization.world;
  return new WorldQuantizer(world.originX, world.originY, world.size);
}

describe('quantization golden vectors', () => {
  it('the fixture is the protocol version this codec implements', () => {
    expect(VECTORS.protocolVersion).toBe(2);
  });

  it.each(VECTORS.quantization.position.map(v => v.name))(
    'position/%s matches the published vector',
    name => {
      const vector = required(
        VECTORS.quantization.position.find(v => v.name === name),
        `position vector ${name}`
      );
      const input = vectorInput(vector);
      const out = createQuantizedPosition();

      expect(vectorWorld().tryQuantizePosition(input, input, out)).toBe(true);

      // Both axes share an origin in this world, so one vector pins both.
      expect(out.qx).toBe(vector.q);
      expect(out.qy).toBe(vector.q);
    }
  );

  it.each(VECTORS.quantization.positionDequantize.map(v => v.q))(
    'positionDequantize/%i matches the published vector',
    q => {
      const vector = required(
        VECTORS.quantization.positionDequantize.find(v => v.q === q),
        `positionDequantize vector ${q}`
      );
      const world = vectorWorld();

      expect(world.dequantizeX(q)).toBe(vector.expect);
      expect(world.dequantizeY(q)).toBe(vector.expect);
    }
  );

  it.each(VECTORS.quantization.rotation.map(v => v.name))(
    'rotation/%s matches the published vector',
    name => {
      const vector = required(
        VECTORS.quantization.rotation.find(v => v.name === name),
        `rotation vector ${name}`
      );

      expect(tryQuantizeRotation(vectorInput(vector))).toBe(vector.q);
    }
  );

  it.each(VECTORS.quantization.velocity.map(v => v.name))(
    'velocity/%s matches the published vector',
    name => {
      const vector = required(
        VECTORS.quantization.velocity.find(v => v.name === name),
        `velocity vector ${name}`
      );

      expect(tryQuantizeVelocity(vectorInput(vector))).toBe(vector.q);
    }
  );

  it.each(VECTORS.quantization.nonFinite.inputs)('%s is refused by every quantizer', text => {
    // Spelled out rather than parsed, so a new spelling in the fixture fails loudly instead of
    // silently becoming some other number.
    const value =
      text === 'NaN'
        ? Number.NaN
        : text === 'Infinity'
          ? Number.POSITIVE_INFINITY
          : text === '-Infinity'
            ? Number.NEGATIVE_INFINITY
            : (() => {
                throw new Error(`Unrecognised non-finite input '${text}'.`);
              })();
    const world = vectorWorld();
    const out = createQuantizedPosition();

    expect(world.tryQuantizePosition(value, 0, out)).toBe(false);
    expect(world.tryQuantizePosition(0, value, out)).toBe(false);
    expect(tryQuantizeRotation(value)).toBeNull();
    expect(tryQuantizeVelocity(value)).toBeNull();
  });

  it('a dequantized value is a fixed point under a second quantize', () => {
    const world = vectorWorld();
    const out = createQuantizedPosition();
    for (const q of [0, 1, 16, 16384, 32768, 49151, 65534, 65535]) {
      const x = world.dequantizeX(q);
      expect(world.tryQuantizePosition(x, x, out)).toBe(true);
      expect(out.qx).toBe(q);
    }
    for (let q = 0; q < 256; q++) {
      expect(tryQuantizeRotation(dequantizeRotation(q))).toBe(q);
    }
    for (const q of [-32768, -800, -1, 0, 1, 800, 32767]) {
      expect(tryQuantizeVelocity(dequantizeVelocity(q))).toBe(q);
    }
  });

  it('refuses a world whose coordinates dwarf its size', () => {
    // 10⁷ away from the origin with a size of 100 is 100 000 × size: the float32 round trip stops
    // being a fixed point and positions would oscillate by a quantum forever.
    expect(isValidWorld(1e7, 1e7, 100)).toBe(false);
    expect(() => new WorldQuantizer(1e7, 1e7, 100)).toThrow(RangeError);
    expect(isValidWorld(-2048, -2048, 4096)).toBe(true);
    expect(isValidWorld(0, 0, 0.5)).toBe(false);
    expect(isValidWorld(Number.NaN, 0, 4096)).toBe(false);
  });
});

// ── Hot plane ────────────────────────────────────────────────────────────────

const SAMPLE = VECTORS.hot.sample;

/** The one entity every hot vector describes, read field by field out of the fixture. */
function sampleState(): EntityWireState {
  return {
    kind: SAMPLE.kind,
    ownerId: SAMPLE.ownerId,
    qx: SAMPLE.qx,
    qy: SAMPLE.qy,
    qrot: SAMPLE.qrot,
    qvx: SAMPLE.qvx,
    qvy: SAMPLE.qvy,
    flags: SAMPLE.flags,
  };
}

function hotVector(name: string): HotVector {
  return required(
    VECTORS.hot.vectors.find(v => v.name === name),
    `hot vector ${name}`
  );
}

/**
 * A composite packet vector states its section counts but not the fields of the record it embeds: it
 * names the standalone vector whose bytes it repeats, in `embedsUpdateRecord` or
 * `embedsOwnerUpdateRecord`. Resolving the reference rather than restating slot and mask is what keeps
 * the composite and the standalone vector from ever drifting apart.
 *
 * A packet whose record sections are all empty embeds nothing and so carries no reference; the slot
 * and mask it would have supplied are then unused, and zero stands in for them.
 */
function embeddedRecord(reference: string | undefined): HotVector | undefined {
  return reference === undefined ? undefined : hotVector(reference);
}

function embeddedSlot(record: HotVector | undefined): number {
  return record === undefined ? 0 : required(record.slot, 'slot');
}

function embeddedMask(record: HotVector | undefined): number {
  return record === undefined ? 0 : required(record.mask, 'mask');
}

function expectStateMatchesSample(state: EntityWireState): void {
  expect(state).toEqual(sampleState());
}

/**
 * Masked fields must carry the sample's values and unmasked ones must stay at zero — that is what
 * catches a decoder that reads the payload in the wrong order.
 */
function expectMaskedFieldsMatchSample(mask: number, state: EntityWireState): void {
  const sample = sampleState();
  expect(state.qx).toBe((mask & DeltaMask.X) !== 0 ? sample.qx : 0);
  expect(state.qy).toBe((mask & DeltaMask.Y) !== 0 ? sample.qy : 0);
  expect(state.qrot).toBe((mask & DeltaMask.Rot) !== 0 ? sample.qrot : 0);
  expect(state.qvx).toBe((mask & DeltaMask.Vx) !== 0 ? sample.qvx : 0);
  expect(state.qvy).toBe((mask & DeltaMask.Vy) !== 0 ? sample.qvy : 0);
  expect(state.flags).toBe((mask & DeltaMask.Flags) !== 0 ? sample.flags : 0);
  // Kind and OwnerId travel only in a FullRecord, never in an update.
  expect(state.kind).toBe(0);
  expect(state.ownerId).toBe(0);
}

function encodeFullRecordVector(): Uint8Array {
  const frame = new Uint8Array(FULL_RECORD_SIZE);
  expect(writeFullRecord(viewOf(frame), 0, SAMPLE.netId, sampleState())).toBe(FULL_RECORD_SIZE);
  return frame;
}

function encodeUpdateRecordVector(vector: HotVector): Uint8Array {
  const slot = required(vector.slot, 'slot');
  const mask = required(vector.mask, 'mask');
  const buffer = new Uint8Array(MAX_UPDATE_RECORD_SIZE);

  const written = writeUpdateRecord(viewOf(buffer), 0, slot, mask, sampleState());

  expect(written).toBe(updateRecordSize(mask));
  return buffer.subarray(0, written);
}

function encodeOwnerUpdateRecordVector(vector: HotVector): Uint8Array {
  const mask = required(vector.mask, 'mask');
  const buffer = new Uint8Array(MAX_OWNER_UPDATE_RECORD_SIZE);

  const written = writeOwnerUpdateRecord(viewOf(buffer), 0, SAMPLE.netId, mask, sampleState());

  expect(written).toBe(ownerUpdateRecordSize(mask));
  return buffer.subarray(0, written);
}

function encodeRemovedSlotVector(vector: HotVector): Uint8Array {
  const frame = new Uint8Array(REMOVED_SLOT_SIZE);
  expect(writeRemovedSlot(viewOf(frame), 0, required(vector.slot, 'slot'))).toBe(REMOVED_SLOT_SIZE);
  return frame;
}

function encodeSnapshotPacketVector(vector: HotVector): Uint8Array {
  const count = required(vector.count, 'count');
  const frame = new Uint8Array(SNAPSHOT_PACKET_HEADER_SIZE + count * FULL_RECORD_SIZE);
  const view = viewOf(frame);

  let offset = writeSnapshotPacketHeader(
    view,
    0,
    required(vector.seq, 'seq'),
    required(vector.serverTick, 'serverTick')
  );
  for (let i = 0; i < count; i++) {
    offset += writeFullRecord(view, offset, SAMPLE.netId, sampleState());
  }

  expect(patchSnapshotPacketCount(view, count)).toBe(true);
  expect(patchSnapshotPacketFrameFlags(view, required(vector.frameFlags, 'frameFlags'))).toBe(true);
  expect(offset).toBe(frame.length);
  return frame;
}

function encodeDeltaPacketVector(vector: HotVector): Uint8Array {
  const removed = vector.removedSlots ?? [];
  const enterCount = vector.enterCount ?? 0;
  const updateCount = vector.updateCount ?? 0;
  const embedded = embeddedRecord(vector.embedsUpdateRecord);
  const updateSlot = embeddedSlot(embedded);
  const updateMask = embeddedMask(embedded);

  const frame = new Uint8Array(
    DELTA_PACKET_FIXED_OVERHEAD +
      removed.length * REMOVED_SLOT_SIZE +
      enterCount * FULL_RECORD_SIZE +
      updateCount * updateRecordSize(updateMask)
  );
  const view = viewOf(frame);

  let offset = writeDeltaPacketHeader(
    view,
    0,
    required(vector.seq, 'seq'),
    required(vector.serverTick, 'serverTick')
  );

  const removedCountOffset = offset;
  offset += writeSectionCountPlaceholder(view, offset);
  for (const slot of removed) {
    offset += writeRemovedSlot(view, offset, slot);
  }
  expect(patchSectionCount(view, removedCountOffset, removed.length)).toBe(true);

  const enterCountOffset = offset;
  offset += writeSectionCountPlaceholder(view, offset);
  for (let i = 0; i < enterCount; i++) {
    offset += writeFullRecord(view, offset, SAMPLE.netId, sampleState());
  }
  expect(patchSectionCount(view, enterCountOffset, enterCount)).toBe(true);

  const updateCountOffset = offset;
  offset += writeSectionCountPlaceholder(view, offset);
  for (let i = 0; i < updateCount; i++) {
    offset += writeUpdateRecord(view, offset, updateSlot, updateMask, sampleState());
  }
  expect(patchSectionCount(view, updateCountOffset, updateCount)).toBe(true);

  expect(offset).toBe(frame.length);
  return frame;
}

function encodeEntityUpdatePacketVector(vector: HotVector): Uint8Array {
  const count = required(vector.count, 'count');
  const embedded = embeddedRecord(vector.embedsOwnerUpdateRecord);
  const mask = embeddedMask(embedded);

  const frame = new Uint8Array(
    ENTITY_UPDATE_PACKET_HEADER_SIZE + count * ownerUpdateRecordSize(mask)
  );
  const view = viewOf(frame);

  let offset = writeEntityUpdatePacketHeader(view, 0, required(vector.clientTick, 'clientTick'));
  for (let i = 0; i < count; i++) {
    offset += writeOwnerUpdateRecord(view, offset, SAMPLE.netId, mask, sampleState());
  }

  expect(patchEntityUpdatePacketCount(view, count)).toBe(true);
  expect(offset).toBe(frame.length);
  return frame;
}

const UTF8 = new TextEncoder();

function encodeSignalBatchPacketVector(vector: HotVector): Uint8Array {
  const entries = required(vector.entries, 'entries');
  let size = SIGNAL_BATCH_PACKET_HEADER_SIZE;
  for (const entry of entries) {
    size += signalEntrySize(UTF8.encode(entry.name).length, hexBytes(entry.payloadHex).length);
  }

  const frame = new Uint8Array(size);
  const view = viewOf(frame);
  let offset = writeSignalBatchPacketHeader(
    view,
    0,
    required(vector.seq, 'seq'),
    required(vector.serverTick, 'serverTick')
  );

  for (const entry of entries) {
    offset += writeSignalEntry(
      view,
      offset,
      entry.sender,
      UTF8.encode(entry.name),
      hexBytes(entry.payloadHex)
    );
  }

  expect(patchSignalBatchPacketCount(view, entries.length)).toBe(true);
  expect(offset).toBe(frame.length);
  return frame;
}

function encodeHotVector(vector: HotVector): Uint8Array {
  switch (vector.name.split('/')[0]) {
    case 'FullRecord':
      return encodeFullRecordVector();
    case 'UpdateRecord':
      return encodeUpdateRecordVector(vector);
    case 'OwnerUpdateRecord':
      return encodeOwnerUpdateRecordVector(vector);
    case 'RemovedSlot':
      return encodeRemovedSlotVector(vector);
    case 'SnapshotPacket':
      return encodeSnapshotPacketVector(vector);
    case 'DeltaPacket':
      return encodeDeltaPacketVector(vector);
    case 'EntityUpdatePacket':
      return encodeEntityUpdatePacketVector(vector);
    case 'SignalBatchPacket':
      return encodeSignalBatchPacketVector(vector);
    default:
      throw new Error(`No encoder for hot vector '${vector.name}'.`);
  }
}

function decodeFullRecordVector(bytes: Uint8Array): void {
  const out = createFullRecord();
  expect(readFullRecord(viewOf(bytes), 0, out)).toBe(true);
  expect(out.netId).toBe(SAMPLE.netId);
  expectStateMatchesSample(out.state);
}

function decodeUpdateRecordVector(vector: HotVector, bytes: Uint8Array): void {
  const out = createUpdateRecord();
  expect(readUpdateRecord(viewOf(bytes), 0, out)).toBe(true);
  expect(out.slot).toBe(required(vector.slot, 'slot'));
  expect(out.mask).toBe(required(vector.mask, 'mask'));
  expect(out.bytesRead).toBe(bytes.length);
  expectMaskedFieldsMatchSample(out.mask, out.state);
}

function decodeOwnerUpdateRecordVector(vector: HotVector, bytes: Uint8Array): void {
  const out = createOwnerUpdateRecord();
  expect(readOwnerUpdateRecord(viewOf(bytes), 0, out)).toBe(true);
  expect(out.netId).toBe(SAMPLE.netId);
  expect(out.mask).toBe(required(vector.mask, 'mask'));
  expect(out.bytesRead).toBe(bytes.length);
  expectMaskedFieldsMatchSample(out.mask, out.state);
}

function decodeRemovedSlotVector(vector: HotVector, bytes: Uint8Array): void {
  expect(readRemovedSlot(viewOf(bytes), 0)).toBe(required(vector.slot, 'slot'));
}

function decodeSnapshotPacketVector(vector: HotVector, bytes: Uint8Array): void {
  const view = viewOf(bytes);
  const snapshot = createSnapshotPacketView();
  expect(readSnapshotPacket(view, snapshot)).toBe(true);

  expect(snapshot.seq).toBe(required(vector.seq, 'seq'));
  expect(snapshot.serverTick).toBe(required(vector.serverTick, 'serverTick'));
  expect(snapshot.frameFlags).toBe(required(vector.frameFlags, 'frameFlags'));
  expect(snapshot.count).toBe(required(vector.count, 'count'));
  expect(snapshot.recordsLength).toBe(snapshot.count * FULL_RECORD_SIZE);

  const record = createFullRecord();
  for (let i = 0; i < snapshot.count; i++) {
    expect(readSnapshotRecord(view, snapshot, i, record)).toBe(true);
    expect(record.netId).toBe(SAMPLE.netId);
    expectStateMatchesSample(record.state);
  }
}

function decodeDeltaPacketVector(vector: HotVector, bytes: Uint8Array): void {
  const view = viewOf(bytes);
  const sections = createDeltaPacketSections();
  expect(readDeltaPacket(view, sections)).toBe(true);

  expect(sections.seq).toBe(required(vector.seq, 'seq'));
  expect(sections.serverTick).toBe(required(vector.serverTick, 'serverTick'));

  const removed = vector.removedSlots ?? [];
  expect(sections.removedCount).toBe(removed.length);
  for (let i = 0; i < removed.length; i++) {
    expect(readRemovedSlotAt(view, sections, i)).toBe(removed[i]);
  }

  const enterCount = vector.enterCount ?? 0;
  expect(sections.enterCount).toBe(enterCount);
  const entered = createFullRecord();
  for (let i = 0; i < enterCount; i++) {
    expect(readEnterRecord(view, sections, i, entered)).toBe(true);
    expect(entered.netId).toBe(SAMPLE.netId);
    expectStateMatchesSample(entered.state);
  }

  const embedded = embeddedRecord(vector.embedsUpdateRecord);
  const updateCount = vector.updateCount ?? 0;
  expect(sections.updateCount).toBe(updateCount);
  const update = createUpdateRecord();
  let cursor = 0;
  for (let i = 0; i < updateCount; i++) {
    expect(readNextUpdateRecord(view, sections, cursor, update)).toBe(true);
    expect(update.slot).toBe(embeddedSlot(embedded));
    expect(update.mask).toBe(embeddedMask(embedded));
    expectMaskedFieldsMatchSample(update.mask, update.state);
    cursor += update.bytesRead;
  }
  expect(cursor).toBe(sections.updatesLength);
}

function decodeEntityUpdatePacketVector(vector: HotVector, bytes: Uint8Array): void {
  const view = viewOf(bytes);
  const packet = createEntityUpdatePacketView();
  expect(readEntityUpdatePacket(view, packet)).toBe(true);

  expect(packet.clientTick).toBe(required(vector.clientTick, 'clientTick'));
  expect(packet.count).toBe(required(vector.count, 'count'));

  const embedded = embeddedRecord(vector.embedsOwnerUpdateRecord);
  const record = createOwnerUpdateRecord();
  let cursor = 0;
  for (let i = 0; i < packet.count; i++) {
    expect(readOwnerUpdateRecord(view, packet.recordsOffset + cursor, record)).toBe(true);
    expect(record.netId).toBe(SAMPLE.netId);
    expect(record.mask).toBe(embeddedMask(embedded));
    expectMaskedFieldsMatchSample(record.mask, record.state);
    cursor += record.bytesRead;
  }
  expect(cursor).toBe(packet.recordsLength);
}

const UTF8_DECODER = new TextDecoder();

function decodeSignalBatchPacketVector(vector: HotVector, bytes: Uint8Array): void {
  const view = viewOf(bytes);
  const sections = createSignalBatchSections();
  expect(readSignalBatchPacket(view, sections)).toBe(true);

  expect(sections.seq).toBe(required(vector.seq, 'seq'));
  expect(sections.serverTick).toBe(required(vector.serverTick, 'serverTick'));

  const entries = required(vector.entries, 'entries');
  expect(sections.count).toBe(entries.length);

  const entry = createSignalBatchEntry();
  let cursor = 0;
  for (const expected of entries) {
    expect(readNextSignalEntry(view, sections, cursor, entry)).toBe(true);
    expect(entry.senderClientId).toBe(expected.sender);
    expect(UTF8_DECODER.decode(entry.name)).toBe(expected.name);
    expect(toHex(entry.payload)).toBe(normalizeHex(expected.payloadHex));
    cursor += entry.bytesRead;
  }
  expect(cursor).toBe(sections.entriesLength);
}

function decodeHotVector(vector: HotVector, bytes: Uint8Array): void {
  switch (vector.name.split('/')[0]) {
    case 'FullRecord':
      decodeFullRecordVector(bytes);
      return;
    case 'UpdateRecord':
      decodeUpdateRecordVector(vector, bytes);
      return;
    case 'OwnerUpdateRecord':
      decodeOwnerUpdateRecordVector(vector, bytes);
      return;
    case 'RemovedSlot':
      decodeRemovedSlotVector(vector, bytes);
      return;
    case 'SnapshotPacket':
      decodeSnapshotPacketVector(vector, bytes);
      return;
    case 'DeltaPacket':
      decodeDeltaPacketVector(vector, bytes);
      return;
    case 'EntityUpdatePacket':
      decodeEntityUpdatePacketVector(vector, bytes);
      return;
    case 'SignalBatchPacket':
      decodeSignalBatchPacketVector(vector, bytes);
      return;
    default:
      throw new Error(`No decoder for hot vector '${vector.name}'.`);
  }
}

describe('hot-plane golden vectors', () => {
  it.each(VECTORS.hot.vectors.map(v => v.name))('%s encodes to the published bytes', name => {
    const vector = hotVector(name);

    expect(toHex(encodeHotVector(vector))).toBe(normalizeHex(vector.hex));
  });

  it.each(VECTORS.hot.vectors.map(v => v.name))('%s decodes back to its published fields', name => {
    const vector = hotVector(name);

    // Decoding the published bytes, not our own output: a reader and a writer that share a mistake
    // would round-trip happily.
    decodeHotVector(vector, hexBytes(vector.hex));
  });

  it('the sample entity spells out the flags byte the fixture documents', () => {
    // 0xA9 = 1010_1001: policy bits 0–1 = 01 (Shared), fabric reserved bit clear, app bits 10101.
    expect(entityFlagsPolicy(SAMPLE.flags)).toBe(OwnershipPolicy.Shared);
    expect(isHotPlane(MessageTypeIds.SnapshotPacket)).toBe(true);
    expect(isHotPlane(MessageTypeIds.WelcomeEvent)).toBe(false);
    expect(messageTypeIdName(MessageTypeIds.DeltaPacket)).toBe('DeltaPacket');
  });

  it('mask payload sizes follow the published field widths', () => {
    expect(deltaMaskPayloadSize(DeltaMask.None)).toBe(0);
    expect(deltaMaskPayloadSize(DeltaMask.X | DeltaMask.Y | DeltaMask.Rot)).toBe(5);
    expect(deltaMaskPayloadSize(DeltaMask.PayloadBits)).toBe(DeltaMask.MaxPayloadSize);
    // ColdDirty and Teleport contribute no bytes at all.
    expect(deltaMaskPayloadSize(DeltaMask.SignalBits)).toBe(0);
    // Client masks are limited to 0x3F | 0x80; ColdDirty is server-authored.
    expect(isClientMaskLegal(DeltaMask.PayloadBits | DeltaMask.Teleport)).toBe(true);
    expect(isClientMaskLegal(DeltaMask.ColdDirty)).toBe(false);
  });

  it('netId is slot | (generation << 16), as the sample documents', () => {
    expect(packNetId(7, 2)).toBe(SAMPLE.netId);
    expect(netIdSlot(SAMPLE.netId)).toBe(7);
    expect(netIdGeneration(SAMPLE.netId)).toBe(2);
    expect(isValidNetId(SAMPLE.netId)).toBe(true);
    // Generations start at 1, so 0 is permanently a safe "no entity" sentinel.
    expect(isValidNetId(0)).toBe(false);
    // The top generation bit must not come back as a negative int32.
    expect(packNetId(65535, 65535)).toBe(0xffffffff);
  });

  it('a truncated record is refused rather than throwing', () => {
    const full = hexBytes(hotVector('FullRecord').hex).subarray(0, FULL_RECORD_SIZE - 1);
    expect(readFullRecord(viewOf(full), 0, createFullRecord())).toBe(false);

    const update = hexBytes(hotVector('UpdateRecord/every field').hex).subarray(0, 5);
    expect(readUpdateRecord(viewOf(update), 0, createUpdateRecord())).toBe(false);

    const snapshot = hexBytes(hotVector('SnapshotPacket/one record, final').hex).subarray(0, 15);
    expect(readSnapshotPacket(viewOf(snapshot), createSnapshotPacketView())).toBe(false);

    // A frame whose TypeId is not this packet's is refused too.
    const wrongTypeId = hexBytes(hotVector('DeltaPacket/empty').hex).slice();
    wrongTypeId[0] = MessageTypeIds.SnapshotPacket;
    expect(readDeltaPacket(viewOf(wrongTypeId), createDeltaPacketSections())).toBe(false);
  });

  it('a masked update merges into known state instead of replacing it', () => {
    const known = createEntityWireState();
    known.qx = 1;
    known.qy = 2;
    known.qrot = 3;
    known.flags = 4;

    const update = createUpdateRecord();
    expect(
      readUpdateRecord(
        viewOf(hexBytes(hotVector('UpdateRecord/rot and flags only').hex)),
        0,
        update
      )
    ).toBe(true);

    // Apply is the one place mask semantics live; a wholesale assign would zero qx/qy.
    const merged = { ...known };
    if ((update.mask & DeltaMask.Rot) !== 0) merged.qrot = update.state.qrot;
    if ((update.mask & DeltaMask.Flags) !== 0) merged.flags = update.state.flags;
    expect(merged.qx).toBe(1);
    expect(merged.qy).toBe(2);
    expect(merged.qrot).toBe(SAMPLE.qrot);
    expect(merged.flags).toBe(SAMPLE.flags);
  });
});

// ── Control plane ────────────────────────────────────────────────────────────

const TYPE_ID_BY_MESSAGE: ReadonlyMap<string, number> = new Map(Object.entries(MessageTypeIds));

/** The vector's label: the message name, plus its `name` discriminator where there are several. */
function controlVectorKey(vector: ControlVector): string {
  return vector.name === undefined ? vector.message : `${vector.message}/${vector.name}`;
}

function controlVector(key: string): ControlVector {
  return required(
    VECTORS.control.vectors.find(v => controlVectorKey(v) === key),
    `control vector ${key}`
  );
}

type Fields = Record<string, unknown>;

function fieldNumber(fields: Fields, key: string): number {
  const value = fields[key];
  if (typeof value !== 'number') {
    throw new Error(`Field "${key}" is not a number.`);
  }
  return value;
}

function fieldString(fields: Fields, key: string): string {
  const value = fields[key];
  if (typeof value !== 'string') {
    throw new Error(`Field "${key}" is not a string.`);
  }
  return value;
}

function fieldBoolean(fields: Fields, key: string): boolean {
  const value = fields[key];
  if (typeof value !== 'boolean') {
    throw new Error(`Field "${key}" is not a boolean.`);
  }
  return value;
}

/** A `…Hex` field: a hex string, or `null` for a null array. */
function fieldBytesOrNull(fields: Fields, key: string): Uint8Array | null {
  const value = fields[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Field "${key}" is not a hex string or null.`);
  }
  return hexBytes(value);
}

function fieldBytes(fields: Fields, key: string): Uint8Array {
  const value = fieldBytesOrNull(fields, key);
  if (value === null) {
    throw new Error(`Field "${key}" may not be null.`);
  }
  return value;
}

function fieldStringList(fields: Fields, key: string): string[] {
  const value = fields[key];
  if (!Array.isArray(value)) {
    throw new Error(`Field "${key}" is not an array.`);
  }
  return value.map(element => {
    if (typeof element !== 'string') {
      throw new Error(`Field "${key}" holds a non-string element.`);
    }
    return element;
  });
}

function fieldBytesList(fields: Fields, key: string): Uint8Array[] {
  return fieldStringList(fields, key).map(hexBytes);
}

function fieldNumberList(fields: Fields, key: string): number[] {
  const value = fields[key];
  if (!Array.isArray(value)) {
    throw new Error(`Field "${key}" is not an array.`);
  }
  return value.map(element => {
    if (typeof element !== 'number') {
      throw new Error(`Field "${key}" holds a non-numeric element.`);
    }
    return element;
  });
}

/** A `…Repeat: { char, count }` field: a string of one repeated character. */
function fieldRepeat(fields: Fields, key: string): string {
  const value = fields[key];
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Field "${key}" is not a repeat spec.`);
  }
  const spec = value as Fields;
  return fieldString(spec, 'char').repeat(fieldNumber(spec, 'count'));
}

/**
 * Builds the message a vector describes. Explicit per message rather than reflective: TypeScript has
 * no property metadata to walk, and spelling each mapping out is what makes a renamed fixture field
 * fail loudly instead of quietly leaving a member at its default.
 */
const CONTROL_BUILDERS: ReadonlyMap<string, (fields: Fields) => ControlMessage> = new Map([
  ['LeaveCommand', (): ControlMessage => ({ typeId: MessageTypeIds.LeaveCommand, body: {} })],
  ['ResyncCommand', (): ControlMessage => ({ typeId: MessageTypeIds.ResyncCommand, body: {} })],
  [
    'PingCommand',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.PingCommand,
      body: { clientTimeMs: fieldNumber(f, 'ClientTimeMs') },
    }),
  ],
  [
    'PongEvent',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.PongEvent,
      body: {
        clientTimeMs: fieldNumber(f, 'ClientTimeMs'),
        serverTimeMs: fieldNumber(f, 'ServerTimeMs'),
        serverTick: fieldNumber(f, 'ServerTick'),
      },
    }),
  ],
  [
    'PeerLeftEvent',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.PeerLeftEvent,
      body: { clientId: fieldNumber(f, 'ClientId'), reason: fieldNumber(f, 'Reason') },
    }),
  ],
  [
    'PeerJoinedEvent',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.PeerJoinedEvent,
      body: { clientId: fieldNumber(f, 'ClientId'), displayName: fieldString(f, 'DisplayName') },
    }),
  ],
  [
    'HostChangedEvent',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.HostChangedEvent,
      body: {
        hostClientId: fieldNumber(f, 'HostClientId'),
        previousHostClientId: fieldNumber(f, 'PreviousHostClientId'),
      },
    }),
  ],
  [
    'RoomInfoEvent',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.RoomInfoEvent,
      body: {
        playerCount: fieldNumber(f, 'PlayerCount'),
        entityCount: fieldNumber(f, 'EntityCount'),
        serverTick: fieldNumber(f, 'ServerTick'),
      },
    }),
  ],
  [
    'RejectedEvent',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.RejectedEvent,
      body: { code: fieldNumber(f, 'Code'), message: fieldString(f, 'Message') },
    }),
  ],
  [
    'ChatMessageEvent',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.ChatMessageEvent,
      body: { clientId: fieldNumber(f, 'ClientId'), text: fieldString(f, 'Text') },
    }),
  ],
  [
    'SendChatCommand',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.SendChatCommand,
      body: { text: fieldString(f, 'Text') },
    }),
  ],
  [
    'SetClientPrefsCommand',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.SetClientPrefsCommand,
      body: {
        hidden: fieldBoolean(f, 'Hidden'),
        sendRateDivisor: fieldNumber(f, 'SendRateDivisor'),
      },
    }),
  ],
  [
    'DespawnEntityCommand',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.DespawnEntityCommand,
      body: { netId: fieldNumber(f, 'NetId') },
    }),
  ],
  [
    'SpawnEntityResponse',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.SpawnEntityResponse,
      body: {
        requestId: fieldNumber(f, 'RequestId'),
        netId: fieldNumber(f, 'NetId'),
        rejectCode: fieldNumber(f, 'RejectCode'),
      },
    }),
  ],
  [
    'SetRoomVarCommand',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.SetRoomVarCommand,
      body: { key: fieldString(f, 'Key'), value: fieldBytes(f, 'ValueHex') },
    }),
  ],
  [
    'SetEntityPropsCommand',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.SetEntityPropsCommand,
      body: { netId: fieldNumber(f, 'NetId'), json: fieldBytes(f, 'JsonHex') },
    }),
  ],
  [
    'EntityPropsChangedEvent',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.EntityPropsChangedEvent,
      body: { netId: fieldNumber(f, 'NetId'), json: fieldBytes(f, 'JsonHex') },
    }),
  ],
  [
    'SignalEvent',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.SignalEvent,
      body: {
        senderClientId: fieldNumber(f, 'SenderClientId'),
        name: fieldString(f, 'Name'),
        payload: fieldBytes(f, 'PayloadHex'),
      },
    }),
  ],
  [
    'EmitSignalCommand',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.EmitSignalCommand,
      body: {
        name: fieldString(f, 'Name'),
        target: fieldNumber(f, 'Target'),
        targetClientId: fieldNumber(f, 'TargetClientId'),
        payload: fieldBytes(f, 'PayloadHex'),
      },
    }),
  ],
  [
    'SpawnEntityRequest',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.SpawnEntityRequest,
      body: {
        requestId: fieldNumber(f, 'RequestId'),
        kind: fieldNumber(f, 'Kind'),
        qx: fieldNumber(f, 'QX'),
        qy: fieldNumber(f, 'QY'),
        qrot: fieldNumber(f, 'QRot'),
        qvx: fieldNumber(f, 'QVx'),
        qvy: fieldNumber(f, 'QVy'),
        flags: fieldNumber(f, 'Flags'),
        props: fieldBytesOrNull(f, 'PropsHex'),
      },
    }),
  ],
  [
    'RoomVarsChangedEvent',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.RoomVarsChangedEvent,
      body: { keys: fieldStringList(f, 'Keys'), values: fieldBytesList(f, 'ValuesHex') },
    }),
  ],
  [
    'RoomRosterEvent',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.RoomRosterEvent,
      body: {
        clientIds: fieldNumberList(f, 'ClientIds'),
        displayNames: fieldStringList(f, 'DisplayNames'),
        frameFlags: fieldNumber(f, 'FrameFlags'),
      },
    }),
  ],
  [
    'WelcomeEvent',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.WelcomeEvent,
      body: {
        clientId: fieldNumber(f, 'ClientId'),
        roomId: fieldString(f, 'RoomId'),
        tickHz: fieldNumber(f, 'TickHz'),
        serverTimeMs: fieldNumber(f, 'ServerTimeMs'),
        serverTick: fieldNumber(f, 'ServerTick'),
        aoiRadius: fieldNumber(f, 'AoiRadius'),
        maxPlayers: fieldNumber(f, 'MaxPlayers'),
        protocolVersion: fieldNumber(f, 'ProtocolVersion'),
        worldOriginX: fieldNumber(f, 'WorldOriginX'),
        worldOriginY: fieldNumber(f, 'WorldOriginY'),
        worldSize: fieldNumber(f, 'WorldSize'),
        mode: fieldNumber(f, 'Mode'),
        maxVisibleEntities: fieldNumber(f, 'MaxVisibleEntities'),
        hostClientId: fieldNumber(f, 'HostClientId'),
        resumeKey: fieldBytes(f, 'ResumeKeyHex'),
        resumed: fieldBoolean(f, 'Resumed'),
      },
    }),
  ],
  [
    'HelloCommand',
    (f: Fields): ControlMessage => ({
      typeId: MessageTypeIds.HelloCommand,
      body: {
        protocolVersion: fieldNumber(f, 'ProtocolVersion'),
        // One vector states the token as a repeat spec, to pin the multi-byte varint boundary.
        token: 'TokenRepeat' in f ? fieldRepeat(f, 'TokenRepeat') : fieldString(f, 'Token'),
        roomId: fieldString(f, 'RoomId'),
        displayName: fieldString(f, 'DisplayName'),
        capabilities: fieldNumber(f, 'Capabilities'),
        resumeKey: fieldBytesOrNull(f, 'ResumeKeyHex'),
      },
    }),
  ],
]);

function buildControlMessage(vector: ControlVector): ControlMessage {
  const build = required(CONTROL_BUILDERS.get(vector.message), `builder for ${vector.message}`);
  return build(vector.fields);
}

const CONTROL_VECTOR_KEYS = VECTORS.control.vectors.map(controlVectorKey);

describe('control-plane golden vectors', () => {
  it('every control message in the map has a builder, and every vector a known TypeId', () => {
    for (const vector of VECTORS.control.vectors) {
      expect(CONTROL_BUILDERS.has(vector.message)).toBe(true);
      expect(TYPE_ID_BY_MESSAGE.has(vector.message)).toBe(true);
    }
  });

  it.each(CONTROL_VECTOR_KEYS)('%s serializes to the published bytes', key => {
    const vector = controlVector(key);

    expect(toHex(encodeControlPayload(buildControlMessage(vector)))).toBe(normalizeHex(vector.hex));
  });

  it.each(CONTROL_VECTOR_KEYS)('%s deserializes back to its published fields', key => {
    const vector = controlVector(key);
    const expected = buildControlMessage(vector);
    const typeId = required(TYPE_ID_BY_MESSAGE.get(vector.message), `TypeId for ${vector.message}`);

    // Decoding the published bytes, not our own output.
    const decoded = decodeControlMessage(typeId, hexBytes(vector.hex));

    expect(decoded).toEqual(expected);
  });
});

// ── WelcomeEvent: the one message the fixture does not cover ─────────────────

/**
 * `WelcomeEvent` has **no vector in `protocol-vectors.json`**, so these bytes are derived by hand from
 * the same tables in `docs/protocol.md` that every other expectation here comes out of — never
 * captured from a run of this codec.
 *
 * Sixteen members, so the header is `10` followed by sixteen lengths:
 * `04` u32 ClientId, `0A` string "r1" (4 + 4 + 2), `01` u8 TickHz, `08` i64 ServerTimeMs,
 * `04` u32 ServerTick, `04` f32 AoiRadius, `02` u16 MaxPlayers, `02` u16 ProtocolVersion,
 * `04` f32 WorldOriginX, `04` f32 WorldOriginY, `04` f32 WorldSize, `01` u8 Mode,
 * `02` u16 MaxVisibleEntities, `04` u32 HostClientId, `14` byte[16] ResumeKey (4 + 16),
 * `01` bool Resumed. The three world floats are exact powers of two: 512 → `44000000`,
 * −2048 → `C5000000`, 4096 → `45800000`, each little-endian on the wire.
 */
// ── Format rules the vectors imply but do not spell out ──────────────────────

describe('version tolerance', () => {
  const peerLeft = controlVector('PeerLeftEvent');

  it('ignores members a newer peer appended', () => {
    // The published PeerLeftEvent with a third, unknown member appended: memberCount 3, a third
    // declared length of 4, and four surplus bytes at the end.
    const newer = hexBytes('03 04 01 04 07000000 03 DEADBEEF');

    expect(decodeControlMessage(MessageTypeIds.PeerLeftEvent, newer)).toEqual(
      decodeControlMessage(MessageTypeIds.PeerLeftEvent, hexBytes(peerLeft.hex))
    );
  });

  it('leaves members an older peer never wrote at their defaults', () => {
    // A one-member PeerLeftEvent: the peer predates `Reason`.
    const older = hexBytes('01 04 07000000');

    expect(decodeControlMessage(MessageTypeIds.PeerLeftEvent, older)).toEqual({
      typeId: MessageTypeIds.PeerLeftEvent,
      body: { clientId: 7, reason: 0 },
    });
  });

  it('rejects a member-length marker it does not know rather than guessing a width', () => {
    // 0x83 is neither the u16 marker (0x84) nor the i32 one (0x82): a misread length would silently
    // shift every following member, so it must fail loudly.
    expect(() => new MemoryPackReader(hexBytes('01 83 0400 07000000'))).toThrow(RangeError);
  });

  it('rejects a truncated object rather than reading past the buffer', () => {
    expect(() => new MemoryPackReader(hexBytes('02 04 01 070000'))).toThrow(RangeError);
  });

  it('refuses the null-object marker, which this protocol never sends', () => {
    expect(() => new MemoryPackReader(hexBytes('FF'))).toThrow(RangeError);
  });
});

describe('unknown TypeIds', () => {
  it('are ignored and counted, never fatal', () => {
    const tally = new UnknownTypeIdTally();

    // 200 is in the app/extension range the fabric never interprets; 60 is an unallocated core id.
    for (const typeId of [200, 200, 60]) {
      const decoded = decodeControlMessage(typeId, hexBytes('00'));
      expect(decoded).toBeUndefined();
      tally.record(typeId);
    }

    expect(tally.count).toBe(3);
    expect(tally.countFor(200)).toBe(2);
    expect(tally.seenTypeIds()).toEqual([200, 60]);
    expect(messageTypeIdName(200)).toBe('Unknown');
  });
});
