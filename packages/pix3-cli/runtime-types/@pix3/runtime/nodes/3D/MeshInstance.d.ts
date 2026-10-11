import { AnimationClip, AnimationMixer, AnimationAction } from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';
export interface MeshInstanceProps extends Omit<Node3DProps, 'type'> {
    src?: string | null;
    castShadow?: boolean;
    receiveShadow?: boolean;
    /** Optional clip name to auto-play on first runtime tick. Falls back to first available clip. */
    initialAnimation?: string | null;
    isPlaying?: boolean;
    isLoop?: boolean;
}
export declare class MeshInstance extends Node3D {
    readonly src: string | null;
    castShadow: boolean;
    receiveShadow: boolean;
    animations: AnimationClip[];
    mixer: AnimationMixer | null;
    currentAction: AnimationAction | null;
    /** The name of the animation clip currently selected for preview. Editor-only, not serialized. */
    activeAnimation: string | null;
    initialAnimation: string | null;
    private _isPlaying;
    private _isLoop;
    private hasAttemptedInitialAnimation;
    constructor(props: MeshInstanceProps);
    get isPlaying(): boolean;
    set isPlaying(value: boolean);
    get isLoop(): boolean;
    set isLoop(value: boolean);
    /**
     * Play an animation by name. Forces `isPlaying` to true.
     * @param name - The name of the animation clip to play
     * @param loop - Optional override for looping
     */
    playAnimation(name: string, loop?: boolean): void;
    /**
     * Select an animation by name without forcing `isPlaying`.
     * Respects current `isPlaying` state for whether the clip actually advances.
     * @param name - The name of the animation clip to set
     * @param loop - Optional override for looping
     */
    setAnimation(name: string, loop?: boolean): void;
    /**
     * Show the default animation at time 0 (for editor mode and post-stop).
     * Uses initialAnimation if set, otherwise falls back to the first available clip.
     * Clears mixer state if no animations are available (restores default mesh pose).
     * Resets hasAttemptedInitialAnimation so play mode restarts the animation cleanly.
     */
    showDefaultPose(): void;
    /**
     * Tick method called every frame.
     * Updates the animation mixer if it exists.
     * @param dt - Delta time in seconds since last frame
     */
    tick(dt: number): void;
    private playInitialAnimationIfNeeded;
    private applyLoopMode;
    /**
     * Get the property schema for MeshInstance.
     * Extends Node3D schema with shadow rendering properties.
     */
    static getPropertySchema(): PropertySchema;
    /**
     * Recursively apply shadow properties to all children meshes.
     * This ensures shadows are applied to loaded GLB models and their sub-meshes.
     */
    private static applyShadowPropertiesToChildren;
    /**
     * Apply shadow properties after loading geometry.
     * Call this after adding children from a loaded GLB/GLTF model.
     */
    applyLoadedShadowProperties(): void;
}
