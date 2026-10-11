import { type Texture, Vector2 } from 'three';
import { UIControl2D, type UIControl2DProps } from './UIControl2D';
import type { PropertySchema } from '../../../fw/property-schema';
import type { InstancePropertySchemaProvider } from '../../../fw/property-schema-utils';
import { ShaderEffectStack, type ShaderEffectEntry, type ShaderEffectHost } from '../../../shader-effects/ShaderEffectStack';
import type { AttachedShaderEffect } from '../../../shader-effects/shader-effect-types';
import { type TextureResourceRef } from '../../../core/TextureResource';
import { type SliceBorder2D } from '../../../core/nine-slice-skin';
export type Button2DSpriteState = 'normal' | 'hover' | 'pressed' | 'disabled';
export interface Button2DProps extends UIControl2DProps {
    width?: number;
    height?: number;
    backgroundColor?: string;
    hoverColor?: string;
    pressedColor?: string;
    buttonAction?: string;
    textureNormal?: TextureResourceRef | string | null;
    textureHover?: TextureResourceRef | string | null;
    texturePressed?: TextureResourceRef | string | null;
    textureDisabled?: TextureResourceRef | string | null;
    stateTextureKeys?: Partial<Record<Button2DSpriteState, string>>;
    /** 9-slice insets (source px) for the state skins. All-zero (default) = stretch. */
    sliceBorder?: Partial<SliceBorder2D> | null;
    /** Registry-backed shader effects attached to the button skin material. */
    effects?: ShaderEffectEntry[];
}
/**
 * A clickable button control for 2D UI.
 * Emits virtual button presses and supports click callbacks.
 *
 * Skin: each interaction state (normal/hover/pressed/disabled) may set its own
 * sprite. A missing state sprite falls back to the normal sprite; with no sprites
 * at all the button keeps its flat-color behavior (backgroundColor/hoverColor/
 * pressedColor). The actual Texture objects are supplied post-construction by the
 * SceneLoader (nodes have no asset loader); the schema stores only resource refs.
 */
export declare class Button2D extends UIControl2D implements InstancePropertySchemaProvider, ShaderEffectHost {
    width: number;
    height: number;
    backgroundColor: string;
    hoverColor: string;
    pressedColor: string;
    buttonAction: string;
    textureNormal: TextureResourceRef | null;
    textureHover: TextureResourceRef | null;
    texturePressed: TextureResourceRef | null;
    textureDisabled: TextureResourceRef | null;
    /**
     * Localization sprite keys per interaction state, resolved through the active
     * locale table's `sprites` section (skins with baked text that differ per
     * language). A resolvable key wins over the authored state texture ref; the
     * ref stays as the universal fallback. Missing/empty entries = not localized.
     */
    stateTextureKeys: Partial<Record<Button2DSpriteState, string>>;
    /**
     * 9-slice insets in *source-texture pixels*. All-zero (the default) keeps the
     * historical behaviour: one shared unit quad scaled to width x height, i.e. the
     * skin is smeared. Any non-zero inset switches the skin mesh to a 3x3 patch
     * whose corners keep their pixel size - so one 64x64 skin fits any button.
     */
    sliceBorder: SliceBorder2D;
    private buttonMesh;
    private buttonMaterial;
    /** Per-instance 9-slice geometry while sliced; null = the shared unit quad. */
    private skinGeometry;
    /** Natural size of the skin texture currently on the material (0 = unknown). */
    private skinTextureWidth;
    private skinTextureHeight;
    /** Mirrors `!effectStack.isEmpty` without reading it before it is constructed. */
    private skinEffectsActive;
    /** Registry-backed shader effects on the skin material; while non-empty the
     * skin mesh opts out of the 2D quad batcher (see Sprite2D for the why). */
    private readonly effectStack;
    private readonly stateTextures;
    constructor(props: Button2DProps);
    /** The shader-effect stack driving the button skin material. */
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
    isPointInBounds(worldPoint: Vector2): boolean;
    tick(dt: number): void;
    protected onPress(isPressed: boolean): void;
    protected onHover(_isHovering: boolean): void;
    protected onEnabledChanged(enabled: boolean): void;
    /**
     * Route the legacy base skin texture (UIControl2D.texturePath) through state
     * resolution so its async load callback cannot clobber a state-specific map.
     */
    protected applySkinTexture(texture: Texture | null): void;
    /** Assign the loaded Texture for a state (called by SceneLoader after loading). */
    setStateTexture(state: Button2DSpriteState, texture: Texture | null): void;
    private resolveStateTexture;
    private resolveStateColor;
    /** Apply the texture or flat color for the current interaction state. */
    private refreshSkinState;
    /**
     * Record the natural size of the skin texture now on the material and re-cut the
     * 9-slice patch when it changed. Called on every state swap; cheap by design —
     * it only rebuilds geometry when the border is non-zero AND the size moved.
     */
    private captureSkinTextureSize;
    /**
     * Point the skin mesh at the right geometry for the current border.
     *
     * Unsliced (the default) keeps the shared unit quad sized by `mesh.scale`, which
     * is what lets the skin ride the 2D quad batcher. A sliced skin bakes pixel
     * positions into its own `BufferGeometry` and therefore MUST opt out of the
     * batcher — the batcher extracts four *unit* corners through `matrixWorld`, so a
     * batched 9-slice would collapse back into a single stretched quad.
     */
    private applySkinGeometry;
    private updateSkinBatchable;
    /** Set the 9-slice insets (source px). All-zero restores the plain stretch. */
    setSliceBorder(border: Partial<SliceBorder2D>): void;
    /**
     * The texture path that should actually be loaded for a state: the locale
     * table's `sprites[stateTextureKeys[state]]` for the active locale, else the
     * authored state texture ref. Single source of truth for the SceneLoader and
     * the locale-change re-resolve walk.
     */
    getEffectiveStateTexturePath(state: Button2DSpriteState): string | null;
    /** Whether any interaction state carries a localization sprite key. */
    hasLocalizedStateTextures(): boolean;
    private setStateTextureKey;
    private setStateTextureRef;
    static getPropertySchema(): PropertySchema;
}
