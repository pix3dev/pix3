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
export declare class MemoryPackReader {
    /** Largest member count a well-formed object may declare. */
    static readonly MAX_MEMBER_COUNT = 249;
    /** The marker a null object carries in place of a member count. */
    static readonly NULL_OBJECT_MARKER = 255;
    private readonly bytes;
    private readonly view;
    /** Absolute offset of member `i`; `memberOffsets[memberCount]` is the end of the value block. */
    private readonly memberOffsets;
    private cursor;
    private static readonly utf8;
    private static readonly utf16;
    /** Number of members the peer actually wrote. */
    readonly memberCount: number;
    constructor(payload: Uint8Array);
    /** True when the peer wrote this member. False means an older peer: keep your default. */
    hasMember(index: number): boolean;
    /** The declared byte length of a member, for callers that want to inspect one they skip. */
    memberLength(index: number): number;
    /** Points the read cursor at the start of a member. Reads then proceed from there. */
    seekMember(index: number): void;
    private requireMember;
    private require;
    /** `bool` — one byte; anything non-zero is true, matching a lenient C# reader. */
    readBool(): boolean;
    /** `byte`. */
    readUint8(): number;
    /** `sbyte`. */
    readInt8(): number;
    /** `ushort`, little-endian. */
    readUint16(): number;
    /** `short`, little-endian. */
    readInt16(): number;
    /** `uint`, little-endian. */
    readUint32(): number;
    /** `int`, little-endian. */
    readInt32(): number;
    /** `float`, little-endian. */
    readFloat32(): number;
    /** `long`, little-endian, exact. */
    readInt64(): bigint;
    /**
     * `long` as a JavaScript number. Every `long` in this protocol is a millisecond timestamp, which
     * stays inside `Number.MAX_SAFE_INTEGER` until the year 287396, so the narrowing is safe — but it
     * throws rather than rounding silently if a peer ever sends something bigger.
     */
    readInt64AsNumber(): number;
    /**
     * `string`. Returns `null` for the `FFFFFFFF` form and `''` for `00000000`.
     *
     * A negative first word is the UTF-8 form — its complement is the byte count, and the second word is
     * the UTF-16 code-unit length, which is informational here because JavaScript derives it from the
     * decoded text. A positive first word is the UTF-16 form; this protocol never writes it, but
     * decoding it costs three lines and refusing it would be an interop trap.
     */
    readString(): string | null;
    /** `byte[]`. Returns `null` for `FFFFFFFF`; the result is a copy, not a view of the frame. */
    readBytes(): Uint8Array | null;
    /** `uint[]`: an element count, then that many little-endian `u32`s. `FFFFFFFF` is `null`. */
    readUint32Array(): number[] | null;
    /** `string[]`: an element count, then that many fully-encoded strings. */
    readStringArray(): (string | null)[] | null;
    /** `byte[][]`: an element count, then that many fully-encoded byte arrays. */
    readBytesArray(): (Uint8Array | null)[] | null;
}
/**
 * Reads one member byte-length and returns `[value, offsetPastIt]`.
 *
 * `0…127` is the raw byte, `0x84` introduces a `u16` and `0x82` an `i32`. Any other marker is
 * **rejected outright rather than guessed**: a misread length silently shifts every following member,
 * which is far worse than a loud failure.
 */
export declare function readVarInt(bytes: Uint8Array, view: DataView, offset: number): [number, number];
