/**
 * Reader for MemoryPack's **version-tolerant object** format — the mirror of {@link MemoryPackWriter}.
 *
 * The constructor parses `[u8 memberCount][varint byteLength × memberCount]` and turns the declared
 * lengths into absolute member offsets, so a decoder addresses members **by index** rather than by
 * reading them in sequence. That is what makes version tolerance fall out for free:
 *
 * - a `memberCount` **larger** than yours simply leaves the surplus members unvisited — you never
 *   have to know their widths, because you never seek to them;
 * - a `memberCount` **smaller** than yours is an older peer, so {@link MemoryPackReader.hasMember}
 *   returns false and your surplus fields stay at their defaults.
 *
 * Malformed input throws — this decodes a frame the transport already accepted, and a length that
 * runs past the buffer means the peer is broken, not that the message is old. A misread length would
 * silently shift every following member, so guessing is never the right answer.
 */
export class MemoryPackReader {
  /** Largest member count a well-formed object may declare. */
  static readonly MAX_MEMBER_COUNT = 249;

  /** The marker a null object carries in place of a member count. */
  static readonly NULL_OBJECT_MARKER = 0xff;

  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  /** Absolute offset of member `i`; `memberOffsets[memberCount]` is the end of the value block. */
  private readonly memberOffsets: number[] = [];
  private cursor = 0;

  private static readonly utf8 = new TextDecoder('utf-8', { fatal: false });
  private static readonly utf16 = new TextDecoder('utf-16le', { fatal: false });

  /** Number of members the peer actually wrote. */
  readonly memberCount: number;

  constructor(payload: Uint8Array) {
    this.bytes = payload;
    this.view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

    if (payload.length === 0) {
      throw new RangeError('A version-tolerant object needs at least its member-count byte.');
    }

    const declared = payload[0];
    if (declared === MemoryPackReader.NULL_OBJECT_MARKER) {
      // Never sent by this protocol: a message is either present as a frame or it is not.
      throw new RangeError('Unexpected null object (memberCount 0xFF) on the control plane.');
    }
    if (declared > MemoryPackReader.MAX_MEMBER_COUNT) {
      throw new RangeError(
        `Illegal member count ${declared}; the maximum is ${MemoryPackReader.MAX_MEMBER_COUNT}.`
      );
    }

    this.memberCount = declared;

    let offset = 1;
    const lengths: number[] = [];
    for (let i = 0; i < declared; i++) {
      const [length, next] = readVarInt(this.bytes, this.view, offset);
      lengths.push(length);
      offset = next;
    }

    for (const length of lengths) {
      if (length < 0) {
        throw new RangeError(`Negative member byte-length ${length}.`);
      }
      this.memberOffsets.push(offset);
      offset += length;
    }
    this.memberOffsets.push(offset);

    if (offset > payload.length) {
      throw new RangeError(
        `Truncated object: members declare ${offset} bytes but the payload is ${payload.length}.`
      );
    }
  }

  /** True when the peer wrote this member. False means an older peer: keep your default. */
  hasMember(index: number): boolean {
    return index >= 0 && index < this.memberCount;
  }

  /** The declared byte length of a member, for callers that want to inspect one they skip. */
  memberLength(index: number): number {
    this.requireMember(index);
    return this.memberOffsets[index + 1] - this.memberOffsets[index];
  }

  /** Points the read cursor at the start of a member. Reads then proceed from there. */
  seekMember(index: number): void {
    this.requireMember(index);
    this.cursor = this.memberOffsets[index];
  }

  private requireMember(index: number): void {
    if (!this.hasMember(index)) {
      throw new RangeError(
        `Member ${index} was not written; the object declares ${this.memberCount}.`
      );
    }
  }

  private require(size: number): number {
    const at = this.cursor;
    if (at + size > this.bytes.length) {
      throw new RangeError(`Truncated value: ${size} bytes needed at offset ${at}.`);
    }
    this.cursor = at + size;
    return at;
  }

  // ── Primitives ─────────────────────────────────────────────────────────────

  /** `bool` — one byte; anything non-zero is true, matching a lenient C# reader. */
  readBool(): boolean {
    return this.bytes[this.require(1)] !== 0;
  }

  /** `byte`. */
  readUint8(): number {
    return this.bytes[this.require(1)];
  }

  /** `sbyte`. */
  readInt8(): number {
    return this.view.getInt8(this.require(1));
  }

  /** `ushort`, little-endian. */
  readUint16(): number {
    return this.view.getUint16(this.require(2), true);
  }

  /** `short`, little-endian. */
  readInt16(): number {
    return this.view.getInt16(this.require(2), true);
  }

