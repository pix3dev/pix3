/**
 * Parse an event's raw `args` string into a positional argument list for
 * `NodeBase.emit(signal, ...args)`. Shared by the keyframe event-track and by
 * per-frame flipbook events (AnimatedSprite2D/3D):
 * - empty / whitespace → no args
 * - a JSON array → its elements, spread
 * - any other valid JSON (number, string, boolean, object, null) → one arg
 * - unparseable text → the trimmed raw string as one arg (author convenience)
 */
export declare function parseEventArgs(raw: string): unknown[];
