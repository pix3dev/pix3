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
export declare class MemoryPackWriter {
    /** Largest member count the format can express. 255 is the null-object marker. */
    static readonly MAX_MEMBER_COUNT = 249;
    private bytes;
    private view;
    private length;
    /** Byte offset of every closed member's end, i.e. `boundaries[i]` ends member `i`. */
    private readonly boundaries;
    private static readonly utf8;
    constructor(initialCapacity?: number);
    /** Closes the member currently being written. Must be called once per member, in order. */
    endMember(): void;
    /**
     * Composes `[memberCount][lengths…][values…]`. An empty message (`LeaveCommand`, `ResyncCommand`)
     * comes out as the single byte `00`.
     */
    finish(): Uint8Array;
    /** `bool` — one byte, `00` or `01`. */
    writeBool(value: boolean): void;
    /** `byte` — one byte. */
    writeUint8(value: number): void;
    /** `sbyte` — one byte. */
    writeInt8(value: number): void;
    /** `ushort` — two bytes, little-endian. */
    writeUint16(value: number): void;
    /** `short` — two bytes, little-endian. */
    writeInt16(value: number): void;
    /** `uint` — four bytes, little-endian. */
    writeUint32(value: number): void;
    /** `int` — four bytes, little-endian. */
    writeInt32(value: number): void;
    /** `float` — four bytes, little-endian. The store itself performs the float32 rounding. */
    writeFloat32(value: number): void;
    /** `long` — eight bytes, little-endian. Accepts a `number` for the usual millisecond timestamps. */
    writeInt64(value: number | bigint): void;
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
    writeString(value: string | null): void;
    /** `byte[]`: `[i32 count][bytes]`. `null` is `FFFFFFFF`, empty is `00000000`. */
    writeBytes(value: Uint8Array | null): void;
    /**
     * `uint[]`: `[i32 elementCount]` then that many little-endian `u32`s. `null` is `FFFFFFFF`.
     *
     * The count is the **element** count, not a byte count — the two coincide only for `byte[]`.
     */
    writeUint32Array(value: readonly number[] | null): void;
    /** `string[]`: `[i32 elementCount]` then that many fully-encoded strings. */
    writeStringArray(value: readonly (string | null)[] | null): void;
    /** `byte[][]`: `[i32 elementCount]` then that many fully-encoded byte arrays. */
    writeBytesArray(value: readonly (Uint8Array | null)[] | null): void;
    /** Appends bytes verbatim — no header. Used by the encoders above. */
    private writeRaw;
    private reserve;
}
/**
 * Bytes a member byte-length occupies. `0…127` is the raw byte; `128…65535` is the marker `0x84`
 * followed by a `u16`; anything larger is the marker `0x82` followed by an `i32`.
 *
 * Only the first two forms are reachable in this protocol — `MaxPayloadBytes` caps a control frame at
 * 4 KiB, so no single member's value can reach 65536 — but the third is written correctly rather than
 * refused, because refusing it would be a silent interop trap if the cap ever moves.
 */
export declare function varIntSize(value: number): number;
/** Writes one member byte-length at `offset` and returns the offset just past it. */
export declare function writeVarInt(bytes: Uint8Array, view: DataView, offset: number, value: number): number;
