import { Texture } from 'three';
import { Node2D, type Node2DProps } from '../Node2D';
import type { PropertySchema } from '../../fw/property-schema';
import type { InstancePropertySchemaProvider } from '../../fw/property-schema-utils';
import { ShaderEffectStack, type ShaderEffectEntry, type ShaderEffectHost } from '../../shader-effects/ShaderEffectStack';
import type { AttachedShaderEffect } from '../../shader-effects/shader-effect-types';
import { type TextureResourceRef } from '../../core/TextureResource';
import { type TextureRegion } from '../../core/texture-region';
export interface SpriteAnchor2D {
    x: number;
    y: number;
}
export interface Sprite2DProps extends Omit<Node2DProps, 'type'> {
    texture?: TextureResourceRef | null;
    texturePath?: string | null;
    textureKey?: string;
    width?: number;
    height?: number;
    color?: string;
    anchor?: SpriteAnchor2D | [number, number];
    /** Cached width/height ratio of the source image; recomputed on load when absent. */
    textureAspectRatio?: number | null;
    aspectRatioLocked?: boolean;
    /** Registry-backed shader effects attached to this sprite's material. */
    effects?: ShaderEffectEntry[];
}
export declare class Sprite2D extends Node2D implements InstancePropertySchemaProvider, ShaderEffectHost {
    texture: TextureResourceRef | null;
    /**
     * Localization sprite key resolved through the active locale table's `sprites`
     * section (e.g. a button skin with baked text that differs per language). When
     * set and the key resolves, the localized path wins; the authored {@link texture}
     * ref stays as the universal fallback. Empty = not localized.
     */
    textureKey: string;
    /** Width in pixels. Defaults to texture width when loaded, or 64 as placeholder. */
    width: number | undefined;
    /** Height in pixels. Defaults to texture height when loaded, or 64 as placeholder. */
    height: number | undefined;
    /** Stored aspect ratio of the original texture (width / height), null if unknown. */
    textureAspectRatio: number | null;
    /** If true, height changes proportionally when width is modified and vice versa. */
    aspectRatioLocked: boolean;
    /** Original width (from texture). Used to reset to natural size. */
    originalWidth: number | null;
    /** Original height (from texture). Used to reset to natural size. */
    originalHeight: number | null;
    /** Normalized anchor point in local sprite space: (0,0)=bottom-left, (0.5,0.5)=center, (1,1)=top-right. */
    anchor: SpriteAnchor2D;
    /**
     * Transient UV crop applied to the current texture (e.g. an odometer showing
     * one digit of a strip). Presentation state only — NOT serialized and NOT in
     * the property schema; scripts set it via {@link setTextureRegion} in play
     * mode (and push the same region as an editor appearance override in edit
     * mode). `null` = full texture.
     */
    textureRegion: TextureRegion | null;
    private mesh;
    private material;
    /**
     * The shared, AssetLoader-cached texture last handed to {@link setTexture}.
     * Multiple sprites reuse the same instance, so this sprite must NEVER mutate
     * its `offset`/`repeat` — the crop goes on {@link ownedTexture} instead.
     */
    private baseTexture;
    /**
     * Per-sprite clone of {@link baseTexture}, created lazily only while a
     * {@link textureRegion} crop is active. The crop is applied to this clone's
     * `offset`/`repeat`, so cropping never leaks onto the shared cached texture
     * that other sprites reuse (the play-mode bug this fixes). The clone shares
     * the base texture's GPU source via three.js source refcounting, so it adds
     * no VRAM; it is disposed in {@link disposeResources}. Mirrors the same
     * per-instance crop pattern in {@link AnimatedSprite2D}.
     */
    private ownedTexture;
    /**
     * Registry-backed shader effects on this sprite's material. While any effect
     * is attached the mesh opts OUT of the 2D quad batcher (the batcher would draw
     * it with its own stock material, dropping the injected GLSL); a passthrough
     * mesh renders with its own effected material, so the injection just works.
     */
    private readonly effectStack;
    constructor(props: Sprite2DProps);
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
    /** Play-mode: advance any effect with a per-frame CPU update (uv-scroll). */
    tick(dt: number): void;
    private static normalizeAnchor;
    private applyAnchorOffset;
    setAnchor(value: SpriteAnchor2D | [number, number]): void;
    /**
     * Crop the sprite to a normalized UV sub-rect, or `null` to show the full
     * texture. Transient presentation state (never serialized). Used by scripts to
     * show one cell of a sprite strip (e.g. an odometer digit) at runtime.
     */
    setTextureRegion(region: TextureRegion | null): void;
    /**
     * Point the material at the correct texture for the current crop state: the
     * shared cached {@link baseTexture} when there is no region (zero overhead,
     * common case), or a private {@link ownedTexture} clone carrying the crop when
     * a region is active — so the crop never mutates the shared texture that other
     * sprites reuse.
     */
    private applyTexturePresentation;
    get texturePath(): string | null;
    /**
     * The texture path that should actually be loaded: the locale table's
     * `sprites[textureKey]` for the active locale (with its fallback chain), else
     * the authored {@link texturePath}. Used by the SceneLoader, the locale-change
     * re-resolve walk, and the editor viewport proxy — single source of truth.
     */
    getEffectiveTexturePath(): string | null;
    set texturePath(value: string | null);
    setTextureResource(value: unknown): void;
    /**
     * Set the texture for this sprite.
     * Resizes the mesh if the texture provides dimensions and width/height were not specified.
     */
    setTexture(texture: Texture): void;
    private updateSize;
    /**
     * Reset sprite size to its original texture dimensions.
     * If no original dimensions are known, does nothing.
     */
    resetToOriginalSize(): void;
    /**
     * Release the per-sprite crop clone (if any) and this sprite's material. The
     * geometry is the shared unit quad and is deliberately NOT disposed — it is
     * referenced by every other sprite (so we do not call `super.disposeResources`,
     * which would dispose it). The shared cached {@link baseTexture} is also left
     * intact for other sprites; `material.dispose()` never frees `material.map`.
     */
    protected disposeResources(): void;
    /**
     * Get the property schema for Sprite2D.
     * Extends Node2D schema with sprite-specific properties.
     */
    static getPropertySchema(): PropertySchema;
}
