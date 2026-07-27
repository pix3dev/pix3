/**
 * Wire-protocol version markers for the pix3-rooms protocol.
 *
 * Negotiation is by **range, not equality**: a client announces the highest version it speaks, the
 * session runs at `min(client, PROTOCOL_VERSION)`, and only a client below
 * {@link MIN_SUPPORTED_PROTOCOL_VERSION} is rejected — with `RejectCode.ProtocolVersionMismatch`, a
 * typed rejection, never a decoder error. That is what lets a game published six months ago keep
 * working when the fabric grows.
 *
 * Any change to a byte layout in the spec is a protocol version bump and must change
 * {@link PROTOCOL_VERSION}.
 */

/** The highest version this build speaks. Announced in `HelloCommand`, echoed in `WelcomeEvent`. */
export const PROTOCOL_VERSION = 2;

/** The lowest version this build still accepts. v2 is the first version that ever shipped. */
export const MIN_SUPPORTED_PROTOCOL_VERSION = 2;

/**
 * True when a peer-announced version can be served. An announcement *above* {@link PROTOCOL_VERSION}
 * is fine — the session simply runs at {@link PROTOCOL_VERSION}.
 */
export function isProtocolVersionSupported(peerVersion: number): boolean {
  return peerVersion >= MIN_SUPPORTED_PROTOCOL_VERSION;
}

/**
 * Resolves the version a session with this peer runs at: `min(peerVersion, PROTOCOL_VERSION)`.
 * Call {@link isProtocolVersionSupported} first — this only clamps downwards, it does not judge.
 */
export function negotiateProtocolVersion(peerVersion: number): number {
  return peerVersion < PROTOCOL_VERSION ? peerVersion : PROTOCOL_VERSION;
}
