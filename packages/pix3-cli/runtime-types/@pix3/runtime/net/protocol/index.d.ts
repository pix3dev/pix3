/**
 * The pix3-rooms wire protocol, v2 — a hand-written TypeScript codec.
 *
 * This directory is **pure wire code** over `ArrayBuffer`/`DataView`/`Uint8Array`. It imports nothing
 * from three.js, nothing from the node classes and nothing else in the runtime, so it stays
 * free-standing and could be extracted into its own package if a second consumer ever appears.
 *
 * It is deliberately **not** re-exported from the package's public `index.ts`: the wire format is
 * internal, so it can change without a breaking-change semver event. Only code under `net/` should
 * import this barrel.
 *
 * The authority for every byte layout is `docs/protocol.md` in the pix3-rooms repo, and the codec is
 * pinned to `protocol-vectors.json` from the same repo — see `protocol.spec.ts`. If this codec and a
 * vector disagree, the codec is wrong.
 */
export * from './enums';
export * from './hot-wire';
export * from './MemoryPackReader';
export * from './MemoryPackWriter';
export * from './messages';
export * from './net-id';
export * from './type-ids';
export * from './version';
export * from './WorldQuantizer';
