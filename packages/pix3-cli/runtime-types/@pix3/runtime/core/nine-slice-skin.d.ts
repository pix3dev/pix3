import { BufferGeometry } from 'three';
import { type TiledSpriteSliceBorder } from './tiled-sprite-geometry';
/**
 * Nine-slice support for the UI controls whose skin is a single stretched rect
 * (`Button2D`, `Slider2D`, `Bar2D`). They are not `TiledSprite2D` — they own their
 * own meshes and sizing — but the *geometry* question is identical, so the actual
 * slicing runs through the same {@link buildTiledSpriteGeometry} the tiled sprite
 * and its editor proxy use. Nothing here duplicates that math.
 *
 * The contract those controls share:
 *
 * - `sliceBorder` defaults to all-zero, which means "no slicing" and produces the
 *   very same centred `PlaneGeometry(width, height)` the controls always built —
 *   an untouched scene renders and serializes exactly as before.
 * - A non-zero border switches the mesh to a 3x3 patch whose corners keep their
 *   source-pixel size while the edges and centre stretch, so one 64x64 skin fits
 *   a button (or a bar fill) of any size instead of being smeared.
 */
/** Border insets in *source-texture pixels* (Godot's `patch_margin_*`). */
export type SliceBorder2D = TiledSpriteSliceBorder;
/** The neutral border: no slicing, plain stretch. */
export declare const ZERO_SLICE_BORDER: SliceBorder2D;
/** Coerce arbitrary authored input into a valid, non-negative border. */
export declare function normalizeSliceBorder(border?: Partial<SliceBorder2D> | null | undefined): SliceBorder2D;
/** True when the border asks for no slicing at all (every inset is zero). */
export declare function isSliceBorderEmpty(border: SliceBorder2D | undefined | null): boolean;
export interface SkinGeometryParams {
    /** On-screen width in design pixels. */
    width: number;
    /** On-screen height in design pixels. */
    height: number;
    /** Natural texture width in px; 0/unknown falls back to the on-screen width. */
    textureWidth?: number;
    /** Natural texture height in px; 0/unknown falls back to the on-screen height. */
    textureHeight?: number;
    border?: SliceBorder2D | null;
}
/**
 * The geometry a skinned UI rect should draw with: an ordinary centred
 * `PlaneGeometry` while the border is empty (bit-for-bit the previous behaviour,
 * and the shape existing specs read `.parameters` off), a 9-slice patch otherwise.
 */
export declare function buildSkinGeometry(params: SkinGeometryParams): BufferGeometry;
