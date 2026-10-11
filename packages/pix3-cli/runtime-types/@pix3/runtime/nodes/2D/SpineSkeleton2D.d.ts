import { Node2D, type Node2DProps } from '../Node2D';
import type { PropertySchema } from '../../fw/property-schema';
import type { InstancePropertySchemaProvider } from '../../fw/property-schema-utils';
import { type TextureResourceRef } from '../../core/TextureResource';
import type { SpineAsset, SpineAssetRequest } from '../../core/spine/SpineAsset';
import { SpineSkeletonView, type SpinePlayOptions, type SpineQueueOptions, type SpineSetupBounds } from '../../core/spine/SpineSkeletonView';
export interface SpineSkeleton2DProps extends Omit<Node2DProps, 'type'> {
    /** `res://…/hero.json` or `res://…/hero.skel`. */
    skeletonPath?: string | null;
    /** `res://…/hero.atlas`. */
    atlasPath?: string | null;
    /** Single-page atlas override; normally the atlas names its own pages. */
    texture?: TextureResourceRef | string | null;
    animation?: string;
    loop?: boolean;
    isPlaying?: boolean;
    skin?: string;
    timeScale?: number;
    defaultMix?: number;
    color?: string;
    twoColorTint?: boolean;
    /** Free the node (`queueFree`) when a non-looping animation finishes. */
    freeOnFinish?: boolean;
    /** Animate in the editor viewport (edit mode) instead of showing one pose. */
    previewInEditor?: boolean;
}
/**
 * A Spine skeleton in the 2D layer.
 *
 * The node owns playback state and the property schema; the actual skeleton comes
 * from a {@link SpineAsset} handed in by the SceneLoader (`setSpineAsset`) — nodes
 * never fetch their own resources. The renderable side lives in
 * {@link SpineSkeletonView}, which the editor's viewport proxy instantiates too so
 * edit mode and play mode draw identically.
 *
 * Scripts drive it through {@link play}/{@link queue}/{@link stop} and read state
 * with {@link getAnimationNames}/{@link getCurrentAnimation}. Emitted signals:
 * `animation-started`, `animation-finished` (non-looping animation ended),
 * `animation-looped`, and `spine-event` for keyed animation events.
 */
export declare class SpineSkeleton2D extends Node2D implements InstancePropertySchemaProvider {
    skeletonPath: string | null;
    atlasPath: string | null;
    texture: TextureResourceRef | null;
    animation: string;
    loop: boolean;
    isPlaying: boolean;
    skin: string;
    timeScale: number;
    defaultMix: number;
    color: string;
    twoColorTint: boolean;
    freeOnFinish: boolean;
    previewInEditor: boolean;
    private asset;
    private view;
    private readonly tintColor;
    private appliedOpacity;
    private appliedTintHex;
    constructor(props: SpineSkeleton2DProps);
    /** The three files this node needs, or null while any of them is unset. */
    getAssetRequest(): SpineAssetRequest | null;
    /** Convenience accessor for the page-image override path. */
    get texturePath(): string | null;
    set texturePath(value: string | null);
    /** True once a skeleton has been loaded into this node. */
    get isLoaded(): boolean;
    /**
     * Installs (or clears) the loaded skeleton. Called by the SceneLoader after the
     * asset resolves and again whenever the authored paths change. Rebuilds the
     * renderable view and re-applies the authored animation/skin/mix/tint.
     */
    setSpineAsset(asset: SpineAsset | null): void;
    /** The renderable view, or null before the asset loads. */
    getView(): SpineSkeletonView | null;
    /** Animation names from the loaded skeleton (empty before it loads). */
    getAnimationNames(): string[];
    /** Skin names from the loaded skeleton (empty before it loads). */
    getSkinNames(): string[];
    /** Setup-pose AABB of the loaded skeleton, or null. */
    getSetupBounds(): SpineSetupBounds | null;
    /** The animation currently playing on a track. */
    getCurrentAnimation(trackIndex?: number): string | null;
    /**
     * Plays an animation. With no name the authored {@link animation} is (re)played.
     * Returns false when the skeleton is not loaded yet or the name is unknown.
     */
    play(animationName?: string, options?: SpinePlayOptions): boolean;
    /** Queues an animation after whatever is already on the track. */
    queue(animationName: string, options?: SpineQueueOptions): boolean;
    /**
     * Stops playback. `mixDuration` mixes back to the setup pose instead of
     * snapping to it.
     */
    stop(options?: {
        trackIndex?: number;
        mixDuration?: number;
    }): void;
    /**
     * Rewinds to the first frame of the current animation (setup pose when no
     * animation is set). Pose-only: it does not touch {@link isPlaying} or any
     * other authored property, so it is safe to call outside an operation — the
     * editor's "reset" affordance uses it as transient preview state.
     */
    resetToFirstFrame(trackIndex?: number): void;
    /** Pauses time advance while keeping the current pose. */
    pause(): void;
    /** Resumes time advance. */
    resume(): void;
    /** Applies a skin by name (empty string = the skeleton's default skin). */
    setSkin(skinName: string): boolean;
    /** Sets the crossfade duration between two animations, in seconds. */
    setMix(fromAnimation: string, toAnimation: string, seconds: number): void;
    /** Playback speed multiplier (1 = authored speed). */
    setTimeScale(scale: number): void;
    tick(dt: number): void;
    /**
     * Advances the skeleton by `dt` regardless of {@link isPlaying}. Used by the
     * editor's preview ticker, which drives the viewport proxy's own view.
     */
    advancePreview(dt: number): void;
    static getPropertySchema(): PropertySchema;
    /**
     * Per-instance schema: once the skeleton is loaded, `animation` and `skin`
     * become dropdowns of the names the skeleton actually declares. Before that
     * they stay plain text fields (from the static schema) so an authored name
     * survives a missing/unloaded asset.
     */
    getInstancePropertySchema(): PropertySchema | null;
    protected disposeResources(): void;
    /** Starts (or restarts) the authored animation on track 0. */
    private applyAuthoredAnimation;
    /**
     * Pushes tint + inherited opacity into the skeleton color. Returns true when
     * anything actually changed (so a paused view knows it must rebuild geometry).
     */
    private applyTint;
    /**
     * Mirrors authored values into `properties`, the record the prefab-override
     * diff and the scene saver read. Only non-defaults are stored.
     */
    private syncSerializedProperties;
}
