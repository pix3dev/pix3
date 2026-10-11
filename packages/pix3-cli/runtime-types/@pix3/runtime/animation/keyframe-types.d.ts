/**
 * Keyframe animation data model.
 *
 * These structures are plain JSON and are stored inside the `config` of a
 * `core:AnimationPlayer` script component, so they serialize with the scene
 * verbatim. Vector values are stored as arrays (`[x, y]`, `[x, y, z]`); the
 * clip evaluator converts to the `{x, y[, z]}` shape expected by the property
 * schema only when applying values to nodes. Rotation values are stored in
 * degrees (matching the property schema contract).
 *
 * `KeyframeAnimationSet` is the versioned unit that could later be extracted
 * into standalone `.pix3clip` asset files without a data migration.
 */
import { type KeyframeEasing } from './easing';
/** JSON-safe keyframe value. Vectors are arrays in storage. */
export type KeyframeValue = number | boolean | string | [number, number] | [number, number, number];
/** Interpolation domain of a property track (subset of PropertyType). */
export type TrackValueType = 'number' | 'vector2' | 'vector3' | 'euler' | 'color' | 'boolean' | 'string';
export interface PropertyKeyframe {
    /** Time in seconds, >= 0. */
    time: number;
    value: KeyframeValue;
    /** Easing of the segment FROM this key TO the next key. */
    easing: KeyframeEasing;
}
export interface PropertyTrack {
    /** Stable id within the clip (used by editor selection/coalescing). */
    id: string;
    kind: 'property';
    /**
     * Relative name path from the host node ('' or '.' = the host itself,
     * otherwise 'Child/GrandChild' with NodeBase.findByPath semantics).
     */
    targetPath: string;
    /** Property schema name, e.g. 'position', 'opacity', 'color'. */
    property: string;
    valueType: TrackValueType;
    /** Mute toggle; disabled tracks are skipped by the evaluator. */
    enabled: boolean;
    /** Keys sorted by time (normalization enforces the order). */
    keys: PropertyKeyframe[];
}
export interface AudioKeyframe {
    time: number;
    /** res:// path of the audio asset to play. */
    audioPath: string;
    /** 0..1, default 1. */
    volume: number;
}
export interface AudioTrack {
    id: string;
    kind: 'audio';
    /** Display label. */
    name: string;
    enabled: boolean;
    keys: AudioKeyframe[];
}
export interface EventKeyframe {
    time: number;
    /** Signal name emitted on the target node when the playhead crosses this key. */
    signal: string;
    /**
     * Raw argument string, parsed at fire time (see `parseEventArgs`):
     * empty → no args, JSON array → spread, JSON scalar → single arg,
     * unparseable → the raw string as a single arg.
     */
    args: string;
}
export interface EventTrack {
    id: string;
    kind: 'event';
    /** Display label. */
    name: string;
    /**
     * Relative name path from the host node ('' or '.' = the host itself,
     * otherwise 'Child/GrandChild' with NodeBase.findByPath semantics). The
     * signal is emitted on the resolved node.
     */
    targetPath: string;
    enabled: boolean;
    keys: EventKeyframe[];
}
export type ClipTrack = PropertyTrack | AudioTrack | EventTrack;
export interface KeyframeClip {
    /** Unique within the animation set. */
    name: string;
    /** Seconds, > 0. Keys past the duration are preserved; playback clamps. */
    duration: number;
    loop: boolean;
    tracks: ClipTrack[];
}
export interface KeyframeAnimationSet {
    version: string;
    clips: KeyframeClip[];
}
export declare const MIN_CLIP_DURATION = 0.01;
export declare const DEFAULT_CLIP_DURATION = 1;
export declare function isTrackValueType(value: unknown): value is TrackValueType;
export declare function generateTrackId(): string;
/** Coerce an arbitrary value into the storage shape for the given track type. */
export declare function coerceKeyframeValue(valueType: TrackValueType, value: unknown): KeyframeValue;
/**
 * Defensively normalize arbitrary data into a valid `KeyframeAnimationSet`.
 * Invalid tracks are dropped, keys are sorted by time, values are coerced to
 * their track's value type, and clip names / track ids are made unique.
 */
export declare function normalizeKeyframeAnimationSet(value: unknown): KeyframeAnimationSet;
export declare function createEmptyAnimationSet(): KeyframeAnimationSet;
export declare function createDefaultClip(name: string): KeyframeClip;
export declare function findKeyframeClip(set: KeyframeAnimationSet | null | undefined, clipName: string | null | undefined): KeyframeClip | null;
