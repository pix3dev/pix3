/**
 * Keyframe clip evaluator.
 *
 * Split in two layers:
 * - a pure sampling layer (no scene-graph dependency) used by both the
 *   runtime player and the editor timeline preview, and
 * - a node-applying layer that resolves track targets against a host node
 *   and writes sampled values through the property schema.
 */
import type { NodeBase } from '../nodes/NodeBase';
import type { PropertyDefinition } from '../fw/property-schema';
import { parseEventArgs } from '../core/parse-event-args';
import type { AudioKeyframe, AudioTrack, EventKeyframe, EventTrack, KeyframeClip, KeyframeValue, PropertyTrack, TrackValueType } from './keyframe-types';
/** Interpolate two keyframe values of the given type with progress t in [0, 1]. */
export declare function interpolateValue(valueType: TrackValueType, a: KeyframeValue, b: KeyframeValue, t: number): KeyframeValue;
/**
 * Sample a property track at the given time.
 * Hold semantics outside the key range: before the first key the first
 * value is returned, after the last key the last value. Returns null for
 * empty tracks.
 */
export declare function sampleTrack(track: PropertyTrack, time: number): KeyframeValue | null;
export interface TimedKeyRangeOptions {
    /**
     * Loop wrap support: when `to < from`, keys are collected from
     * `(from, wrapDuration]` and `[0, to]` (the `[0, ...]` part is inclusive
     * so keys at exactly t=0 fire on wrap).
     */
    wrapDuration?: number;
    /** Include a key at exactly `from` (used on the first frame after play()). */
    includeStart?: boolean;
}
/** Back-compat alias for the shared time-window options. */
export type AudioKeyRangeOptions = TimedKeyRangeOptions;
/**
 * Collect time-window keys crossed while advancing from `from` to `to`.
 * The shared boundary rule is `from < time <= to`; both the runtime player
 * and the editor preview use this so keys fire exactly once. Used by audio
 * and event tracks alike (any track whose keys carry a `time`).
 */
export declare function collectTimedKeysInRange<T extends {
    time: number;
}>(keys: readonly T[], from: number, to: number, options?: TimedKeyRangeOptions): T[];
/**
 * Collect audio keys crossed while advancing from `from` to `to`.
 * Disabled tracks yield nothing. See `collectTimedKeysInRange`.
 */
export declare function collectAudioKeysInRange(track: AudioTrack, from: number, to: number, options?: TimedKeyRangeOptions): AudioKeyframe[];
/**
 * Collect event keys crossed while advancing from `from` to `to`.
 * Disabled tracks yield nothing. See `collectTimedKeysInRange`.
 */
export declare function collectEventKeysInRange(track: EventTrack, from: number, to: number, options?: TimedKeyRangeOptions): EventKeyframe[];
export { parseEventArgs };
/** Emit an event key's signal on the given node with its parsed args. */
export declare function fireEventKey(node: NodeBase, key: EventKeyframe): void;
/** Convert a stored keyframe value into the shape expected by PropertyDefinition.setValue. */
export declare function toSchemaValue(valueType: TrackValueType, value: KeyframeValue): unknown;
/**
 * Convert a value read from PropertyDefinition.getValue into the JSON storage
 * shape. Returns null when the value does not match the track type.
 */
export declare function fromSchemaValue(valueType: TrackValueType, value: unknown): KeyframeValue | null;
/**
 * Resolve a track target path against the host node.
 * '' or '.' resolves to the host itself; other paths use findByPath semantics.
 */
export declare function resolveTrackTarget(host: NodeBase, targetPath: string): NodeBase | null;
export interface PropertyBindingEntry {
    track: PropertyTrack;
    node: NodeBase;
    propDef: PropertyDefinition;
}
export interface EventBindingEntry {
    track: EventTrack;
    node: NodeBase;
}
export interface ClipBinding {
    clip: KeyframeClip;
    entries: PropertyBindingEntry[];
    audioTracks: AudioTrack[];
    eventEntries: EventBindingEntry[];
    /** targetPath/property pairs that could not be resolved (missing node or property). */
    missingTargets: string[];
}
/**
 * Resolve every track of a clip against the host node once.
 * Unresolved property tracks are recorded in `missingTargets` and skipped by
 * `applyClipAtTime`; call again after structural scene changes.
 */
export declare function createClipBindings(host: NodeBase, clip: KeyframeClip): ClipBinding;
/**
 * Apply all resolved property tracks of the binding at the given time.
 * Disabled tracks and empty tracks are skipped. Audio tracks are not touched
 * (audio firing is time-window based and owned by the caller).
 */
export declare function applyClipAtTime(binding: ClipBinding, time: number): void;
