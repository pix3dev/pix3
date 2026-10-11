import { type Texture, Vector2 } from 'three';
import { UIControl2D, type UIControl2DProps } from './UIControl2D';
import type { PropertySchema } from '../../../fw/property-schema';
import { type TextureResourceRef } from '../../../core/TextureResource';
import { type SliceBorder2D } from '../../../core/nine-slice-skin';
/** The two skin slots a bar can be given a sprite for. */
export type Bar2DTextureSlot = 'trough' | 'fill';
export interface Bar2DProps extends UIControl2DProps {
    width?: number;
    height?: number;
    backBackgroundColor?: string;
    barColor?: string;
    minValue?: number;
    maxValue?: number;
    value?: number;
    showBorder?: boolean;
    borderColor?: string;
    borderWidth?: number;
    /** Sprite for the empty trough behind the fill. */
    textureTrough?: TextureResourceRef | string | null;
    /** Sprite for the filled portion, re-cut (not squashed) as `value` moves. */
    textureFill?: TextureResourceRef | string | null;
    /** 9-slice insets (source px) applied to both the trough and the fill. */
    sliceBorder?: Partial<SliceBorder2D> | null;
}
/**
 * A progress/status bar for 2D UI (HP, energy, progress, etc).
 * Visual only - no interaction. Value is typically set by scripts.
 */
export declare class Bar2D extends UIControl2D {
    width: number;
    height: number;
    backBackgroundColor: string;
    barColor: string;
    minValue: number;
    maxValue: number;
    value: number;
    showBorder: boolean;
    borderColor: string;
    borderWidth: number;
    /**
     * Skin slots. A set slot replaces the corresponding flat colour with the sprite
     * (material colour goes white, like `Button2D` does for its state skins). The
     * actual `Texture` objects arrive post-construction from the SceneLoader.
     */
    textureTrough: TextureResourceRef | null;
    textureFill: TextureResourceRef | null;
    /**
     * 9-slice insets in *source-texture pixels*, applied to the trough and the fill.
     * All-zero (the default) keeps the historical plain `PlaneGeometry` stretch.
     */
    sliceBorder: SliceBorder2D;
    private backgroundMesh;
    private barMesh;
    private borderMesh;
    private backgroundMaterial;
    private barMaterial;
    private borderMaterial;
    private backgroundGeometry;
    private barGeometry;
    private borderGeometry;
    private readonly slotTextures;
    /** Natural size of each slot's texture (0 = unknown), needed to cut 9-slice UVs. */
    private readonly slotTextureSizes;
    constructor(props: Bar2DProps);
    private createBorder;
    private buildBorderGeometry;
    private rebuildBorderGeometry;
    isPointInBounds(_worldPoint: Vector2): boolean;
    /**
     * Set the bar's value (clamped to min/max range)
     */
    setValue(newValue: number): void;
    private updateBarVisuals;
    /** Geometry for one slot: a plain quad, or a 9-slice patch when sliced. */
    private buildSlotGeometry;
    /** Re-cut the trough (and the fill, via updateBarVisuals) after a size/border change. */
    private rebuildTroughGeometry;
    /** Set the 9-slice insets (source px) for the trough and fill. All-zero = stretch. */
    setSliceBorder(border: Partial<SliceBorder2D>): void;
    /**
     * Assign the loaded `Texture` for one skin slot (called by the SceneLoader after
     * loading, mirroring `Button2D.setStateTexture`). Passing null clears the slot
     * and the control falls back to its flat colour.
     */
    setSlotTexture(slot: Bar2DTextureSlot, texture: Texture | null): void;
    /** The authored path that should be loaded for a slot, or null. */
    getSlotTexturePath(slot: Bar2DTextureSlot): string | null;
    private setSlotTextureRef;
    /** Repaint one slot's flat colour, unless a sprite currently covers it. */
    private refreshSlotColor;
    static getPropertySchema(): PropertySchema;
}
