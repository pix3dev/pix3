import { Texture } from 'three';
import { Node2D, type Node2DProps } from '../Node2D';
import type { PropertySchema } from '../../fw/property-schema';
import type { InstancePropertySchemaProvider } from '../../fw/property-schema-utils';
import { ShaderEffectStack, type ShaderEffectEntry, type ShaderEffectHost } from '../../shader-effects/ShaderEffectStack';
import type { AttachedShaderEffect } from '../../shader-effects/shader-effect-types';
import { type AnimationResource } from '../../core/AnimationResource';
import { type AnimatedSpriteAnchor2D, type AnimatedSpriteSizeMode, type ResolvedFramePoint } from '../../core/animated-sprite-layout';
export type { AnimatedSpriteAnchor2D, AnimatedSpriteSizeMode };
export interface AnimatedSprite2DProps extends Omit<Node2DProps, 'type'> {
    animationResourcePath?: string | null;
    currentClip?: string;
    isPlaying?: boolean;
    currentFrame?: number;
    /** Free the node (`queueFree`) when a non-looping clip finishes. */
    freeOnFinish?: boolean;
    width?: number;
    height?: number;
    color?: string;
    /** Node-level pivot; composes on top of the per-frame anchor. */
    anchor?: AnimatedSpriteAnchor2D | [number, number];
    /** Frame sizing policy. Defaults to `stretch` for back-compat. */
    sizeMode?: AnimatedSpriteSizeMode;
    /** Registry-backed shader effects attached to this sprite's material. */
    effects?: ShaderEffectEntry[];
}
export declare class AnimatedSprite2D extends Node2D implements InstancePropertySchemaProvider, ShaderEffectHost {
    animationResourcePath: string | null;
    currentClip: string;
    isPlaying: boolean;
    freeOnFinish: boolean;
    width: number;
    height: number;
    color: string;
    /** Node-level pivot (y up), same meaning as `Sprite2D.anchor`. */
    anchor: AnimatedSpriteAnchor2D;
    sizeMode: AnimatedSpriteSizeMode;
    private _currentFrame;
    private readonly frameSequencePlayer;
    private animationResource;
    private activeClip;
    private spritesheetTexture;
    private readonly frameTextures;
    private mesh;
    private material;
    /** Registry-backed shader effects; while non-empty the mesh opts out of the
     * 2D quad batcher so its effected material is used directly (see Sprite2D). */
    private readonly effectStack;
    constructor(props: AnimatedSprite2DProps);
    /** The shader-effect stack driving this sprite's material. */
    getShaderEffectStack(): ShaderEffectStack;
    /** Per-instance schema contribution: the attached effects' `fx.*` params. */
    getInstancePropertySchema(): PropertySchema | null;
    /** Attach a shader effect by registry id (e.g. `core:adjust`). */
    attachEffect(type: string, init?: {
        enabled?: boolean;
        params?: Record<string, unknown>;
    }): boolean;
    /** Detach an effect by type. Returns the removed attachment or null. */
    detachEffect(type: string): AttachedShaderEffect | null;
    /** Enable/disable an attached effect. */
    setEffectEnabled(type: string, on: boolean): void;
    /** Set one param on an attached effect (by registry id or short key). */
    setEffectParam(typeOrKey: string, param: string, value: unknown): boolean;
    /** The attached effects, in composition order (read-only view). */
    getAttachedEffects(): readonly AttachedShaderEffect[];
    get currentFrame(): number;
    set currentFrame(value: number);
    setAnimationResource(resource: AnimationResource | null): void;
    setFrameTexture(frameIndex: number, texture: Texture | null): void;
    setSpritesheetTexture(texture: Texture | null): void;
    tick(dt: number): void;
    private emitFrameEvents;
    static getPropertySchema(): PropertySchema;
    private getCurrentFrameData;
    private refreshTexturePresentation;
    private syncActiveClip;
    private cloneTexture;
    private static normalizeAnchor;
    /** Set the node-level pivot (composes on top of the per-frame anchor). */
    setAnchor(value: AnimatedSpriteAnchor2D | [number, number]): void;
    /**
     * The frame's intrinsic pixel size: the authored `sourceSize` first (stamped by
     * the editor, so layout never waits on I/O), then the atlas view's recorded
     * source size, then a plain texture's own image dimensions. `null` when nothing
     * knows — the caller falls back to stretch layout for that frame.
     */
    private resolveFrameSourceSize;
    /** Layout of one frame's quad, resolved through the shared editor/runtime math. */
    private resolveFrameLayout;
    /**
     * Size and place the quad for the current frame. The math is shared with the
     * editor's proxy visuals via {@link resolveAnimatedSpriteFrameLayout} — the
     * editor draws separate meshes, so parity has to come from one implementation.
     */
    private updateSize;
    /**
     * Where a named frame point currently sits, in **node-local** space — directly
     * usable as a child node's position (a muzzle flash, a held item). Returns
     * `null` when the frame doesn't define the point.
     *
     * The result is composed through the same presentation math as the visible
     * pixels (sizeMode, per-clip scale, frame anchor, node anchor), so the point
     * stays glued to the art as frames change size.
     *
     * @param frameIndex Frame to read; defaults to the frame showing right now.
     */
    getFramePoint(name: string, frameIndex?: number): ResolvedFramePoint | null;
    /**
     * {@link getFramePoint} in world space: the point transformed by this node's
     * world matrix, with the node's world Z-rotation added to the point's angle.
     * `null` when the point doesn't exist on the current frame.
     */
    getFramePointWorld(name: string, frameIndex?: number): {
        x: number;
        y: number;
        z: number;
        angle: number;
    } | null;
    /** Names of every point defined anywhere in the active clip, in first-seen order. */
    getClipPointNames(): string[];
    /**
     * The frame's authored collision polygon in **node-local** space (y up) — the
     * outline traced or drawn in the Sprite Editor, placed through the same layout
     * math as the visible pixels. `[]` when the frame has no polygon or its pixel
     * size was never stamped.
     *
     * This is what makes a per-frame outline an actual collider: `core:Hitbox2D`
     * with `polygonSource: 'frame'` reads it every query, so the shape follows the
     * animation frame by frame instead of being a box that approximates all of them.
     *
     * @param frameIndex Frame to read; defaults to the frame showing right now.
     */
    getFrameCollisionPolygon(frameIndex?: number): {
        x: number;
        y: number;
    }[];
    protected disposeResources(): void;
}
