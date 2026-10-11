/**
 * AnimationPlayer script component (`core:AnimationPlayer`).
 *
 * Plays keyframe animation clips authored in the editor timeline on the host
 * node and its descendants. Clip data lives in `config.animations` (see
 * `keyframe-types.ts`) and therefore serializes with the scene.
 *
 * Signals emitted on the host node:
 * - `animation_started` (clipName)
 * - `animation_finished` (clipName) — emitted when a non-looping clip reaches
 *   its end during playback, and by {@link AnimationPlayerBehavior.finish} for
 *   both looping and non-looping clips (used by the Cutscene Director on skip).
 */
import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
import { type KeyframeAnimationSet } from './keyframe-types';
export declare class AnimationPlayerBehavior extends Script {
    private cachedSet;
    private activeClipName;
    private binding;
    private time;
    private playing;
    private paused;
    /** Fire audio keys at exactly t=0 on the first update after play(). */
    private pendingStartAudio;
    private missingTargetsWarned;
    constructor(id: string, type: string);
    static getPropertySchema(): PropertySchema;
    onStart(): void;
    onUpdate(dt: number): void;
    onDetach(): void;
    /**
     * Start playing a clip. Without an argument, plays the autoplay clip or the
     * first clip in the set. Returns false when no matching clip exists.
     */
    play(clipName?: string): boolean;
    /** Halt playback. The current pose is kept as-is (Godot-style). */
    stop(): void;
    /**
     * Immediately complete the active clip: fire every event/audio key between the
     * current time and the clip's end (unless `fireRemainingKeys` is false), snap
     * to the end pose, stop, and emit `animation_finished`. This is what lets the
     * Cutscene Director "skip" without silently dropping state-changing event keys
     * authored near the end of a cinematic ("spawn boss", "unlock door") — which a
     * plain {@link seek} would lose, since seek only applies value tracks.
     *
     * A looping clip has no "end", so this degrades to a plain stop + emit.
     * A no-op when not currently playing.
     */
    finish(fireRemainingKeys?: boolean): void;
    pause(): void;
    resume(): void;
    /** Jump to a time within the active clip and (by default) apply the pose. */
    seek(time: number, apply?: boolean): void;
    get currentTime(): number;
    get duration(): number;
    get isPlaying(): boolean;
    get isPaused(): boolean;
    get currentClipName(): string | null;
    /** The normalized animation set (cached until invalidateBindings). */
    getAnimationSet(): KeyframeAnimationSet;
    /**
     * Drop cached clip data and target bindings. The editor calls this after
     * mutating `config.animations` or after structural scene changes.
     */
    invalidateBindings(): void;
    private getActiveClip;
    private ensureBinding;
    /**
     * Fire all time-window keys (audio + events) crossed while advancing from
     * `from` to `to`. Audio and events share identical windowing so that keys on
     * either kind of track fire exactly once per crossing, including loop wraps.
     */
    private fireTimeWindow;
    private playAudioKey;
    private warmUpAudio;
    private getAutoplay;
    private getSpeed;
}
