export interface AudioPlayback {
    stop: () => void;
    ended: Promise<void>;
}
/** The three fixed mixer buses. `music`/`sfx` route into `master`. */
export type AudioBusName = 'master' | 'music' | 'sfx';
export declare const AUDIO_BUS_NAMES: readonly AudioBusName[];
export interface AudioSnapshot {
    name: string;
    /** Per-bus lowpass cutoff (Hz); omitted buses ramp to the open cutoff (20000). */
    lowpassHz?: Partial<Record<AudioBusName, number>>;
    /** Per-bus multiplier composed ON TOP of the user bus volume; omitted = 1. */
    volumeScale?: Partial<Record<AudioBusName, number>>;
}
export interface ActiveAudioPlaybackSnapshot {
    readonly id: string;
    readonly label: string;
    readonly resourcePath: string | null;
    readonly startedAtMs: number;
    readonly elapsedMs: number;
    readonly loop: boolean;
    readonly volume: number;
    readonly playbackRate: number;
    readonly pan: number | null;
    readonly bus: AudioBusName;
    readonly durationSeconds: number | null;
    readonly channelCount: number | null;
    readonly sampleRate: number | null;
    readonly bitrateKbps: number | null;
}
export interface PlayAudioOptions {
    label?: string;
    resourcePath?: string;
    sizeBytes?: number;
    volume?: number;
    loop?: boolean;
    playbackRate?: number;
    pan?: number;
    /** Destination bus (default `'sfx'`). */
    bus?: AudioBusName;
    /** Random ± spread applied to playback rate per shot, 0..1 (default 0). */
    pitchVariation?: number;
    /** Random ± spread applied to volume per shot, 0..1 (default 0). */
    volumeVariation?: number;
}
export declare class AudioService {
    private static readonly LOWPASS_OPEN_HZ;
    private context;
    private readonly buses;
    private readonly snapshots;
    private activeSnapshotName;
    private readonly activePlaybacks;
    private readonly activePlaybackEntries;
    private nextPlaybackId;
    /**
     * Bumped whenever the active-playback set changes (a playback starts, ends or
     * is stopped). `SceneRunner` compares it frame to frame to decide whether
     * {@link getActivePlaybackSnapshot} — which copies and sorts every entry —
     * needs to run at all; in steady state (music looping, no new SFX) it does
     * not, and the frame sample reuses the previous list by reference.
     */
    private activePlaybackRevision;
    /**
     * Whether audio *should* be audible right now — i.e. the page is visible and focused.
     *
     * Intent, not observation: {@link reconcileContextState} drives the context towards it. Keeping
     * the two apart is what makes the focus handling survive the asynchrony of `suspend()`/`resume()`.
     */
    private wantsAudible;
    /** Page-activity half of {@link wantsAudible}: the document is visible and focused. */
    private pageActive;
    /**
     * Host-pause half of {@link wantsAudible}. A paused game must go quiet even though its window is
     * still focused — a frozen scene over continuing music reads as a hang, not a pause. Suspending
     * the context (rather than stopping playbacks) is what makes resume seamless: every buffer picks
     * up where the pause caught it.
     */
    private pausedByHost;
    /** Whether the browser has ever permitted this context to run (autoplay unlock has happened). */
    private unlockedByGesture;
    private readonly unlockFromPointerDown;
    private readonly unlockFromKeydown;
    private readonly handleContextStateChange;
    constructor();
    /** Alias for the master bus volume — keeps {@link mute}/{@link unmute} working. */
    setVolume(value: number): void;
    mute(): void;
    unmute(): void;
    /** Set the authored volume of a bus, ramping over ~`fadeSec` to avoid clicks. */
    setBusVolume(bus: AudioBusName, volume: number, fadeSec?: number): void;
    /** Authoritative user volume of a bus (not the ramping `gain.value`). */
    getBusVolume(bus: AudioBusName): number;
    /** Compose the active snapshot's per-bus scale on top of the user volume. */
    private applyBusGain;
    /**
     * Blend the mixer to a named snapshot (per-bus lowpass + volume scale). User
     * bus volumes compose with the snapshot, so leaving a snapshot restores the
     * authored mix. Unknown names warn and leave state unchanged.
     */
    applySnapshot(name: string, options?: {
        timeConstantSec?: number;
    }): void;
    /** Blend back to the transparent `'default'` snapshot. */
    resetSnapshot(options?: {
        timeConstantSec?: number;
    }): void;
    /** Register (or replace) a named snapshot; user scripts can add their own. */
    registerSnapshot(snapshot: AudioSnapshot): void;
    getActiveSnapshotName(): string;
    /** Reset all bus volumes to 1 and snap to `'default'` — called on scene stop. */
    resetBuses(): void;
    private createBus;
    private getBusInput;
    private handleActivityChange;
    /**
     * Silence (or un-silence) the mixer because the host paused the game. Idempotent, and orthogonal
     * to the focus rule: whichever of the two wants silence gets it, and audio only comes back when
     * both are happy. Driven by {@link SceneRunner.pause}/`resume`.
     */
    setPaused(paused: boolean): void;
    private updateWantsAudible;
    /**
     * Drive the context towards {@link wantsAudible}.
     *
     * Deliberately a *reconciler* rather than a transition handler, and idempotent, because
     * `suspend()` / `resume()` are asynchronous: `state` does not flip when the call is made, it flips
     * when the operation lands. The previous version decided what to do from `state` at the moment an
     * event arrived and recorded the verdict in a `suspendedByFocusLoss` flag, which deadlocks on a
     * fast blur→focus: `focus` sees a context still reading `'running'` (the `suspend()` from `blur`
     * is in flight), so it neither resumes nor clears the flag — and then the flag it left set is the
     * very thing that made `unlock()` refuse to resume, so no amount of clicking recovered it. The
     * game stayed silent while everything still reported itself as playing.
     *
     * Reading intent instead of history makes the fast path a no-op and the slow path self-healing:
     * whatever the state turns out to be, this is re-run on every `statechange` until it matches.
     */
    private reconcileContextState;
    /**
     * Resume after a user gesture (the Web Audio autoplay unlock).
     *
     * Also the point where {@link unlockedByGesture} latches: from here on the reconciler is allowed
     * to resume on its own, so a context suspended by focus loss comes back without a click.
     */
    unlock(): void;
    /**
     * Stops all active playbacks.
     */
    stopAll(): void;
    play(buffer: AudioBuffer, options?: PlayAudioOptions): AudioPlayback;
    /** Monotonic count of active-playback set changes; see {@link activePlaybackRevision}. */
    getActivePlaybackRevision(): number;
    getActivePlaybackSnapshot(nowMs?: number): ActiveAudioPlaybackSnapshot[];
    /**
     * Output sample rate, or null when Web Audio is unavailable. Together with
     * {@link createBuffer} this is the whole surface procedural audio needs (see
     * {@link ./SfxSynth}) — no caller has to reach for the raw AudioContext.
     */
    getSampleRate(): number | null;
    /**
     * Allocate an empty buffer at the output sample rate for callers that synthesize
     * their own samples. Null (never a throw) when Web Audio is unavailable, which is
     * what makes procedural SFX a silent no-op in headless runs and tests.
     */
    createBuffer(lengthSamples: number, channels?: number): AudioBuffer | null;
    decodeAudioData(audioData: ArrayBuffer): Promise<AudioBuffer>;
    dispose(): void;
    private createPlaybackId;
    private normalizePlaybackLabel;
    private normalizeResourcePath;
    private extractFileName;
    private normalizePositiveNumber;
    private computeBitrateKbps;
    private readNowMs;
}
