/**
 * Writer for MemoryPack's **version-tolerant object** format, which is what the control plane speaks.
 *
 * ```
 * [u8 memberCount][varint byteLength × memberCount][member values …]
 * ```
 *
 * All the lengths come **first, as a block**, and only then the values — not length-then-value
 * interleaved. That is what lets a reader skip a member it does not know, which is the entire
 * mechanism behind "a field can be appended without a version bump".
 *
 * A writer therefore buffers the values and composes the frame in {@link MemoryPackWriter.finish}.
 * Call one write per member and close it with {@link MemoryPackWriter.endMember}; **emit every member
 * your version defines, in order, never a prefix** — the reader on the other side matches members by
 * position, not by name.
 *
 * Everything is little-endian. Nothing here knows about a TypeId: the frame byte is added by
 * `encodeFrame`.
 */
export class MemoryPackWriter {
  /** Largest member count the format can express. 255 is the null-object marker. */
  static readonly MAX_MEMBER_COUNT = 249;

  private bytes: Uint8Array;
  private view: DataView;
  private length = 0;
  /** Byte offset of every closed member's end, i.e. `boundaries[i]` ends member `i`. */
  private readonly boundaries: number[] = [];

  private static readonly utf8 = new TextEncoder();

  constructor(initialCapacity = 128) {
    this.bytes = new Uint8Array(initialCapacity);
    this.view = new DataView(this.bytes.buffer);
  }

  /** Closes the member currently being written. Must be called once per member, in order. */
  endMember(): void {
    this.boundaries.push(this.length);
  }

  /**
   * Composes `[memberCount][lengths…][values…]`. An empty message (`LeaveCommand`, `ResyncCommand`)
   * comes out as the single byte `00`.
   */
  finish(): Uint8Array {
    const memberCount = this.boundaries.length;
    if (memberCount > MemoryPackWriter.MAX_MEMBER_COUNT) {
      throw new RangeError(
        `A version-tolerant object may declare at most ${MemoryPackWriter.MAX_MEMBER_COUNT} members, got ${memberCount}.`
      );
    }
    const closed = memberCount === 0 ? 0 : this.boundaries[memberCount - 1];
    if (closed !== this.length) {
      throw new Error('The last member was never closed — call endMember() after every member.');
    }

    let headerSize = 1;
    let previous = 0;
    for (const boundary of this.boundaries) {
      headerSize += varIntSize(boundary - previous);
      previous = boundary;
    }

    const frame = new Uint8Array(headerSize + this.length);
    const frameView = new DataView(frame.buffer);
    frame[0] = memberCount;

    let offset = 1;
    previous = 0;
    for (const boundary of this.boundaries) {
      offset = writeVarInt(frame, frameView, offset, boundary - previous);
      previous = boundary;
    }

    frame.set(this.bytes.subarray(0, this.length), offset);
    return frame;
  }

  // ── Primitives ─────────────────────────────────────────────────────────────

  /** `bool` — one byte, `00` or `01`. */
  writeBool(value: boolean): void {
    this.reserve(1);
    this.bytes[this.length] = value ? 1 : 0;
    this.length += 1;
  }

  /** `byte` — one byte. */
  writeUint8(value: number): void {
    this.reserve(1);
    this.bytes[this.length] = value & 0xff;
    this.length += 1;
  }

  /** `sbyte` — one byte. */
  writeInt8(value: number): void {
    this.reserve(1);
    this.view.setInt8(this.length, value);
    this.length += 1;
  }

  /** `ushort` — two bytes, little-endian. */
  writeUint16(value: number): void {
    this.reserve(2);
    this.view.setUint16(this.length, value, true);
    this.length += 2;
  }

  /** `short` — two bytes, little-endian. */
  writeInt16(value: number): void {
    this.reserve(2);
    this.view.setInt16(this.length, value, true);
    this.length += 2;
  }

  /** `uint` — four bytes, little-endian. */
  writeUint32(value: number): void {
    this.reserve(4);
    this.view.setUint32(this.length, value, true);
    this.length += 4;
  }

  /** `int` — four bytes, little-endian. */
  writeInt32(value: number): void {
    this.reserve(4);
    this.view.setInt32(this.length, value, true);
    this.length += 4;
  }

  /** `float` — four bytes, little-endian. The store itself performs the float32 rounding. */
  writeFloat32(value: number): void {
    this.reserve(4);
    this.view.setFloat32(this.length, value, true);
    this.length += 4;
  }

