import { type Texture, Vector2 } from 'three';
import { UIControl2D, type UIControl2DProps } from './UIControl2D';
import type { PropertySchema } from '../../../fw/property-schema';
import { type InteractionDescriptor } from '../../../fw/interactive';
import { type TextureResourceRef } from '../../../core/TextureResource';
import { type SliceBorder2D } from '../../../core/nine-slice-skin';
/** The three skin slots a slider can be given a sprite for. */
export type Slider2DTextureSlot = 'track' | 'fill' | 'thumb';
export interface Slider2DProps extends UIControl2DProps {
    width?: number;
    height?: number;
    handleSize?: number;
    trackBackgroundColor?: string;
    trackFilledColor?: string;
    handleColor?: string;
    minValue?: number;
    maxValue?: number;
    value?: number;
    axisName?: string;
    /** Sprite for the track background. */
    textureTrack?: TextureResourceRef | string | null;
    /** Sprite for the filled portion of the track (left of the handle). */
    textureFill?: TextureResourceRef | string | null;
    /** Sprite for the draggable handle. Never nine-sliced. */
    textureThumb?: TextureResourceRef | string | null;
    /** 9-slice insets (source px) applied to the track and the fill. */
    sliceBorder?: Partial<SliceBorder2D> | null;
}
/**
 * A horizontal slider control for 2D UI.
 * Emits axis values and supports value change callbacks.
 *
 * Pointer handling runs through the shared `UIControl2D` funnel, which means: the control emits the
 * lifecycle signals (`pointerdown`/`pressed`/`pointerup`/`released`/`click`), tracks hover and
 * honours the ancestor-scroll gate (a scroll drag passing over the track no longer grabs the
 * handle). The drag itself is unchanged: the press must start inside the track, and it keeps
 * tracking the pointer outside the bounds until release (see {@link capturesPointer}).
 *
 * Unlike `Checkbox2D` / `InventorySlot2D` this control has no state signal, because it has no
 * activation that flips a state behind the pointer signals: the value is written from
 * {@link onPointerDrag}, i.e. during the drag, so by the time `released` / `click` are emitted
 * `value` is already the value the gesture produced. Scripts either read `value` in those listeners
 * or poll it (`slider.value`); the live value during a drag is `input.getAxis(axisName)`.
 */
export declare class Slider2D extends UIControl2D {
    width: number;
    height: number;
    handleSize: number;
    trackBackgroundColor: string;
    trackFilledColor: string;
    handleColor: string;
    minValue: number;
    maxValue: number;
    value: number;
    axisName: string;
    /**
     * Skin slots. A set slot replaces the corresponding flat colour with the sprite
     * (material colour goes white, like `Button2D` does for its state skins). The
     * actual `Texture` objects arrive post-construction from the SceneLoader.
     */
    textureTrack: TextureResourceRef | null;
    textureFill: TextureResourceRef | null;
    textureThumb: TextureResourceRef | null;
    /**
     * 9-slice insets in *source-texture pixels*, applied to the track and the fill.
     * All-zero (the default) keeps the historical plain `PlaneGeometry` stretch. The
     * thumb is never sliced - it is drawn at its authored size, not stretched.
     */
    sliceBorder: SliceBorder2D;
    private trackMesh;
    private filledTrackMesh;
    private handleMesh;
    private trackMaterial;
    private filledTrackMaterial;
    private handleMaterial;
    private trackGeometry;
    private filledTrackGeometry;
    private handleGeometry;
    private readonly slotTextures;
    /** Natural size of each slot's texture (0 = unknown), needed to cut 9-slice UVs. */
    private readonly slotTextureSizes;
    constructor(props: Slider2DProps);
    isPointInBounds(worldPoint: Vector2): boolean;
    tick(dt: number): void;
    /** A slider owns the pointer once grabbed: the drag keeps tracking past the track's edges. */
    protected capturesPointer(): boolean;
    protected onPointerDrag(pointerWorld: Vector2): void;
    /** True while the handle is being dragged (the press that owns the pointer). */
    get isDragging(): boolean;
    getInteractions(): InteractionDescriptor[];
    /**
     * `setValue` and `dragTo` are deliberately two interactions, not one. The first answers "does
     * anything react to the value changing", the second "does the drag machinery work at all" — a
     * slider can pass either one while failing the other, and collapsing them loses that half of the
     * check.
     */
    protected performInteraction(name: string, args?: Record<string, unknown>): boolean;
    /**
     * Run a real drag: press on the handle where it currently sits, travel to the target value and
     * release there. Every frame goes through the pointer funnel, so the value moves only because
     * {@link onPointerDrag} moved it — the same reason a finger moves it.
     */
    private dragHandleTo;
    /** World X of a value on this track — the mirror of {@link updateSliderFromPointer}. */
    private worldXForValue;
    private updateSliderFromPointer;
    private setValue;
    private updateSliderVisuals;
    /** Geometry for one slot: a plain quad, or a 9-slice patch when sliced. */
    private buildSlotGeometry;
    /** Re-cut the track (and the fill, via updateSliderVisuals) after a size/border change. */
    private rebuildTrackGeometry;
    /** Set the 9-slice insets (source px) for the track and fill. All-zero = stretch. */
    setSliceBorder(border: Partial<SliceBorder2D>): void;
    /**
     * Assign the loaded `Texture` for one skin slot (called by the SceneLoader after
     * loading, mirroring `Button2D.setStateTexture`). Passing null clears the slot
     * and the control falls back to its flat colour.
     */
    setSlotTexture(slot: Slider2DTextureSlot, texture: Texture | null): void;
    /** The authored path that should be loaded for a slot, or null. */
    getSlotTexturePath(slot: Slider2DTextureSlot): string | null;
    private materialForSlot;
    private colorForSlot;
    private setSlotTextureRef;
    /** Repaint one slot's flat colour, unless a sprite currently covers it. */
    private refreshSlotColor;
    static getPropertySchema(): PropertySchema;
}
