import type { SpineAsset } from './SpineAsset';
import type { SpineSkeletonMesh } from './spine-module';
/** Setup-pose bounding box of a skeleton, in skeleton-local pixels. */
export interface SpineSetupBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface SpinePlayOptions {
    loop?: boolean;
    trackIndex?: number;
    /** Crossfade duration from the current animation, in seconds. */
    mixDuration?: number;
}
export interface SpineQueueOptions extends SpinePlayOptions {
    /** Extra delay after the previous entry, in seconds. */
    delay?: number;
}
export interface SpineSkeletonViewOptions {
    asset: SpineAsset;
    /** Enable spine's tint-black rendering (skeletons exported with dark tint). */
    twoColorTint?: boolean;
    /** Fired when a non-looping animation reaches its end. */
    onFinished?: (animationName: string, trackIndex: number) => void;
    /** Fired every time a looping animation completes a loop. */
    onLooped?: (animationName: string, trackIndex: number) => void;
    /** Fired when a track entry becomes current. */
    onStarted?: (animationName: string, trackIndex: number) => void;
    /** Fired for each keyed animation event. */
    onEvent?: (eventName: string, payload: {
        int: number;
        float: number;
        string: string | null;
    }, trackIndex: number) => void;
}
/**
 * Owns one renderable Spine skeleton instance: a spine-threejs `SkeletonMesh`
 * configured for pix3's 2D overlay pass, plus playback helpers.
 *
 * Deliberately shared between the runtime node and the editor viewport proxy —
 * the editor renders its own proxy objects rather than the runtime node's meshes,
 * so both sides build a `SpineSkeletonView` from the same {@link SpineAsset} and
 * stay pixel-identical. Each view holds its own `Skeleton`/`AnimationState`; the
 * `SkeletonData` and atlas textures belong to the shared asset.
 */
export declare class SpineSkeletonView {
    private readonly options;
    /** The object to parent into the scene graph (a three.js `Object3D`). */
    readonly object: SpineSkeletonMesh;
    private readonly asset;
    private disposed;
    private color;
    private opacity;
    constructor(options: SpineSkeletonViewOptions);
    get skeletonAsset(): SpineAsset;
    /** Animation names available on this skeleton, in export order. */
    getAnimationNames(): string[];
    /** Skin names available on this skeleton, in export order. */
    getSkinNames(): string[];
    /** Setup-pose AABB — stable across frames, unlike the live pose bounds. */
    getSetupBounds(): SpineSetupBounds;
    /** The animation currently playing on a track, or null. */
    getCurrentAnimation(trackIndex?: number): string | null;
    /**
     * Rewinds a track to the start of its animation without changing what is
     * playing. Falls back to the setup pose when the track is empty. Pose-only —
     * nothing about the authored playback state changes.
     */
    rewind(trackIndex?: number): void;
    /** Sets the default crossfade duration used when no pair-specific mix exists. */
    setDefaultMix(seconds: number): void;
    /** Sets the crossfade duration for one animation pair. */
    setMix(fromAnimation: string, toAnimation: string, seconds: number): void;
    setTimeScale(scale: number): void;
    /**
     * Plays an animation on a track, replacing whatever is on it. Unknown names are
     * reported by the caller — this returns false instead of throwing so a stale
     * authored name cannot break a scene load.
     */
    play(animationName: string, options?: SpinePlayOptions): boolean;
    /** Queues an animation after the ones already on the track. */
    queue(animationName: string, options?: SpineQueueOptions): boolean;
    /**
     * Clears playback. With a `mixDuration` the skeleton mixes back to the setup
     * pose (spine's recommended way out of an animation); without one the tracks
     * are cleared and the current pose is reset immediately.
     */
    stop(options?: {
        trackIndex?: number;
        mixDuration?: number;
    }): void;
    /** Applies a skin by name. Returns false for an unknown skin. */
    setSkin(skinName: string): boolean;
    /**
     * Tint + alpha for the whole skeleton. Applied through spine's own skeleton
     * color (which reaches the batched vertex colors) rather than per-material,
     * because the batch materials are created lazily and replaced as slots change.
     */
    setTint(color: {
        r: number;
        g: number;
        b: number;
    }, opacity: number): void;
    setOpacity(opacity: number): void;
    /** Advances animation state and rebuilds geometry. */
    update(dt: number): void;
    /** Rebuilds geometry for the current pose without advancing time. */
    refresh(): void;
    /**
     * Disposes the per-instance mesh, geometry and materials. The shared
     * {@link SpineAsset} (skeleton data + page textures) is owned by the asset
     * cache and intentionally NOT disposed here.
     */
    dispose(): void;
}