  /** `uint`, little-endian. */
  readUint32(): number {
    return this.view.getUint32(this.require(4), true);
  }

  /** `int`, little-endian. */
  readInt32(): number {
    return this.view.getInt32(this.require(4), true);
  }

  /** `float`, little-endian. */
  readFloat32(): number {
    return this.view.getFloat32(this.require(4), true);
  }

  /** `long`, little-endian, exact. */
  readInt64(): bigint {
    return this.view.getBigInt64(this.require(8), true);
  }

  /**
   * `long` as a JavaScript number. Every `long` in this protocol is a millisecond timestamp, which
   * stays inside `Number.MAX_SAFE_INTEGER` until the year 287396, so the narrowing is safe — but it
   * throws rather than rounding silently if a peer ever sends something bigger.
   */
  readInt64AsNumber(): number {
    const value = this.readInt64();
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError(`i64 value ${value} does not fit a JavaScript number exactly.`);
    }
    return Number(value);
  }

  /**
   * `string`. Returns `null` for the `FFFFFFFF` form and `''` for `00000000`.
   *
   * A negative first word is the UTF-8 form — its complement is the byte count, and the second word is
   * the UTF-16 code-unit length, which is informational here because JavaScript derives it from the
   * decoded text. A positive first word is the UTF-16 form; this protocol never writes it, but
   * decoding it costs three lines and refusing it would be an interop trap.
   */
  readString(): string | null {
    const header = this.readInt32();
    if (header === -1) {
      return null;
    }
    if (header === 0) {
      return '';
    }

    if (header < 0) {
      const utf8ByteCount = ~header;
      // The UTF-16 length is the peer's view of `string.Length`; we do not need it to decode.
      this.readInt32();
      const at = this.require(utf8ByteCount);
      return MemoryPackReader.utf8.decode(this.bytes.subarray(at, at + utf8ByteCount));
    }

    const at = this.require(header * 2);
    return MemoryPackReader.utf16.decode(this.bytes.subarray(at, at + header * 2));
  }

  /** `byte[]`. Returns `null` for `FFFFFFFF`; the result is a copy, not a view of the frame. */
  readBytes(): Uint8Array | null {
    const count = this.readInt32();
    if (count === -1) {
      return null;
    }
    if (count < 0) {
      throw new RangeError(`Illegal array element count ${count}.`);
    }
    const at = this.require(count);
    return this.bytes.slice(at, at + count);
  }

  /** `string[]`: an element count, then that many fully-encoded strings. */
  readStringArray(): (string | null)[] | null {
    const count = this.readInt32();
    if (count === -1) {
      return null;
    }
    if (count < 0) {
      throw new RangeError(`Illegal array element count ${count}.`);
    }
    const elements: (string | null)[] = [];
    for (let i = 0; i < count; i++) {
      elements.push(this.readString());
    }
    return elements;
  }

  /** `byte[][]`: an element count, then that many fully-encoded byte arrays. */
  readBytesArray(): (Uint8Array | null)[] | null {
    const count = this.readInt32();
    if (count === -1) {
      return null;
    }
    if (count < 0) {
      throw new RangeError(`Illegal array element count ${count}.`);
    }
    const elements: (Uint8Array | null)[] = [];
    for (let i = 0; i < count; i++) {
      elements.push(this.readBytes());
    }
    return elements;
  }
}

/**
 * Reads one member byte-length and returns `[value, offsetPastIt]`.
 *
 * `0…127` is the raw byte, `0x84` introduces a `u16` and `0x82` an `i32`. Any other marker is
 * **rejected outright rather than guessed**: a misread length silently shifts every following member,
 * which is far worse than a loud failure.
 */
export function readVarInt(bytes: Uint8Array, view: DataView, offset: number): [number, number] {
  if (offset >= bytes.length) {
    throw new RangeError(`Truncated member length at offset ${offset}.`);
  }

  const marker = bytes[offset];
  if (marker <= 0x7f) {
    return [marker, offset + 1];
  }
  if (marker === 0x84) {
    if (offset + 3 > bytes.length) {
      throw new RangeError(`Truncated u16 member length at offset ${offset}.`);
    }
    return [view.getUint16(offset + 1, true), offset + 3];
  }
  if (marker === 0x82) {
    if (offset + 5 > bytes.length) {
      throw new RangeError(`Truncated i32 member length at offset ${offset}.`);
    }
    return [view.getInt32(offset + 1, true), offset + 5];
  }

  throw new RangeError(
    `Unsupported member-length marker 0x${marker.toString(16).toUpperCase().padStart(2, '0')} at offset ${offset}.`
  );
}