  /** `long` — eight bytes, little-endian. Accepts a `number` for the usual millisecond timestamps. */
  writeInt64(value: number | bigint): void {
    this.reserve(8);
    this.view.setBigInt64(
      this.length,
      typeof value === 'bigint' ? value : BigInt(Math.trunc(value)),
      true
    );
    this.length += 8;
  }

  /**
   * `string`, UTF-8: `[i32 ~utf8ByteCount][i32 utf16Length][utf8 bytes]`.
   *
   * The first word is the bitwise complement of the UTF-8 byte count, so it is always negative — that
   * is what distinguishes the UTF-8 form from the UTF-16 one (a non-negative word is a UTF-16 length)
   * without a separate tag byte. The second word is the **UTF-16 code-unit length**, i.e. JavaScript's
   * `String.prototype.length`, which differs from the byte count for anything above U+007F; writing
   * the byte count in both slots produces text a C# reader mis-sizes.
   *
   * An empty string is `00000000` (the non-negative UTF-16 length zero) and `null` is `FFFFFFFF`.
   */
  writeString(value: string | null): void {
    if (value === null) {
      this.writeInt32(-1);
      return;
    }
    if (value.length === 0) {
      this.writeInt32(0);
      return;
    }

    const utf8 = MemoryPackWriter.utf8.encode(value);
    this.writeInt32(~utf8.length);
    this.writeInt32(value.length);
    this.writeRaw(utf8);
  }

  /** `byte[]`: `[i32 count][bytes]`. `null` is `FFFFFFFF`, empty is `00000000`. */
  writeBytes(value: Uint8Array | null): void {
    if (value === null) {
      this.writeInt32(-1);
      return;
    }
    this.writeInt32(value.length);
    this.writeRaw(value);
  }

  /**
   * `uint[]`: `[i32 elementCount]` then that many little-endian `u32`s. `null` is `FFFFFFFF`.
   *
   * The count is the **element** count, not a byte count — the two coincide only for `byte[]`.
   */
  writeUint32Array(value: readonly number[] | null): void {
    if (value === null) {
      this.writeInt32(-1);
      return;
    }
    this.writeInt32(value.length);
    for (const element of value) {
      this.writeUint32(element);
    }
  }

  /** `string[]`: `[i32 elementCount]` then that many fully-encoded strings. */
  writeStringArray(value: readonly (string | null)[] | null): void {
    if (value === null) {
      this.writeInt32(-1);
      return;
    }
    this.writeInt32(value.length);
    for (const element of value) {
      this.writeString(element);
    }
  }

  /** `byte[][]`: `[i32 elementCount]` then that many fully-encoded byte arrays. */
  writeBytesArray(value: readonly (Uint8Array | null)[] | null): void {
    if (value === null) {
      this.writeInt32(-1);
      return;
    }
    this.writeInt32(value.length);
    for (const element of value) {
      this.writeBytes(element);
    }
  }

  /** Appends bytes verbatim — no header. Used by the encoders above. */
  private writeRaw(value: Uint8Array): void {
    this.reserve(value.length);
    this.bytes.set(value, this.length);
    this.length += value.length;
  }

  private reserve(extra: number): void {
    const needed = this.length + extra;
    if (needed <= this.bytes.length) {
      return;
    }

    let capacity = this.bytes.length === 0 ? 32 : this.bytes.length;
    while (capacity < needed) {
      capacity *= 2;
    }

    const grown = new Uint8Array(capacity);
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }
}

/**
 * Bytes a member byte-length occupies. `0…127` is the raw byte; `128…65535` is the marker `0x84`
 * followed by a `u16`; anything larger is the marker `0x82` followed by an `i32`.
 *
 * Only the first two forms are reachable in this protocol — `MaxPayloadBytes` caps a control frame at
 * 4 KiB, so no single member's value can reach 65536 — but the third is written correctly rather than
 * refused, because refusing it would be a silent interop trap if the cap ever moves.
 */
export function varIntSize(value: number): number {
  if (value >= 0 && value <= 127) {
    return 1;
  }
  if (value >= 0 && value <= 65535) {
    return 3;
  }
  return 5;
}

/** Writes one member byte-length at `offset` and returns the offset just past it. */
export function writeVarInt(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  value: number
): number {
  if (value >= 0 && value <= 127) {
    bytes[offset] = value;
    return offset + 1;
  }
  if (value >= 0 && value <= 65535) {
    bytes[offset] = 0x84;
    view.setUint16(offset + 1, value, true);
    return offset + 3;
  }
  bytes[offset] = 0x82;
  view.setInt32(offset + 1, value, true);
  return offset + 5;
}
